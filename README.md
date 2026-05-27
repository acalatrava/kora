## Kora

Kora is a **local-first AI agent runtime** with multi-channel support (Telegram, Email, scheduler/heartbeat) and a built-in web admin UI.

This repository is the **MIT-licensed, open-source** edition focused on running Kora on a single machine (single-node), with **SQLite + filesystem** storage by default.

## Features (Open Source)

- **Multi-Provider LLM Support** — OpenAI, Anthropic, and OpenAI-compatible endpoints (Ollama, LM Studio, Qwen)
- **Multi-Channel** — Telegram bot (primary UX) + Email (IMAP/SMTP & Gmail API). Architecture supports adding more channels.
- **Workspaces & identities** — Isolated workspaces and identity linking across channels.
- **Web UI** — Admin panel at `/admin` (a portal UI can be enabled for multi-user mode).
- **Web Admin** — Browser-based admin panel for monitoring, audit logs, task management, and system configuration.
- **Local-First** — All data stored locally in SQLite + filesystem. No cloud backend required.
- **Skills** — Extensible instruction-based skills following the [AgentSkills spec](https://agentskills.io/specification). Install, read, and execute via the agent.
- **Task Scheduler** — Cron-based task scheduling with per-workspace persistence.
- **Memory** — Per-workspace MEMORY.md + local vector store for semantic search.
- **Identity Linking** — Map Telegram users, email addresses, etc. to workspaces via pairing codes.
- **Mail Delegation** — Agent can read/send user email (Gmail OAuth or IMAP/SMTP) with configurable permissions.
- **Home Assistant** — Optional MQTT integration to appear as a device in HA.
- **MCP-Compatible** — Tool/skill system follows standard patterns for extensibility.

## Editions

Kora is open source, and there is also a **proprietary multi-user / multi-service** edition that can be licensed to third parties with extras such as:

- **Multi-user (scalable)** with horizontally scalable worker pools
- **Microservices decomposition**: stateless web servers, scalable agent workers, independent channel/scheduler/indexer services
- **PostgreSQL + Redis** for shared state and job queues
- **Sandboxed shell** (Docker / Firejail / macOS Seatbelt with network/filesystem restrictions)
- **Browser isolation** (per-workspace headless browser containers)
- **Stripe billing** (optional)

See <a href="https://kora.era3000.com">https://kora.era3000.com</a>

## Install

### From source

```bash
git clone <this-repo-url>
cd kora
npm install
npm run build
npm link
```

## Getting Started

```bash
# Run the setup wizard
kora setup

# Start the agent
kora start

# Check your environment
kora doctor
```

The setup wizard guides you through:

1. Choosing a storage path (default `~/.kora`)
2. Configuring LLM provider(s) and API keys
3. Setting up Telegram bot token (optional)
4. Configuring email (Gmail easy mode or manual IMAP/SMTP, optional)
5. Enabling/disabling tools (scheduler, mail, browser, web search, Home Assistant)
6. Running diagnostics

## Requirements

- **Node.js** >= 20
- LLM provider API key (OpenAI, Anthropic) or local model (Ollama, LM Studio)

## Web Interfaces

Kora serves two web interfaces from a single HTTP server:

| Interface       | URL Path | Purpose                                                                      |
| --------------- | -------- | ---------------------------------------------------------------------------- |
| **Admin Panel** | `/admin` | Full system administration, audit logs, sessions, tasks, configuration       |
| **User Portal** | `/`      | Self-service portal for multi-user mode (registration, workspace management) |

In **single-user mode**, visiting `/` redirects to `/admin`.

Access the admin panel using the URL printed on startup:

```
Web Admin: http://localhost:3100/admin?token=abc123...
```

See [Web Admin](docs/web-admin.md) and [User Portal](docs/user-portal.md) for details.

## Architecture

```
~/.kora/
├── config/
│   ├── AGENT.md          # Main agent personality & system prompt
│   ├── providers.yml     # LLM provider configs
│   ├── channels.yml      # Channel configs (Telegram, Email)
│   └── settings.yml      # General settings
├── skills/               # Installed skills
├── tools/                # Installed tools
├── workspaces/
│   └── <workspace_id>/
│       ├── MEMORY.md     # Curated workspace memory
│       ├── tasks.db      # Scheduled tasks
│       ├── vector.db     # Vector embeddings
│       └── agents/       # Sub-agent instances
└── logs/
```

## Project Structure

```
src/
├── core/               # Config, DB, workspace, identity, memory, dispatcher, router, user
├── providers/          # LLM providers (OpenAI, Anthropic, OpenAI-compatible)
├── channels/           # Communication channels (Telegram, Email, Gmail)
├── skills_runtime/     # Skill loader, registry (global + workspace-scoped)
├── tasks/              # Scheduler, store, executor
├── tools/              # Built-in tools (scheduler, mail, browser, search, HA, delegation)
├── mcp/                # MCP client/manager (global + workspace-scoped)
├── billing/            # Stripe integration, usage tracking
├── web_admin/          # Admin panel (served at /admin)
├── web_portal/         # User portal (served at /)
├── cli/                # CLI commands + TUI setup wizard
└── index.ts            # Main exports
```

## Built-in Tools

| Tool                | Description                                                              |
| ------------------- | ------------------------------------------------------------------------ |
| `scheduler_*`       | Create, list, pause, resume, run, delete scheduled tasks                 |
| `mail_send`         | Send emails via the bot's own email channel                              |
| `mail_list`         | List emails from the bot's inbox with pagination (single-user mode only) |
| `mail_read`         | Read the full content of a specific email by ID (single-user mode only)  |
| `mail_delegation_*` | Read/send user email via delegated accounts (Gmail/IMAP)                 |
| `browser_*`         | Navigate, screenshot, extract text, click, fill forms (headless)         |
| `web_search`        | Search the web via Brave Search API                                      |
| `web_fetch`         | Fetch and extract content from web pages                                 |
| `shell_exec`        | Execute sandboxed shell commands                                         |
| `ha_*`              | Home Assistant integration via MQTT discovery                            |
| `mcp_*`             | Install and manage MCP servers                                           |
| `subagent_*`        | Create and manage sub-agents                                             |
| `memory_*`          | Store and retrieve workspace memories                                    |
| `skill_*`           | List, read, install, remove skills                                       |
| `settings_*`        | View and update agent settings                                           |

## Skills

Skills follow the [AgentSkills spec](https://agentskills.io/specification) — a `SKILL.md` file with YAML frontmatter + markdown instructions, plus optional `scripts/`, `references/`, and `assets/` directories.

```markdown
---
name: my-skill
description: Does something useful. Use when the user asks about X.
metadata:
  author: your-name
  version: "1.0"
---

# My Skill

Step-by-step instructions for the agent on how to use this skill.

## Usage

1. Run the script: `scripts/do-thing.py`
2. Parse the output
3. Return results to the user
```

The agent can install, read, and manage skills via built-in tools (`skill_list`, `skill_read`, `skill_create`, `skill_update` ,`skill_remove`).

## Multi-Tenant Mode

Kora supports multi-tenant SaaS mode where multiple users can register and use the agent independently.

### Enabling Multi-User

In `settings.yml`:

```yaml
multiUser: true
```

### Registration Flow

1. A new user sends `/start` to the Telegram bot — this creates a workspace and Telegram identity
2. If Stripe billing is enabled and no subscription is active, the bot sends a checkout link
3. The user sends `/link email@example.com` — a registration code is sent to that email
4. User opens the web portal (`/`) and registers with the code, email, and password
5. A user account is created and linked to the existing workspace
6. Two-factor authentication (TOTP or Passkey) setup is offered (can be skipped)

### Email Verification

When `SYSTEM_SMTP_*` environment variables are set, email verification is enforced during registration:

1. User submits the registration form
2. A 6-character verification code is sent to their email
3. The user enters the code on the portal to activate their account
4. Until verified, the account remains in `pending_verification` status and cannot log in

### Password Reset

Users can reset their password through two channels:

- **Web Portal** — Click "Forgot password?" on the login page, enter email, receive a reset code, and set a new password
- **Telegram** — Send `/resetpassword` to the bot, receive a reset code, then use it on the portal

### System Mailer Configuration

Kora uses a dedicated SMTP service for sending transactional emails (verification codes, password resets). This is separate from the agent's email channel.

```bash
SYSTEM_SMTP_HOST=smtp.gmail.com
SYSTEM_SMTP_PORT=587
SYSTEM_SMTP_USER=noreply@yourdomain.com
SYSTEM_SMTP_PASS=your-app-password
SYSTEM_SMTP_FROM="Kora <noreply@yourdomain.com>"
SYSTEM_SMTP_SECURE=false
```

### Stripe Billing (Optional)

Set these environment variables to enable billing:

```bash
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...
KORA_BASE_URL=https://your-domain.com
```

Configure billing in `settings.yml`:

```yaml
billing:
  enabled: true
  dailyLimit: 1000     # Global daily request limit per user (-1 to disable)
  models:
    gpt-4o:
      provider: openai
      included_calls: 500  # Per-model daily limit (checked after global limit)
```

The `dailyLimit` sets a global cap on all LLM requests per user per day (default: 1000). Per-model `included_calls` limits are checked in addition to the global limit. Set `dailyLimit: -1` to disable the global cap and rely only on per-model limits.

### User Portal

Available at `/` (the root URL), the user portal provides:

- **Dashboard** — Daily usage statistics with progress bar and subscription status
- **Tools** — Toggle which tools the agent can use
- **MCP Servers** — Install/remove MCP servers (workspace-scoped)
- **Skills** — Manage workspace-specific skills
- **Models** — Choose default AI model (hidden when only one model is configured)
- **Agent Prompt** — Customize the agent's system prompt (AGENT.md)
- **Mail Delegation** — Configure delegated email access with sensitive content filtering
- **Subscription** — Manage billing via Stripe Customer Portal
- **Sub-Agents** — Create, manage, and trigger sub-agents (with webhook URLs)

### Workspace Isolation

Each user gets an isolated workspace with:

- Separate MCP server configurations
- Workspace-specific skills (override global skills with same name)
- Custom tool settings and agent prompt
- Independent mail delegation accounts
- Usage tracking and billing enforcement

### Security

- Portal sessions stored in SQLite (survive restarts)
- CSRF protection on all state-changing portal API requests
- Bcrypt password hashing (cost factor 12)
- Rate limiting on login, registration, password reset, API calls, and webhooks
- Global per-IP rate limiting on all endpoints (100 req/min)
- Separate admin and user session cookies
- Path traversal prevention on all file operations
- Workspace isolation enforced on every DB query and file operation
- Email verification for new accounts (when System Mailer is configured)
- Two-factor authentication (TOTP and WebAuthn/Passkey) for admin and portal
- Security headers: HSTS, X-Frame-Options DENY, CSP, X-Content-Type-Options, Permissions-Policy
- Request body size limits (512KB for API, 10MB for uploads)
- Sanitized error responses (no internal details leaked)

## Agent Personality

The default agent personality is dry, arrogant, and snarky (think Gilfoyle from Silicon Valley). Responses are kept short. You can customize this by editing `~/.kora/config/AGENT.md`.

## Documentation

Full documentation is available in the [docs/](docs/) directory. See [docs/README.md](docs/README.md) for the index.

## Development

```bash
npm run dev       # Run with tsx (hot reload)
npm run build     # Compile TypeScript
npm run lint      # Run ESLint
npm test          # Run tests
```

## License

MIT. See `LICENSE`.
