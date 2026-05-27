# Troubleshooting

This guide covers common issues, debugging techniques, and solutions for Kora.

## Common Issues

### Agent Not Responding

**Symptoms**: You send a message on Telegram or email but get no response.

**Possible causes and fixes**:

1. **Kora is not running** — Check if the process is alive:
   ```bash
   kora service status
   ```
   If not running, start it:
   ```bash
   kora start
   ```

2. **Channel not connected** — Look at the startup output for channel registration:
   ```
   Channels: telegram, email
   ```
   If your channel is missing, verify it is `enabled: true` in [channels.yml](configuration.md).

3. **Chat ID not allowed** — If `allowedChatIds` is set in your Telegram config, messages from unlisted chat IDs are silently ignored. Add your chat ID to the list or remove the restriction entirely.

4. **Provider error** — The LLM provider may be unreachable or returning errors. Set `logLevel: debug` in [settings.yml](configuration.md) and check the logs for HTTP errors or timeouts.

5. **Max iterations reached** — The Dispatcher limits LLM call loops to 50 iterations per event. If the agent is stuck in a tool loop, it will eventually stop and return a truncated response. Check the [audit trail](#checking-the-audit-trail) for the session.

---

### Tool Approval Timeouts

**Symptoms**: The agent says a tool was denied, or sensitive tools never execute.

**Possible causes and fixes**:

1. **Approval expired** — Tool approval requests have a 2-minute timeout. If you don't respond in time, the tool is automatically denied with `deny_once`. React faster, or grant a standing approval ("Always Allow") for tools you trust.

2. **No notifier configured** — The approval system sends notifications via Telegram. If no Telegram channel is active, there is no way to deliver approval requests, and all sensitive tools default to `deny_once`.

3. **Always Denied** — A tool may have been permanently denied. Check and revoke via Telegram:
   ```
   /permissions
   ```
   Or use the web admin dashboard to manage standing approvals.

4. **Unlimited mode disabled** — If you previously enabled unlimited mode and it was turned off, sensitive tools will require approval again. Re-enable via Telegram:
   ```
   /unlimited on
   ```

See [Security](security.md) for the full tool approval reference.

---

### Telegram Not Connecting

**Symptoms**: `kora start` shows no Telegram channel, or the bot doesn't respond.

**Possible causes and fixes**:

1. **Invalid bot token** — Verify your token with BotFather. Tokens look like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`. Update it in [channels.yml](configuration.md).

2. **Channel disabled** — Ensure `enabled: true` in the channel config:
   ```yaml
   channels:
     - id: telegram-main
       type: telegram
       enabled: true
       config:
         token: "your-token-here"
   ```

3. **Network issues** — Kora needs outbound HTTPS access to `api.telegram.org`. Check your firewall or proxy settings.

4. **Another instance running** — Telegram only allows one active polling connection per bot token. If another instance of Kora (or another bot using the same token) is running, the connection will fail. Stop other instances first.

5. **Webhook conflict** — If the bot was previously configured with a webhook, polling may not work. Clear the webhook:
   ```bash
   curl "https://api.telegram.org/bot<YOUR_TOKEN>/deleteWebhook"
   ```

---

### Web Admin Auth Issues

**Symptoms**: Cannot log in to the web admin dashboard, or requests return 401.

**Possible causes and fixes**:

1. **Token mismatch** — The web admin URL includes a `?token=` parameter. If you lost the token, check the startup logs:
   ```
   Generated web admin token: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   Web Admin: http://localhost:3100/admin?token=xxxxxxxx-...
   ```
   Alternatively, set a fixed token in [settings.yml](configuration.md):
   ```yaml
   web_admin:
     token: "my-secret-token"
   ```

2. **Credentials not set** — If using username/password auth, make sure both are configured:
   ```yaml
   web_admin:
     username: "admin"
     password: "your-password"
   ```
   You can also set credentials via Telegram using the `/webadmin` command.

3. **Port conflict** — If port 3100 is in use, the web admin fails to start. Change the port:
   ```yaml
   web_admin:
     port: 3200
   ```

4. **Web admin disabled** — Verify it is enabled:
   ```yaml
   web_admin:
     enabled: true
   ```

See [Web Admin](web-admin.md) for more details.

---

### MCP Server Connection Failures

**Symptoms**: MCP tools are not available, or `mcp_list` shows disconnected servers.

**Possible causes and fixes**:

1. **npm package not installed** — For stdio-based MCP servers, the npm package must be installed. Kora auto-installs packages, but network issues can prevent this. Manually install:
   ```bash
   npx -y @modelcontextprotocol/server-filesystem /path/to/dir
   ```

2. **Server process crash** — Check logs for MCP-related errors. Set `logLevel: debug` to see detailed connection output.

3. **SSE endpoint unreachable** — For SSE-based MCP servers, verify the URL is accessible:
   ```bash
   curl -v http://your-mcp-server:8080/sse
   ```

4. **Configuration error** — Review the MCP config file at `~/.kora/config/mcp.json`. Ensure `args`, `env`, and `url` fields are correct.

5. **Reconnect** — Try reconnecting the server via the agent:
   ```
   "Reconnect the filesystem MCP server"
   ```
   The agent will use `mcp_reconnect` to re-establish the connection.

See [MCP](mcp.md) for server configuration details.

---

### Empty LLM Responses

**Symptoms**: The agent replies with generic messages like "I was unable to generate a response" or gives empty answers.

**Possible causes and fixes**:

1. **Invalid API key** — Verify your LLM provider API key is correct in [providers.yml](configuration.md). Test it independently:
   ```bash
   curl https://api.openai.com/v1/models \
     -H "Authorization: Bearer sk-your-key"
   ```

2. **Model not available** — The configured model may not exist or may have been deprecated. Check available models with your provider and update `defaultModel` in settings.yml.

3. **Rate limiting** — If you are hitting API rate limits, the provider may return empty or error responses. Add a delay between requests or switch to a less busy model.

4. **Token limit too low** — If `maxTokens` is set very low, the LLM may not have enough space to generate a meaningful response. Increase it:
   ```yaml
   maxTokens: 16384
   ```

5. **Think block stripping** — Some models emit `<think>` blocks. Kora strips these from the final output. If the entire response is inside a think block with no visible content, the result appears empty. This is typically a model behavior issue.

---

### Context Too Large

**Symptoms**: Slow responses, errors about context length, or frequent context compaction messages in logs.

**Possible causes and fixes**:

1. **Long conversation history** — The Dispatcher keeps up to 50 messages in history. For very long conversations, context compaction kicks in automatically. You can reset the conversation:
   - Telegram: `/reset`
   - This clears the conversation history for a fresh start

2. **Large memory file** — If `MEMORY.md` has grown very large, the context snippet (up to 8,000 characters) may consume significant context. Clean up outdated entries:
   ```
   "Review my memory and remove entries that are no longer relevant"
   ```

3. **Too many tools** — Each tool definition consumes context tokens. If you have many MCP servers, the ToolCatalog system activates automatically (threshold: 15 tools) to only load core tools. If you are still hitting limits, disable unused MCP servers.

4. **Reduce maxContextTokens** — If the model supports a smaller context window than configured, reduce it:
   ```yaml
   maxContextTokens: 128000
   ```

---

## Debugging Steps

### Enable Debug Logging

Set the log level to `debug` for maximum verbosity:

```yaml
# In settings.yml
logLevel: debug
```

Or update at runtime (requires restart to take full effect):

```bash
# Edit settings.yml directly
nano ~/.kora/config/settings.yml
```

Debug logs include:
- Every LLM request and response with token counts
- Tool call arguments and results
- Memory operations
- Heartbeat tick details
- MCP connection events
- Skill loading diagnostics

### Checking the Audit Trail

The web admin dashboard provides a full audit trail for every agent session. Navigate to:

```
http://localhost:3100/admin?token=your-token
```

The audit log records:
- `session_start` — When a new conversation session begins
- `user_msg` — Every incoming user message
- `system_prompt` — The full system prompt sent to the LLM (including memory)
- `llm_request` — Every LLM API call with message counts and tool lists
- `llm_response` — LLM responses with token usage and finish reason
- `tool_call` — Every tool invocation with arguments
- `tool_result` — Tool execution results (truncated to 500 chars)
- `context_compaction` — When context is compressed to fit the window
- `assistant_msg` — Final cleaned response sent to the user
- `session_end` — Session duration and iteration count

### Using `kora doctor`

Run the diagnostic command to check your installation:

```bash
kora doctor
```

This verifies:
- Node.js version (requires >= 20)
- Configuration files exist and are valid
- Provider API keys are set
- Channel configurations are complete
- Storage directory permissions
- Installed dependencies

---

## Environment Issues

### Node.js Version

Kora requires Node.js 20 or later. Check your version:

```bash
node --version
```

If you need to upgrade, use a version manager:

```bash
# Using nvm
nvm install 20
nvm use 20

# Using fnm
fnm install 20
fnm use 20
```

### Missing Dependencies

If you installed from source and encounter module errors:

```bash
cd /path/to/korabot
npm install
npm run build
```

For the browser tool, Puppeteer installs Chrome automatically on first use. If this fails (e.g., in a headless server environment), install Chrome manually:

```bash
npx puppeteer browsers install chrome
```

### File Permissions

Kora needs read/write access to its storage directory (default `~/.kora/`). If you see permission errors:

```bash
chmod -R 755 ~/.kora
```

The SQLite database file (`~/.kora/korabot.db`) must be writable by the Kora process.

---

## Service Management

### Checking Service Status

```bash
kora service status
```

### Starting and Stopping

```bash
kora start           # Start in foreground
kora service start   # Start as a background service
kora service stop    # Stop the background service
kora service restart # Restart the service
```

### Viewing Logs

When running as a service, logs are written to the system log. View them with:

```bash
# macOS (launchd)
tail -f ~/Library/Logs/korabot.log

# Linux (systemd)
journalctl -u korabot -f
```

---

### User Portal Issues

**Symptoms**: Cannot register, cannot log in, or email verification not working in multi-user mode.

**Possible causes and fixes**:

1. **Multi-user mode not enabled** — The User Portal is only active when `multiUser: true` is set in settings.yml. In single-user mode, visiting `/` redirects to the admin panel at `/admin`.

2. **Email verification not working** — Email verification requires the System Mailer to be configured via environment variables. Check that all `SYSTEM_SMTP_*` variables are set:
   ```bash
   SYSTEM_SMTP_HOST=smtp.gmail.com
   SYSTEM_SMTP_PORT=587
   SYSTEM_SMTP_USER=noreply@yourdomain.com
   SYSTEM_SMTP_PASS=your-app-password
   SYSTEM_SMTP_FROM="Kora <noreply@yourdomain.com>"
   ```
   If not configured, registration works but without email verification.

3. **Registration code invalid** — Registration codes expire after 10 minutes. Generate a new code by sending `/start` to the Telegram bot again.

4. **Password reset code not received** — Ensure the System Mailer is configured. Alternatively, use the Telegram `/resetpassword` command to receive the code via Telegram instead of email.

5. **"Account pending verification" error on login** — The account was created but email verification was not completed. Either:
   - Complete verification using the code sent to your email
   - Ask an administrator to manually activate the account

See [User Portal](user-portal.md) for complete documentation.

---

## FAQ

**Q: Can the agent enable the shell tool by itself?**
A: No. The `tools.shell` setting is restricted and cannot be changed by the agent. You must enable it manually in [settings.yml](configuration.md) or via Telegram.

**Q: Why does the heartbeat never fire?**
A: Check that `heartbeat.enabled` is `true` and that `HEARTBEAT.md` exists at `~/.kora/config/HEARTBEAT.md`. Also, if you are actively chatting, the heartbeat defers for 10 minutes after the last channel activity. See [Heartbeat](heartbeat.md).

**Q: How do I reset all tool approvals?**
A: Use the `/permissions` command in Telegram to view and revoke individual approvals. You can also delete the `tool_approvals` table in the SQLite database for a full reset.

**Q: The agent keeps forgetting things between sessions.**
A: Make sure the agent is using `memory_append` to save important information. Memory is per-workspace and persisted in `~/.kora/workspaces/<id>/MEMORY.md`. Check that the file exists and contains entries. See [Memory](MEMORY.md).

**Q: Can I use multiple LLM providers simultaneously?**
A: You can configure multiple providers in [providers.yml](configuration.md), but only one is active at a time (`defaultProvider` in settings.yml). You can switch providers at runtime using `settings_update`.

**Q: How do I add a new MCP server?**
A: Ask the agent directly (e.g., "Install the filesystem MCP server pointing to /home/user/docs") or use the web admin dashboard. See [MCP](mcp.md).

**Q: The web admin shows "No audit events".**
A: The audit log starts recording from the moment Kora starts. If you just started the service, send a test message to generate audit events. Older events may have been purged if the database was cleared.

**Q: How do I back up my Kora data?**
A: Back up the entire `~/.kora/` directory. This includes configuration files, the SQLite database, workspace data, memory files, and MCP configurations.

**Q: How do I access the admin panel in multi-user mode?**
A: The admin panel is always available at `/admin`. In multi-user mode, the root URL (`/`) serves the User Portal instead. Bookmark `http://localhost:3100/admin?token=...` for direct admin access.

**Q: Can users reset their password without email?**
A: Yes. Users can send `/resetpassword` to the Telegram bot to receive a reset code via Telegram. They then enter this code on the portal's "Forgot password?" page.

**Q: What happens if I don't configure the System Mailer?**
A: Without the System Mailer, email verification is skipped during registration (accounts are activated immediately) and password reset via email is unavailable. Password reset via Telegram `/resetpassword` still works.

## Related Documentation

- [Getting Started](getting-started.md) — Installation and setup
- [Configuration](configuration.md) — All configuration files
- [Security](security.md) — Tool approval and access control
- [Architecture](architecture.md) — System design and data flow
- [Web Admin](web-admin.md) — Dashboard features and API
