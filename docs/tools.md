# Built-in Tools Reference

Kora ships with a comprehensive set of built-in tools organized by category. Tools are enabled or disabled in [settings.yml](configuration.md) and made available to the LLM during each conversation.

## Dynamic Tool Discovery

When the total number of available tools exceeds 15 (the default threshold), Kora activates the **ToolCatalog** system to avoid overwhelming the LLM context window. In this mode:

1. Only **core tools** are loaded by default (memory, settings, agent prompt, MCP management, and `find_tools`)
2. The agent uses `find_tools` to search the catalog by keyword or category
3. Matching tools are **activated for the session** and become available for the LLM to call
4. Activated tools persist for the duration of the conversation

This allows Kora to scale to dozens or hundreds of tools (especially with MCP servers) without degrading LLM performance.

### find_tools

Search the tool catalog to discover available tools.

| Parameter  | Type   | Required | Description                                                                                                                                |
| ---------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `query`    | string | Yes      | Search keyword (e.g., "file", "browser", "schedule", "email")                                                                              |
| `category` | string | No       | Filter by category: `scheduler`, `browser`, `search`, `shell`, `email`, `mcp`, `memory`, `settings`, `home_assistant`, `subagent`, `other` |

```json
{ "query": "screenshot", "category": "browser" }
```

Returns matching tool names, descriptions, and categories. After discovery, the agent can call any returned tool directly.

---

## Memory & Settings

These tools are always loaded (core tools) regardless of the ToolCatalog threshold.

### memory_read

Read the current long-term memory entries. Memory is also injected into every prompt automatically, so this is rarely needed.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| *(none)*  | —    | —        | —           |

### memory_write

Replace the entire long-term memory with new content. Use for bulk reorganization.

| Parameter | Type   | Required | Description                                  |
| --------- | ------ | -------- | -------------------------------------------- |
| `content` | string | Yes      | Full replacement content in MEMORY.md format |

```json
{ "content": "## [mem-abc123] 2026-03-08T10:00:00Z\nUser prefers dark mode.\n" }
```

### memory_append

Add a new entry to long-term memory. Each entry gets a unique ID and timestamp automatically.

| Parameter | Type   | Required | Description                      |
| --------- | ------ | -------- | -------------------------------- |
| `entry`   | string | Yes      | The memory entry content to save |

```json
{ "entry": "User's project uses TypeScript with Node.js 22" }
```

### memory_remove

Remove a specific memory entry by its ID.

| Parameter  | Type   | Required | Description                                                 |
| ---------- | ------ | -------- | ----------------------------------------------------------- |
| `entry_id` | string | Yes      | Entry ID to remove (e.g., `a1b2c3d4` from `[mem-a1b2c3d4]`) |

```json
{ "entry_id": "a1b2c3d4" }
```

### memory_list

List all memory entries with their IDs, timestamps, and content previews.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| *(none)*  | —    | —        | —           |

### settings_read

Read the current Kora settings. Returns the full configuration (excluding `storagePath`).

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| *(none)*  | —    | —        | —           |

### settings_update

Update one or more Kora settings. Supports nested keys.

| Parameter | Type   | Required | Description               |
| --------- | ------ | -------- | ------------------------- |
| `updates` | object | Yes      | Key-value pairs to update |

```json
{ "updates": { "defaultModel": "gpt-4o-mini", "heartbeat": { "intervalMinutes": 10 } } }
```

Restricted keys (`storagePath`, `logLevel`, `tools.shell`) cannot be changed by the agent.

### agent_prompt_read

Read the current AGENT.md system prompt.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| *(none)*  | —    | —        | —           |

### agent_prompt_write

Update the AGENT.md system prompt.

| Parameter | Type   | Required | Description                             |
| --------- | ------ | -------- | --------------------------------------- |
| `content` | string | Yes      | New AGENT.md content in markdown format |

### identity_read

Read the current IDENTITY.md that defines the agent's personality and motivations. See [Identity](identity.md) for details.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| *(none)*  | —    | —        | —           |

### agent_evolve

Evolve the agent's identity by updating IDENTITY.md. Each evolution is logged with a timestamp and reason. Can be disabled per workspace.

| Parameter | Type   | Required | Description                                     |
| --------- | ------ | -------- | ----------------------------------------------- |
| `content` | string | Yes      | Updated IDENTITY.md content in markdown format  |
| `reason`  | string | Yes      | Brief explanation of what triggered this change |

---

## Scheduler

Enabled by default (`tools.scheduler: true`). Manages cron-based scheduled tasks.

### scheduler_create

Create a new scheduled task with a cron expression.

| Parameter         | Type   | Required | Description                                           |
| ----------------- | ------ | -------- | ----------------------------------------------------- |
| `name`            | string | Yes      | Human-readable task name                              |
| `cron_expression` | string | Yes      | Cron expression (e.g., `0 9 * * *` for daily at 9 AM) |
| `prompt`          | string | Yes      | The instruction the agent will execute on each run    |

```json
{ "name": "Morning briefing", "cron_expression": "0 9 * * 1-5", "prompt": "Check weather and top news, send me a morning briefing" }
```

### scheduler_list

List all scheduled tasks in the current workspace.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| *(none)*  | —    | —        | —           |

### scheduler_pause

Pause a scheduled task so it stops running.

| Parameter | Type   | Required | Description             |
| --------- | ------ | -------- | ----------------------- |
| `task_id` | string | Yes      | ID of the task to pause |

### scheduler_resume

Resume a previously paused task.

| Parameter | Type   | Required | Description              |
| --------- | ------ | -------- | ------------------------ |
| `task_id` | string | Yes      | ID of the task to resume |

### scheduler_run_now

Trigger immediate execution of a task, regardless of its schedule.

| Parameter | Type   | Required | Description           |
| --------- | ------ | -------- | --------------------- |
| `task_id` | string | Yes      | ID of the task to run |

### scheduler_delete

Permanently delete a scheduled task.

| Parameter | Type   | Required | Description              |
| --------- | ------ | -------- | ------------------------ |
| `task_id` | string | Yes      | ID of the task to delete |

---

## Shell

Disabled by default for security (`tools.shell: false`). Must be enabled manually — the agent cannot enable it.

### shell_exec

Execute a shell command and return stdout, stderr, and exit code.

| Parameter           | Type   | Required | Description                                         |
| ------------------- | ------ | -------- | --------------------------------------------------- |
| `command`           | string | Yes      | Shell command to execute                            |
| `working_directory` | string | No       | Working directory for the command                   |
| `timeout_ms`        | number | No       | Timeout in milliseconds (default 30000, max 300000) |

```json
{ "command": "ls -la /tmp", "timeout_ms": 10000 }
```

Security measures:
- Sensitive environment variables (`*_API_KEY`, `*_SECRET`, `*_TOKEN`) are stripped from the process environment before execution
- Output is truncated at 50,000 characters
- The [ToolApprovalManager](architecture.md) can require user approval before execution
- Dangerous commands (e.g., `rm -rf /`) are blocked outright
- When sandbox is active, commands run in an isolated container with only the workspace work directory mounted as read-write
- The agent is informed of the exact workspace path, accessible mounts, and network restrictions via the system prompt

---

## File Operations

Enabled by default (`tools.files: true`). Provides sandbox-aware file manipulation without requiring `shell_exec`. When a sandbox is active, all file operations run inside the sandbox with the same mount and access restrictions. When no sandbox is active, operations are constrained by allowed paths (if configured).

### file_list

List the contents of a directory with names, types, and sizes.

| Parameter | Type   | Required | Description            |
| --------- | ------ | -------- | ---------------------- |
| `path`    | string | Yes      | Directory path to list |

```json
{ "path": "/workspace/data" }
```

### file_info

Get file metadata: line count and size in bytes.

| Parameter | Type   | Required | Description      |
| --------- | ------ | -------- | ---------------- |
| `path`    | string | Yes      | Path to the file |

### file_write_text

Create a new text file. Parent directories are created automatically.

| Parameter | Type   | Required | Description           |
| --------- | ------ | -------- | --------------------- |
| `path`    | string | Yes      | Path for the new file |
| `content` | string | Yes      | Text content to write |

```json
{ "path": "/workspace/notes.md", "content": "# My Notes\n\nHello world" }
```

### file_read_text

Read text content from a file with optional line-range support.

| Parameter | Type   | Required | Description                                      |
| --------- | ------ | -------- | ------------------------------------------------ |
| `path`    | string | Yes      | Path to the file                                 |
| `skip`    | number | No       | Lines to skip from the beginning (default: 0)    |
| `read`    | number | No       | Number of lines to read (default: all remaining) |

```json
{ "path": "/workspace/data.csv", "skip": 0, "read": 20 }
```

### file_edit

Edit a text file by inserting, replacing, or deleting lines at a specific position.

| Parameter | Type   | Required | Description                                            |
| --------- | ------ | -------- | ------------------------------------------------------ |
| `path`    | string | Yes      | Path to the file                                       |
| `skip`    | number | Yes      | Line number (0-based) where the edit starts            |
| `content` | string | No       | New content to insert at the position                  |
| `delete`  | number | No       | Number of lines to delete at the position (default: 0) |

To **insert** lines at position 5:
```json
{ "path": "/workspace/app.js", "skip": 5, "content": "const x = 42;\nconst y = 100;" }
```

To **replace** 3 lines starting at position 10:
```json
{ "path": "/workspace/app.js", "skip": 10, "delete": 3, "content": "const newCode = true;" }
```

To **delete** 2 lines at position 7:
```json
{ "path": "/workspace/app.js", "skip": 7, "delete": 2 }
```

### file_delete

Delete a file.

| Parameter | Type   | Required | Description                |
| --------- | ------ | -------- | -------------------------- |
| `path`    | string | Yes      | Path to the file to delete |

These tools are preferred over `shell_exec` for file operations because they are faster, produce structured output, and respect sandbox restrictions natively.

---

## Browser

Enabled by default (`tools.browser: true`). Uses headless Playwright/Chromium. The browser is automatically managed by Playwright.

### browser_navigate

Navigate to a URL. Returns the page title, final URL, and a simplified DOM snapshot with interactive elements.

| Parameter  | Type   | Required | Description                               |
| ---------- | ------ | -------- | ----------------------------------------- |
| `url`      | string | Yes      | URL to navigate to                        |
| `wait_for` | string | No       | CSS selector to wait for before returning |

```json
{ "url": "https://example.com", "wait_for": "#main-content" }
```

### browser_get_dom

Get a simplified DOM snapshot of the current page showing interactive elements (links, buttons, inputs, forms). Each element has a unique `[ref=N]` attribute for use with `browser_click` or `browser_fill`.

| Parameter  | Type   | Required | Description                              |
| ---------- | ------ | -------- | ---------------------------------------- |
| `selector` | string | No       | CSS selector to scope the DOM extraction |

### browser_screenshot

Take a screenshot of the current page or a specific element.

| Parameter  | Type   | Required | Description                                      |
| ---------- | ------ | -------- | ------------------------------------------------ |
| `url`      | string | No       | URL to navigate to before taking the screenshot  |
| `selector` | string | No       | CSS selector to capture instead of the full page |

### browser_extract_text

Extract visible text content from the current page or a URL.

| Parameter  | Type   | Required | Description                           |
| ---------- | ------ | -------- | ------------------------------------- |
| `url`      | string | No       | URL to navigate to first              |
| `selector` | string | No       | CSS selector to limit text extraction |

Text output is truncated at 10,000 characters.

### browser_click

Click an element on the current page.

| Parameter  | Type   | Required | Description                                      |
| ---------- | ------ | -------- | ------------------------------------------------ |
| `selector` | string | Yes      | CSS selector or `[ref=N]` from `browser_get_dom` |

### browser_fill

Type text into an input or textarea. Clears existing content first.

| Parameter  | Type   | Required | Description                       |
| ---------- | ------ | -------- | --------------------------------- |
| `selector` | string | Yes      | CSS selector of the input element |
| `value`    | string | Yes      | Value to type into the field      |

### browser_select

Select an option from a `<select>` dropdown.

| Parameter  | Type   | Required | Description                        |
| ---------- | ------ | -------- | ---------------------------------- |
| `selector` | string | Yes      | CSS selector of the select element |
| `value`    | string | Yes      | Value of the option to select      |

### browser_evaluate

Execute JavaScript in the page context and return the result.

| Parameter    | Type   | Required | Description                       |
| ------------ | ------ | -------- | --------------------------------- |
| `expression` | string | Yes      | JavaScript expression to evaluate |

### browser_wait

Wait for a CSS selector to appear or for a fixed delay.

| Parameter    | Type   | Required | Description                         |
| ------------ | ------ | -------- | ----------------------------------- |
| `selector`   | string | No       | CSS selector to wait for            |
| `timeout_ms` | number | No       | Max wait time in ms (default 10000) |

Browser security: URLs with `file:`, `javascript:`, `data:` schemes are blocked. Localhost and private IP ranges are blocked (SSRF protection). The browser auto-closes after 5 minutes of inactivity.

---

## Web Search

Disabled by default (`tools.web_search: false`). Requires a Brave Search API key.

### web_search

Search the web and return results with title, URL, and description.

| Parameter | Type   | Required | Description                           |
| --------- | ------ | -------- | ------------------------------------- |
| `query`   | string | Yes      | Search query                          |
| `count`   | number | No       | Number of results (default 5, max 20) |

```json
{ "query": "TypeScript 5.5 new features", "count": 10 }
```

---

## Email

Disabled by default (`tools.mail: false`). Auto-enabled when an email channel is configured. The available mail tools depend on the operating mode (single-user vs. multi-user).

### mail_send

Send an email via the bot's configured email channel.

**Single-user mode:** The agent can send to any recipient.

| Parameter | Type   | Required | Description              |
| --------- | ------ | -------- | ------------------------ |
| `to`      | string | Yes      | Recipient email address  |
| `subject` | string | Yes      | Email subject line       |
| `text`    | string | Yes      | Plain text email body    |
| `html`    | string | No       | Optional HTML email body |

```json
{ "to": "user@example.com", "subject": "Daily Report", "text": "Here is your report..." }
```

**Multi-user mode:** The `to` parameter is removed. The recipient is automatically set to the current user's registered email address. The agent can only send emails to the workspace owner.

| Parameter | Type   | Required | Description              |
| --------- | ------ | -------- | ------------------------ |
| `subject` | string | Yes      | Email subject line       |
| `body`    | string | Yes      | Plain text email body    |
| `html`    | string | No       | Optional HTML email body |

### mail_list

**Single-user mode only.** List emails from the bot's own inbox with pagination.

| Parameter  | Type   | Required | Description                  |
| ---------- | ------ | -------- | ---------------------------- |
| `page`     | number | No       | Page number (default 1)      |
| `pageSize` | number | No       | Emails per page (default 10) |

```json
{ "page": 1, "pageSize": 20 }
```

Returns a list of email metadata objects (ID, from, subject, date, snippet) along with the total count, current page, and page size.

### mail_read

**Single-user mode only.** Read the full content of a specific email by its ID.

| Parameter | Type   | Required | Description                          |
| --------- | ------ | -------- | ------------------------------------ |
| `id`      | string | Yes      | Email ID (obtained from `mail_list`) |

```json
{ "id": "42" }
```

Returns the full email including body, headers (from, to, cc), subject, and date.

### Multi-User Restrictions

In multi-user mode, the agent's inbox tools (`mail_list`, `mail_read`) are not available. This prevents the agent from reading emails addressed to its own account, which in a multi-tenant setup could contain messages from multiple users.

The `mail_send` tool is restricted to only send emails to the current workspace owner's registered email address. The `to` parameter is not exposed to the LLM.

---

## MCP Management

Enabled by default (`tools.mcp: true`). Manages Model Context Protocol tool servers.

### mcp_install

Install a new MCP tool server. Supports two transports:

| Parameter   | Type     | Required | Description                          |
| ----------- | -------- | -------- | ------------------------------------ |
| `source`    | string   | Yes      | npm package name, local path, or URL |
| `args`      | string[] | No       | CLI arguments for the server process |
| `env`       | object   | No       | Environment variables for the server |
| `transport` | string   | No       | `stdio` (default) or `sse`           |
| `url`       | string   | No       | URL for SSE transport                |

**stdio example** (npm package):
```json
{ "source": "@modelcontextprotocol/server-filesystem", "args": ["/home/user/documents"] }
```

**SSE example** (remote server):
```json
{ "source": "homeassistant", "transport": "sse", "url": "http://homeassistant.local:8123/mcp" }
```

### mcp_list

List all installed MCP servers with their transport, status, and available tools.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| *(none)*  | —    | —        | —           |

### mcp_remove

Remove an installed MCP server by its ID.

| Parameter   | Type   | Required | Description          |
| ----------- | ------ | -------- | -------------------- |
| `server_id` | string | Yes      | ID of the MCP server |

### mcp_update

Update configuration of an existing MCP server.

| Parameter   | Type     | Required | Description               |
| ----------- | -------- | -------- | ------------------------- |
| `server_id` | string   | Yes      | ID of the MCP server      |
| `args`      | string[] | No       | New CLI arguments         |
| `env`       | object   | No       | New environment variables |
| `url`       | string   | No       | New URL (for SSE servers) |
| `enabled`   | boolean  | No       | Enable or disable         |

### mcp_enable

Enable or disable an MCP server.

| Parameter   | Type    | Required | Description                          |
| ----------- | ------- | -------- | ------------------------------------ |
| `server_id` | string  | Yes      | ID of the MCP server                 |
| `enabled`   | boolean | Yes      | `true` to enable, `false` to disable |

### mcp_reconnect

Reconnect to an MCP server (useful after configuration changes).

| Parameter   | Type   | Required | Description          |
| ----------- | ------ | -------- | -------------------- |
| `server_id` | string | Yes      | ID of the MCP server |

---

## Communication

### notify

Send a message to the user. This is the **only** way to communicate with the user.

| Parameter        | Type    | Required | Description                                                                 |
| ---------------- | ------- | -------- | --------------------------------------------------------------------------- |
| `message`        | string  | Yes      | The message to deliver. Supports markdown formatting.                       |
| `reply_expected` | boolean | No       | If true, pause and wait for the user to reply (up to 5 min). Default: false |

When `reply_expected` is `true`, the agent pauses and waits for the user's reply. If the user responds within 5 minutes, the reply is injected into the conversation and the agent continues. If no reply arrives, the agent receives a timeout signal and continues on its own.

### finish

Signal that the current task is complete.

| Parameter | Type   | Required | Description                                            |
| --------- | ------ | -------- | ------------------------------------------------------ |
| `summary` | string | Yes      | Brief summary of what was accomplished in this session |

### continue_execution

Signal that the agent needs another turn to complete the task.

---

## Sub-Agents

Enabled by default. Allows the main agent to spawn specialized child agents. See [Sub-Agents](sub-agents.md) for the full guide.

### subagent_create

Create a new sub-agent. Does **not** execute anything — use `subagent_dispatch` to assign tasks.

| Parameter       | Type   | Required | Description                                                     |
| --------------- | ------ | -------- | --------------------------------------------------------------- |
| `name`          | string | Yes      | Short name for the sub-agent                                    |
| `description`   | string | Yes      | What this sub-agent specializes in                              |
| `system_prompt` | string | Yes      | System prompt defining behavior                                 |
| `model`         | string | No       | Model ID to use (see Available Models section in system prompt) |

```json
{
  "name": "researcher",
  "description": "Specializes in web research and data gathering",
  "system_prompt": "You are a research assistant. Search the web thoroughly and compile findings.",
  "model": "gpt-4o-mini"
}
```

### subagent_dispatch

Dispatch one or more tasks to sub-agents for parallel execution. All tasks run concurrently. Reports accurate `completed` or `failed` status for each task.

| Parameter | Type  | Required | Description                                   |
| --------- | ----- | -------- | --------------------------------------------- |
| `tasks`   | array | Yes      | Array of `{ agent_id: string, task: string }` |

### subagent_list

List all sub-agents and their status.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| *(none)*  | —    | —        | —           |

### subagent_remove

Remove a sub-agent by ID.

| Parameter  | Type   | Required | Description                   |
| ---------- | ------ | -------- | ----------------------------- |
| `agent_id` | string | Yes      | ID of the sub-agent to remove |

---

## Home Assistant (REST API)

Disabled by default (`tools.homeassistant_mqtt: false`). Requires a Home Assistant instance URL and a Long-Lived Access Token.

The Home Assistant tool uses the HA REST API for on-demand queries and service calls. For real-time events from HA automations or IoT devices, use the [MQTT Channel](channels.md#mqtt) instead.

### ha_get_states

Query entity states from Home Assistant. Returns full state with attributes. Omit `entity_id` to list all entities.

| Parameter   | Type   | Required | Description                                          |
| ----------- | ------ | -------- | ---------------------------------------------------- |
| `entity_id` | string | No       | Entity ID (e.g., `light.living_room`). Omit for all. |

```json
{ "entity_id": "sensor.temperature_living_room" }
```

Returns entity state, attributes, and last changed timestamp.

### ha_call_service

Call any Home Assistant service (turn on/off, toggle, set temperature, etc.).

| Parameter      | Type   | Required | Description                                                            |
| -------------- | ------ | -------- | ---------------------------------------------------------------------- |
| `domain`       | string | Yes      | Service domain (e.g., `light`, `switch`, `climate`, `automation`)      |
| `service`      | string | Yes      | Service name (e.g., `turn_on`, `turn_off`, `toggle`)                   |
| `service_data` | object | No       | Payload with `entity_id` and optional parameters like brightness, etc. |

```json
{ "domain": "light", "service": "turn_on", "service_data": { "entity_id": "light.living_room", "brightness": 200 } }
```

### ha_list_services

Discover available services per domain. Useful for finding out what actions are supported.

| Parameter | Type   | Required | Description                                         |
| --------- | ------ | -------- | --------------------------------------------------- |
| `domain`  | string | No       | Filter by domain (e.g., `light`). Omit to list all. |

### Configuration

In the web admin panel under Tools > Home Assistant, configure:

| Field      | Description                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `ha_url`   | Your Home Assistant instance URL (e.g., `http://homeassistant.local:8123`)                      |
| `ha_token` | A Long-Lived Access Token. Generate one in HA at Profile > Security > Long-Lived Access Tokens. |

Or via `settings.yml`:

```yaml
tools:
  homeassistant_mqtt: true
  ha_url: "http://homeassistant.local:8123"
  ha_token: "eyJhbGciOiJIUzI1NiIs..."
```

---

## Web Fetch

Always available. Fetches and extracts readable content from web pages.

### web_fetch

Fetch a URL and return a simplified text extraction of the page content.

| Parameter | Type   | Required | Description  |
| --------- | ------ | -------- | ------------ |
| `url`     | string | Yes      | URL to fetch |

```json
{ "url": "https://example.com/article" }
```

Returns the page title and extracted text content, useful for reading articles, documentation, or any web page without needing a full browser session.

---

## Skills

Always available. Manage instruction-based skill plugins.

### skill_list

List all installed skills (global and workspace-scoped).

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| *(none)*  | —    | —        | —           |

### skill_read

Read the full content of a skill's SKILL.md file.

| Parameter | Type   | Required | Description |
| --------- | ------ | -------- | ----------- |
| `name`    | string | Yes      | Skill name  |

### skill_create

Install a skill by creating the SKILL.md file.

| Parameter | Type   | Required | Description              |
| --------- | ------ | -------- | ------------------------ |
| `name`    | string | Yes      | Name of the skill        |
| `content` | string | Yes      | Content of SKILL.md file |

### skill_update

Update or create new files to a skill

| Parameter  | Type   | Required | Description                |
| ---------- | ------ | -------- | -------------------------- |
| `name`     | string | Yes      | Name of the skill          |
| `fileName` | string | Yes      | Name of the file to update |
| `content`  | string | Yes      | Content of file            |

### skill_remove

Remove an installed skill by name.

| Parameter | Type   | Required | Description          |
| --------- | ------ | -------- | -------------------- |
| `name`    | string | Yes      | Skill name to remove |

---

## Speech

Available when voice messages are received.

### speech_transcribe

Transcribe an audio file to text using Whisper.

| Parameter   | Type   | Required | Description            |
| ----------- | ------ | -------- | ---------------------- |
| `file_path` | string | Yes      | Path to the audio file |

---

## Document Knowledge Base (RAG)

Kora automatically vectorizes documents sent by users (via Telegram, email, or other channels) and stores them in a per-workspace vector database. This enables Retrieval-Augmented Generation (RAG), where the agent can draw on previously sent documents to provide informed, context-aware responses.

### How It Works

1. **Document ingestion** — When a user sends a document, Kora parses it (see supported formats below), splits the text into chunks, and generates embeddings for each chunk.

2. **Vector storage** — Embeddings are stored in a SQLite-backed vector database at `~/.kora/workspaces/{workspace-id}/vector.db`. Each workspace has its own isolated database.

3. **Automatic context injection** — On every user message, Kora performs a semantic search of the vector database using the message content as a query. The top 5 most relevant document excerpts are automatically injected into the system prompt under "Relevant Documents."

4. **Explicit search** — The agent can also use `knowledge_search` to perform targeted searches with custom queries and higher result counts (up to 20). This is useful when the auto-injected context is not sufficient.

### Supported File Types

| Format         | Extension(s)                                                                                    | Parser               | Notes                                                       |
| -------------- | ----------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------- |
| **Plain text** | `.txt`, `.md`, `.log`, `.csv`                                                                   | Direct read          | Any UTF-8 text file                                         |
| **Code**       | `.js`, `.ts`, `.py`, `.rb`, `.go`, `.java`, `.c`, `.cpp`, `.rs`, `.php`, `.swift`, `.kt`, `.sh` | Direct read          | Source code files                                           |
| **Config**     | `.json`, `.yml`, `.yaml`, `.xml`, `.toml`, `.ini`, `.cfg`, `.env`, `.conf`                      | Direct read          | Configuration files                                         |
| **PDF**        | `.pdf`                                                                                          | `pdf-parse`          | Extracts text from all pages                                |
| **Word**       | `.docx`                                                                                         | `mammoth`            | Extracts raw text from OOXML documents                      |
| **Images**     | `.jpg`, `.png`, `.gif`, `.bmp`, `.tiff`, `.webp`                                                | `tesseract.js` (OCR) | Extracts text from images via optical character recognition |
| **HTML/CSS**   | `.html`, `.css`, `.sql`                                                                         | Direct read          | Markup and query languages                                  |

### knowledge_search

Search the document knowledge base with a custom query.

| Parameter | Type   | Required | Description                              |
| --------- | ------ | -------- | ---------------------------------------- |
| `query`   | string | Yes      | Describe what you are looking for        |
| `top_k`   | number | No       | Number of results (default: 10, max: 20) |

```json
{ "query": "project deployment instructions", "top_k": 5 }
```

Returns matching document excerpts with relevance scores, file names, parse methods, and dates.

### knowledge_list

List all documents in the knowledge base.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| *(none)*  | —    | —        | —           |

Returns a summary of all stored documents grouped by file name, showing the parse method, chunk count, and date.

### Embedding Providers

By default, Kora uses a built-in hash-based embedding provider (`SimpleEmbeddingProvider`) that generates 384-dimensional vectors locally without external API calls. For higher-quality retrieval, you can configure the `OpenAIEmbeddingProvider` which uses OpenAI's `text-embedding-3-small` model.

### Size Limits

- Documents larger than 1 MB are skipped to avoid excessive memory usage
- Documents are chunked into ~1000-character segments for granular retrieval
- Automatic context injection returns the top 5 results (score >= 0.3)
- Explicit `knowledge_search` returns up to 20 results (score >= 0.2)
- Each workspace has its own isolated vector database

---

## Related Documentation

- [Architecture](architecture.md) — How the Dispatcher routes tool calls
- [Configuration](configuration.md) — Enable/disable tools in settings.yml
- [Getting Started](getting-started.md) — Initial tool configuration in the setup wizard
- [User Portal](user-portal.md) — Mail tool behavior in multi-user mode
