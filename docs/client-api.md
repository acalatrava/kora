# Client API

Kora provides a REST + WebSocket API for external clients (desktop apps, mobile apps, custom integrations) to connect and interact with the agent.

The Client API is automatically enabled in multi-user mode when the web admin server is running.

## Base URL

All API endpoints are prefixed with `/api/v1/`. For example, if your server runs on `http://localhost:3100`, the login endpoint is:

```
POST http://localhost:3100/api/v1/auth/login
```

## Authentication

All endpoints (except login) require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <token>
```

### Login

```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "your-password"
}
```

**Responses:**

- `{ "ok": true, "token": "...", "user": {...} }` — success, no 2FA needed
- `{ "needs2FASetup": true, "tempToken": "..." }` — first login, 2FA setup required
- `{ "needs2FA": true, "method": "totp|passkey", "tempToken": "...", ... }` — 2FA verification required

### 2FA Setup (TOTP)

```
POST /api/v1/auth/2fa/setup/totp
{ "tempToken": "..." }

→ { "ok": true, "tempToken": "...", "qrCodeDataUrl": "...", "secret": "..." }
```

```
POST /api/v1/auth/2fa/setup/totp/verify
{ "tempToken": "...", "code": "123456" }

→ { "verified": true, "token": "..." }
```

### 2FA Setup (Passkey)

```
POST /api/v1/auth/2fa/setup/passkey/register-options
{ "tempToken": "..." }

→ { "ok": true, "options": {...}, "tempToken": "...", "challengeKey": "..." }
```

```
POST /api/v1/auth/2fa/setup/passkey/register
{ "tempToken": "...", "challengeKey": "...", "credential": {...} }

→ { "verified": true, "token": "..." }
```

### 2FA Verification

```
POST /api/v1/auth/2fa/verify/totp
{ "tempToken": "...", "code": "123456" }

POST /api/v1/auth/2fa/verify/passkey
{ "tempToken": "...", "challengeKey": "...", "credential": {...} }
```

### Logout

```
POST /api/v1/auth/logout
Authorization: Bearer <token>
```

## REST Endpoints

| Endpoint                        | Method | Description           |
| ------------------------------- | ------ | --------------------- |
| `/api/v1/me`                    | GET    | Current user info     |
| `/api/v1/sessions`              | GET    | List chat sessions    |
| `/api/v1/sessions`              | POST   | Create a new session  |
| `/api/v1/sessions/:id`          | GET    | Get session details   |
| `/api/v1/sessions/:id`          | DELETE | Delete a session      |
| `/api/v1/sessions/:id/messages` | GET    | Get session messages  |
| `/api/v1/sessions/:id/messages` | POST   | Send a message        |
| `/api/v1/models`                | GET    | List available models |

## WebSocket

### Connection

```
ws://localhost:3100/api/v1/ws?token=<auth-token>&session=<session-id>
```

The `token` is obtained from the login response. The `session` parameter specifies which chat session to connect to.

### Incoming Messages (Server → Client)

#### Assistant Message

```json
{
  "type": "assistant",
  "content": "Here's what I found...",
  "timestamp": "2026-03-20T10:30:00Z"
}
```

#### Tool Status

Sent when the agent starts or finishes executing a tool:

```json
{
  "type": "tool_status",
  "tool": "web_search",
  "phase": "start"
}
```

```json
{
  "type": "tool_status",
  "tool": "web_search",
  "phase": "end"
}
```

Clients can use this to display "Running web_search..." instead of a generic typing indicator.

#### Typing Indicator

```json
{
  "type": "typing",
  "active": true
}
```

### Outgoing Messages (Client → Server)

```json
{
  "models": [
    {
      "id": "gpt-4o",
      "name": "gpt-4o",
      "provider": "openai",
      "roles": ["default", "capable"]
    }
  ]
}
```

## Rate Limits

The API is rate-limited to 100 requests per minute per authenticated user. WebSocket connections do not count toward this limit.

## Desktop Client

Kora includes a desktop client built with Electrobun. See the `client/` directory and `docs/desktop-client.md` for details.
