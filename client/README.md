# Kora Desktop Client

A cross-platform desktop client for Kora built with [Electrobun](https://electrobun.dev).

## Prerequisites

- [Bun](https://bun.sh) installed on your system
- An Kora server running in multi-user mode with the Client API enabled

## Setup

```bash
cd client
bun install
```

## Development

```bash
bun start
```

## Build

```bash
bun run build
```

## Features

- Multi-session chat interface with sidebar navigation
- Real-time streaming via WebSocket
- Dark theme with modern UI
- Auto-reconnect on connection loss
- Persistent login across restarts

## Connecting

1. Enter the server URL (e.g., `http://localhost:3100`)
2. Log in with your registered email and password
3. Create new conversations or continue existing ones

## API

The desktop client communicates via the Client REST + WebSocket API at `/api/v1/`.
See `docs/client-api.md` for the full API reference.
