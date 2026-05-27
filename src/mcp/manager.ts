import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { McpClient, type IMcpClient } from './client.js';
import { logger } from '../core/logger.js';
import type { ToolDefinition } from '../core/types.js';

const VALID_NPM_PACKAGE = /^(@[a-z0-9_-]+\/)?[a-z0-9._-]+$/i;

const SCOPE = 'mcp-manager';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'sse';
  command: string;
  args: string[];
  userArgs?: string[];
  url?: string;
  env?: Record<string, string>;
  enabled: boolean;
  source?: string;
  installedAt?: string;
  allowedTools?: string[];
  blockedTools?: string[];
}

export class McpManager {
  private configPath: string;
  private clients: Map<string, IMcpClient> = new Map();
  private servers: McpServerConfig[] = [];
  private workspaceServers: Map<string, McpServerConfig[]> = new Map();
  private workspaceClients: Map<string, Map<string, IMcpClient>> = new Map();

  constructor(private toolsDir: string) {
    this.configPath = path.join(toolsDir, 'mcp.yml');
    this.loadConfig();
  }

  private loadConfig(): void {
    if (!fs.existsSync(this.configPath)) {
      this.servers = [];
      return;
    }
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const parsed = parseYaml(raw);
      this.servers = (parsed?.servers as McpServerConfig[]) ?? [];
    } catch (err) {
      logger.warn(SCOPE, `Failed to parse mcp.yml: ${err}`);
      this.servers = [];
    }
  }

  private saveConfig(): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, stringifyYaml({ servers: this.servers }), 'utf-8');
  }

  async install(
    source: string,
    options?: {
      env?: Record<string, string>;
      args?: string[];
      transport?: 'stdio' | 'sse';
      url?: string;
      command?: string;
      name?: string;
    },
  ): Promise<McpServerConfig> {
    logger.info(SCOPE, `Installing MCP server from: ${source}`);

    const transport = options?.transport ?? 'stdio';

    if (transport === 'sse') {
      const url = options?.url ?? source;
      const name = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
      const id = name;
      const existing = this.servers.find(s => s.id === id);
      if (existing) {
        existing.url = url;
        existing.env = options?.env;
        existing.userArgs = options?.args;
        existing.enabled = true;
        this.saveConfig();
        return existing;
      }
      const config: McpServerConfig = {
        id, name, transport: 'sse', command: '', args: [], userArgs: options?.args,
        url, env: options?.env, enabled: true, source, installedAt: new Date().toISOString(),
      };
      this.servers.push(config);
      this.saveConfig();
      logger.info(SCOPE, `SSE MCP server "${id}" configured at ${url}`);
      return config;
    }

    let command: string;
    let args: string[] = [];
    let name = source;

    if (options?.command) {
      command = options.command;
      args = options.args ?? [];
      name = options.name || path.basename(command);
      logger.info(SCOPE, `Custom command MCP server: ${command} ${args.join(' ')}`);
    } else if (source.startsWith('/') || source.startsWith('./')) {
      const resolved = path.resolve(source);
      if (!fs.existsSync(resolved)) {
        throw new Error(`Local path does not exist: ${resolved}`);
      }
      command = resolved;
      name = path.basename(resolved);
    } else if (source.includes('/') && !source.startsWith('@')) {
      if (!VALID_NPM_PACKAGE.test(source.split('/').pop() ?? '')) {
        throw new Error(`Invalid npm package name: ${source}`);
      }
      logger.info(SCOPE, `Installing npm package: ${source}`);
      execFileSync('npm', ['install', '-g', source], { stdio: 'pipe', timeout: 120_000 });
      command = 'npx';
      args = ['-y', source];
    } else {
      if (!VALID_NPM_PACKAGE.test(source)) {
        throw new Error(`Invalid npm package name: ${source}`);
      }
      logger.info(SCOPE, `Installing npm package: ${source}`);
      try {
        execFileSync('npm', ['install', '-g', source], { stdio: 'pipe', timeout: 120_000 });
      } catch {
        logger.info(SCOPE, `Global install failed, will use npx`);
      }
      command = 'npx';
      args = ['-y', source];
      name = source.replace(/^@[^/]+\//, '');
    }

    const userArgs = options?.command ? [] : (options?.args ?? []);
    const id = (options?.name || name).replace(/[^a-zA-Z0-9_-]/g, '_');

    const existing = this.servers.find(s => s.id === id);
    if (existing) {
      logger.info(SCOPE, `MCP server "${id}" already installed, updating config`);
      existing.command = command;
      existing.args = args;
      existing.userArgs = userArgs;
      existing.env = options?.env;
      existing.enabled = true;
      this.saveConfig();
      return existing;
    }

    const config: McpServerConfig = {
      id, name, transport: 'stdio', command, args, userArgs,
      env: options?.env, enabled: true, source, installedAt: new Date().toISOString(),
    };

    this.servers.push(config);
    this.saveConfig();
    logger.info(SCOPE, `MCP server "${id}" saved, validating connection...`);

    try {
      await this.connectServer(config);
      logger.info(SCOPE, `MCP server "${id}" installed and connected successfully`);
    } catch (err) {
      this.servers = this.servers.filter(s => s.id !== config.id);
      this.saveConfig();
      throw new Error(`MCP server failed to connect: ${(err as Error).message}`);
    }

    return config;
  }

  update(id: string, updates: Partial<Pick<McpServerConfig, 'userArgs' | 'env' | 'url' | 'enabled' | 'allowedTools' | 'blockedTools'>>): McpServerConfig | null {
    const server = this.servers.find(s => s.id === id);
    if (!server) return null;
    if (updates.userArgs !== undefined) server.userArgs = updates.userArgs;
    if (updates.env !== undefined) server.env = updates.env;
    if (updates.url !== undefined) server.url = updates.url;
    if (updates.enabled !== undefined) server.enabled = updates.enabled;
    if (updates.allowedTools !== undefined) server.allowedTools = updates.allowedTools;
    if (updates.blockedTools !== undefined) server.blockedTools = updates.blockedTools;
    this.saveConfig();
    return server;
  }

  remove(id: string): boolean {
    const idx = this.servers.findIndex(s => s.id === id);
    if (idx === -1) return false;

    const client = this.clients.get(id);
    if (client) {
      client.disconnect();
      this.clients.delete(id);
    }

    this.servers.splice(idx, 1);
    this.saveConfig();
    logger.info(SCOPE, `MCP server "${id}" removed`);
    return true;
  }

  async connectAll(): Promise<void> {
    for (const server of this.servers) {
      if (!server.enabled) continue;
      try {
        await this.connectServer(server);
      } catch (err) {
        logger.error(SCOPE, `Failed to connect MCP server "${server.id}": ${(err as Error).message}`);
      }
    }
  }

  async connectServer(server: McpServerConfig): Promise<IMcpClient> {
    if (this.clients.has(server.id)) {
      const existing = this.clients.get(server.id)!;
      if (existing.isConnected) return existing;
    }

    let client: IMcpClient;
    if (server.transport === 'sse' && server.url) {
      const { SseMcpClient } = await import('./sse-client.js');
      client = new SseMcpClient(server.url, server.env);
    } else {
      const allArgs = [...server.args, ...(server.userArgs ?? [])];
      client = new McpClient(server.command, allArgs, server.env);
    }
    await client.connect();
    this.clients.set(server.id, client);
    return client;
  }

  async disconnectAll(): Promise<void> {
    for (const [id, client] of this.clients) {
      await client.disconnect();
      logger.info(SCOPE, `Disconnected MCP server "${id}"`);
    }
    this.clients.clear();
  }

  private isToolAllowed(serverId: string, toolName: string): boolean {
    const server = this.servers.find(s => s.id === serverId);
    if (!server) return true;
    if (server.blockedTools?.includes(toolName)) return false;
    if (server.allowedTools && server.allowedTools.length > 0) {
      return server.allowedTools.includes(toolName);
    }
    return true;
  }

  getToolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const [id, client] of this.clients) {
      for (const tool of client.tools) {
        if (this.isToolAllowed(id, tool.name)) {
          defs.push(tool);
        }
      }
    }
    return defs;
  }

  findClientForTool(toolName: string): IMcpClient | undefined {
    for (const [id, client] of this.clients) {
      if (client.tools.some(t => t.name === toolName) && this.isToolAllowed(id, toolName)) {
        return client;
      }
    }
    return undefined;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const client = this.findClientForTool(toolName);
    if (!client) {
      return JSON.stringify({ ok: false, error: `No MCP server provides tool "${toolName}"` });
    }
    return client.callTool(toolName, args);
  }

  listServers(): McpServerConfig[] {
    return [...this.servers];
  }

  listServersWithTools(): Array<McpServerConfig & { tools: string[]; connected: boolean }> {
    return this.servers.map(s => {
      const client = this.clients.get(s.id);
      const tools = client?.tools?.map(t => t.name) ?? [];
      const connected = client?.isConnected ?? false;
      return { ...s, tools, connected };
    });
  }

  getServer(id: string): McpServerConfig | undefined {
    return this.servers.find(s => s.id === id);
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const server = this.servers.find(s => s.id === id);
    if (!server) return false;
    server.enabled = enabled;
    this.saveConfig();
    if (!enabled) {
      const client = this.clients.get(id);
      if (client) {
        client.disconnect();
        this.clients.delete(id);
      }
    }
    return true;
  }

  getConnectedCount(): number {
    let count = 0;
    for (const [, client] of this.clients) {
      if (client.isConnected) count++;
    }
    return count;
  }

  getAllMcpToolNames(): string[] {
    const names: string[] = [];
    for (const [, client] of this.clients) {
      names.push(...client.tools.map(t => t.name));
    }
    return names;
  }

  loadWorkspaceConfig(workspaceId: string, workspacePath: string): void {
    const wsConfigPath = path.join(workspacePath, 'mcp.yml');
    if (!fs.existsSync(wsConfigPath)) {
      this.workspaceServers.set(workspaceId, []);
      return;
    }
    try {
      const raw = fs.readFileSync(wsConfigPath, 'utf-8');
      const parsed = parseYaml(raw);
      const servers = (parsed?.servers as McpServerConfig[]) ?? [];
      this.workspaceServers.set(workspaceId, servers);
      logger.info(SCOPE, `Loaded ${servers.length} workspace MCP server(s) for ${workspaceId}`);
    } catch (err) {
      logger.warn(SCOPE, `Failed to parse workspace mcp.yml for ${workspaceId}: ${err}`);
      this.workspaceServers.set(workspaceId, []);
    }
  }

  async connectWorkspaceServers(workspaceId: string): Promise<void> {
    const servers = this.workspaceServers.get(workspaceId) ?? [];
    if (!this.workspaceClients.has(workspaceId)) {
      this.workspaceClients.set(workspaceId, new Map());
    }
    const clients = this.workspaceClients.get(workspaceId)!;

    for (const server of servers) {
      if (!server.enabled) continue;
      if (clients.has(server.id)) continue;
      try {
        const client = await this.connectServer(server);
        clients.set(server.id, client);
      } catch (err) {
        logger.error(SCOPE, `Failed to connect workspace MCP "${server.id}" for ${workspaceId}: ${(err as Error).message}`);
      }
    }
  }

  getToolDefinitionsForWorkspace(workspaceId?: string): ToolDefinition[] {
    const globalDefs = this.getToolDefinitions();
    if (!workspaceId) return globalDefs;

    const wsClients = this.workspaceClients.get(workspaceId);
    if (!wsClients || wsClients.size === 0) return globalDefs;

    const wsToolNames = new Set<string>();
    const wsDefs: ToolDefinition[] = [];

    for (const [, client] of wsClients) {
      for (const tool of client.tools) {
        wsToolNames.add(tool.name);
        wsDefs.push(tool);
      }
    }

    const merged = [...wsDefs];
    for (const def of globalDefs) {
      if (!wsToolNames.has(def.name)) {
        merged.push(def);
      }
    }
    return merged;
  }

  findClientForToolInWorkspace(toolName: string, workspaceId?: string): IMcpClient | undefined {
    if (workspaceId) {
      const wsClients = this.workspaceClients.get(workspaceId);
      if (wsClients) {
        for (const [, client] of wsClients) {
          if (client.tools.some(t => t.name === toolName)) return client;
        }
      }
    }
    return this.findClientForTool(toolName);
  }

  async callToolInWorkspace(toolName: string, args: Record<string, unknown>, workspaceId?: string): Promise<string> {
    const client = this.findClientForToolInWorkspace(toolName, workspaceId);
    if (!client) {
      return JSON.stringify({ ok: false, error: `No MCP server provides tool "${toolName}"` });
    }
    return client.callTool(toolName, args);
  }
}
