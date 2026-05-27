# Kora Documentation

Welcome to the Kora documentation. Kora is a **local-first, autonomous AI agent runtime** built in TypeScript/Node.js. It connects to your favorite LLM providers, communicates through Telegram and Email, executes real tasks with built-in tools, and remembers what matters between conversations.

Think of it as your own self-hosted AI assistant that actually *does things* — browses the web, runs shell commands, sends emails, manages scheduled tasks, and learns your preferences over time.

## Features

- **Multi-Provider LLM Support** — OpenAI, Anthropic, and any OpenAI-compatible endpoint (Ollama, LM Studio, Qwen)
- **MCP Tool Ecosystem** — Install and manage Model Context Protocol servers for extensible tooling
- **Telegram Channel** — Full-featured Telegram bot with inline buttons, file attachments, and tool approval flow
- **Email Channel** — IMAP/SMTP and Gmail API support for receiving and sending emails as an agent
- **Web Admin Dashboard** — Browser-based admin panel at `/admin` for monitoring, audit logs, task management, and configuration
- **User Portal** — Self-service portal at `/` for multi-user mode: registration, email verification, workspace management
- **Scheduled Tasks** — Cron-based task scheduler with persistence, logging, and Telegram notifications
- **Persistent Memory** — Per-workspace `MEMORY.md` with automatic injection into every prompt
- **KYU (Know Your User)** — Automatic user profiling that learns preferences, interests, and personality across sessions
- **Skills** — Instruction-based skills following the [AgentSkills spec](https://agentskills.io/specification), manageable by the agent itself
- **Heartbeat System** — Periodic autonomous agent check-ins using a customizable prompt template
- **Sub-Agents** — Spawn specialized child agents for parallel task execution with per-agent model selection
- **Model Roles & Fallback** — Assign roles (default, fallback, fast, capable) to models with automatic failover
- **Client API** — REST + WebSocket API for desktop/mobile clients with streaming chat
- **Desktop Client** — Native Electrobun desktop app with multi-session chat interface
- **Context Compaction** — Automatic conversation summarization when context windows fill up
- **Audit Logging** — Full session tracing: every LLM call, tool invocation, and agent decision is recorded
- **Identity & Workspaces** — Multi-user support with identity linking and workspace isolation
- **Stripe Billing** — Optional subscription-based billing with usage tracking per workspace

## Quick Install

```bash
# macOS / Linux / WSL
curl -fsSL https://raw.githubusercontent.com/korabot/korabot/main/install/install.sh | bash

# Or from source
git clone https://github.com/korabot/korabot.git
cd korabot && npm install && npm run build && npm link
```

Then run the setup wizard:

```bash
kora setup
```

## Documentation

| Page                                  | Description                                                             |
| ------------------------------------- | ----------------------------------------------------------------------- |
| [Getting Started](getting-started.md) | Installation, setup wizard walkthrough, and first run                   |
| [Architecture](architecture.md)       | System design, component diagram, and data flow                         |
| [Configuration](configuration.md)     | All config files: settings.yml, providers.yml, channels.yml, AGENT.md   |
| [Channels](channels.md)               | Telegram and Email channel setup and features                           |
| [Built-in Tools](tools.md)            | Complete reference for every built-in tool with parameters and examples |
| [Skills](skills.md)                   | AgentSkills system: creating and managing custom skill plugins          |
| [MCP](mcp.md)                         | Model Context Protocol server management                                |
| [Memory System](MEMORY.md)            | How persistent long-term memory works                                   |
| [KYU (Know Your User)](kyu.md)        | Automatic user profiling and personalization system                     |
| [Agent Identity](identity.md)         | Identity system: personality, evolution, and IDENTITY.md                |
| [Heartbeat](heartbeat.md)             | Periodic autonomous agent check-ins and proactive actions               |
| [Scheduled Tasks](tasks.md)           | Cron-based task scheduling and management                               |
| [Web Admin](web-admin.md)             | Browser-based admin dashboard at `/admin`                               |
| [User Portal](user-portal.md)         | Self-service user portal for multi-user mode                            |
| [Plugins](plugins.md)                 | Channel and knowledge connector plugin system                           |
| [Telegram Groups](telegram-groups.md) | Groups and forum topics support                                         |
| [Models](models.md)                   | Model roles, fallback system, and per-model configuration               |
| [Sub-Agents](sub-agents.md)           | Sub-agent creation, dispatch, model selection, and failure handling     |
| [Client API](client-api.md)           | REST + WebSocket API for external clients and integrations              |
| [Desktop Client](desktop-client.md)   | Electrobun desktop client setup and usage                               |
| [Security](security.md)               | Tool approval, authentication, access control, and data protection      |
| [Troubleshooting](troubleshooting.md) | Common issues, debugging, and FAQ                                       |

## Requirements

- **Node.js** >= 20
- An LLM provider API key (OpenAI, Anthropic) or a local model (Ollama, LM Studio)

## License

MIT
