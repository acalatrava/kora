# Web Administration Panel

Kora includes a built-in web admin dashboard for monitoring, configuration, and management. The panel is a single-page application built with [Preact](https://preactjs.com/) and connects to the agent's HTTP/WebSocket server.

The admin panel is served at the `/admin` path. In single-user mode, visiting the root URL (`/`) automatically redirects to `/admin`.

## Accessing the Web Admin

### Enable the Web Admin

The web admin is enabled by default. Configuration in `settings.yml`:

```yaml
web_admin:
  enabled: true
  port: 3100
```

### URL

Once the agent is running, access the dashboard at:

```
http://localhost:3100/admin
```

Or from another device on the same network using the machine's IP address (e.g., `http://192.168.1.50:3100/admin`).

### Authentication

The web admin requires authentication when either a token or credentials are configured. Two login methods are available:

**Username & Password:**

Set credentials via Telegram:

```
/webadmin myuser mypassword
```

The message is automatically deleted for security. Then log in at the web admin login page using those credentials.

**Access Token:**

A token is auto-generated on first start and printed to the console:

```
Web Admin: http://localhost:3100/admin?token=abc123...
```

You can paste the token in the login page's "Access Token" tab, or visit the URL directly — the token is converted to an HttpOnly session cookie and removed from the URL.

For details on the cookie-based session model, see [Security](security.md).

## Pages

### Dashboard

The home page displays a system overview with status cards:

| Card        | Description                             |
| ----------- | --------------------------------------- |
| Provider    | Active LLM provider name                |
| Model       | Current model                           |
| Channels    | Number of active communication channels |
| Tools       | Total enabled tools                     |
| MCP Servers | Connected MCP server count              |
| Scheduler   | Number of active cron jobs              |
| Heartbeat   | Active/inactive status badge            |
| Uptime      | Time since the agent started            |

Below the cards, the **Recent Sessions** table shows the 5 most recent sessions with quick links to the session detail view. The dashboard auto-refreshes every 10 seconds.

### Live Log

A real-time audit stream powered by WebSocket. Every event in the system — user messages, LLM requests and responses, tool calls, errors — appears here as it happens.

**Features:**

- **WebSocket connection** with auto-reconnect (exponential backoff)
- **Type filters** — toggle visibility of specific event types (user messages, tool calls, LLM requests, etc.)
- **Auto-scroll** — follows new entries; can be paused
- **Group by session** — collapses entries by session ID for easier reading
- **Expand/collapse** — click on entries to see full details (LLM message lists, tool arguments, result previews)
- **Clear** — flush the in-memory log buffer

The live log retains up to 500 entries in memory. Older entries are available in the Sessions view.

**Event types and their color coding:**

| Type               | Color  | Icon | Description                                   |
| ------------------ | ------ | ---- | --------------------------------------------- |
| User Message       | Yellow | 💬    | Incoming user text                            |
| Assistant Message  | Purple | 🤖    | Agent's response                              |
| LLM Request        | Blue   | 📤    | Outbound call to the LLM provider             |
| LLM Response       | Blue   | 📥    | Response from the LLM (tokens, finish reason) |
| Tool Call          | Green  | 🔧    | Agent invoking a tool                         |
| Tool Result        | Green  | 📋    | Result returned from a tool                   |
| System Prompt      | Purple | 📝    | System prompt assembly                        |
| Context Compaction | Purple | 📦    | Context window compaction event               |
| Error              | Red    | ❌    | Error at any stage                            |
| Session Start      | Blue   | ▶    | New session beginning                         |
| Session End        | Blue   | ⏹    | Session completion                            |

### Sessions

A paginated list of all recorded sessions, sorted newest first. Each row shows:

- Session ID (truncated, click to open)
- Channel (telegram, email, scheduler, heartbeat)
- Identity (the user or system that initiated)
- Start time (relative, e.g. "5m ago")
- Entry count
- Type badges (colored labels for event types present in the session)

Supports auto-refresh (every 5 seconds) and manual refresh. Pagination with 20 sessions per page.

### Session Detail

The full audit trail for a single session. This is the primary debugging and inspection tool.

**Summary bar** at the top shows:

- Channel and identity
- Start time
- Total duration
- Entry count
- Tool call count
- Error count (if any)

**Timeline** displays every event in chronological order (toggleable newest-first or oldest-first). Each entry can be expanded to reveal:

- **LLM Request**: model, message count, tool count, iteration number. Expandable sections for the full message list and tool definitions.
- **LLM Response**: finish reason, token usage (prompt/completion/total), content preview. Tool call names if the response triggered tools.
- **Tool Call**: tool name and full JSON arguments (expandable).
- **Tool Result**: tool name, success/error status, result preview (expandable, auto-formatted JSON).
- **Context Compaction**: before/after token counts, messages removed, context limit.
- **Session End**: total duration, iteration count, total tool calls.

Auto-refresh runs every 3 seconds for active sessions (sessions without a `session_end` entry).

### Tasks

Full management interface for scheduled tasks. See [Tasks](tasks.md) for the complete task system documentation.

**Task list** displays each task as a card with:

- Name and UUID
- Cron expression
- Active/paused status badge
- Last run time (relative)
- Creation date
- Full prompt text

**Actions per task:**

| Button             | Action                      |
| ------------------ | --------------------------- |
| ⏸ Pause / ▶ Resume | Toggle task enabled state   |
| 🚀 Run              | Trigger immediate execution |
| ✏ Edit             | Open the edit form          |
| 🗑 Delete           | Delete with confirmation    |

**Create/Edit form:**

- Task name (required)
- Cron expression (required)
- Prompt text (required)
- Enabled checkbox (edit mode only)

### Chat History

Browse raw conversation histories by session key. Shows the user-assistant message exchange in a chat bubble layout.

- **Session selector** — buttons for each conversation key
- **Message bubbles** — styled differently for user (right-aligned), assistant (left-aligned), and tool messages
- Useful for reviewing what the agent said versus what was logged in the audit trail

### Config Editor

Edit runtime configuration files directly in the browser. Changes are saved to disk and take effect according to each file's reload behavior.

**Tabs:**

| Tab       | File            | Format   | Description                                               |
| --------- | --------------- | -------- | --------------------------------------------------------- |
| Settings  | `settings.yml`  | JSON     | General runtime settings                                  |
| Agent     | `AGENT.md`      | Markdown | Agent personality and system prompt                       |
| Heartbeat | `HEARTBEAT.md`  | Markdown | Heartbeat prompt template                                 |
| Providers | `providers.yml` | YAML     | LLM provider configurations (secrets redacted in display) |
| Channels  | `channels.yml`  | YAML     | Channel configurations (secrets redacted in display)      |

Each tab provides a code editor textarea with Reload and Save buttons. A toast notification confirms saves or reports errors.

The **KYU Profile** tab shows the automatically generated user profile. This file is maintained by the `kyu_agent` internal agent after each conversation. See [KYU (Know Your User)](kyu.md) for full documentation.

**Note:** Provider and channel configuration files are displayed with secrets partially redacted (first 4 characters visible). Saving overwrites the file with the editor contents, so be careful with redacted values.

### Tools & MCP

Split view showing built-in tools and MCP server integrations.

**Left panel — Enabled Tools:**

A list of all currently enabled tools with their names and enabled/disabled badges.

**Right panel — MCP Servers:**

Each installed MCP server is shown as a card with:

- Server name and source
- Transport badge (stdio / sse)
- Tool count badge showing how many tools the server provides
- Connection status (connected / disconnected / off)
- User arguments (if any)
- Expandable tool list showing all tool names provided by the server
- **Reconnect** button — re-establish the connection
- **Remove** button — uninstall the server

**Install form** at the bottom with three modes:

- **npm Package** — Package name input, optional arguments, and environment variables
- **Custom Command** — Command input (e.g. `uvx`, `docker`), arguments, optional display name, and environment variables. Supports the same format used by Cursor and Claude Desktop.
- **Remote (SSE)** — URL input and environment variables

Installation validates that the server connects successfully before saving the configuration. If the connection fails, the config is rolled back and an error is displayed.

## Mobile-Responsive Design

The web admin is fully responsive:

- **Desktop** — Sidebar navigation on the left, main content area on the right
- **Mobile** — Sidebar collapses into a hamburger menu; a **bottom navigation bar** appears with quick links:

| Icon | Label    | Page            |
| ---- | -------- | --------------- |
| ◉    | Home     | Dashboard       |
| ⚡    | Live     | Live Log        |
| ☰    | Sessions | Sessions list   |
| 📅    | Tasks    | Scheduled tasks |
| 🔧    | Tools    | Tools & MCP     |

The bottom nav is always visible on mobile for quick page switching.

## Real-Time Features

### WebSocket Live Log

The live log page connects via WebSocket to receive audit entries in real time:

```
ws://localhost:3100/admin/ws?token=<AUTH_TOKEN>
```

or without a token (uses the `korabot_session` cookie automatically):

```
ws://localhost:3100/admin/ws
```

The WebSocket connection:

- Authenticates via `?token=` parameter or the `korabot_session` cookie
- Receives JSON messages of type `{ type: "audit_entry", data: { ... } }`
- Auto-reconnects with exponential backoff (1s → 2s → 4s → ... → 30s max)

### Auto-Refresh

Several pages poll the REST API at regular intervals:

| Page           | Interval   | Toggleable                     |
| -------------- | ---------- | ------------------------------ |
| Dashboard      | 10 seconds | No                             |
| Sessions       | 5 seconds  | Yes (⏸ Pause / ▶ Auto-refresh) |
| Session Detail | 3 seconds  | Yes (⏸ Pause / ▶ Auto-refresh) |

## REST API Reference

All admin API endpoints are served under `/admin/api/`. Authentication is required (cookie, bearer token, or query parameter). Responses are JSON.

### System

| Method | Endpoint                | Description                    |
| ------ | ----------------------- | ------------------------------ |
| `GET`  | `/admin/api/status`     | System status                  |
| `GET`  | `/admin/api/auth/check` | Check authentication status    |
| `POST` | `/admin/api/login`      | JSON login (username/password) |
| `POST` | `/admin/api/logout`     | Clear session                  |

### Sessions

| Method | Endpoint                             | Description               |
| ------ | ------------------------------------ | ------------------------- |
| `GET`  | `/admin/api/sessions?limit=&offset=` | List sessions (paginated) |
| `GET`  | `/admin/api/sessions/:id`            | Get session entries       |

### Configuration

| Method | Endpoint                      | Description                   |
| ------ | ----------------------------- | ----------------------------- |
| `GET`  | `/admin/api/config/settings`  | Read settings                 |
| `PUT`  | `/admin/api/config/settings`  | Write settings                |
| `GET`  | `/admin/api/config/agent`     | Read AGENT.md                 |
| `PUT`  | `/admin/api/config/agent`     | Write AGENT.md                |
| `GET`  | `/admin/api/config/heartbeat` | Read HEARTBEAT.md             |
| `PUT`  | `/admin/api/config/heartbeat` | Write HEARTBEAT.md            |
| `GET`  | `/admin/api/config/providers` | Read providers.yml (redacted) |
| `PUT`  | `/admin/api/config/providers` | Write providers.yml           |
| `GET`  | `/admin/api/config/channels`  | Read channels.yml (redacted)  |
| `PUT`  | `/admin/api/config/channels`  | Write channels.yml            |

### Tools & MCP

| Method   | Endpoint                       | Description                |
| -------- | ------------------------------ | -------------------------- |
| `GET`    | `/admin/api/tools`             | List enabled tools         |
| `GET`    | `/admin/api/mcp/servers`       | List MCP servers           |
| `GET`    | `/admin/api/mcp/:id`           | Get MCP server details     |
| `POST`   | `/admin/api/mcp/install`       | Install an MCP server      |
| `PUT`    | `/admin/api/mcp/:id`           | Update MCP server config   |
| `DELETE` | `/admin/api/mcp/:id`           | Remove an MCP server       |
| `POST`   | `/admin/api/mcp/:id/reconnect` | Reconnect to an MCP server |

### Tasks

| Method   | Endpoint                   | Description            |
| -------- | -------------------------- | ---------------------- |
| `GET`    | `/admin/api/tasks`         | List all tasks         |
| `POST`   | `/admin/api/tasks`         | Create a task          |
| `GET`    | `/admin/api/tasks/:id`     | Get task with logs     |
| `PUT`    | `/admin/api/tasks/:id`     | Update a task          |
| `DELETE` | `/admin/api/tasks/:id`     | Delete a task          |
| `POST`   | `/admin/api/tasks/:id/run` | Run a task immediately |

### Chat History

| Method | Endpoint                  | Description            |
| ------ | ------------------------- | ---------------------- |
| `GET`  | `/admin/api/history`      | List conversation keys |
| `GET`  | `/admin/api/history/:key` | Get messages for a key |

## Related Documentation

- [User Portal](user-portal.md) — Self-service portal for multi-user mode
- [Security](security.md) — Authentication model and session cookies
- [Tasks](tasks.md) — Scheduled task system details
- [MCP](mcp.md) — MCP server management
- [Configuration](configuration.md) — Configuration file reference
