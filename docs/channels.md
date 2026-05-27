# Communication Channels

Kora communicates with users through configurable channels. Each channel translates platform-specific messages into a unified `IncomingEvent` format that the Dispatcher processes, and converts agent responses back into platform-native messages.

Currently supported channels:

| Channel  | Type       | Description                                               |
| -------- | ---------- | --------------------------------------------------------- |
| Telegram | `telegram` | Primary interactive channel via Telegram Bot API          |
| Email    | `email`    | IMAP/SMTP email channel for asynchronous communication    |
| Gmail    | `gmail`    | Gmail channel via OAuth2 API                              |
| MQTT     | `mqtt`     | Event-driven channel for IoT / Home Assistant automations |

## Telegram

Telegram is the primary real-time channel. It supports text messages, inline buttons, file attachments, voice messages, and multimodal input (images).

### Setup

1. **Create a bot** — Talk to [@BotFather](https://t.me/BotFather) on Telegram and use `/newbot` to create a new bot. Copy the API token.

2. **Get your chat ID** — Send a message to your new bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your `chat.id`.

3. **Configure in `channels.yml`**:

```yaml
channels:
  - id: telegram-main
    type: telegram
    enabled: true
    config:
      token: "123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
      allowedChatIds:
        - 123456789
```

4. **Or use the setup wizard** — Run `kora setup` and follow the prompts to configure Telegram interactively.

### Configuration Fields

| Field            | Type     | Required | Description                                                                                              |
| ---------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `token`          | string   | Yes      | Bot API token from @BotFather                                                                            |
| `allowedChatIds` | number[] | No       | Restrict access to specific Telegram chat IDs. If omitted, the bot responds to anyone (not recommended). |

### Agent Identity

Each Telegram user is identified by `telegram:<chatId>`. This identity is used to maintain separate conversation histories in multi-user mode and to route proactive messages back to the correct chat.

### Commands

The bot registers the following slash commands with Telegram:

| Command          | Description                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/start`         | Welcome message with quick-action buttons. In multi-user mode, generates a registration code for new users.      |
| `/status`        | System status (provider, model, tools, uptime)                                                                   |
| `/tasks`         | List scheduled tasks with pause/resume/run/delete buttons                                                        |
| `/tools`         | List all enabled tools                                                                                           |
| `/mcp`           | Show installed MCP servers                                                                                       |
| `/settings`      | View and toggle runtime settings                                                                                 |
| `/permissions`   | View and revoke tool approval decisions                                                                          |
| `/unlimited`     | Toggle unlimited mode (bypasses all tool approvals)                                                              |
| `/webadmin`      | Show web admin URL; set credentials with `/webadmin user pass`                                                   |
| `/heartbeat`     | View heartbeat status (enabled, interval, run count)                                                             |
| `/newsession`    | Start a fresh conversation session (clears context)                                                              |
| `/clear`         | Clear conversation history (with confirmation)                                                                   |
| `/resetpassword` | Generate a password reset code (multi-user mode). The code can be used on the User Portal to set a new password. |
| `/help`          | Show all available commands                                                                                      |

### File and Media Handling

Kora handles several types of file attachments from Telegram:

#### Receiving Files

| Type               | How It's Processed                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Photos**         | Downloaded as JPEG, stored locally. Passed to the agent as an attachment with `type: "photo"`. Supports multimodal LLM analysis when the provider supports vision. |
| **Documents**      | Downloaded with original filename and MIME type preserved. Stored locally and passed to the agent as `type: "document"`.                                           |
| **Voice messages** | Downloaded as OGG audio files. Passed to the agent as `type: "voice"`. Can be transcribed if the agent has speech-to-text capabilities.                            |
| **Videos**         | Downloaded as MP4 with original filename. Passed to the agent as `type: "video"`.                                                                                  |

Files are downloaded to `~/.kora/downloads/<type>/` (e.g., `downloads/photo/`, `downloads/document/`).

#### Sending Files

The agent can send files back through Telegram in two modes:

- **Document** — Sends any file as a Telegram document attachment with an optional caption
- **Photo** — Sends image files rendered inline in the chat with an optional caption

#### Multimodal Support

When a user sends a photo with a caption (or without), the image is:

1. Downloaded from Telegram servers
2. Stored locally
3. Passed to the Dispatcher as an `EventAttachment` with the local file path and MIME type
4. Converted to a multimodal message with `image_base64` content for LLM providers that support vision (OpenAI, Anthropic)

This enables conversations like:

> *[sends a photo of a plant]* "What kind of plant is this?"

### Message Formatting

Telegram messages use HTML formatting:

- `<b>bold</b>` for emphasis
- `<code>monospace</code>` for code and identifiers
- `<pre>blocks</pre>` for code blocks

The channel tries HTML first, falls back to Markdown, and finally sends plain text if both fail. Long messages (over 4096 characters) are automatically split across multiple messages.

### Inline Buttons and Callbacks

Many bot responses include inline keyboard buttons for quick actions. For example, the `/tasks` command shows buttons to pause, resume, run, or delete each task. The `/permissions` command shows revoke buttons for each stored approval.

Callback data follows the format `action:entity:param` (e.g., `task:pause:abc123`, `approve:always:request-uuid`).

### Tool Approval Flow

When the agent wants to execute a [sensitive tool](security.md), a Telegram message is sent with inline buttons:

```
🔧 Tool Approval Request

Tool: shell_exec
Args: { "command": "npm install express" }

[✅ Allow Once] [✅ Always Allow]
[🚫 Deny Once]  [🚫 Always Deny]
```

The agent's execution pauses until the user taps a button (2-minute timeout, after which the tool is denied).

### Proactive Messages

The agent can send messages to Telegram users without waiting for input. This happens in two cases:

1. **Scheduled tasks** — When a cron task fires, the agent executes the task prompt and sends the result to the first allowed Telegram chat
2. **Heartbeat** — Periodic autonomous check-ins send their results to Telegram

Both use the same `send()` method on the Telegram channel, routing by the stored `identityId`.

## Email

The email channel enables asynchronous communication over IMAP/SMTP. The agent polls for new emails and responds via SMTP.

### Configuration

```yaml
channels:
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

### Email Channel Config

| Field           | Type    | Required | Description                                        |
| --------------- | ------- | -------- | -------------------------------------------------- |
| `imap.host`     | string  | Yes      | IMAP server hostname                               |
| `imap.port`     | number  | Yes      | IMAP port (993 for TLS)                            |
| `imap.user`     | string  | Yes      | Email address or username                          |
| `imap.password` | string  | Yes      | Password or app password                           |
| `imap.tls`      | boolean | Yes      | Enable TLS encryption                              |
| `smtp.host`     | string  | Yes      | SMTP server hostname                               |
| `smtp.port`     | number  | Yes      | SMTP port (587 for STARTTLS, 465 for implicit TLS) |
| `smtp.user`     | string  | Yes      | SMTP username                                      |
| `smtp.password` | string  | Yes      | SMTP password                                      |
| `smtp.secure`   | boolean | Yes      | `true` for port 465, `false` for port 587          |

When the email channel is enabled, the `mail` tool set is automatically activated, giving the agent the ability to send emails and check the inbox.

## MQTT

The MQTT channel enables event-driven communication with IoT devices, smart home platforms (like Home Assistant), and any system that publishes to an MQTT broker. Messages arriving on subscribed topics are routed to the agent as incoming events.

This channel is particularly powerful when combined with the [Home Assistant REST API tool](tools.md#home-assistant-rest-api):

- **MQTT Channel** receives real-time events (e.g., "motion detected in kitchen", sensor state changes)
- **HA REST API Tool** lets the agent act on those events (e.g., "turn on the kitchen lights")

### Configuration

```yaml
channels:
  - id: mqtt-ha
    type: mqtt
    enabled: true
    config:
      broker_url: "mqtt://localhost:1883"
      username: "homeassistant"
      password: "your-mqtt-password"
      subscribe_topics:
        - "korabot/inbox"
        - "homeassistant/binary_sensor/+/state"
      response_topic: "korabot/response"
      client_id: "korabot-mqtt"
```

Or configure via the web admin panel under Configuration > Channels > Add Channel > MQTT.

### Configuration Fields

| Field              | Type     | Required | Description                                                                                  |
| ------------------ | -------- | -------- | -------------------------------------------------------------------------------------------- |
| `broker_url`       | string   | Yes      | MQTT broker URL (e.g., `mqtt://localhost:1883`, `mqtts://broker.example.com:8883`)           |
| `username`         | string   | No       | Broker authentication username                                                               |
| `password`         | string   | No       | Broker authentication password                                                               |
| `subscribe_topics` | string[] | Yes      | Topics to subscribe to. Supports MQTT wildcards (`+` for single level, `#` for multi-level). |
| `response_topic`   | string   | No       | Topic where agent replies are published. Defaults to `korabot/response`.                     |
| `client_id`        | string   | No       | MQTT client identifier. Auto-generated if omitted.                                           |

### How It Works

1. On startup, the MQTT channel connects to the broker and subscribes to all configured topics.
2. When a message arrives on a subscribed topic, it creates an `IncomingEvent` with:
   - `channel: 'mqtt'`
   - `identityId: 'mqtt:<topic>'` (e.g., `mqtt:korabot/inbox`)
   - `content`: the raw MQTT payload (string)
   - `metadata.topic`: the original MQTT topic
3. The event is routed through the Router to the Dispatcher like any other channel message.
4. Agent replies are published to the `response_topic` as JSON.

### Home Assistant Integration

To receive events from Home Assistant automations via MQTT:

1. **Enable MQTT in HA**: Install and configure the Mosquitto add-on or connect to an external broker.
2. **Create an automation in HA** that publishes to `korabot/inbox`:

```yaml
automation:
  - alias: "Notify Kora on Motion"
    trigger:
      - platform: state
        entity_id: binary_sensor.kitchen_motion
        to: "on"
    action:
      - service: mqtt.publish
        data:
          topic: "korabot/inbox"
          payload: "Motion detected in the kitchen"
```

3. **Configure the MQTT channel** in Kora to subscribe to `korabot/inbox`.
4. **Enable the HA REST API tool** so the agent can respond by controlling HA entities.

### Multi-User vs Mono-User

**Mono-user mode**: All MQTT messages are routed to the default workspace. The agent handles all events with full context.

**Multi-user mode**: MQTT messages are not automatically associated with a specific user workspace. By default, they are treated as unassigned events. To route MQTT messages to specific workspaces, you can:

- Use topic-based routing: subscribe to user-specific topics (e.g., `korabot/user1/inbox`) and configure the identity manager to map MQTT identities to workspaces
- Use a single shared workspace for IoT events and let the agent decide how to handle them

For most Home Assistant setups, mono-user mode is recommended since HA events are typically for a single household.

### Subscribing to State Changes

To monitor HA entity state changes directly via MQTT Statestream:

1. Enable [MQTT Statestream](https://www.home-assistant.io/integrations/mqtt_statestream/) in HA
2. Subscribe to specific entity topics:

```yaml
subscribe_topics:
  - "homeassistant/sensor/temperature_living_room/state"
  - "homeassistant/binary_sensor/+/state"
  - "homeassistant/light/#"
```

Be cautious with broad wildcards (`#`) as they can generate high message volumes.

### Troubleshooting

| Issue                                     | Solution                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| Connection refused                        | Verify broker URL and credentials. Check that the broker is running.                          |
| No messages received                      | Verify topic names match exactly. Check HA automation is firing. Use `mosquitto_sub` to test. |
| Messages arrive but agent doesn't respond | Check agent logs. Verify the MQTT channel is enabled and the subscribe topics match.          |

## Channel Architecture

All channels implement a common pattern:

```
External Platform ──▶ Channel ──▶ IncomingEvent ──▶ Router ──▶ Dispatcher
                                                                    │
External Platform ◀── Channel ◀── OutgoingEvent ◀── Router ◀────────┘
```

### IncomingEvent

```typescript
interface IncomingEvent {
  channel: string;       // "telegram" | "email" | "mqtt"
  identityId: string;    // e.g., "telegram:123456789", "mqtt:korabot/inbox"
  type: string;          // "message" | "command" | "callback" | "email"
  content: string;       // Text content of the message
  attachments?: EventAttachment[];
  metadata?: Record<string, unknown>;
  raw?: unknown;         // Original platform-specific message
}
```

### EventAttachment

```typescript
interface EventAttachment {
  type: "photo" | "document" | "voice" | "audio" | "video" | "sticker";
  fileId: string;
  fileName?: string;
  mimeType?: string;
  localPath?: string;    // Path after download
  caption?: string;
}
```

## Related Documentation

- [Getting Started](getting-started.md) — Channel setup in the wizard
- [Configuration](configuration.md) — Channel configuration reference
- [Security](security.md) — Allowed chat IDs and access control
- [Tasks](tasks.md) — Proactive messages from scheduled tasks
- [Tools — Home Assistant](tools.md#home-assistant-rest-api) — HA REST API tool for controlling smart home devices
