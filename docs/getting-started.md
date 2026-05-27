# Getting Started

This guide walks you through installing Kora, running the setup wizard, and starting your first agent session.

## Prerequisites

- **Node.js 20+** — Kora requires Node.js version 20 or later. Check with `node --version`.
- **npm** — Comes with Node.js.
- **An LLM provider** — You need at least one of:
  - An OpenAI API key
  - An Anthropic API key
  - A local model running via Ollama, LM Studio, or any OpenAI-compatible endpoint

## Installation

### One-Line Install (macOS / Linux / WSL)

```bash
curl -fsSL https://raw.githubusercontent.com/korabot/korabot/main/install/install.sh | bash
```

### One-Line Install (Windows PowerShell)

```powershell
irm https://raw.githubusercontent.com/korabot/korabot/main/install/install.ps1 | iex
```

### From Source

```bash
git clone https://github.com/korabot/korabot.git
cd korabot
npm install
npm run build
npm link
```

After installation, verify the CLI is available:

```bash
kora --version
```

## Setup Wizard

Run the interactive setup wizard to configure Kora for the first time:

```bash
kora setup
```

The wizard walks you through each step:

### 1. Storage Path

Choose where Kora stores its data. The default is `~/.kora`. This directory will contain configuration files, workspaces, skills, logs, and the SQLite database.

### 2. LLM Provider

Select and configure one or more LLM providers:

- **OpenAI** — Enter your API key. Choose from models like `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `o3-mini`.
- **Anthropic** — Enter your API key. Choose from models like `claude-sonnet-4-20250514`, `claude-3-5-haiku-20241022`.
- **OpenAI-Compatible** — For Ollama, LM Studio, Qwen, or any compatible endpoint. Enter the base URL (e.g., `http://localhost:11434/v1`) and select models.

You can configure multiple providers and set a default.

### 3. Telegram Bot (Optional)

If you want to interact with Kora through Telegram:

1. Create a bot via [@BotFather](https://t.me/BotFather) on Telegram
2. Copy the bot token
3. Optionally restrict the bot to specific chat IDs for security

### 4. Email Channel (Optional)

Configure email integration with either:

- **Gmail Easy Mode** — Uses standard Gmail IMAP/SMTP settings; just provide your email and an [App Password](https://myaccount.google.com/apppasswords)
- **Manual IMAP/SMTP** — Full control over host, port, TLS, and credentials

### 5. Tools

Enable or disable built-in tool categories:

| Tool           | Default      | Description                                   |
| -------------- | ------------ | --------------------------------------------- |
| Scheduler      | Enabled      | Cron-based task scheduling                    |
| Browser        | Enabled      | Headless Chrome for web interaction           |
| Shell          | **Disabled** | System command execution (security-sensitive) |
| Web Search     | Disabled     | Brave Search API integration                  |
| Email          | Disabled     | Send and check emails                         |
| Home Assistant | Disabled     | REST API integration with HA                  |
| MCP            | Enabled      | Model Context Protocol tool servers           |

### 6. Diagnostics

The wizard finishes by running `kora doctor`, which checks your environment for common issues: Node.js version, provider connectivity, and configuration validity.

## First Run

Start the agent:

```bash
kora start
```

You will see a startup summary showing active providers, channels, tools, MCP servers, scheduled tasks, skills, heartbeat status, and the web admin URL.

```
  Kora is running

  Providers:    openai
  Channels:     telegram
  Tools:        scheduler, browser, mcp, subagents
  MCP Servers:  0 connected (0 tools)
  Scheduler:    0 active job(s)
  Skills:       0 loaded
  Heartbeat:    every 5min
  Web Admin:    http://localhost:3100/admin?token=abc123

  Press Ctrl+C to stop.
```

Now send a message to your Telegram bot — Kora will respond.

## Running as a Background Service

For persistent operation, install Kora as a system service:

```bash
# Install the service (systemd on Linux, launchd on macOS)
kora service install

# Manage the service
kora service start
kora service restart
kora service stop
kora service status

# Remove the service
kora service uninstall
```

On macOS, this creates a `launchd` agent that starts automatically on login. On Linux, it creates a `systemd` user service.

## CLI Reference

| Command                  | Description                        |
| ------------------------ | ---------------------------------- |
| `kora setup`             | Run the interactive setup wizard   |
| `kora start`             | Start the agent runtime            |
| `kora status`            | Show current configuration summary |
| `kora doctor`            | Run diagnostic checks              |
| `kora service install`   | Install as a system service        |
| `kora service uninstall` | Remove the system service          |
| `kora service start`     | Start the background service       |
| `kora service restart`   | Restart the background service     |
| `kora service stop`      | Stop the background service        |
| `kora service status`    | Show service status                |

## Config File Locations

All configuration lives under your storage path (default `~/.kora`):

```
~/.kora/
├── config/
│   ├── settings.yml      # General settings
│   ├── providers.yml     # LLM provider configurations
│   ├── channels.yml      # Channel configurations
│   └── AGENT.md          # Agent personality & system prompt
├── workspaces/
│   └── default/
│       └── MEMORY.md     # Agent's long-term memory
├── skills/               # Installed skills
├── tools/                # MCP server configurations
├── logs/                 # Audit and runtime logs
└── data/
    └── korabot.db        # SQLite database (users, sessions, audit, tasks, etc.)
```

For detailed configuration options, see [Configuration](configuration.md).

## Next Steps

- [Architecture](architecture.md) — Understand how Kora works under the hood
- [Configuration](configuration.md) — Fine-tune every setting
- [Built-in Tools](tools.md) — Explore everything Kora can do
- [Web Admin](web-admin.md) — Admin panel features and REST API
- [User Portal](user-portal.md) — Multi-user self-service portal
