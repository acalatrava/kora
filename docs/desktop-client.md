# Desktop Client

Kora includes a native desktop client built with [Electrobun](https://electrobun.dev), providing a lightweight, fast chat interface that connects to your Kora server.

## Features

- Multi-session chat with sidebar navigation
- Real-time streaming via WebSocket
- Dark theme with modern UI
- Auto-reconnect on connection loss
- Persistent login credentials
- Keyboard shortcuts (Enter to send, Shift+Enter for newline)

## Prerequisites

- [Bun](https://bun.sh) runtime installed
- An Kora server running in multi-user mode
- A registered user account with email and password

## Quick Start

```bash
cd client
bun install
bun start
```

## Connecting

1. Enter your server URL (e.g., `http://localhost:3100`)
2. Enter your email and password
3. Click "Connect"

The client remembers your credentials for future sessions.

## Using the Client

### Creating Conversations

Click the **+** button in the sidebar header to start a new conversation. The title auto-updates based on your first message.

### Sending Messages

Type in the input area and press **Enter** to send. Use **Shift+Enter** for multi-line messages. The send button activates when there's text to send.

### Real-Time Updates

When connected via WebSocket, you'll see:
- **Typing indicator** while the agent processes your message
- **Notifications** showing the agent's progress (e.g., "Searching for information...")
- **Responses** as soon as the agent finishes

### Managing Conversations

- Click a conversation in the sidebar to switch to it
- Click the 🗑 button in the chat header to delete the current conversation

### Disconnecting

Click the ⏻ button in the sidebar footer to log out and return to the login screen.

## Architecture

The desktop client uses:

- **Electrobun** — Desktop framework with native webview
- **Client API** (`/api/v1/`) — REST endpoints for sessions and messages
- **WebSocket** (`/api/v1/ws`) — Real-time streaming for live responses

All communication goes through the Client API, which handles authentication, session management, and message routing to the agent dispatcher.

## Building for Distribution

```bash
bun run build
```

This produces a native application bundle for your platform. See the [Electrobun bundling guide](https://electrobun.dev/docs/guides/bundling-and-distribution) for distribution options.

## Troubleshooting

| Issue                         | Solution                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| "Session expired" after login | Your token has expired (24h TTL). Log in again.                                    |
| WebSocket not connecting      | Ensure your server URL uses the correct protocol and port.                         |
| Messages not appearing        | Check that the server is running and accessible from your machine.                 |
| Cannot log in                 | Verify your email/password. The account must be active (not pending verification). |
