# Memory System

Kora has a persistent long-term memory system that lets the agent remember important facts, user preferences, project details, and decisions across conversations and sessions. Memory is stored per workspace in a `MEMORY.md` file and is automatically injected into every LLM prompt.

## What Is Long-Term Memory?

Unlike conversation history (which is session-scoped and limited to 50 messages), long-term memory persists indefinitely. It survives restarts, session resets, and context compaction. Every time the agent processes a message — whether from a user, a scheduled task, or a heartbeat tick — the full memory is included in the system prompt.

This gives the agent continuous awareness of:
- Who you are and how you prefer to communicate
- What projects you are working on
- Decisions made in past conversations
- Recurring tasks and patterns
- Important facts and configuration notes

## How It Works

Each workspace has its own `MEMORY.md` file stored at:

```
~/.kora/workspaces/<workspace_id>/MEMORY.md
```

For the default workspace, this is:

```
~/.kora/workspaces/default/MEMORY.md
```

### Lifecycle

1. **Automatic injection** — The `MemoryManager` reads `MEMORY.md` and builds a context snippet (up to 8,000 characters) that is included in every system prompt. The agent sees this as "Current Memory" in its instructions.
2. **Proactive saving** — The agent is instructed to save new information immediately as it learns it, using `memory_append`.
3. **Cleanup** — Outdated or incorrect entries should be removed via `memory_remove` to keep memory fresh.
4. **Reorganization** — When memory gets cluttered, `memory_write` replaces the entire file with consolidated entries.
5. **Per-workspace isolation** — In multi-user mode, each workspace maintains independent memory.

## Entry Format

Each memory entry is a markdown section with a unique ID and ISO 8601 timestamp:

```markdown
## [mem-a1b2c3d4] 2026-03-06T15:00:00.000Z
User prefers dark mode and communicates in Spanish.

## [mem-e5f6g7h8] 2026-03-06T16:30:00.000Z
Project "Bender" uses TypeScript + Node.js, deployed on a Mac Mini.

## [mem-9i0j1k2l] 2026-03-07T09:15:00.000Z
Weekly standup meeting is every Monday at 10:00 AM. User wants a summary
of pending tasks and recent activity sent 30 minutes before.
```

### Format Breakdown

| Component     | Example                    | Description                               |
| ------------- | -------------------------- | ----------------------------------------- |
| Header prefix | `## `                      | Markdown H2 heading                       |
| Entry ID      | `[mem-a1b2c3d4]`           | Unique 8-character hex ID, auto-generated |
| Timestamp     | `2026-03-06T15:00:00.000Z` | ISO 8601 creation time, auto-generated    |
| Content       | (lines after the header)   | Free-form text, can span multiple lines   |

IDs are generated using `crypto.randomBytes(4).toString('hex')`, producing 8 hex characters. Each entry is separated by a blank line.

## Memory Tools

The agent interacts with memory through five built-in tools. These are always available (core tools) regardless of how many other tools are loaded.

### memory_append

Add a new entry to memory. The ID and timestamp are generated automatically.

| Parameter | Type   | Required | Description         |
| --------- | ------ | -------- | ------------------- |
| `entry`   | string | Yes      | The content to save |

```json
{ "entry": "User's preferred language is Spanish. Always respond in Spanish unless asked otherwise." }
```

Returns the generated entry ID (e.g., `mem-a1b2c3d4`).

### memory_remove

Remove a specific entry by its ID. Use this to clean up outdated, incorrect, or redundant information.

| Parameter  | Type   | Required | Description                                                 |
| ---------- | ------ | -------- | ----------------------------------------------------------- |
| `entry_id` | string | Yes      | Entry ID to remove (e.g., `a1b2c3d4` from `[mem-a1b2c3d4]`) |

```json
{ "entry_id": "a1b2c3d4" }
```

The `mem-` prefix is optional — both `a1b2c3d4` and `mem-a1b2c3d4` are accepted.

### memory_list

List all entries with their IDs, timestamps, and content previews (first 120 characters).

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| *(none)*  | —    | —        | —           |

Returns a JSON array with each entry's `id`, `timestamp`, and `preview`.

### memory_write

Replace the entire memory file with new content. This is a destructive operation intended for bulk reorganization — consolidating related entries, removing duplicates, or restructuring the file.

| Parameter | Type   | Required | Description                   |
| --------- | ------ | -------- | ----------------------------- |
| `content` | string | Yes      | New full content of MEMORY.md |

```json
{
  "content": "## [mem-new1] 2026-03-08T10:00:00.000Z\nConsolidated user preferences: Spanish, dark mode, concise responses.\n\n## [mem-new2] 2026-03-08T10:00:00.000Z\nProject stack: TypeScript, Node.js 22, SQLite, deployed on Mac Mini.\n"
}
```

### memory_read

Read the raw memory file content. This is rarely needed because memory is automatically injected into every prompt. Use it only when you need to verify the exact file state.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| *(none)*  | —    | —        | —           |

## Auto-Injection Into System Prompt

The `MemoryManager.getContextSnippet()` method builds a compact representation of memory for the system prompt. The process:

1. All entries are parsed from `MEMORY.md`
2. Each entry is formatted as: `[mem-ID] content`
3. Entries are appended in order until the character limit is reached
4. The resulting snippet is injected into the system prompt under "Current Memory"

The agent sees memory in this format during conversations:

```
### Current Memory (3 entries)
```
[mem-a1b2c3d4] User prefers dark mode and communicates in Spanish.
[mem-e5f6g7h8] Project "Bender" uses TypeScript + Node.js, deployed on a Mac Mini.
[mem-9i0j1k2l] Weekly standup meeting is every Monday at 10:00 AM.
```
```

### Context Snippet Size Limit

The default maximum is **8,000 characters**. If memory exceeds this limit, only the entries that fit within the budget are included (oldest first). Entries that don't fit are silently dropped from the prompt — they are not deleted from the file and will be included if older entries are removed.

This limit exists to prevent memory from consuming too much of the LLM context window. If your memory is consistently hitting the limit:
- Remove outdated entries with `memory_remove`
- Consolidate related entries with `memory_write`
- Keep individual entries concise

## Memory Management Best Practices

### Save Early and Often

The agent is instructed to proactively save information the moment it learns it. Examples of what should be saved:

- User's name, language, communication preferences
- Project names, tech stacks, architecture decisions
- Important dates, deadlines, recurring meetings
- Configuration choices and deployment details
- Lessons learned from failed operations

### Remove Outdated Entries

Memory entries can become stale. If a project is completed, a preference changes, or information is superseded, the old entry should be removed:

```
"My project now uses PostgreSQL instead of SQLite — update your memory"
```

The agent will `memory_remove` the old entry and `memory_append` the corrected one.

### Don't Duplicate

Before saving, the agent should check existing memory to avoid storing the same fact multiple times. If information changes, remove the old entry before appending the update.

### Reorganize Periodically

Over time, memory accumulates many small entries. Periodically ask the agent to consolidate:

```
"Review your memory and reorganize it — merge related entries and remove duplicates"
```

The agent will use `memory_list` to review entries, then `memory_write` to produce a cleaner, consolidated version.

### Keep Entries Concise

Each entry consumes context budget. Write memory entries as dense, factual notes rather than verbose descriptions:

```
# Good
User prefers TypeScript, uses VSCode, deploys to Vercel.

# Verbose (wastes context budget)
The user has mentioned that they prefer to use TypeScript as their
primary programming language. They use Visual Studio Code as their
editor of choice, and they deploy their applications to the Vercel
platform for hosting.
```

## Legacy Format Compatibility

Older versions of Kora used a simpler format without IDs:

```
[2026-03-06T15:00:00.000Z] User prefers dark mode.
```

These entries are automatically migrated to the new format with generated IDs when first parsed by the `MemoryManager`. No manual migration is needed.

Plain text lines without any recognized format are also handled gracefully — they are assigned a generated ID and the current timestamp.

## Manual Editing

You can manually edit `MEMORY.md` at `~/.kora/workspaces/default/MEMORY.md`. Follow the entry format:

```markdown
## [mem-XXXXXXXX] YYYY-MM-DDTHH:MM:SS.MMMZ
Your entry content here.
```

Changes are picked up on the next interaction — there is no need to restart Kora.

When manually adding entries, generate a unique 8-character hex string for the ID, or use any short alphanumeric string. The parser accepts any characters matching `[a-z0-9]+`.

## Related Documentation

- [Built-in Tools](tools.md) — Full memory tool reference with parameters
- [KYU (Know Your User)](kyu.md) — User profiling system (complementary to memory)
- [Configuration](configuration.md) — Workspace and storage path settings
- [Heartbeat](heartbeat.md) — Memory is available during heartbeat ticks
- [Architecture](architecture.md) — How memory integrates with the Dispatcher
- [Troubleshooting](troubleshooting.md) — Memory-related issues
