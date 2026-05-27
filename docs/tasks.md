# Scheduled Tasks

Kora includes a cron-based task scheduler that allows the agent to execute prompts on a recurring schedule. Tasks run autonomously — the agent receives the task prompt as input, processes it through the full dispatch loop (including tool calls), and delivers the result to the user.

## Overview

```
┌───────────────┐     cron trigger    ┌─────────────┐     dispatch    ┌─────────────┐
│  TaskScheduler│ ──────────────────▶ │  Dispatcher │ ──────────────▶ │  LLM + Tools│
│   (croner)    │                     │             │                 │             │
└───────────────┘                     └──────┬──────┘                 └─────────────┘
                                             │
                                             ▼ result
                                       ┌─────────────┐
                                       │   Channel   │
                                       │  (Telegram) │
                                       └─────────────┘
```

The scheduler uses the [croner](https://github.com/hexagon/croner) library for cron expression parsing and job management.

## Creating Tasks

### Via Conversation

Ask the agent to create a scheduled task using natural language:

> "Schedule a daily weather report at 9am"

> "Create a task that checks my server health every 30 minutes"

> "Remind me to review pull requests every weekday at 2pm"

The agent uses the `scheduler_create` tool internally, translating your request into a cron expression and a prompt.

### Via Agent Tools

The agent has direct access to scheduler tools:

```json
{
  "name": "scheduler_create",
  "arguments": {
    "name": "Daily Weather Report",
    "cron_expression": "0 9 * * *",
    "prompt": "Check the current weather for Madrid and send me a brief summary."
  }
}
```

### Via the Web Admin

Navigate to the **Tasks** page and click **+ New Task**. Fill in:

- **Task Name** — A descriptive name
- **Cron Expression** — The schedule in cron format
- **Prompt** — The instruction the agent will execute

### Via Telegram

While there is no dedicated Telegram command to create tasks, you can:

1. Ask the agent conversationally (it will use its tools)
2. Use the web admin
3. View and manage existing tasks with `/tasks`

## Cron Expressions

Kora uses standard 5-field cron expressions:

```
┌──────── minute (0-59)
│ ┌────── hour (0-23)
│ │ ┌──── day of month (1-31)
│ │ │ ┌── month (1-12)
│ │ │ │ ┌ day of week (0-7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

### Common Examples

| Expression     | Schedule                              |
| -------------- | ------------------------------------- |
| `0 9 * * *`    | Every day at 9:00 AM                  |
| `0 9 * * 1-5`  | Weekdays at 9:00 AM                   |
| `*/30 * * * *` | Every 30 minutes                      |
| `0 */2 * * *`  | Every 2 hours                         |
| `0 8,20 * * *` | At 8:00 AM and 8:00 PM                |
| `0 0 * * 0`    | Every Sunday at midnight              |
| `0 0 1 * *`    | First day of every month at midnight  |
| `15 10 * * 1`  | Every Monday at 10:15 AM              |
| `0 9 * * 1-5`  | Weekdays at 9 AM                      |
| `0 6 1,15 * *` | 1st and 15th of each month at 6:00 AM |

The croner library also supports seconds (6-field expressions) and enhanced syntax like `L` for last day of month, though standard 5-field expressions cover most use cases.

## Task Data Model

Each task is stored in SQLite with the following fields:

| Field            | Type          | Description                                      |
| ---------------- | ------------- | ------------------------------------------------ |
| `id`             | string (UUID) | Unique task identifier                           |
| `workspaceId`    | string        | Workspace the task belongs to                    |
| `name`           | string        | Human-readable name                              |
| `cronExpression` | string        | Cron schedule expression                         |
| `agentId`        | string        | Agent that executes the task (default: `"main"`) |
| `skillName`      | string?       | Optional skill to use for execution              |
| `prompt`         | string?       | The instruction sent to the agent on each run    |
| `enabled`        | boolean       | Whether the task is active                       |
| `lastRun`        | Date?         | Timestamp of the most recent execution           |
| `nextRun`        | Date?         | Calculated next execution time                   |
| `createdAt`      | Date          | When the task was created                        |

## Task Execution Flow

When a cron trigger fires:

1. **TaskScheduler** detects the cron match and invokes the handler
2. `lastRun` is updated to the current timestamp
3. `nextRun` is recalculated from the cron expression
4. The **handler** sends the task's `prompt` to the Dispatcher as a system-initiated event
5. The Dispatcher runs the full agent loop: builds context, calls the LLM, executes any tool calls, and produces a response
6. The response is delivered to the user via the configured channel (typically Telegram)
7. A **task log** entry is recorded with the status (`success` or `error`) and output

### Task Sessions

Each task execution creates its own session context. This means:

- The task prompt is processed independently from ongoing user conversations
- The agent has access to the same tools, memory, and MCP servers
- Task results appear in the audit log as separate sessions
- The agent can use multi-step reasoning and tool calls just like in interactive sessions

## Managing Tasks

### Agent Tools

| Tool                | Description                                              |
| ------------------- | -------------------------------------------------------- |
| `scheduler_create`  | Create a new task with name, cron expression, and prompt |
| `scheduler_list`    | List all tasks in the current workspace                  |
| `scheduler_pause`   | Pause a task (stops cron execution, preserves config)    |
| `scheduler_resume`  | Resume a paused task                                     |
| `scheduler_run_now` | Execute a task immediately, regardless of schedule       |
| `scheduler_delete`  | Permanently remove a task                                |

### Telegram `/tasks`

The `/tasks` command displays all tasks with interactive buttons:

```
Scheduled Tasks — 2 task(s)

🟢 Daily Weather Report [▶ active]
  Cron: 0 9 * * *
  Prompt: Check the current weather for Madrid...
  Last: Mar 7, 2026, 9:00 AM

⏸ Server Health Check [⏸ paused]
  Cron: */30 * * * *
  Prompt: Check if api.example.com is responding...

[📋 Detail] [⏸ Pause]
[🚀 Run Now] [🗑 Delete]
[↻ Refresh]
```

Available actions per task:

- **Detail** — View full task information
- **Pause / Resume** — Toggle the task's enabled state
- **Run Now** — Trigger immediate execution
- **Delete** — Remove the task (with confirmation via callback)

### Web Admin

The **Tasks** page provides a full management interface:

- View all tasks with status, cron expression, last run, and creation date
- Create new tasks with a form
- Edit existing tasks (name, cron, prompt, enabled)
- Pause/resume with a toggle
- Run immediately with the Run button
- Delete with confirmation

### REST API

| Method   | Endpoint             | Description                                        |
| -------- | -------------------- | -------------------------------------------------- |
| `GET`    | `/api/tasks`         | List all tasks                                     |
| `POST`   | `/api/tasks`         | Create a task (`name`, `cronExpression`, `prompt`) |
| `GET`    | `/api/tasks/:id`     | Get task details with recent logs                  |
| `PUT`    | `/api/tasks/:id`     | Update task fields                                 |
| `DELETE` | `/api/tasks/:id`     | Delete a task                                      |
| `POST`   | `/api/tasks/:id/run` | Trigger immediate execution                        |

## Task Logs

Every execution is logged in the `task_logs` table:

| Field        | Type    | Description                      |
| ------------ | ------- | -------------------------------- |
| `id`         | integer | Auto-incrementing log ID         |
| `taskId`     | string  | Reference to the parent task     |
| `startedAt`  | Date    | When execution began             |
| `finishedAt` | Date    | When execution completed         |
| `status`     | string  | `"success"` or `"error"`         |
| `output`     | string  | Summary of what happened         |
| `error`      | string? | Error message if the task failed |

Logs are accessible through:

- The web admin task detail view (shows the 20 most recent logs)
- The `GET /api/tasks/:id` endpoint (includes `logs` array in the response)

## Startup Behavior

When Kora starts:

1. The `TaskStore` initializes the SQLite tables (`scheduled_tasks` and `task_logs`)
2. The `TaskScheduler` loads all tasks where `enabled = true`
3. Each enabled task is scheduled with croner
4. `nextRun` is recalculated and persisted for each task

If a task's cron expression is invalid, the scheduler logs an error and skips that task without affecting others.

## Tips

- **Use descriptive prompts** — The task prompt is what the agent sees. Be specific about what you want done and how the result should be formatted.
- **Test with Run Now** — After creating a task, use "Run Now" to verify it works before waiting for the cron trigger.
- **Check the audit log** — Task executions appear as sessions in the audit log, making it easy to debug issues in the [web admin](web-admin.md).
- **Pause instead of delete** — If you want to temporarily stop a task, pause it rather than deleting it. This preserves the configuration and execution history.

## Related Documentation

- [Architecture](architecture.md) — How the scheduler fits into the dispatch loop
- [Configuration](configuration.md) — The `tools.scheduler` setting
- [Channels](channels.md) — How task results are delivered
- [Web Admin](web-admin.md) — Task management in the web interface
