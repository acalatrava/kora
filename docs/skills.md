# Skills

Kora supports a modular skill system that lets you extend the agent's capabilities with custom tools, triggers, and integrations. Skills are self-contained packages that declare their own tools, permissions, and behavior through a `SKILL.md` manifest file.

## What Is a Skill?

A skill is a plugin that adds new tools to Kora. Each skill lives in its own directory and declares:

- **Tools** — new tool definitions the LLM can call
- **Permissions** — what resources the skill needs (filesystem, network, shell)
- **Triggers** — optional events that activate the skill (cron schedules, events, commands)
- **Instructions** — optional guidance for the LLM on how and when to use the skill

Skills are loaded at startup from the skills directory (`~/.kora/skills/` or the built-in `skills_builtin/` directory inside the project).

## Directory Structure

Each skill is a directory containing at minimum a `SKILL.md` manifest file:

```
skills_builtin/
└── homeassistant_mqtt/
    └── SKILL.md          # Manifest + instructions (required)
```

For more complex skills, you can include additional files:

```
my_skill/
├── SKILL.md              # Manifest with frontmatter + instructions
├── handler.ts            # Tool handler implementation (optional)
├── config.json           # Skill-specific configuration (optional)
└── README.md             # Additional documentation (optional)
```

The only required file is `SKILL.md`. Everything the skill needs — metadata, tool definitions, permissions, triggers, and instructions — is declared in this single file.

## The SKILL.md Manifest

A `SKILL.md` file uses YAML frontmatter for structured metadata, followed by markdown content that serves as instructions for the LLM.

### Frontmatter Fields

| Field         | Type   | Required | Description                                                        |
| ------------- | ------ | -------- | ------------------------------------------------------------------ |
| `name`        | string | Yes      | Unique skill identifier                                            |
| `description` | string | Yes      | Human-readable description of what the skill does                  |
| `version`     | string | Yes      | Semantic version (e.g., `1.0.0`)                                   |
| `author`      | string | No       | Skill author name                                                  |
| `permissions` | object | No       | Required permissions (see [Permissions Model](#permissions-model)) |
| `tools`       | array  | No       | Tool definitions the skill provides                                |
| `triggers`    | array  | No       | Events that activate the skill                                     |

### Example: Home Assistant MQTT Skill

```yaml
---
name: homeassistant_mqtt
description: Integrates Kora with Home Assistant via MQTT discovery.
version: 1.0.0
author: Kora
permissions:
  network:
    allow:
      - "http://*"
      - "https://*"
  shell: false
tools:
  - name: ha_call_service
    description: Call a Home Assistant service via REST API
    parameters:
      type: object
      properties:
        domain:
          type: string
          description: Service domain (e.g., light, switch, climate)
        service:
          type: string
          description: Service name (e.g., turn_on, turn_off, toggle)
        service_data:
          type: object
          description: Payload with entity_id and optional parameters
      required:
        - domain
        - service
  - name: ha_get_states
    description: Query Home Assistant entity states via REST API
    parameters:
      type: object
      properties:
        entity_id:
          type: string
          description: The entity ID to query. If omitted, returns all entities.
triggers:
  - type: event
    value: mqtt_message
---

# Home Assistant Integration

This skill enables Kora to query and control Home Assistant
entities via the REST API. Use `ha_call_service` to control entities
and `ha_get_states` to query their current state.
```

## Tool Definitions

Each tool in the `tools` array follows the standard Kora tool definition format:

| Field         | Type   | Required | Description                                                     |
| ------------- | ------ | -------- | --------------------------------------------------------------- |
| `name`        | string | Yes      | Tool name (must be unique across all skills and built-in tools) |
| `description` | string | Yes      | What the tool does — this is shown to the LLM                   |
| `parameters`  | object | No       | JSON Schema describing accepted parameters                      |

Tool parameters use standard JSON Schema with `type`, `properties`, `required`, and `description` fields. The LLM uses these definitions to understand how to call the tool.

```yaml
tools:
  - name: my_tool
    description: Does something useful
    parameters:
      type: object
      properties:
        input:
          type: string
          description: The input to process
        verbose:
          type: boolean
          description: Whether to return detailed output
      required:
        - input
```

## Permissions Model

Skills declare the permissions they need in the `permissions` frontmatter field. The permission system provides granular control over three resource categories.

### Filesystem Permissions

Control which paths a skill can read from and write to:

```yaml
permissions:
  filesystem:
    read:
      - "/home/user/documents"
      - "/tmp/skill-data"
    write:
      - "/tmp/skill-output"
```

### Network Permissions

Control which hosts or protocols a skill can connect to:

```yaml
permissions:
  network:
    allow:
      - "https://api.example.com"
      - "mqtt://*"
```

### Shell Permissions

Control whether a skill can execute shell commands:

```yaml
permissions:
  shell: true    # Allow shell execution
  shell: false   # Deny shell execution (default)
```

### Permission Decisions

When a skill attempts to use a resource that requires permission, the `PermissionManager` checks the decision database. Decisions are stored per workspace and per skill:

| Decision | Meaning                                      |
| -------- | -------------------------------------------- |
| `allow`  | Permission has been granted                  |
| `deny`   | Permission has been denied                   |
| `ask`    | No decision recorded — user will be prompted |

Permissions are persistent. Once granted or denied, the decision is remembered for future invocations in the same workspace. You can manage permissions through the web admin dashboard or Telegram commands.

## Triggers

Skills can declare triggers that activate them automatically:

| Type      | Description             | Example                       |
| --------- | ----------------------- | ----------------------------- |
| `cron`    | Run on a cron schedule  | `0 */6 * * *` (every 6 hours) |
| `event`   | React to a named event  | `mqtt_command`                |
| `command` | React to a user command | `/myskill`                    |

```yaml
triggers:
  - type: cron
    value: "0 9 * * 1-5"
  - type: event
    value: mqtt_command
  - type: command
    value: /healthcheck
```

## Skill Registry

At startup, Kora scans the skills directory and loads all valid skills into the **SkillRegistry**. The registry:

1. **Parses** each `SKILL.md` file using `gray-matter` to extract frontmatter and instructions
2. **Validates** required fields (`name`, `description`, `version`) — skills missing these are skipped with a warning
3. **Registers** the skill manifest, making its tools available to the dispatcher
4. **Resolves** tool lookups — when the LLM calls a tool, the registry identifies which skill owns it

The registry provides these key operations:

- `register(skill)` — Add a skill to the registry
- `get(name)` — Retrieve a skill manifest by name
- `list()` — List all registered skills
- `getToolDefinitions()` — Get all tool definitions from all skills
- `findSkillForTool(toolName)` — Find which skill provides a specific tool

### How Skills Are Loaded

```
kora start
  └─ SkillRegistry.loadFromDirectory(skillsPath)
       └─ For each subdirectory:
            └─ Look for SKILL.md
                 └─ loadSkill(path)
                      ├─ Parse YAML frontmatter
                      ├─ Validate required fields
                      ├─ Normalize permissions
                      ├─ Parse tool definitions
                      ├─ Parse triggers
                      └─ Return SkillManifest
```

Skills with invalid or missing frontmatter are skipped with a warning log. The loader is resilient — a single broken skill does not prevent others from loading.

## Built-in Skills

Kora ships with the following built-in skill:

### homeassistant_mqtt

Integrates with Home Assistant via the REST API. Provides three tools:

| Tool               | Description                                                            |
| ------------------ | ---------------------------------------------------------------------- |
| `ha_get_states`    | Query entity states (single entity or all) via REST API                |
| `ha_call_service`  | Call any HA service (turn_on, turn_off, toggle, set_temperature, etc.) |
| `ha_list_services` | Discover available services per domain                                 |

This skill requires the `homeassistant_mqtt` tool to be enabled in `settings.yml` and the HA REST API configured via `tools.ha_url` and `tools.ha_token`.

## Creating a Custom Skill

Follow these steps to create and install a new skill:

### Step 1: Create the Skill Directory

```bash
mkdir -p ~/.kora/skills/my_weather_skill
```

### Step 2: Write the SKILL.md Manifest

Create `~/.kora/skills/my_weather_skill/SKILL.md`:

```markdown
---
name: my_weather_skill
description: Fetches current weather data for a given location.
version: 1.0.0
author: Your Name
permissions:
  network:
    allow:
      - "https://api.openweathermap.org"
  shell: false
tools:
  - name: weather_get_current
    description: Get current weather for a city
    parameters:
      type: object
      properties:
        city:
          type: string
          description: City name (e.g., "Madrid", "New York")
        units:
          type: string
          description: Temperature units (metric or imperial)
      required:
        - city
triggers:
  - type: command
    value: /weather
---

# Weather Skill

Fetches current weather data from OpenWeatherMap. Call `weather_get_current`
with a city name to get temperature, conditions, humidity, and wind speed.

The API key should be configured in the skill's environment or settings.
```

### Step 3: Restart Kora

```bash
kora service restart
# or stop and start manually
```

On startup, Kora will discover and load the new skill. Check the logs to confirm:

```
[info] [skills] Loaded skill "my_weather_skill" v1.0.0 (1 tools)
[info] [registry] Loaded 2 skill(s) from directory
```

### Step 4: Verify

Ask the agent to list its available tools or use `/tools` in Telegram. Your new skill's tools should appear in the list.

## Skill Loading Diagnostics

If a skill fails to load, check for these common issues:

| Problem                                         | Cause                                      | Fix                                                    |
| ----------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| "Skipping: missing required frontmatter fields" | `name` or `description` is absent          | Add the missing field to the YAML frontmatter          |
| "No SKILL.md found"                             | The skill directory has no `SKILL.md` file | Ensure the file exists and is named exactly `SKILL.md` |
| "Failed to load skill"                          | YAML parsing error                         | Check for YAML syntax issues in the frontmatter        |
| Skill loads but tools don't appear              | Tools array is malformed                   | Ensure each tool has at least a `name` field           |

Set `logLevel: debug` in [settings.yml](configuration.md) for detailed skill loading logs.

## Related Documentation

- [Built-in Tools](tools.md) — Complete reference for all tools including skill-provided ones
- [Configuration](configuration.md) — Enable skill-related tools in settings.yml
- [Security](security.md) — Tool approval flow for sensitive operations
- [Architecture](architecture.md) — How the Dispatcher routes tool calls to skills
