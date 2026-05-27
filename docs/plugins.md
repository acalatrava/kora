# Plugins

Kora supports two types of plugins: **Channel Plugins** and **Knowledge Connector Plugins**. Both are loaded from npm packages and configured via `plugins.yml`.

## Channel Plugins

Channel plugins extend Kora with new communication channels (e.g., Discord, Slack, WhatsApp).

### Interface

A channel plugin must export a default object implementing the `ChannelPlugin` interface:

```typescript
interface ChannelPlugin {
  name: string;
  version: string;
  type: 'channel';
  initialize(config: Record<string, unknown>, callbacks: ChannelCallbacks): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(identityId: string, event: OutgoingEvent): Promise<void>;
  getSetupQuestions?(): PluginSetupQuestion[];
}
```

### Callbacks

The `ChannelCallbacks` object provides:
- `onMessage(event)` — Forward incoming messages to the agent
- `resolveIdentity(channel, userId)` — Check if a user identity exists
- `registerIdentity(channel, userId, workspaceId?)` — Register a new identity

### Installation

1. Install the npm package: `npm install korabot-channel-discord`
2. Add to `config/plugins.yml`:

```yaml
- name: discord
  package: korabot-channel-discord
  type: channel
  enabled: true
  config:
    token: "your-discord-bot-token"
    guildId: "your-guild-id"
```

3. Restart Kora

### Creating a Channel Plugin

Create an npm package that exports a `ChannelPlugin`:

```javascript
export default {
  name: 'my-channel',
  version: '1.0.0',
  type: 'channel',
  
  async initialize(config, callbacks) {
    // Set up your channel client
    // Store callbacks for later use
  },
  
  async start() {
    // Start listening for messages
    // Call callbacks.onMessage() for each incoming message
  },
  
  async stop() {
    // Clean up resources
  },
  
  async send(identityId, event) {
    // Send a message to the user
  },
};
```

## Knowledge Connector Plugins

Connector plugins import external data sources into Kora's knowledge base via vector embeddings.

### Interface

```typescript
interface ConnectorPlugin {
  name: string;
  version: string;
  type: 'connector';
  initialize(config: Record<string, unknown>, callbacks: ConnectorCallbacks): Promise<void>;
  index(): Promise<void>;
  watch?(onChange: () => void): void;
  stop?(): Promise<void>;
}
```

### Built-in: Filesystem Connector

Kora includes a built-in filesystem connector that indexes text files from a directory:

```yaml
- name: docs
  package: built-in:filesystem
  type: connector
  enabled: true
  config:
    path: /path/to/documents
    watch: true
    extensions: [.md, .txt, .pdf]
    maxFileSizeKb: 512
```

Supported file types include: `.md`, `.txt`, `.csv`, `.json`, `.xml`, `.yaml`, `.yml`, `.html`, and common programming language files.

### Creating a Connector Plugin

```javascript
export default {
  name: 'my-connector',
  version: '1.0.0',
  type: 'connector',
  
  async initialize(config, callbacks) {
    // Set up connection to data source
    // Store callbacks.vectorize and callbacks.deleteVectors
  },
  
  async index() {
    // Read content from data source
    // Call callbacks.vectorize(content, metadata) for each document
    // Call callbacks.deleteVectors(field, value) to remove stale content
  },
  
  watch(onChange) {
    // Optional: watch for changes and call onChange() to trigger re-indexing
  },
};
```

## Configuration

All plugin configurations are stored in `config/plugins.yml`. The file contains an array of plugin configurations:

```yaml
- name: "unique-plugin-name"
  package: "npm-package-name"
  type: "channel" | "connector"
  enabled: true
  config:
    key1: value1
    key2: value2
```

Plugins are loaded on startup. Disabled plugins are skipped.
