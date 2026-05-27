import { logger } from '../core/logger.js';
import type { ToolDefinition } from '../core/types.js';
import type { IMcpClient } from './client.js';

const SCOPE = 'mcp-sse-client';

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

/**
 * MCP client that connects to remote servers via SSE transport.
 * Opens GET /sse for server-to-client messages, sends JSON-RPC via POST to the message endpoint.
 */
export class SseMcpClient implements IMcpClient {
  private _tools: ToolDefinition[] = [];
  private _serverName = '';
  private _connected = false;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private messageEndpoint = '';
  private abortController: AbortController | null = null;

  constructor(
    private baseUrl: string,
    private env?: Record<string, string>,
  ) { }

  get tools(): ToolDefinition[] { return this._tools; }
  get serverName(): string { return this._serverName; }
  get isConnected(): boolean { return this._connected; }

  async connect(): Promise<void> {
    const sseUrl = this.baseUrl.replace(/\/$/, '') + '/sse';
    logger.info(SCOPE, `Connecting to SSE MCP server at ${sseUrl}`);

    this.abortController = new AbortController();
    const headers: Record<string, string> = {};
    if (this.env) {
      for (const [k, v] of Object.entries(this.env)) {
        headers[k] = v;
      }
    }

    const endpointPromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SSE endpoint discovery timed out')), 15_000);

      fetch(sseUrl, { headers, signal: this.abortController!.signal })
        .then(async (response) => {
          if (!response.ok) {
            clearTimeout(timer);
            reject(new Error(`SSE connection failed: ${response.status} ${response.statusText}`));
            return;
          }

          const reader = response.body?.getReader();
          if (!reader) {
            clearTimeout(timer);
            reject(new Error('No readable stream from SSE response'));
            return;
          }

          const decoder = new TextDecoder();
          let buffer = '';
          let endpointFound = false;

          const readLoop = async () => {
            try {
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                  if (line.startsWith('event: endpoint')) {
                    endpointFound = true;
                    continue;
                  }
                  if (endpointFound && line.startsWith('data: ')) {
                    const endpoint = line.slice(6).trim();
                    this.messageEndpoint = new URL(endpoint, this.baseUrl).href;
                    clearTimeout(timer);
                    resolve(this.messageEndpoint);
                    endpointFound = false;
                    continue;
                  }
                  if (line.startsWith('event: message')) {
                    continue;
                  }
                  if (line.startsWith('data: ') && this.messageEndpoint) {
                    try {
                      const msg = JSON.parse(line.slice(6)) as JsonRpcResponse;
                      if (msg.id !== undefined && this.pending.has(msg.id)) {
                        const handler = this.pending.get(msg.id)!;
                        this.pending.delete(msg.id);
                        if (msg.error) {
                          handler.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
                        } else {
                          handler.resolve(msg.result);
                        }
                      }
                    } catch { /* non-JSON SSE data */ }
                  }
                }
              }
            } catch (err) {
              if ((err as Error).name !== 'AbortError') {
                logger.error(SCOPE, `SSE read error: ${(err as Error).message}`);
              }
            }
          };

          readLoop().catch(() => { });
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });

    this.messageEndpoint = await endpointPromise;
    this._connected = true;
    logger.info(SCOPE, `SSE endpoint discovered: ${this.messageEndpoint}`);

    const initResult = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'korabot', version: '0.1.0' },
    }) as { serverInfo?: { name?: string } };

    this._serverName = initResult?.serverInfo?.name ?? 'unknown';

    await this.sendNotification('notifications/initialized', {});
    await this.refreshTools();
    logger.info(SCOPE, `Connected to SSE MCP server "${this._serverName}" with ${this._tools.length} tool(s)`);
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
    this.abortController?.abort();
    this.abortController = null;
    this._tools = [];
    this._connected = false;
    for (const [, handler] of this.pending) {
      handler.reject(new Error('Client disconnected'));
    }
    this.pending.clear();
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this._connected && method !== 'initialize') {
        return reject(new Error('SSE MCP client not connected'));
      }
      const id = ++this.requestId;
      const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
      this.pending.set(id, { resolve, reject });

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.env) {
        for (const [k, v] of Object.entries(this.env)) {
          headers[k] = v;
        }
      }

      fetch(this.messageEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      }).catch((err) => {
        this.pending.delete(id);
        reject(new Error(`SSE POST failed: ${(err as Error).message}`));
      });

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`SSE MCP request "${method}" timed out after 120s`));
        }
      }, 120_000);
    });
  }

  private async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.env) {
      for (const [k, v] of Object.entries(this.env)) {
        headers[k] = v;
      }
    }
    try {
      await fetch(this.messageEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }),
      });
    } catch (err) {
      logger.debug(SCOPE, `Notification send failed: ${(err as Error).message}`);
    }
  }
}
