# Configuration

All Kora configuration lives under the storage path (default `~/.kora/config/`). Configuration files are created by the `kora setup` wizard, but you can edit them manually at any time.

## Configuration Files Overview

| File            | Format   | Purpose                             |
| --------------- | -------- | ----------------------------------- |
| `settings.yml`  | YAML     | General runtime settings            |
| `providers.yml` | YAML     | LLM provider configurations         |
| `channels.yml`  | YAML     | Communication channel settings      |
| `AGENT.md`      | Markdown | Agent personality and system prompt |

## settings.yml

Controls the overall runtime behavior. All fields have sensible defaults.

```yaml
defaultProvider: openai
defaultModel: gpt-4o
maxTokens: 16384
maxContextTokens: 200000
multiUser: false
logLevel: info

tools:
  scheduler: true
  browser: true
  shell: false
  web_search: false
  mail: false
  homeassistant_mqtt: false
  mcp: true

heartbeat:
  enabled: true
  intervalMinutes: 5

web_admin:
  enabled: true
  port: 3100
  token: "your-secret-token"
  username: "admin"
  password: "your-password"
```

### General Settings

| Field              | Type    | Default  | Description                                                                                     |
| ------------------ | ------- | -------- | ----------------------------------------------------------------------------------------------- |
| `defaultProvider`  | string  | `openai` | ID of the default LLM provider (must match an entry in `providers.yml`)                         |
| `defaultModel`     | string  | `gpt-4o` | Default model to use for all LLM calls                                                          |
| `maxTokens`        | number  | `16384`  | Maximum tokens in the LLM response                                                              |
| `maxContextTokens` | number  | `200000` | Maximum total context window size; triggers [context compaction](architecture.md) when exceeded |
| `multiUser`        | boolean | `false`  | Enable multi-user mode with workspace isolation per identity                                    |
| `logLevel`         | string  | `info`   | Log verbosity: `debug`, `info`, `warn`, or `error`                                              |

### Tool Settings

Each tool category can be independently enabled or disabled. Some tools require additional configuration.

| Field                      | Type    | Default | Description                                                               |
| -------------------------- | ------- | ------- | ------------------------------------------------------------------------- |
| `tools.scheduler`          | boolean | `true`  | Cron-based scheduled task system                                          |
| `tools.browser`            | boolean | `true`  | Headless Chrome browser automation                                        |
| `tools.shell`              | boolean | `false` | Shell command execution (disabled by default for security)                |
| `tools.web_search`         | boolean | `false` | Web search integration                                                    |
| `tools.web_search_api_key` | string  | —       | Brave Search API key (required when `web_search` is enabled)              |
| `tools.web_search_engine`  | string  | `brave` | Search engine backend: `brave` or `google`                                |
| `tools.mail`               | boolean | `false` | Email send/check tools (auto-enabled when an email channel is configured) |
| `tools.homeassistant_mqtt` | boolean | `false` | Home Assistant REST API integration                                       |
| `tools.ha_url`             | string  | —       | Home Assistant instance URL (e.g., `http://homeassistant.local:8123`)     |
| `tools.ha_token`           | string  | —       | Long-Lived Access Token for Home Assistant                                |
| `tools.mcp`                | boolean | `true`  | Model Context Protocol tool servers                                       |

### Heartbeat Settings

| Field                       | Type    | Default | Description                          |
| --------------------------- | ------- | ------- | ------------------------------------ |
| `heartbeat.enabled`         | boolean | `true`  | Enable periodic autonomous check-ins |
| `heartbeat.intervalMinutes` | number  | `5`     | Minutes between heartbeat ticks      |

The heartbeat fires a prompt from `HEARTBEAT.md.template` (located in the `docs/` or config directory). It is skipped when the user has been active within the last 10 minutes.

### Web Admin Settings

| Field                | Type    | Default        | Description                                                               |
| -------------------- | ------- | -------------- | ------------------------------------------------------------------------- |
| `web_admin.enabled`  | boolean | `true`         | Enable the web admin dashboard                                            |
| `web_admin.port`     | number  | `3100`         | HTTP port for the admin server                                            |
| `web_admin.token`    | string  | auto-generated | Bearer token for API authentication (generated on first start if not set) |
| `web_admin.username` | string  | —              | Username for basic auth (optional, alternative to token auth)             |
| `web_admin.password` | string  | —              | Password for basic auth                                                   |

## providers.yml

Defines one or more LLM provider connections. Each provider has a unique ID, a type, and a list of models.

```yaml
providers:
  - id: openai
    type: openai
    apiKey: sk-...
    models:
      - id: gpt-4o
        name: GPT-4o
        maxTokens: 16384

  - id: anthropic
    type: anthropic
    apiKey: sk-ant-...
    models:
      - id: claude-sonnet-4-20250514
        name: Claude Sonnet 4
        maxTokens: 8192

  - id: ollama
    type: openai_compat
    baseUrl: http://localhost:11434/v1
    models:
      - id: qwen2.5:latest
        name: Qwen 2.5
        toolCallProfile: qwen
      - id: llama3:latest
        name: Llama 3
```

### Provider Fields

| Field     | Type   | Required   | Description                                                                   |
| --------- | ------ | ---------- | ----------------------------------------------------------------------------- |
| `id`      | string | Yes        | Unique identifier, referenced by `settings.yml` `defaultProvider`             |
| `type`    | string | Yes        | Provider type: `openai`, `anthropic`, or `openai_compat`                      |
| `apiKey`  | string | Depends    | API key (required for `openai` and `anthropic`, optional for `openai_compat`) |
| `baseUrl` | string | For compat | Base URL for OpenAI-compatible endpoints                                      |
| `models`  | array  | Yes        | List of available models                                                      |

### Model Fields

| Field             | Type   | Required | Description                                                 |
| ----------------- | ------ | -------- | ----------------------------------------------------------- |
| `id`              | string | Yes      | Model identifier sent to the API                            |
| `name`            | string | Yes      | Human-readable display name                                 |
| `maxTokens`       | number | No       | Override max response tokens for this model                 |
| `toolCallProfile` | string | No       | Tool call format: `standard` (default), `qwen`, or `custom` |

The `toolCallProfile` field is useful for OpenAI-compatible providers that have non-standard tool call formatting (e.g., Qwen models).

## channels.yml

Configures communication channels. Each channel has a unique ID, a type, and channel-specific configuration.

```yaml
channels:
  - id: telegram-main
    type: telegram
    enabled: true
    config:
      token: "123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
      allowedChatIds:
        - 123456789

  - id: email-main
    type: email
    enabled: true
    config:
      imap:
        host: imap.gmail.com
        port: 993
        user: you@gmail.com
        password: "app-password-here"
        tls: true
      smtp:
        host: smtp.gmail.com
        port: 587
        user: you@gmail.com
        password: "app-password-here"
        secure: false
```

### Telegram Channel Config

| Field            | Type     | Required | Description                                                                    |
| ---------------- | -------- | -------- | ------------------------------------------------------------------------------ |
| `token`          | string   | Yes      | Bot token from @BotFather                                                      |
| `allowedChatIds` | number[] | No       | Restrict the bot to specific chat IDs. If omitted, the bot responds to anyone. |

### Email Channel Config

| Field           | Type    | Required | Description                                                         |
| --------------- | ------- | -------- | ------------------------------------------------------------------- |
| `imap.host`     | string  | Yes      | IMAP server hostname                                                |
| `imap.port`     | number  | Yes      | IMAP port (usually 993 for TLS)                                     |
| `imap.user`     | string  | Yes      | IMAP username / email address                                       |
| `imap.password` | string  | Yes      | IMAP password or app password                                       |
| `imap.tls`      | boolean | Yes      | Enable TLS                                                          |
| `smtp.host`     | string  | Yes      | SMTP server hostname                                                |
| `smtp.port`     | number  | Yes      | SMTP port (587 for STARTTLS, 465 for implicit TLS)                  |
| `smtp.user`     | string  | Yes      | SMTP username                                                       |
| `smtp.password` | string  | Yes      | SMTP password or app password                                       |
| `smtp.secure`   | boolean | Yes      | `true` for implicit TLS (port 465), `false` for STARTTLS (port 587) |

## AGENT.md

The `AGENT.md` file defines the agent's personality, behavior guidelines, and system prompt. It is loaded and prepended to every LLM call as the system message.

The file supports optional YAML frontmatter:

```markdown
---
name: Kora
version: 0.1.0
---

# Kora — System Prompt

You are Kora. You are a personal AI assistant running as a local-first
agent runtime...

## Personality

- You keep responses short and to the point.
- You never use emojis.
...
```

If `AGENT.md` does not exist, Kora falls back to a generic system prompt: *"You are Kora, a helpful assistant."*

You can modify this file manually or through the agent itself using the `agent_prompt_read` and `agent_prompt_write` tools.

## Environment Variables

Kora reads the following environment variables:

| Variable               | Purpose                                                |
| ---------------------- | ------------------------------------------------------ |
| `HOME` / `USERPROFILE` | Used to determine the default storage path (`~/.kora`) |
| `NODE_ENV`             | Standard Node.js environment variable                  |

### System Mailer Environment Variables

The System Mailer sends transactional emails such as email verification codes and password reset codes. It is separate from the agent's email channel (which is used for conversational communication). All variables are required to enable the System Mailer.

| Variable             | Required | Description                                                                         |
| -------------------- | -------- | ----------------------------------------------------------------------------------- |
| `SYSTEM_SMTP_HOST`   | Yes      | SMTP server hostname (e.g., `smtp.gmail.com`)                                       |
| `SYSTEM_SMTP_PORT`   | Yes      | SMTP port (e.g., `587` for STARTTLS, `465` for implicit TLS)                        |
| `SYSTEM_SMTP_USER`   | Yes      | SMTP username / email address                                                       |
| `SYSTEM_SMTP_PASS`   | Yes      | SMTP password or app password                                                       |
| `SYSTEM_SMTP_FROM`   | Yes      | Sender address with optional display name (e.g., `"Kora <noreply@yourdomain.com>"`) |
| `SYSTEM_SMTP_SECURE` | No       | Set to `true` for implicit TLS (port 465). Defaults to `false` (STARTTLS).          |

Alternatively, you can store the same values in `config/system-smtp.json` under your Kora storage path. The file is a JSON object with `host`, `user`, `pass`, optional `port` (default `587`), optional `from` (defaults to `user`), and optional `boolean` `secure`. Environment variables take precedence when both are set. The interactive setup wizard can create this file when you choose multi-user mode and opt into configuring system SMTP.

If neither the environment variables nor `system-smtp.json` is configured and multi-user mode is enabled, a warning is logged at startup. Email verification and password reset via email will not be available, but users can still reset passwords via Telegram (`/resetpassword`).

### Billing Settings

Billing is configured in `settings.yml`:

```yaml
billing:
  enabled: true
  dailyLimit: 1000
  models:
    gpt-4o:
      provider: openai
      included_calls: 500
    gpt-4o-mini:
      provider: openai
      included_calls: 2000
```

| Field                                | Type    | Default | Description                                                     |
| ------------------------------------ | ------- | ------- | --------------------------------------------------------------- |
| `billing.enabled`                    | boolean | `false` | Enable billing and usage tracking                               |
| `billing.dailyLimit`                 | number  | `1000`  | Global daily LLM request limit per user. Set to `-1` to disable |
| `billing.models.<id>.provider`       | string  | —       | Provider ID for this model                                      |
| `billing.models.<id>.included_calls` | number  | —       | Per-model daily call limit (checked in addition to global)      |

The daily limit system works in two layers:
1. **Global limit** (`dailyLimit`): Caps total LLM requests per user per day across all models
2. **Per-model limits** (`included_calls`): Additional per-model caps checked after the global limit

When a limit is reached, the LLM returns an error and no further requests are processed until the next day (UTC midnight reset).

### Stripe Billing Environment Variables

Required only when using the billing feature in multi-user mode.

| Variable                | Required | Description                                                                |
| ----------------------- | -------- | -------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`     | Yes      | Stripe API secret key                                                      |
| `STRIPE_WEBHOOK_SECRET` | Yes      | Stripe webhook signing secret                                              |
| `STRIPE_PRICE_ID`       | Yes      | Stripe Price ID for the subscription product                               |
| `KORA_BASE_URL`         | Yes      | Public base URL for Stripe redirect URLs (e.g., `https://your-domain.com`) |

API keys and secrets for LLM providers should be stored in `providers.yml` and `channels.yml` rather than environment variables. The shell tool sanitizes the process environment, stripping variables that match patterns like `*_API_KEY`, `*_SECRET`, and `*_TOKEN` before executing commands.

## Modifying Settings at Runtime

The agent can read and modify its own settings through built-in tools:

- **`settings_read`** — Returns the current settings (excluding `storagePath`)
- **`settings_update`** — Updates one or more settings with a JSON object
- **`agent_prompt_read`** — Reads the current AGENT.md content
- **`agent_prompt_write`** — Replaces the AGENT.md content

Some settings are restricted and cannot be modified by the agent for security reasons:
- `storagePath`, `logLevel`, `unlimitedMode` — can only be changed by the user via Telegram commands or manual file editing
- `tools.shell` — cannot be enabled by the agent; must be enabled manually

Changes to most settings take effect immediately. Some changes (like adding a new provider or channel) require a restart.

## Related Documentation

- [Getting Started](getting-started.md) — Setup wizard walkthrough
- [Architecture](architecture.md) — How configuration flows through the system
- [Built-in Tools](tools.md) — Settings and agent prompt tools
