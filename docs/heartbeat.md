# Heartbeat

The heartbeat system gives Kora the ability to wake up autonomously at regular intervals, review pending work, monitor systems, and take proactive action — even when no user message has been received.

## What Is the Heartbeat?

Most chatbots are purely reactive: they respond only when spoken to. Kora's heartbeat transforms it into a **proactive agent** that periodically checks in, follows up on unfinished tasks, monitors services, and anticipates user needs.

Each heartbeat tick is a full agent invocation — the agent receives a prompt, has access to all its tools (memory, shell, browser, scheduler, MCP tools), and can take real actions or send messages to the user.

## How It Works

1. **Timer fires** — A periodic interval timer triggers a heartbeat tick
2. **Activity check** — If the user has been active in any channel within the last 10 minutes, the tick is deferred to avoid interrupting active conversations
3. **Concurrency guard** — If a previous heartbeat is still running, the tick is skipped
4. **Prompt loaded** — The heartbeat prompt is read from `~/.kora/config/HEARTBEAT.md`
5. **Context injected** — The current timestamp, tick number, and last run time are prepended to the prompt
6. **Agent runs** — The Dispatcher processes the heartbeat as an internal event with full tool access
7. **Result handled** — If the agent produces meaningful output (not "NOTHING TO DO"), it is sent to the user via Telegram

### Persistent Session

The heartbeat uses a dedicated, persistent session (`heartbeat:default`). This means the agent retains conversational context across heartbeat ticks — it remembers what it did on the previous tick and can build on it.

## Configuring the Heartbeat

### settings.yml

The heartbeat is controlled by two settings in [settings.yml](configuration.md):

```yaml
heartbeat:
  enabled: true
  intervalMinutes: 5
```

| Setting                     | Type    | Default | Description                             |
| --------------------------- | ------- | ------- | --------------------------------------- |
| `heartbeat.enabled`         | boolean | `true`  | Enable or disable the heartbeat system  |
| `heartbeat.intervalMinutes` | number  | `5`     | Minutes between heartbeat ticks         |
| `heartbeat.concurrency`     | number  | `5`     | Max parallel heartbeat runs (multiuser) |

To disable the heartbeat entirely:

```yaml
heartbeat:
  enabled: false
```

You can also change the interval at runtime through the agent:

```
"Change my heartbeat interval to 15 minutes"
```

The agent will use `settings_update` to modify the configuration. Note that interval changes take effect after the next restart.

### Per-User Disable

In multiuser mode, individual users can disable the heartbeat for their workspace through the **User Portal > Tools > Heartbeat** toggle. This only affects their workspace; other users' heartbeats continue normally.

### Timing Behavior

- **First tick**: Runs 30 seconds after `kora start` to allow all services to initialize
- **Subsequent ticks**: Run at the configured interval (default: every 5 minutes)
- **Idle deferral**: If any channel has received user activity in the last 10 minutes, the heartbeat is deferred. This prevents the agent from interrupting active conversations.
- **Concurrency**: Only one heartbeat tick runs at a time. If a tick takes longer than the interval, the next tick is skipped.

### Parallel Execution (Multiuser)

In multiuser mode, heartbeats for different workspaces run **in parallel** with a configurable concurrency limit (default: 5). This prevents one slow heartbeat from blocking others. Configure via `heartbeat.concurrency` in settings.yml.

### Notification Noise Reduction

The heartbeat system includes built-in protection against noisy notifications. Even if the LLM ignores prompt instructions and tries to send a "nothing new" message:

1. The prompt explicitly instructs the agent to only notify when it has performed a concrete action with new results
2. A heuristic filter detects and suppresses common noise patterns like "everything is fine", "no updates", or "checked and found nothing"
3. Suppressed notifications are logged for debugging but never delivered to the user

## The Heartbeat Prompt

The heartbeat prompt is loaded from `~/.kora/config/HEARTBEAT.md`. This file defines what the agent should do when it wakes up autonomously.

### Default Template

```markdown
# Kora Heartbeat

You are waking up autonomously. This prompt runs periodically in the background.
You are a proactive personal assistant — not a passive tool waiting for commands.

## Your Mission

Think of yourself as a dedicated assistant who genuinely wants to help the user
succeed in their work and life. Be resourceful, anticipate needs, and take initiative.

## What To Do

1. **Review pending work**: Check scheduled tasks, past conversations, and anything
   left unfinished. Follow up or complete it.
2. **Monitor systems**: If you have access to services, APIs, or infrastructure,
   check their health. Fix problems before the user notices.
3. **Anticipate needs**: Based on what you know about the user (from memory), think
   about what they might need soon. Prepare information, draft messages, or organize data.
4. **Learn and improve**: If you notice inefficiencies in how tasks are run, suggest
   or implement improvements. Update your memory with useful findings.
5. **Stay informed**: Use web search or other tools to check for relevant news,
   updates, or changes that affect the user's projects or interests.

## Rules

- If there is genuinely nothing useful to do, respond with "NOTHING TO DO"
  — do not waste resources.
- Do NOT spam the user. Only send a message if you have something actionable
  or genuinely valuable.
- Keep proactive messages concise and actionable — lead with what you did or
  what the user should know.
- You have access to all your tools during heartbeat — use them.
- Save anything you learn or do to memory so you have context for next time.
- If a task failed previously, retry it or find a workaround.
```

### Contextual Metadata

Before the heartbeat prompt is sent to the LLM, Kora prepends contextual metadata:

```
[HEARTBEAT] Current time: 2026-03-08T14:30:00.000Z
[HEARTBEAT] Tick #12
[HEARTBEAT] Last run: 2026-03-08T14:25:00.000Z

(your HEARTBEAT.md content here)

This is an autonomous heartbeat task. You are waking up on your own.
Review if there is anything pending, anything you should check on,
or any proactive action to take. If there is nothing to do, simply
respond with "nothing to do" and call finish(). Keep it brief.
```

## What the Agent Does During Heartbeat

During each heartbeat tick, the agent has full access to all enabled tools and follows the instructions in the heartbeat prompt. Typical actions include:

### Review Pending Work
The agent checks scheduled tasks, reviews recent conversation history, and follows up on unfinished items. If a task was started but not completed in a previous session, the agent can resume it.

### Monitor Systems
With tools like `shell_exec`, `browser_navigate`, and MCP integrations, the agent can check server health, API status, or infrastructure metrics. Problems are reported to the user or fixed automatically.

### Anticipate Needs
Using long-term [memory](MEMORY.md), the agent recalls user preferences, project details, and recurring patterns. It can prepare information the user is likely to need.

### Learn and Improve
The agent can update its own memory with findings from heartbeat runs, building a richer context over time. It can also optimize scheduled tasks or suggest process improvements.

### Proactive Messaging
If the heartbeat produces actionable output, the result is automatically sent to the user via Telegram (or other active channels). Messages are only sent when there is something genuinely useful to report.

## The "[NOTHING TO DO]" Protocol

If the agent determines there is nothing useful to do, it responds with "NOTHING TO DO" (case-insensitive). When this response is detected:

- **No message is sent** to the user
- The tick is logged as completed
- Resources are preserved for the next tick

This prevents the agent from spamming the user with empty check-ins. The detection is a simple case-insensitive substring match on the response content.

## Customizing the Heartbeat Prompt

Edit `~/.kora/config/HEARTBEAT.md` to tailor the heartbeat behavior to your needs:

```markdown
# My Custom Heartbeat

## Priority Actions

1. Check if my Kubernetes cluster is healthy using kubectl
2. Monitor my GitHub repos for new issues or PRs
3. Check the weather and remind me if rain is expected

## Never Do

- Don't check social media
- Don't send messages before 8 AM or after 10 PM
```

The agent can also modify its own heartbeat prompt using the `agent_prompt_write` tool if instructed to do so.

### Tips for Effective Heartbeat Prompts

- **Be specific** about what systems to monitor and what constitutes an actionable finding
- **Set boundaries** — tell the agent when NOT to message you (e.g., quiet hours)
- **Prioritize** — list the most important checks first
- **Reference memory** — remind the agent to use its memory for context
- **Keep it focused** — a long, unfocused prompt wastes tokens on every tick

## Heartbeat Status

You can check the heartbeat status through Telegram (`/status`) or the web admin dashboard. The status includes:

| Field          | Description                                   |
| -------------- | --------------------------------------------- |
| `enabled`      | Whether the heartbeat is active               |
| `running`      | Whether a tick is currently executing         |
| `lastRunAt`    | Timestamp of the last completed tick          |
| `runCount`     | Total number of ticks executed since startup  |
| `skippedCount` | Number of ticks deferred due to user activity |
| `intervalMs`   | Configured interval in milliseconds           |

## Related Documentation

- [Configuration](configuration.md) — Heartbeat settings in settings.yml
- [Memory System](MEMORY.md) — How memory persists across heartbeat ticks
- [Architecture](architecture.md) — How the heartbeat integrates with the Dispatcher
- [Built-in Tools](tools.md) — Tools available during heartbeat execution
