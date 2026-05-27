import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '../core/logger.js';
import type { ToolDefinition } from '../core/types.js';

const SCOPE = 'mcp-client';

export interface IMcpClient {
  readonly tools: ToolDefinition[];
  readonly serverName: string;
  readonly isConnected: boolean;
  connect(): Promise<void>;
  refreshTools(): Promise<ToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  disconnect(): Promise<void>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class McpClient implements IMcpClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private _tools: ToolDefinition[] = [];
  private _serverName = '';

  constructor(
    private command: string,
    private args: string[] = [],
    private env?: Record<string, string>,
  ) { }

  get tools(): ToolDefinition[] {
    return this._tools;
  }

  get serverName(): string {
    return this._serverName;
  }

  async connect(): Promise<void> {
    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
    });

    this.process.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.process.stderr!.on('data', (chunk: Buffer) => {
      logger.debug(SCOPE, `[stderr] ${chunk.toString().trim()}`);
    });

    this.process.on('close', (code) => {
      logger.info(SCOPE, `MCP server exited with code ${code}`);
      for (const [, handler] of this.pending) {
        handler.reject(new Error(`MCP server exited with code ${code}`));
      }
      this.pending.clear();
      this.process = null;
    });

    const initResult = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'korabot', version: '0.1.0' },
    }) as { serverInfo?: { name?: string } };

    this._serverName = initResult?.serverInfo?.name ?? 'unknown';

    this.sendNotification('notifications/initialized', {});

    await this.refreshTools();

    logger.info(SCOPE, `Connected to MCP server "${this._serverName}" with ${this._tools.length} tool(s)`);
  }

  async refreshTools(): Promise<ToolDefinition[]> {
    const result = await this.sendRequest('tools/list', {}) as { tools?: McpToolInfo[] };
    this._tools = (result?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    }));
    return this._tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.sendRequest('tools/call', { name, arguments: args }) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };

    if (result?.isError) {
      const errorText = result.content?.map(c => c.text).join('\n') ?? 'Unknown MCP error';
      return JSON.stringify({ ok: false, error: errorText });
    }

    const text = result?.content?.map(c => c.text).filter(Boolean).join('\n') ?? '';
    return text || JSON.stringify({ ok: true, result });
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      const child = this.process;
      this.process = null;
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      setTimeout(() => {
        try { if (!child.killed) child.kill('SIGKILL'); } catch { /* already dead */ }
      }, 2_000).unref();
    }
    this._tools = [];
    for (const [, handler] of this.pending) {
      handler.reject(new Error('Client disconnected'));
    }
    this.pending.clear();
    this.buffer = '';
  }

  get isConnected(): boolean {
    return this.process !== null && !this.process.killed;
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        return reject(new Error('MCP server not connected'));
      }
      const id = ++this.requestId;
      const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify(request) + '\n';
      this.process.stdin.write(msg);

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request "${method}" timed out after 120s`));
        }
      }, 120_000).unref();
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n';
    this.process.stdin.write(msg);
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const handler = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            handler.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            handler.resolve(msg.result);
          }
        }
      } catch {
        logger.debug(SCOPE, `Non-JSON line from MCP server: ${trimmed.slice(0, 200)}`);
      }
    }
  }
}
