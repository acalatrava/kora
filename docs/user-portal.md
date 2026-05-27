# User Portal

The User Portal is a self-service web interface for end users in multi-user (multi-tenant) mode. It allows each user to manage their own workspace, tools, MCP servers, skills, agent prompt, email delegation, and subscription — without needing access to the admin panel.

The portal is served at the root URL path (`/`). In single-user mode, visiting `/` redirects to the [Web Admin](web-admin.md) at `/admin`.

## Prerequisites

The User Portal is only active when multi-user mode is enabled in `settings.yml`:

```yaml
multiUser: true
```

For email verification and password reset functionality, configure the [System Mailer](configuration.md#system-mailer-environment-variables):

```bash
SYSTEM_SMTP_HOST=smtp.gmail.com
SYSTEM_SMTP_PORT=587
SYSTEM_SMTP_USER=noreply@yourdomain.com
SYSTEM_SMTP_PASS=your-app-password
SYSTEM_SMTP_FROM="Kora <noreply@yourdomain.com>"
SYSTEM_SMTP_SECURE=false
```

## User Registration

Registration is a multi-step process that begins on Telegram and finishes on the web portal.

### Step 1: Get a Registration Code

Send `/start` to the Kora Telegram bot. If the chat is not already linked to a user, the bot generates a **6-character registration code** (valid for 10 minutes) and provides a link to the portal.

### Step 2: Complete Registration on the Portal

Visit the portal (e.g., `http://localhost:3100/`) and click "Register with code." Fill in:

- **Registration Code** — The code received from Telegram
- **Email** — A valid email address (validated server-side)
- **Password** — Minimum 8 characters
- **Display Name** — Optional

### Step 3: Email Verification (if System Mailer is configured)

If the System Mailer is configured, the portal requires email verification:

1. After submitting the registration form, a 6-character verification code is sent to the provided email address
2. The portal displays a verification form where the user enters the code
3. Once verified, the account is activated and the user is logged in automatically
4. A "Resend code" option is available if the email was not received

If the System Mailer is **not** configured, accounts are activated immediately upon registration (no email verification).

### Step 4: Stripe Payment (if billing is enabled)

If Stripe billing is configured, the user is redirected to Stripe Checkout to complete payment before the workspace is created. After successful payment, the Stripe webhook triggers workspace creation automatically.

## Login

Registered users log in at the portal root (`/`) with their email and password.

**Error handling:**

- Invalid credentials display a clear error message
- Suspended accounts receive a "Account is suspended" message
- Accounts pending email verification receive a message prompting them to check their inbox

## Password Reset

Users who forget their password have two options:

### Via the Portal

1. On the login page, click "Forgot password?"
2. Enter the registered email address
3. If the System Mailer is configured, a 6-character reset code is sent to that email
4. Click "I already have a code" (or wait for the redirect)
5. Enter the reset code and the new password (minimum 8 characters)

### Via Telegram

1. Send `/resetpassword` to the Kora Telegram bot
2. If the chat is linked to a user account, a reset code is generated and sent back via Telegram
3. Visit the portal, click "Forgot password?" → "I already have a code"
4. Enter the reset code and the new password

Reset codes expire after a configurable time period (default 15 minutes) and can only be used once.

## Portal Pages

Once logged in, the portal provides the following sections:

### Dashboard

Displays an overview of the user's workspace:

- Current AI model and provider
- Usage statistics (requests made, tokens used)
- Subscription status (if billing is enabled)
- Workspace information

### Tools

Toggle which built-in tools the agent can use for this workspace. Each tool shows its name, category, and current enabled/disabled state. Changes take effect immediately.

### MCP Servers

Manage workspace-scoped MCP (Model Context Protocol) servers:

- **Install** — Add a new MCP server by npm package name or SSE URL
- **Remove** — Delete an MCP server from the workspace
- **View details** — See transport type, arguments, and available tools

Workspace MCP servers are isolated — they do not affect other users' workspaces or the global MCP configuration.

### Skills

Manage workspace-scoped skills:

- View installed skills and their descriptions
- Skills installed at the workspace level override global skills with the same name

### Models

Choose the default AI model for the workspace. If billing is enabled, each model shows pricing information (cost per 1K input/output tokens) and the number of included calls.

### Agent Prompt

Customize the agent's personality and behavior by editing the workspace-specific `AGENT.md`. This overrides the global system prompt for this user's interactions.

### Mail Delegation

Configure delegated email access so the agent can read and send email on behalf of the user:

- **Add delegation** — Configure a Gmail or IMAP/SMTP email account with credentials
- **Permissions** — Control whether the agent can read, send, or both
- **Auto-check** — Set an interval (in minutes) for automatic inbox polling
- **Remove** — Revoke email delegation

### My KYU Profile

View the automatically generated user profile built by the KYU (Know Your User) system. This read-only page shows what the assistant has learned about you — your interests, goals, communication preferences, professional context, and more.

The profile is updated automatically after each conversation by the `kyu_agent` internal agent. See [KYU (Know Your User)](kyu.md) for full documentation.

### Subscription (Billing)

If Stripe billing is enabled:

- View current subscription status
- Manage billing through the Stripe Customer Portal
- See usage against included quotas

## Portal API Reference

All portal API endpoints are served under `/api/`. Authenticated endpoints require the `korabot_user_session` cookie and a valid CSRF token (`X-CSRF-Token` header) for state-changing requests.

### Authentication

| Method | Endpoint          | Description                |
| ------ | ----------------- | -------------------------- |
| `POST` | `/api/register`   | Register a new account     |
| `POST` | `/api/login`      | Log in with email/password |
| `POST` | `/api/logout`     | Log out and clear session  |
| `GET`  | `/api/auth/check` | Check if session is valid  |

### Email Verification

| Method | Endpoint                   | Description               |
| ------ | -------------------------- | ------------------------- |
| `POST` | `/api/verify-email`        | Verify email with code    |
| `POST` | `/api/resend-verification` | Resend verification email |

### Password Reset

| Method | Endpoint                      | Description                      |
| ------ | ----------------------------- | -------------------------------- |
| `POST` | `/api/password-reset/request` | Request a password reset code    |
| `POST` | `/api/password-reset/confirm` | Set new password with reset code |

### Workspace Management

| Method | Endpoint                      | Description                        |
| ------ | ----------------------------- | ---------------------------------- |
| `GET`  | `/api/workspace`              | Get workspace details and settings |
| `PUT`  | `/api/workspace/settings`     | Update workspace settings          |
| `GET`  | `/api/workspace/agent-prompt` | Read workspace AGENT.md            |
| `PUT`  | `/api/workspace/agent-prompt` | Write workspace AGENT.md           |

### Tools & MCP

| Method   | Endpoint       | Description                        |
| -------- | -------------- | ---------------------------------- |
| `GET`    | `/api/tools`   | List available tools with status   |
| `PUT`    | `/api/tools`   | Update tool enabled/disabled state |
| `GET`    | `/api/mcp`     | List workspace MCP servers         |
| `POST`   | `/api/mcp`     | Install a workspace MCP server     |
| `DELETE` | `/api/mcp/:id` | Remove a workspace MCP server      |

### Skills

| Method   | Endpoint            | Description              |
| -------- | ------------------- | ------------------------ |
| `GET`    | `/api/skills`       | List workspace skills    |
| `DELETE` | `/api/skills/:name` | Remove a workspace skill |

### Mail Delegation

| Method   | Endpoint                    | Description                      |
| -------- | --------------------------- | -------------------------------- |
| `GET`    | `/api/mail-delegations`     | List configured mail delegations |
| `POST`   | `/api/mail-delegations`     | Add a mail delegation            |
| `DELETE` | `/api/mail-delegations/:id` | Remove a mail delegation         |

### Billing

| Method | Endpoint             | Description                    |
| ------ | -------------------- | ------------------------------ |
| `POST` | `/api/stripe/portal` | Get Stripe Customer Portal URL |

## Session Security

Portal sessions use HttpOnly cookies with the following properties:

| Property    | Value                  |
| ----------- | ---------------------- |
| Cookie name | `korabot_user_session` |
| HttpOnly    | Yes                    |
| SameSite    | `Strict`               |
| Path        | `/`                    |
| Max-Age     | 86400 (24 hours)       |

Additionally:

- **CSRF protection** — All non-GET requests require a valid `X-CSRF-Token` header that matches the token stored server-side for the session
- **Rate limiting** — Login, registration, and API calls are rate-limited per IP and per user
- **Bcrypt hashing** — Passwords are hashed with bcrypt (cost factor 12)
- **Session persistence** — Portal sessions are stored in SQLite, so they survive server restarts

## Related Documentation

- [Web Admin](web-admin.md) — Admin panel documentation
- [Configuration](configuration.md) — System Mailer and billing configuration
- [Security](security.md) — Authentication, CSRF, and access control details
- [Channels](channels.md) — Telegram registration and password reset commands
