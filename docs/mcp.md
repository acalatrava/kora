# MCP (Model Context Protocol)

Kora integrates with [Model Context Protocol](https://modelcontextprotocol.io/) servers to dynamically extend its tool set. MCP servers expose tools over a standardized JSON-RPC interface, and Kora can connect to them using two transport types: **stdio** for local servers and **SSE** for remote servers.

Once connected, tools provided by MCP servers are automatically registered alongside built-in tools and become available to the agent in all conversations.

## How MCP Works

MCP follows a client-server architecture:

```
Kora (MCP Client)           MCP Server
      │                            │
      │── initialize ──────────────▶│  Handshake & capabilities
      │◀── serverInfo ─────────────│
      │── notifications/initialized▶│
      │── tools/list ──────────────▶│  Discover available tools
      │◀── tool definitions ───────│
      │                            │
      │── tools/call { name, args }▶│  Agent invokes a tool
      │◀── result ─────────────────│
```

Communication uses JSON-RPC 2.0 messages. Kora initializes the connection with protocol version `2024-11-05`, discovers the server's tools via `tools/list`, and then calls them on demand via `tools/call`.

## Transports

### stdio (Local Servers)

The default transport. Kora spawns the MCP server as a child process and communicates over stdin/stdout. This is the standard mode for npm-distributed MCP servers.

```
Kora ──stdin──▶ MCP Server Process
        ◀─stdout──
```

- The server process runs locally on the same machine
- Environment variables and CLI arguments are passed at spawn time
- The process is automatically killed on disconnect

### SSE (Remote Servers)

For MCP servers running on remote machines or as services. Uses HTTP Server-Sent Events for server-to-client messages and HTTP POST for client-to-server requests.

```
Kora ──GET /sse──────────▶ Remote Server    (SSE stream)
        ◀─event: endpoint───                   (discover POST URL)
        ──POST /message─────▶                   (JSON-RPC requests)
        ◀─event: message────                    (JSON-RPC responses)
```

The SSE client:
1. Opens a `GET /sse` connection to the server
2. Receives an `endpoint` event containing the URL for sending messages
3. Sends JSON-RPC requests via POST to that endpoint
4. Receives responses as SSE `message` events

Environment variables configured for an SSE server are sent as HTTP headers on every request, which is useful for authentication tokens.

## Installing MCP Servers

After installation, Kora validates the server by attempting to connect and discover tools. If the connection fails, the configuration is automatically rolled back and the error is reported.

### Via the Agent (Conversational)

Ask the agent to install an MCP server and it will use the `mcp_install` tool:

> "Install the filesystem MCP server and give it access to /home/user/documents"

The agent handles the npm installation and configuration automatically.

### Via the CLI Tool

```bash
kora mcp install @modelcontextprotocol/server-filesystem -- /home/user/documents
```

### Via the Web Admin

Navigate to **Tools & MCP** in the web admin. The install form supports three modes:

- **npm Package** — Enter an npm package name (e.g. `@modelcontextprotocol/server-filesystem`) with optional arguments and environment variables.
- **Custom Command** — Provide an arbitrary executable command, arguments, and environment variables. This supports tools like `uvx`, `docker`, `python`, or any other binary — the same format used by Cursor, Claude Desktop, and similar tools.
- **Remote (SSE)** — Enter a server URL and optional environment variables for remote MCP servers.

### Installing a Custom Command Server

Custom command mode lets you install MCP servers that aren't distributed as npm packages. For example, to install a Python-based MCP server via `uvx`:

```json
{
  "command": "uvx",
  "args": ["minimax-coding-plan-mcp"],
  "env": {
    "MINIMAX_API_KEY": "your-api-key",
    "MINIMAX_MCP_BASE_PATH": "/path/to/output"
  }
}
```

In the web admin, select **Custom Command**, fill in the command (`uvx`), arguments (`minimax-coding-plan-mcp`), an optional display name, and environment variables.

### Installing a Remote SSE Server

For remote servers, specify the `sse` transport and provide the server URL:

> "Connect to my Home Assistant MCP server at http://homeassistant.local:8123/mcp_server"

Or through the `mcp_install` tool directly:

```json
{
  "source": "http://homeassistant.local:8123/mcp_server",
  "transport": "sse",
  "url": "http://homeassistant.local:8123/mcp_server"
}
```

## Configuration File

MCP server configurations are persisted in `~/.kora/tools/mcp.yml`. This file is managed automatically but can be edited manually.

```yaml
servers:
  - id: server-filesystem
    name: server-filesystem
    transport: stdio
    command: npx
    args:
      - "-y"
      - "@modelcontextprotocol/server-filesystem"
    userArgs:
      - /home/user/documents
    env: {}
    enabled: true
    source: "@modelcontextprotocol/server-filesystem"
    installedAt: "2025-01-15T10:30:00.000Z"

  - id: MiniMax
    name: MiniMax
    transport: stdio
    command: uvx
    args:
      - minimax-coding-plan-mcp
    env:
      MINIMAX_API_KEY: "your-api-key"
      MINIMAX_MCP_BASE_PATH: "/home/user/output"
    enabled: true
    source: MiniMax
    installedAt: "2025-01-15T10:45:00.000Z"

  - id: homeassistant_local_8123_mcp_server
    name: homeassistant_local_8123_mcp_server
    transport: sse
    command: ""
    args: []
    url: "http://homeassistant.local:8123/mcp_server"
    env:
      Authorization: "Bearer YOUR_HA_TOKEN"
    enabled: true
    source: "http://homeassistant.local:8123/mcp_server"
    installedAt: "2025-01-15T11:00:00.000Z"
```

### McpServerConfig Fields

| Field         | Type                     | Description                                                                                     |
| ------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| `id`          | string                   | Unique identifier, derived from the server name                                                 |
| `name`        | string                   | Display name                                                                                    |
| `transport`   | `"stdio"` \| `"sse"`     | Communication transport                                                                         |
| `command`     | string                   | Executable command (for stdio servers, e.g. `npx` or an absolute path)                          |
| `args`        | string[]                 | Base arguments passed to the command (e.g. `["-y", "@modelcontextprotocol/server-filesystem"]`) |
| `userArgs`    | string[]                 | Additional user-supplied arguments appended after `args` (e.g. allowed paths)                   |
| `url`         | string                   | Server URL (required for SSE transport)                                                         |
| `env`         | Record\<string, string\> | Environment variables passed to the process (stdio) or as HTTP headers (SSE)                    |
| `enabled`     | boolean                  | Whether the server is active; disabled servers are not connected on startup                     |
| `source`      | string                   | Original source string (npm package name or URL)                                                |
| `installedAt` | string                   | ISO 8601 timestamp of installation                                                              |

## Managing MCP Servers

### Agent Tools

The agent has six MCP management tools:

| Tool            | Description                                         |
| --------------- | --------------------------------------------------- |
| `mcp_install`   | Install and connect a new MCP server                |
| `mcp_list`      | List all installed servers, their status, and tools |
| `mcp_update`    | Update configuration (args, env, url, enabled)      |
| `mcp_remove`    | Uninstall and remove a server                       |
| `mcp_enable`    | Enable or disable a server                          |
| `mcp_reconnect` | Reconnect to a server after config changes          |

### Telegram Commands

Use `/mcp` in Telegram to view installed MCP servers and their status.

### Web Admin

The **Tools & MCP** page shows all installed servers with their connection status, tool count, and an expandable list of tools provided by each server. Each server has buttons to reconnect or remove it, plus an install form for adding new servers with three install modes (npm, custom command, SSE).

### Enable / Disable

Disabling a server disconnects it and prevents auto-connect on startup, but preserves its configuration. Re-enabling it triggers an immediate reconnect attempt.

### Reconnect

If a server connection drops or you change its configuration, use `mcp_reconnect` (or the web admin Reconnect button) to re-establish the connection without reinstalling.

## Startup Behavior

On startup, Kora:

1. Loads `mcp.yml` from the tools directory
2. Iterates over all servers where `enabled: true`
3. Connects each server using the appropriate transport
4. Logs the server name and tool count on successful connection
5. Logs an error and continues to the next server on failure

Failed connections do not prevent the system from starting. You can retry with `mcp_reconnect` later.

## Examples

### Filesystem Server

Grants the agent read/write access to specific directories:

```
Install the filesystem MCP server with access to /home/user/projects
```

This installs `@modelcontextprotocol/server-filesystem` and passes the path as an argument. The server provides tools like `read_file`, `write_file`, `list_directory`, etc.

### Home Assistant (SSE)

Connects to a Home Assistant instance's MCP endpoint:

```
Connect to Home Assistant at http://192.168.1.50:8123/mcp_server with auth token "eyJ..."
```

The agent will configure an SSE server with the `Authorization` header set from the environment variables. This exposes Home Assistant entities as tools for smart home control.

### GitHub Server

```
Install the GitHub MCP server and set GITHUB_PERSONAL_ACCESS_TOKEN to ghp_xxxxx
```

Installs `@modelcontextprotocol/server-github` with the token as an environment variable, enabling tools for repository management, issues, and pull requests.

## Troubleshooting

- **Server fails to connect** — Check that the command or URL is correct. For npm packages, verify the package is installed globally or available via `npx`. For custom commands, ensure the binary is in `PATH`. Installation now validates connectivity, so errors are reported immediately rather than silently. Use `mcp_reconnect` to retry.
- **No tools discovered** — The server connected but reported zero tools. Check the server's documentation for required arguments or environment variables.
- **SSE connection timeout** — The client waits 15 seconds for the SSE endpoint discovery. Verify the remote server is reachable and the URL includes the correct path.
- **Request timeout** — Individual tool calls time out after 30 seconds. If a tool consistently times out, the MCP server may be unresponsive.

## Related Documentation

- [Architecture](architecture.md) — How MCP fits into the overall system
- [Tools](tools.md) — Built-in tool reference
- [Configuration](configuration.md) — The `tools.mcp` setting
- [Web Admin](web-admin.md) — Managing MCP servers through the web interface
