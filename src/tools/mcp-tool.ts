import type { ToolDefinition } from '../core/types.js';
import { logger } from '../core/logger.js';
import type { McpManager } from '../mcp/manager.js';

const SCOPE = 'mcp-tool';

export interface McpToolContext {
  mcpManager: McpManager;
  multiUserEnabled?: boolean;
  isAdmin?: boolean;
}

export const mcpToolDefinitions: ToolDefinition[] = [
  {
    name: 'mcp_install',
    description:
      'Install a new MCP (Model Context Protocol) tool server. Supports three modes:\n' +
      '- npm (default): npm packages or local executables. Example: source="@modelcontextprotocol/server-filesystem", args=["/path/to/dir"]\n' +
      '- custom command: arbitrary executables like uvx, docker, python. Example: command="uvx", args=["minimax-coding-plan-mcp"]\n' +
      '- sse: remote HTTP/SSE servers. Example: transport="sse", url="http://homeassistant:8123/mcp"\n' +
      'After installation, connectivity is validated and tools become available immediately.',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'npm package name, local path, or URL for SSE servers. Optional when using command mode.',
        },
        command: {
          type: 'string',
          description: 'Custom executable command (e.g., "uvx", "docker", "python"). When set, skips npm install and uses this command directly.',
        },
        name: {
          type: 'string',
          description: 'Display name for the server (optional, defaults to command basename or source)',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'CLI arguments passed to the command or MCP server process',
        },
        env: {
          type: 'object',
          description: 'Environment variables for the MCP server (e.g., {"API_KEY": "xxx"})',
        },
        transport: {
          type: 'string',
          enum: ['stdio', 'sse'],
          description: 'Transport type. "stdio" for local servers (default), "sse" for remote HTTP/SSE servers',
        },
        url: {
          type: 'string',
          description: 'URL for SSE transport (e.g., "http://host:port/sse")',
        },
      },
    },
  },
  {
    name: 'mcp_list',
    description: 'List all installed MCP tool servers, their transport, status, and available tools.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'mcp_remove',
    description: 'Remove an installed MCP tool server by its ID.',
    parameters: {
      type: 'object',
      properties: {
        server_id: { type: 'string', description: 'ID of the MCP server to remove' },
      },
      required: ['server_id'],
    },
  },
  {
    name: 'mcp_update',
    description: 'Update configuration of an existing MCP server (args, env, url, enabled).',
    parameters: {
      type: 'object',
      properties: {
        server_id: { type: 'string', description: 'ID of the MCP server' },
        args: { type: 'array', items: { type: 'string' }, description: 'New CLI arguments' },
        env: { type: 'object', description: 'New environment variables' },
        url: { type: 'string', description: 'New URL (for SSE servers)' },
        enabled: { type: 'boolean', description: 'Enable or disable the server' },
      },
      required: ['server_id'],
    },
  },
  {
    name: 'mcp_enable',
    description: 'Enable or disable an installed MCP tool server.',
    parameters: {
      type: 'object',
      properties: {
        server_id: { type: 'string', description: 'ID of the MCP server' },
        enabled: { type: 'boolean', description: 'true to enable, false to disable' },
      },
      required: ['server_id', 'enabled'],
    },
  },
  {
    name: 'mcp_reconnect',
    description: 'Reconnect to an MCP server (useful after configuration changes).',
    parameters: {
      type: 'object',
      properties: {
        server_id: { type: 'string', description: 'ID of the MCP server to reconnect' },
      },
      required: ['server_id'],
    },
  },
];

export async function handleMcpTool(
  name: string,
  args: Record<string, unknown>,
  context: McpToolContext,
): Promise<string> {
  try {
    switch (name) {
      case 'mcp_install': {
        const source = (args.source as string) ?? '';
        const command = args.command as string | undefined;
        const name = args.name as string | undefined;
        const env = args.env as Record<string, string> | undefined;
        const userArgs = args.args as string[] | undefined;
        const transport = args.transport as 'stdio' | 'sse' | undefined;
        const url = args.url as string | undefined;

        if (context.multiUserEnabled && !context.isAdmin && transport !== 'sse') {
          return JSON.stringify({ ok: false, error: 'Only remote SSE servers can be installed in multi-user mode. Local (stdio) servers require admin privileges.' });
        }

        const server = await context.mcpManager.install(source || name || command || 'unnamed', { env, args: userArgs, transport, url, command, name });

        const serverInfo = context.mcpManager.listServersWithTools().find(s => s.id === server.id);
        return JSON.stringify({
          ok: true,
          server: { id: server.id, name: server.name, source: server.source },
          connected: true,
          availableTools: serverInfo?.tools ?? [],
        });
      }

      case 'mcp_list': {
        const servers = context.mcpManager.listServers();
        const mcpToolNames = context.mcpManager.getAllMcpToolNames();

        return JSON.stringify({
          ok: true,
          servers: servers.map(s => ({
            id: s.id,
            name: s.name,
            transport: s.transport ?? 'stdio',
            source: s.source,
            url: s.url,
            userArgs: s.userArgs,
            enabled: s.enabled,
            installedAt: s.installedAt,
          })),
          connectedServers: context.mcpManager.getConnectedCount(),
          totalTools: mcpToolNames.length,
          tools: mcpToolNames,
        });
      }

      case 'mcp_update': {
        const serverId = args.server_id as string;
        const updated = context.mcpManager.update(serverId, {
          userArgs: args.args as string[] | undefined,
          env: args.env as Record<string, string> | undefined,
          url: args.url as string | undefined,
          enabled: args.enabled as boolean | undefined,
        });
        if (!updated) {
          return JSON.stringify({ ok: false, error: `MCP server "${serverId}" not found` });
        }
        return JSON.stringify({ ok: true, message: `MCP server "${serverId}" updated`, server: updated });
      }

      case 'mcp_remove': {
        const serverId = args.server_id as string;
        const removed = context.mcpManager.remove(serverId);
        if (!removed) {
          return JSON.stringify({ ok: false, error: `MCP server "${serverId}" not found` });
        }
        return JSON.stringify({ ok: true, message: `MCP server "${serverId}" removed` });
      }

      case 'mcp_enable': {
        const serverId = args.server_id as string;
        const enabled = args.enabled as boolean;
        const success = context.mcpManager.setEnabled(serverId, enabled);
        if (!success) {
          return JSON.stringify({ ok: false, error: `MCP server "${serverId}" not found` });
        }
        if (enabled) {
          const server = context.mcpManager.getServer(serverId);
          if (server) {
            try {
              await context.mcpManager.connectServer(server);
            } catch (err) {
              return JSON.stringify({
                ok: true,
                message: `Server "${serverId}" enabled but failed to connect: ${(err as Error).message}`,
              });
            }
          }
        }
        return JSON.stringify({ ok: true, message: `MCP server "${serverId}" ${enabled ? 'enabled' : 'disabled'}` });
      }

      case 'mcp_reconnect': {
        const serverId = args.server_id as string;
        const server = context.mcpManager.getServer(serverId);
        if (!server) {
          return JSON.stringify({ ok: false, error: `MCP server "${serverId}" not found` });
        }
        try {
          const client = await context.mcpManager.connectServer(server);
          return JSON.stringify({
            ok: true,
            message: `Reconnected to "${serverId}"`,
            tools: client.tools.map(t => t.name),
          });
        } catch (err) {
          return JSON.stringify({ ok: false, error: `Failed to reconnect: ${(err as Error).message}` });
        }
      }

      default:
        return JSON.stringify({ ok: false, error: `Unknown MCP tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(SCOPE, `${name} failed: ${msg}`);
    return JSON.stringify({ ok: false, error: msg });
  }
}
