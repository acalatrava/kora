# Architecture

Kora is an autonomous AI agent runtime built around a central dispatch loop. Incoming events from any channel (Telegram, Email, Scheduled Tasks, Heartbeat) are routed through a single **Dispatcher** that orchestrates LLM calls, tool execution, sub-agent delegation, and response delivery.

## High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                          CLI (kora)                             │
│         setup · start · doctor · reset-admin · service          │
└────────────────────────────┬────────────────────────────────────┘
                             │ runStart()
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Runtime Core                             │
│                                                                 │
│  ┌───────────┐   ┌──────────┐   ┌───────────┐   ┌───────────┐   │
│  │ Telegram  │   │  Email   │   │ Scheduler │   │ Heartbeat │   │
│  │ Channel   │   │ Channel  │   │  (Cron)   │   │  (Timer)  │   │
│  └─────┬─────┘   └─────┬────┘   └─────┬─────┘   └─────┬─────┘   │
│        │               │              │               │         │
│        └───────┬───────┴──────┬───────┘               │         │
│                ▼              │                       │         │
│          ┌──────────┐         │                       │         │
│          │  Router   │◄───────┘───────────────────────┘         │
│          └─────┬─────┘                                          │
│                ▼                                                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                     Dispatcher                           │   │
│  │                                                          │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐  │   │
│  │  │  Provider   │  │   Tool      │  │    Context       │  │   │
│  │  │  Registry   │  │  Catalog    │  │   Compactor      │  │   │
│  │  └──────┬──────┘  └──────┬──────┘  └──────────────────┘  │   │
│  │         │                │                               │   │
│  │         ▼                ▼                               │   │
│  │  ┌─────────────┐  ┌─────────────────────────────────┐    │   │
│  │  │ LLM Provider│  │         Tool Handlers           │    │   │
│  │  │ (chat call) │  │  Memory · Shell · Browser · MCP │    │   │
│  │  │             │  │  Scheduler · Search · SubAgents │    │   │
│  │  │             │  │  Knowledge · Files · Skills     │    │   │
│  │  └─────────────┘  └─────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────┐  │
│  │ Identity   │ │ Workspace  │ │  Memory    │ │  Audit Log   │  │
│  │ Manager    │ │ Manager    │ │  Manager   │ │              │  │
│  └────────────┘ └────────────┘ └────────────┘ └──────────────┘  │
│                                                                 │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────┐   │
│  │   Skill    │ │ Permission │ │    MCP     │ │ Tool        │   │
│  │  Registry  │ │  Manager   │ │  Manager   │ │ Approval    │   │
│  └────────────┘ └────────────┘ └────────────┘ └─────────────┘   │
│                                                                 │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────┐   │
│  │  Vector    │ │  Admin     │ │  Sandbox   │ │  Sub-Agent  │   │
│  │  Store     │ │  Auth      │ │  Provider  │ │  Manager    │   │
│  └────────────┘ └────────────┘ └────────────┘ └─────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  HTTP Server (single port)               │   │
│  │  /admin → Admin Panel    / → User Portal (multi-user)   │   │
│  │  /api/v1 → Client API (REST + WebSocket)                │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
                     ┌──────────────┐
                     │   SQLite DB  │
                     │  + Filesystem│
                     └──────────────┘
```

## Data Flow

A typical interaction follows this path:

```
1. User sends message     →  Telegram / Email / Scheduler / Heartbeat
2. Channel creates event  →  IncomingEvent { channel, identityId, content, attachments }
3. Router receives event  →  Resolves identity, maps to workspace
4. Dispatcher processes   →  Builds system prompt + memory + skills + documents + tool defs
                          →  Sends to LLM provider (respects workspace model overrides)
5. LLM responds           →  Text response and/or tool calls
6. Tool execution         →  Dispatcher executes each tool call (sandboxed if applicable)
7. Sub-agent dispatch     →  If subagent_dispatch called, tasks run in parallel
8. Loop continues         →  Results fed back to LLM, repeat until finish()
9. Final response         →  Router sends OutgoingEvent back to channel
10. Audit log             →  Every step recorded with session tracking
```

## The Dispatch Loop

The Dispatcher (`src/core/dispatcher.ts`) runs an iterative loop (configurable, default 50 iterations) for each incoming event:

1. **Resolve workspace** — Identity is mapped to a workspace via `IdentityManager`
2. **Build system prompt** — Rebuilt every iteration to include latest:
   - Agent personality (`AGENT.md` global + workspace-specific)
   - Memory context from `MEMORY.md`
   - KYU (Know Your User) profile from `KYU.md`
   - Available tool definitions (from catalog or direct)
   - Skills list (global + workspace)
   - Relevant document chunks (auto-injected from vector store)
   - Sub-agent list with descriptions
   - Sandbox configuration details
   - Environment info (date, OS, paths)
3. **Assemble messages** — System prompt + conversation history + new user message
4. **Check context size** — If estimated tokens exceed `maxContextTokens`, trigger context compaction
5. **Call LLM** — Send messages + tool definitions to the provider (using workspace model if configured)
6. **Handle response**:
   - **Tool calls with `finish()`** → Agent is done, return response to channel
   - **Tool calls with `continue_execution()`** → Agent signals more work needed, loop continues
   - **Tool calls (no control signal)** → Execute tools, push results back, continue loop
   - **No tool calls, no control signal** → Prompt agent to call finish() or continue_execution()
   - **Empty response** → Retry with prompt to generate output
   - **Truncated** → Request continuation from LLM

### The `notify` Protocol

The agent communicates with users exclusively through the `notify` tool:

- The `notify` tool is the **only way** to send messages to the user
- The agent must call `notify` at least once before calling `finish()`
- Text in the agent's response is invisible to the user — only `notify` messages are delivered
- This allows the agent to "think" freely in its response while controlling what the user sees
- When `reply_expected` is set to `true`, the dispatch loop **pauses** and waits for the user to reply (up to 5 minutes). The Router manages this via a `waitForReply` callback that resolves when a new message arrives or times out.

### Turn Control: `finish()` / `continue_execution()`

These are **tool functions** (not text markers) that the agent must call to control the dispatch loop:

- **`finish()`** — Task completed or waiting for user input. Dispatch loop exits.
- **`continue_execution()`** — More work needed. Loop continues.

## Key Components

### Dispatcher (`src/core/dispatcher.ts`)

The central orchestrator. Manages the full lifecycle of each interaction: prompt assembly, LLM calls, tool execution, the `finish()`/`continue_execution()` turn control protocol, context compaction, and history management. Each workspace maintains its own conversation history. Supports workspace-specific model selection — if a user chooses a different model via the portal, the dispatcher uses it.

### ProviderRegistry (`src/providers/registry.ts`)

Manages LLM provider instances. Supports three provider types:

- **OpenAI** (`src/providers/openai.ts`) — Direct OpenAI API integration
- **Anthropic** (`src/providers/anthropic.ts`) — Claude models via the Anthropic API
- **OpenAI-Compatible** (`src/providers/openai-compat.ts`) — Any endpoint implementing the OpenAI chat completions API (Ollama, LM Studio, Qwen). Includes special handling for Qwen-style tool call formatting.

Each provider can host multiple models. The setup wizard validates tool-calling support for OpenAI-compatible models.

**Model Roles:** Each model can be assigned roles (`default`, `fallback`, `fast`, `capable`, `vision`, `coding`). The registry provides helper methods:
- `getByRole(role)` — Find the first model with a given role
- `getFallback()` — Shortcut for `getByRole('fallback')`
- `listModelsWithRoles()` — List all models across providers with their roles

**Fallback Model:** When the primary LLM fails (network errors, rate limits, etc.), the dispatcher and sub-agents automatically retry with the `fallback` model. This provides resilience without manual intervention. See [Models](models.md) for configuration details.

### Client API (`src/api/client-api.ts`)

A REST + WebSocket API for external clients (desktop apps, mobile apps, integrations). Enabled automatically in multi-user mode. Provides:

- **Authentication** — Email/password login with Bearer token
- **Chat Sessions** — CRUD operations for persistent chat sessions
- **Message Exchange** — Send messages via REST (synchronous) or WebSocket (streaming)
- **Real-time Streaming** — WebSocket connection delivers notifications and responses as they happen

The Client API stores its own session and message history in SQLite, separate from the agent's internal history. See [Client API](client-api.md) for the full reference.

### SubAgentManager (`src/core/sub-agent.ts`)

Creates and manages child agent instances for parallel task execution:

- **Creation** — `subagent_create` creates a named agent with a system prompt. Does not execute.
- **Delete** - `subagent_remove` removes an agent by its agent_id.
- **Dispatch** — `subagent_dispatch` runs one or more tasks on sub-agents **in parallel**. All tasks run concurrently using `Promise.all`.
- **Isolation** — Sub-agents have access to workspace tools and skills but **cannot** use `notify` or dispatch other sub-agents. They communicate results back through their `finish()` response.
- **Context** — Sub-agents receive the workspace's agent prompt, memory, and skills automatically.
- **Persistence** — Sub-agent configurations are stored in SQLite and survive restarts.

### VectorStore & Embeddings (`src/core/vector-store.ts`)

Provides semantic search over uploaded documents:

- **Embedding providers**:
  - `LocalEmbeddingProvider` — Uses `all-MiniLM-L6-v2` via `@huggingface/transformers` (~80MB, downloads on first use, 384 dimensions)
  - `OpenAIEmbeddingProvider` — OpenAI `text-embedding-3-small` or similar
  - `OpenAICompatEmbeddingProvider` — Any OpenAI-compatible embedding endpoint (e.g., Ollama with `nomic-embed-text`)
  - `SimpleEmbeddingProvider` — Hash-based fallback (not recommended for production)
- **Auto-injection** — Top 5 relevant document chunks are automatically injected into the system prompt based on the user's query
- **Tools** — `knowledge_search` and `knowledge_list` allow the agent to explicitly search the vector store
- **Document parsing** — Supports PDF, DOCX, images (OCR), and plain text via `document-parser.ts`

### ToolCatalog (`src/tools/tool-catalog.ts`)

Dynamic tool discovery system. When total available tools exceeds a threshold (default 15), only core tools are loaded into the LLM context. The agent uses `find_tools` to search by keyword or category and dynamically activate additional tools for its session.

### MemoryManager (`src/core/memory.ts`)

Per-workspace persistent memory. Each workspace has a `MEMORY.md` file with timestamped, ID-tagged entries. Memory content is injected into every system prompt automatically.

### SkillRegistry (`src/skills_runtime/registry.ts`)

Loads and manages skill manifests from both global (`~/.kora/skills/`) and workspace-specific (`~/.kora/workspaces/<id>/skills/`) directories. Skills are defined by a `SKILL.md` file with YAML frontmatter. Workspace skills are auto-reloaded every iteration so skills created during a session are immediately available.

### ContextCompactor (`src/core/context-compactor.ts`)

Automatic context window management. When conversation history approaches `maxContextTokens`, older messages are summarized by the LLM into a compact recap. The system prompt and recent messages are preserved.

### AuditLog (`src/core/audit.ts`)

Full session tracing. Records every event type: `session_start`, `user_msg`, `system_prompt`, `llm_request`, `llm_response`, `tool_call`, `tool_result`, `notify`, `assistant_msg`, `context_compaction`, `session_end`, and `error`. Stored in SQLite, accessible via the Web Admin dashboard.

### AdminAuth (`src/core/admin-auth.ts`)

Secure admin credential management using bcrypt hashing. Credentials are stored in the `admin_credentials` SQLite table. Set via `kora setup`, `kora reset-admin`, or Telegram `/webadmin username password`. Token-based login has been removed — only username/password authentication is supported.

### ToolApprovalManager (`src/core/tool-approval.ts`)

Security gate for sensitive tool execution. Sensitive tools (like `shell_exec`) require explicit user approval via Telegram inline buttons. Supports four decisions: allow once, always allow, deny once, always deny.

### Sandbox (`src/tools/sandbox.ts`)

Sandboxed execution environment for shell commands and file operations:

- **Firejail** (Linux) — Preferred, lightweight namespace-based sandbox
- **macOS Seatbelt** — Apple's `sandbox-exec` with custom profile
- **Docker** — Container-based isolation (Linux and macOS)
- Auto-detection selects the best available backend
- Configurable read-only and read-write mounts
- Network access can be enabled/disabled
- Each workspace has a private `work/` directory mounted read-write

### Heartbeat (`src/core/heartbeat.ts`)

Periodic autonomous agent activation. Fires at a configurable interval (default 5 minutes) and sends a prompt from `HEARTBEAT.md` to the Dispatcher. Skipped when the user is actively interacting.

### McpManager (`src/mcp/manager.ts`)

Manages Model Context Protocol server connections:

- **stdio** — Local processes communicating via stdin/stdout
- **SSE** — Remote HTTP servers using Server-Sent Events

MCP tools are dynamically registered and available to the agent.

### Router (`src/core/router.ts`)

Routes incoming events to the Dispatcher and outgoing responses back to the originating channel. Sends typing indicators while the agent is processing.

### IdentityManager (`src/core/identity.ts`)

Resolves channel-specific user identifiers (e.g., `telegram:12345`) to internal identities linked to workspaces. Supports linking multiple channels to the same user account.

### WorkspaceManager (`src/core/workspace.ts`)

Manages isolated user workspaces. Each workspace has its own memory, tasks, sub-agents, documents, skills, and conversation history.

### UserManager (`src/core/user.ts`)

User account management: registration, email verification, password hashing, role assignment (user/admin). Used in multi-user mode.

## Web Interface

A single HTTP server (default port 3100) serves both interfaces:

### Admin Panel (`/admin`)

- **Backend**: `src/web_admin/server.ts` — HTTP/WebSocket server with cookie-based session auth
- **Frontend**: `src/web_admin/public/app.js` — Preact SPA with HTM
- **Features**: Live session monitoring, user management, task/sub-agent management, memory viewer, tool configuration, MCP server management, audit log, real-time WebSocket updates
- **Auth**: Username/password via `AdminAuth` (bcrypt). No token-based login.

### User Portal (`/`)

- **Backend**: Handled by the same `WebAdminServer` with a separate route namespace
- **Frontend**: `src/web_portal/public/app.js` — Preact SPA
- **Features**: Chat history, model selection, agent prompt customization, skill management, MCP server management (remote SSE only in multi-user), memory management, mail delegation configuration, tool toggles
- **Auth**: Email/password registration with per-user sessions

In single-user mode, `/` redirects to `/admin`.

## CLI Commands

| Command                                  | File                     | Description                                                                                                                       |
| ---------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `kora setup`                             | `src/cli/setup.ts`       | Interactive setup wizard with provider config, channel setup, embedding selection, admin credentials, and tool-calling validation |
| `kora start`                             | `src/cli/start.ts`       | Bootstraps all components and starts the runtime                                                                                  |
| `kora doctor`                            | `src/cli/doctor.ts`      | Runs diagnostic checks on the installation                                                                                        |
| `kora reset-admin`                       | `src/cli/reset-admin.ts` | Interactively reset admin panel credentials (hidden password input with confirmation)                                             |
| `kora service install/start/stop/status` | `src/cli/service.ts`     | System service management (systemd on Linux, launchd on macOS)                                                                    |

## Telegram Commands

| Command          | Description                           | Admin Only |
| ---------------- | ------------------------------------- | ---------- |
| `/start`         | Register (multi-user) or show welcome | No         |
| `/status`        | System status overview                | Mono only  |
| `/tasks`         | List scheduled tasks                  | No         |
| `/tools`         | List available tools                  | No         |
| `/agents`        | List sub-agents                       | No         |
| `/skills`        | List loaded skills                    | No         |
| `/mcp`           | Manage MCP servers                    | No         |
| `/settings`      | Show settings                         | Yes        |
| `/heartbeat`     | Heartbeat status                      | Yes        |
| `/permissions`   | Manage tool permissions               | Yes        |
| `/unlimited`     | Toggle unlimited mode                 | Yes        |
| `/webadmin`      | Web admin URL + credential reset      | Yes        |
| `/link`          | Link email identity                   | No         |
| `/resetpassword` | Get portal password reset code        | No         |
| `/newsession`    | Start new conversation session        | No         |
| `/clear`         | Clear conversation history            | No         |

## Storage Layout

```
~/.kora/
├── config/
│   ├── AGENT.md              # Global system prompt & personality
│   ├── HEARTBEAT.md          # Heartbeat prompt template
│   ├── providers.yml         # LLM provider configs & API keys
│   ├── channels.yml          # Telegram, Email channel settings
│   ├── settings.yml          # General settings (mode, tools, sandbox, embedding)
│   └── workspaces/
│       └── <workspace_id>/
│           ├── AGENT.md       # Per-user agent personality override
│           ├── MEMORY.md      # Persistent agent memory
│           ├── settings.yml   # Per-user settings (model, provider overrides)
│           └── skills/        # User-created skills
│               └── <skill>/
│                   └── SKILL.md
├── skills/                    # Global skills directory
├── tools/                     # MCP server config files (JSON)
├── workspaces/
│   └── <workspace_id>/
│       ├── work/              # Sandboxed working directory
│       └── downloads/         # File attachments from channels
├── logs/                      # Runtime logs
├── screenshots/               # Browser tool screenshots
└── data/
    └── korabot.db                # SQLite database (users, sessions, audit, tasks, etc.)
```

## Database Tables

| Table                  | Purpose                                                  |
| ---------------------- | -------------------------------------------------------- |
| `users`                | User accounts (email, password hash, role, subscription) |
| `workspaces`           | Workspace metadata and ownership                         |
| `identities`           | Channel identity → workspace mappings                    |
| `messages`             | Conversation message history                             |
| `permission_decisions` | Tool approval decisions per workspace                    |
| `registration_codes`   | Multi-user registration codes (Telegram)                 |
| `usage_logs`           | Per-request token usage tracking                         |
| `user_sessions`        | Portal session tokens                                    |
| `verification_codes`   | Email/password verification codes                        |
| `admin_credentials`    | Admin panel credentials (bcrypt, single row)             |
| `sub_agents`           | Sub-agent configurations and state                       |
| `scheduled_tasks`      | Cron-based task definitions                              |
| `task_logs`            | Task execution history                                   |
| `audit_events`         | Full audit trail of all agent activity                   |

## Source Code Structure

```
src/
├── core/                    # Runtime core
│   ├── config.ts              ConfigManager — YAML config loading, workspace settings
│   ├── dispatcher.ts          Dispatcher — main agent loop, prompt building, tool execution
│   ├── router.ts              Event routing between channels and dispatcher
│   ├── types.ts               TypeScript interfaces for the entire system
│   ├── database.ts            SQLite database manager with migrations
│   ├── identity.ts            Channel identity resolution and cross-channel linking
│   ├── workspace.ts           Workspace CRUD and isolation
│   ├── user.ts                User management (registration, auth, roles)
│   ├── memory.ts              Per-workspace MEMORY.md persistent memory
│   ├── vector-store.ts        Vector store + embedding providers (local ML, OpenAI, compat)
│   ├── document-parser.ts     PDF, DOCX, image parsing for vectorization
│   ├── heartbeat.ts           Periodic autonomous agent activation
│   ├── audit.ts               Session audit logging to SQLite
│   ├── sub-agent.ts           Sub-agent creation, parallel dispatch, execution
│   ├── tool-approval.ts       Sensitive tool approval flow
│   ├── context-compactor.ts   LLM-based context window compaction
│   ├── admin-auth.ts          Admin credentials (bcrypt hashing)
│   ├── system-mailer.ts       SMTP for verification and password reset emails
│   ├── helpers.ts             Shared utilities (cronToHuman, etc.)
│   ├── event-bus.ts           Internal typed event bus
│   └── logger.ts              Structured logging with levels
├── providers/               # LLM providers
│   ├── registry.ts            Provider registration, lookup, hot-reload
│   ├── base.ts                LLMProvider interface
│   ├── openai.ts              OpenAI API provider
│   ├── anthropic.ts           Anthropic API provider
│   └── openai-compat.ts       OpenAI-compatible provider (Ollama, LM Studio, Qwen)
├── channels/                # Communication channels
│   ├── telegram/index.ts      Telegram bot (commands, callbacks, file handling)
│   ├── email/index.ts         IMAP/SMTP email channel
│   └── gmail/index.ts         Gmail OAuth email channel
├── tools/                   # Built-in tool definitions and handlers
│   ├── index.ts               Tool registry, routing, sandbox mount configuration
│   ├── tool-catalog.ts        Dynamic tool discovery (find_tools)
│   ├── notify-tool.ts         User communication (notify), turn control (finish, continue_execution)
│   ├── memory-tool.ts         Memory CRUD (append, list, delete, search)
│   ├── settings-tool.ts       Settings and agent prompt tools
│   ├── scheduler-tool.ts      Cron task management
│   ├── shell-tool.ts          Shell command execution (sandboxed)
│   ├── file-tool.ts           File operations (create, read, edit, delete, list)
│   ├── browser-tool.ts        Headless Chrome (navigate, click, screenshot, DOM)
│   ├── web-search-tool.ts     Brave/Google search integration
│   ├── web-fetch-tool.ts      Full HTTP client (GET/POST/PUT/DELETE/PATCH, headers, body, query params)
│   ├── mail-tool.ts           Email send/list/read tools
│   ├── mail-delegation/       Delegated email access (Gmail/IMAP per user)
│   ├── mcp-tool.ts            MCP server install/manage
│   ├── subagent-tool.ts       Sub-agent create, dispatch (parallel), list, remove
│   ├── skill-tool.ts          Skill read/list/install/remove
│   ├── knowledge-tool.ts      Vector store search and document listing
│   ├── speech-tool.ts         Audio transcription (Whisper)
│   ├── sandbox.ts             Sandbox provider detection and execution
│   └── homeassistant-tool.ts  Home Assistant REST API control
├── mcp/                     # Model Context Protocol
│   ├── manager.ts             MCP server lifecycle, config persistence
│   ├── client.ts              stdio MCP client
│   └── sse-client.ts          SSE/HTTP MCP client
├── skills_runtime/          # Skill system
│   ├── registry.ts            Global + workspace skill manifest management
│   ├── loader.ts              SKILL.md file parsing (YAML frontmatter)
│   └── permissions.ts         Granular skill permission decisions
├── tasks/                   # Task scheduler
│   ├── store.ts               SQLite-backed task storage with logs
│   ├── scheduler.ts           Cron job management (node-cron)
│   └── executor.ts            Task execution and result logging
├── api/                     # Client API
│   └── client-api.ts          REST + WebSocket API for external clients (auth, sessions, chat)
├── billing/                 # Stripe integration
│   ├── stripe.ts              Checkout sessions, webhooks, customer portal
│   └── usage.ts               Per-workspace usage tracking and limits
├── web_admin/               # Admin panel
│   ├── server.ts              HTTP server, routing, auth, REST API, WebSocket
│   └── public/                Admin frontend (Preact + HTM SPA)
├── web_portal/              # User portal
│   └── public/                Portal frontend (Preact + HTM SPA)
└── cli/                     # CLI commands
    ├── index.ts               Commander.js entry point
    ├── start.ts               Runtime bootstrap — wires all components together
    ├── setup.ts               Interactive setup wizard (providers, channels, tools, sandbox, embeddings, admin)
    ├── doctor.ts              Diagnostic checks
    ├── reset-admin.ts         Admin credential reset (hidden password input)
    └── service.ts             System service management (systemd/launchd)

client/                      # Electrobun Desktop Client
├── src/
│   ├── main.ts                Main process (BrowserWindow creation)
│   └── views/main/            Frontend (HTML + CSS + JS)
├── electrobun.config.ts       Build configuration
└── package.json
```
