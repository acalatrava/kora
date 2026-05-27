# Security

Kora implements multiple layers of security to protect against unauthorized access, accidental damage, and token theft. This document covers the tool approval system, web admin authentication, channel access control, and data protection.

## Tool Approval System

The agent has access to powerful tools — shell commands, MCP server installation, settings modification, and more. The **ToolApprovalManager** acts as a security gate, requiring explicit user approval before sensitive tools execute.

### Sensitive Tools

The following tools are classified as sensitive and always require approval (unless unlimited mode or a standing approval is active):

| Tool                 | Risk                                            |
| -------------------- | ----------------------------------------------- |
| `shell_exec`         | Executes arbitrary shell commands               |
| `mcp_install`        | Installs and runs external MCP server processes |
| `mcp_remove`         | Removes MCP server configurations               |
| `settings_update`    | Modifies runtime configuration                  |
| `agent_prompt_write` | Rewrites the agent's system prompt              |

### Approval Decisions

When the agent requests a sensitive tool, four options are presented:

| Decision         | Effect                                                       |
| ---------------- | ------------------------------------------------------------ |
| **Allow Once**   | Permits this single execution; asks again next time          |
| **Always Allow** | Stores a standing approval for this tool in this workspace   |
| **Deny Once**    | Blocks this single execution; asks again next time           |
| **Always Deny**  | Permanently blocks this tool in this workspace until revoked |

Standing decisions (`allow_always` / `deny_always`) are persisted in SQLite and survive restarts.

### Approval Flow

```
Agent wants to call shell_exec
        │
        ▼
ToolApprovalManager.requestApproval()
        │
        ├── Unlimited mode ON? ──▶ Auto-approve
        ├── Always denied? ──────▶ Deny immediately
        ├── Standing approval? ──▶ Allow immediately
        │
        ▼
Send approval request to Telegram
(inline buttons: Allow Once / Always / Deny Once / Always Deny)
        │
        ├── User taps button ──▶ Resolve with chosen decision
        └── 2 minutes timeout ──▶ Deny (timeout)
```

### Dangerous Command Blocking

Even beyond the approval system, certain shell commands are **blocked outright** and cannot be approved. These patterns are detected before the approval request is sent:

| Pattern                          | Example                              |
| -------------------------------- | ------------------------------------ |
| `rm -rf /` variants              | Recursive deletion of root           |
| `mkfs`                           | Filesystem formatting                |
| `dd of=/dev/`                    | Raw disk writes                      |
| `shutdown`, `reboot`, `poweroff` | System power commands                |
| `curl \| sh`, `wget \| sh`       | Piped remote code execution          |
| `chmod 777 /`                    | Dangerous permission changes on root |
| Fork bombs                       | `:(){ :\|:& };:`                     |
| `eval $()`                       | Dynamic code execution               |

These are rejected with a descriptive error message regardless of approval status or unlimited mode.

### Managing Permissions

**View stored permissions:**

- Telegram: `/permissions` — shows all stored decisions with revoke buttons
- Web admin: visible in the Tools & MCP section

**Revoke a stored permission:**

- Telegram: tap the "Revoke" button next to any permission in `/permissions`
- This deletes the stored decision; the tool will ask for approval again on next use

### Unlimited Mode

Unlimited mode bypasses all tool approvals. When enabled, every sensitive tool is auto-approved without asking.

**Enabling:**

1. Telegram: `/unlimited` → read the warning → tap "I understand, enable it"
2. The agent **cannot** enable unlimited mode itself — only the user can

**Disabling:**

1. Telegram: `/unlimited` → tap "Disable Unlimited Mode"

**Security warning:** Unlimited mode means the agent can run arbitrary shell commands, install software, modify its own configuration, and rewrite its system prompt without asking. Only enable this on sandboxed or disposable environments.

## Web Admin Authentication

The web admin dashboard (served at `/admin`) uses a cookie-based authentication model following security best practices.

### Authentication Methods

The web admin supports two login methods:

1. **Username & Password** — Set via Telegram with `/webadmin username password` (the message is auto-deleted for security)
2. **Access Token** — Generated automatically on first start and printed to the console output

### Session Security

| Property    | Value                               |
| ----------- | ----------------------------------- |
| Cookie name | `korabot_session`                   |
| HttpOnly    | Yes — not accessible via JavaScript |
| SameSite    | `Strict` — prevents CSRF attacks    |
| Secure      | Set when available (HTTPS)          |
| Max-Age     | 86400 seconds (24 hours)            |
| Path        | `/`                                 |

When a user logs in:

1. The server validates credentials against stored values
2. On success, a `crypto.randomUUID()` session ID is generated
3. The session ID is set as an HttpOnly cookie
4. The session ID is stored server-side in a `Map<string, number>` with creation timestamp
5. Subsequent requests are authenticated by the cookie
6. Sessions expire after 24 hours

### Token-Based Access

For programmatic access or initial setup:

- A bearer token can be passed via the `Authorization: Bearer <token>` header
- A `?token=<token>` query parameter is accepted on `/admin?token=...` (redirects to set a cookie and remove the token from the URL)
- The token is printed to the console on startup for easy access:
  ```
  Web Admin: http://localhost:3100/admin?token=abc123...
  ```

### Logout

```
POST /admin/api/logout
```

The server clears the session cookie by setting `Max-Age=0`, effectively invalidating the session.

### Two-Factor Authentication

Both the admin panel and user portal support two-factor authentication:

| Method      | Description                                 |
| ----------- | ------------------------------------------- |
| **TOTP**    | Time-based codes via authenticator apps     |
| **Passkey** | WebAuthn/FIDO2 hardware keys and biometrics |

2FA is offered during login. Users can skip the setup temporarily and configure it later. A 2FA method is not considered active until it has been fully verified (TOTP code validated, or passkey successfully registered). This prevents partially configured 2FA from locking users out.

### Security Headers

All responses include:

| Header                      | Value                                                      | Purpose                               |
| --------------------------- | ---------------------------------------------------------- | ------------------------------------- |
| `X-Content-Type-Options`    | `nosniff`                                                  | Prevents MIME-type sniffing           |
| `X-Frame-Options`           | `DENY`                                                     | Prevents clickjacking via iframes     |
| `X-XSS-Protection`          | `1; mode=block`                                            | XSS filter hint                       |
| `Referrer-Policy`           | `no-referrer`                                              | Prevents referrer leakage             |
| `Content-Security-Policy`   | `default-src 'self'; script-src 'self' https://esm.sh ...` | Restricts resource loading origins    |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`                      | Forces HTTPS for 1 year               |
| `Permissions-Policy`        | `camera=(), microphone=(), geolocation=()`                 | Disables unnecessary browser features |
| `Cache-Control`             | `no-store`                                                 | Prevents caching of sensitive data    |

### WebSocket Authentication

WebSocket connections to the live log at `/admin/ws` are authenticated using:

1. A `?token=` query parameter in the WebSocket URL
2. The `korabot_session` cookie

Unauthenticated WebSocket connections are rejected with a 401 status.

### Secret Redaction

When configuration files are served through the web admin API, sensitive values matching patterns like `api_key`, `token`, `password`, and `secret` are partially redacted (first 4 characters shown, rest replaced with asterisks).

## User Portal Authentication

The user portal (served at `/`) uses a separate cookie-based session model with CSRF protection. Portal sessions are stored in SQLite (not in-memory), so they survive server restarts.

### Session Security

| Property    | Value                  |
| ----------- | ---------------------- |
| Cookie name | `korabot_user_session` |
| HttpOnly    | Yes                    |
| SameSite    | `Strict`               |
| Path        | `/`                    |
| Max-Age     | 86400 (24 hours)       |
| Storage     | SQLite (persistent)    |

### CSRF Protection

All non-GET portal API requests must include a valid `X-CSRF-Token` header. The CSRF token is generated when the session is created and returned to the frontend during the auth check response. This prevents cross-site request forgery attacks.

### Password Storage

User passwords are hashed using **bcrypt** with a cost factor of 12 before storage. Plain-text passwords are never stored or logged.

### Rate Limiting

Multiple layers of rate limiting protect against brute-force and DDoS attacks:

| Scope                     | Limit        | Window     |
| ------------------------- | ------------ | ---------- |
| Global (all endpoints)    | 100 per IP   | 1 minute   |
| Login attempts            | 5 per IP     | 15 minutes |
| Registration attempts     | 5 per IP     | 15 minutes |
| Password reset            | 5 per IP     | 15 minutes |
| API calls (authenticated) | 100 per user | 1 minute   |
| Webhooks                  | 100 per IP   | 1 minute   |
| Client API login          | 10 per IP    | 15 minutes |

### Request Size Limits

| Type         | Maximum Size |
| ------------ | ------------ |
| API body     | 512 KB       |
| File uploads | 10 MB        |

### Email Verification

When the System Mailer is configured, new user accounts require email verification:

1. After registration, the account is set to `pending_verification` status
2. A 6-character alphanumeric verification code is sent to the user's email
3. The user enters the code on the portal to activate the account
4. Verification codes expire after 15 minutes
5. Each code can only be used once

### Password Reset Security

Password reset codes follow the same security model as verification codes:

- 6-character alphanumeric codes
- Expire after 15 minutes
- Single-use (marked as used after successful reset)
- Available via email (System Mailer) or Telegram (`/resetpassword` command)
- Rate-limited to prevent abuse

## Telegram Access Control

### allowedChatIds

The `allowedChatIds` field in the Telegram channel configuration restricts which Telegram users can interact with the bot:

```yaml
channels:
  - id: telegram-main
    type: telegram
    enabled: true
    config:
      token: "..."
      allowedChatIds:
        - 123456789    # Your Telegram user chat ID
        - 987654321    # Another authorized user
```

- If `allowedChatIds` is set, only messages from listed chat IDs are processed
- If omitted, the bot responds to **anyone** — this is not recommended for production
- Unauthorized messages are silently ignored (no error response is sent)
- The check runs on every handler: text messages, commands, callbacks, and file uploads

### Getting Your Chat ID

1. Send any message to the bot
2. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. Find `"chat": { "id": 123456789 }` in the response
4. Add that number to `allowedChatIds`

## Data Storage Security

### SQLite Database

The main database (`~/.kora/korabot.db`) stores:

- Identity mappings
- Workspace configurations
- Tool approval decisions
- Audit log entries
- Scheduled tasks and logs

The database file permissions are set by the operating system's default umask. For production deployments, ensure the `~/.kora/` directory is readable only by the running user:

```bash
chmod 700 ~/.kora
```

### API Keys

API keys for LLM providers are stored in `providers.yml`. This file should be treated as sensitive:

- Never commit it to version control
- The shell tool automatically strips environment variables matching `*_API_KEY`, `*_SECRET`, and `*_TOKEN` before executing commands, preventing the agent from accidentally leaking keys through shell output
- The web admin redacts secrets when displaying configuration files

### Downloads

Files received from Telegram (photos, documents, voice messages) are stored per-workspace at `~/.kora/workspaces/{workspace-id}/work/downloads/`. Each workspace's files are isolated from other workspaces. Files persist until manually deleted.

## MCP Server Sandboxing

MCP servers run as separate processes. Security considerations:

- **stdio servers** run as child processes with the same OS-level permissions as Kora
- **SSE servers** are accessed over HTTP; authentication is handled via environment variables passed as headers
- The `mcp_install` tool is classified as sensitive and requires approval
- Environment variables configured for MCP servers are stored in `mcp.yml` in plain text — treat this file as sensitive

### Tool-Level Filtering

Each MCP server can be configured with `allowedTools` and `blockedTools` lists in `mcp.yml`:

```yaml
servers:
  - id: filesystem-server
    name: Filesystem
    # ...
    allowedTools:
      - read_file
      - list_directory
    blockedTools:
      - delete_file
      - write_file
```

- `allowedTools` — only these tools are exposed to the agent; all others are hidden
- `blockedTools` — these tools are hidden; all others are exposed
- If both are set, `blockedTools` takes precedence (blocked tools are removed even if listed in allowed)
- If neither is set, all tools from the server are exposed

### Recommendations

- Only install MCP servers from trusted sources
- Use `allowedTools` / `blockedTools` to restrict which operations the agent can perform
- Review the tools an MCP server exposes before enabling it
- Use `allowedPaths` or similar restrictions when configuring filesystem MCP servers
- For SSE servers, use HTTPS and authentication tokens

## Shell Sandbox

Kora supports container-based sandboxing for shell commands and file operations. When enabled, all `shell_exec` calls and `file_*` tool operations run inside an isolated environment with restricted filesystem and network access.

### Sandbox Backends

The sandbox system supports multiple backends with automatic detection:

| Backend            | Platform        | Priority | Description                                                                  |
| ------------------ | --------------- | -------- | ---------------------------------------------------------------------------- |
| **Docker**         | Inside Docker   | 1        | Spawns sibling containers via Docker socket with per-workspace volume mounts |
| **Firejail**       | Linux (bare)    | 1        | Profile-based sandboxing with blacklists, seccomp, and resource limits       |
| **macOS Seatbelt** | macOS           | 2        | Apple's built-in `sandbox-exec` with custom deny/allow profiles              |
| **Docker**         | Any (bare host) | 3        | Full container isolation with resource limits and volume mounts              |

In **auto** mode (recommended), Kora probes for available backends at startup. When running inside Docker, firejail is automatically disabled (it cannot create namespaces inside containers) and the Docker backend is preferred.

### Docker Deployment (Recommended)

When deploying with Docker, the sandbox uses **sibling containers**: the main Kora container spawns isolated Docker containers for each shell command, mounting only the active workspace directory.

Required docker-compose configuration:

```yaml
volumes:
  - korabot-data:/data
  - /var/run/docker.sock:/var/run/docker.sock
environment:
  - SANDBOX_DOCKER_VOLUME=korabot-data
```

- `/var/run/docker.sock` — gives Kora access to the Docker daemon to spawn sandbox containers
- `SANDBOX_DOCKER_VOLUME` — the named volume that holds `/data`, so sandbox containers can mount workspace subdirectories directly via `volume-subpath`

Each sandbox container runs with: `--network none`, `--read-only`, `--security-opt no-new-privileges`, memory/CPU/PID limits, and only the workspace work+skills directories mounted read-write.

#### Container Pooling

By default, each `shell_exec` call creates and destroys a Docker container. For workloads with frequent shell commands, set `dockerKeepAlive` (seconds) to reuse containers:

```yaml
shell_sandbox:
  dockerKeepAlive: 600  # keep containers alive for 10 minutes after last use
```

When enabled, one container is maintained per workspace. Commands execute via `docker exec` instead of `docker run`, eliminating the container creation overhead (~1-3s per command). Idle containers are automatically reaped after the configured timeout, and all pooled containers are cleaned up on application shutdown.

### Environment Variable Protection

Sandbox processes (all backends) receive a minimal whitelist of safe environment variables: `PATH`, `HOME`, `LANG`, `TERM`, `TZ`, `TMPDIR`, and locale settings. API keys, tokens, database credentials, and other secrets from the parent process are **never** passed to the sandboxed command. Only explicitly configured `customEnv` values are forwarded.

### Defense in Depth (File Tools)

File tools (`file_read_text`, `file_write_text`, `file_list`, `file_edit_text`, `file_delete`) enforce `allowedPaths` validation at the application level **before** delegating to the sandbox. Even if the sandbox backend has a vulnerability, the Node.js process blocks access to paths outside the workspace. Symlink traversal is prevented by resolving real paths before validation.

### Configuration

Sandbox settings are configured in `settings.yml` under `shell_sandbox`:

```yaml
shell_sandbox:
  enabled: true
  backend: auto              # auto | docker | macos_seatbelt | firejail
  networkAccess: false       # block network from sandbox
  memoryLimitMb: 512         # memory limit
  image: node:22-bookworm-slim  # Docker image (docker backend only)
  dockerKeepAlive: 600       # keep sandbox containers alive for 10 min (0 = disabled)
  mounts:
    - hostPath: /data/shared
      containerPath: /data/shared
      mode: rw         # rw or ro
```

### Workspace Directories

Each user workspace automatically gets a dedicated **work directory** mounted as read-write inside the sandbox:

```
~/.kora/workspaces/{workspace-id}/work/
```

This is the default working directory for all sandboxed commands. The agent can create, edit, and delete files freely within this directory.

### Per-Workspace Downloads

Files received from users (via Telegram, email, etc.) are stored in a **workspace-private** downloads directory:

```
~/.kora/workspaces/{workspace-id}/work/downloads/
```

Each workspace has its own isolated downloads directory. In multiuser mode, **users cannot access other users' downloads** — the sandbox only mounts the current workspace's work directory. Files are initially downloaded to a temporary staging area and relocated to the workspace-specific directory once the dispatcher identifies the workspace.

Since the downloads directory lives inside the workspace `work/` folder, it is automatically accessible within the sandbox (read-write). The agent can read user-sent attachments directly from this path.

### Filesystem Mounts

Additional host paths can be mounted into the sandbox through the web admin security panel or `settings.yml`. These mounts are **shared across all users** — any path configured here is accessible to every workspace.

| Mount Type        | Description                                    |
| ----------------- | ---------------------------------------------- |
| `rw` (read-write) | Full read and write access to the mounted path |
| `ro` (read-only)  | Read-only access; writes are blocked           |

### Network Access

By default, sandboxed commands have **no network access**. This prevents the agent from making unauthorized network requests, exfiltrating data, or downloading malicious payloads. Enable `networkAccess` only if the agent needs to interact with external services from shell commands.

### System Prompt Integration

When sandbox is active, the agent's system prompt automatically includes information about:
- Which sandbox backend is active
- Which directories are accessible and their access mode (rw/ro)
- Whether network access is available
- Memory limits

This ensures the agent is aware of its constraints and does not attempt operations that would fail.

## Security Checklist

- [ ] Set `allowedChatIds` in Telegram config to restrict access
- [ ] Set a strong web admin password via `/webadmin username password`
- [ ] Enable 2FA (TOTP or Passkey) on the admin panel
- [ ] Keep `tools.shell` disabled unless needed (it's off by default)
- [ ] Enable shell sandbox when `tools.shell` is enabled
- [ ] Leave sandbox `networkAccess` disabled unless specifically needed
- [ ] Leave unlimited mode disabled in production
- [ ] Restrict `~/.kora/` directory permissions to the running user
- [ ] Review MCP server tools before approving `mcp_install`
- [ ] Review sandbox mount paths — they are shared across all users
- [ ] Use HTTPS for web admin and portal in production (reverse proxy with TLS)
- [ ] Set `KORA_BASE_URL` for correct origin detection behind reverse proxies
- [ ] Regularly review stored tool permissions via `/permissions`
- [ ] Configure `SYSTEM_SMTP_*` for email verification in multi-user mode
- [ ] Set strong Stripe webhook secret when billing is enabled
- [ ] Keep sub-agent webhook tokens secret — they grant unauthenticated trigger access
- [ ] Configure appropriate `dailyLimit` in billing settings to prevent abuse

## Related Documentation

- [Configuration](configuration.md) — Web admin, System Mailer, and tool security settings
- [Channels](channels.md) — Telegram `allowedChatIds` configuration
- [MCP](mcp.md) — MCP server security considerations
- [Web Admin](web-admin.md) — Admin panel authentication and access control
- [User Portal](user-portal.md) — Portal authentication and CSRF protection
