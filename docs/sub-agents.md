# Sub-Agents

Sub-agents are specialized, lightweight agents that the main agent can create and dispatch tasks to. They run in parallel and return results to the main agent.

## How Sub-Agents Work

1. **Creation**: The main agent creates a sub-agent with a specific purpose, instructions, and optionally a model.
2. **Dispatch**: Tasks are sent to sub-agents via `subagent_dispatch`. Multiple tasks can run in parallel.
3. **Execution**: Each sub-agent processes its task independently with its own conversation loop.
4. **Results**: When complete, results are returned to the main agent which synthesizes and presents them to the user.

## Available Tools

### `subagent_create`

Creates a new sub-agent. Does **not** execute anything.

| Parameter       | Type   | Required | Description                                            |
| --------------- | ------ | -------- | ------------------------------------------------------ |
| `name`          | string | Yes      | Short identifier for the sub-agent                     |
| `description`   | string | Yes      | What this sub-agent specializes in                     |
| `system_prompt` | string | Yes      | Instructions defining the sub-agent's behavior         |
| `model`         | string | No       | Model ID to use (defaults to the system default model) |

### `subagent_dispatch`

Dispatches one or more tasks to sub-agents for parallel execution.

| Parameter | Type  | Required | Description                           |
| --------- | ----- | -------- | ------------------------------------- |
| `tasks`   | array | Yes      | Array of `{ agent_id, task }` objects |

### `subagent_list`

Lists all sub-agents and their current status.

### `subagent_remove`

Removes a sub-agent by ID.

| Parameter  | Type   | Required | Description                   |
| ---------- | ------ | -------- | ----------------------------- |
| `agent_id` | string | Yes      | ID of the sub-agent to remove |

## Model Selection

The main agent can choose which model each sub-agent uses. The system prompt includes an "Available Models" section listing all configured models and their roles:

```
## Available Models
- gpt-4o (provider: openai) [default, capable]
- gpt-4o-mini (provider: openai) [fast, fallback]
```

This allows the agent to assign fast models to simple tasks and capable models to complex ones.

## Failure Reporting

If a sub-agent fails during execution, `subagent_dispatch` reports the actual failure status:

```json
{
  "ok": true,
  "dispatched": true,
  "results": [
    {
      "agentId": "uuid",
      "agentName": "researcher",
      "task": "Find pricing info",
      "result": "Found pricing...",
      "status": "completed"
    },
    {
      "agentId": "uuid",
      "agentName": "analyst",
      "task": "Analyze market data",
      "result": "Error: Model rate limited",
      "status": "failed"
    }
  ]
}
```

## Fallback Model

If the primary model fails during sub-agent execution, the system automatically retries with the fallback model (if configured). This is transparent to both the main agent and user.

## User Portal

Users can manage sub-agents from the web portal under the Tools section:

- View all sub-agents with their status and assigned model
- Create new sub-agents with a model dropdown
- Delete sub-agents
- Run one-off tasks on sub-agents

## Webhooks

Each sub-agent is automatically assigned a unique webhook token (UUID) on creation. External services can trigger a sub-agent by sending a POST request to its webhook URL:

```
POST /api/webhook/subagent/{webhookToken}
Content-Type: application/json

{
  "task": "Process this incoming data..."
}
```

The webhook accepts a JSON body with a `task`, `message`, or `content` field (or a plain string). If the body is not valid JSON, the raw text is used as the task prompt.

**Response:**
```json
{
  "ok": true,
  "agentId": "uuid",
  "status": "started"
}
```

The sub-agent runs asynchronously — the webhook returns immediately after queuing the task.

### Webhook Security

- Each webhook token is a UUID v4, making it practically impossible to guess
- Webhooks are rate-limited (100 requests/minute per IP)
- Request body is limited to 512KB
- If the sub-agent is already running, the webhook returns `409 Conflict`

### Viewing Webhook URLs

- **User Portal**: The sub-agents list includes the full webhook URL for each agent
- **Main Agent Prompt**: The system prompt automatically includes webhook URLs when `KORA_BASE_URL` is configured

### Use Cases

- **GitHub Webhooks**: Create a sub-agent that processes PR reviews, issue triage, or CI failures
- **Monitoring Alerts**: Route Grafana, PagerDuty, or Uptime Robot alerts to a specialized sub-agent
- **Form Submissions**: Process contact forms or survey responses
- **IoT Events**: React to sensor data or smart home events
- **Scheduled External Triggers**: Use cron jobs or cloud schedulers to trigger periodic agent tasks

## Configuration

Sub-agents persist across sessions. They are stored in the workspace database and loaded when the agent starts. Each sub-agent is scoped to a workspace, so in multi-user mode, users only see their own sub-agents.

### Limits

- Sub-agents have a default maximum of 100 iterations per task
- Sub-agents inherit the workspace's tool configuration
- Sub-agents do not have access to the `notify` tool (they communicate via `finish`)
