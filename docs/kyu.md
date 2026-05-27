# KYU (Know Your User)

KYU is a system that enables the agent to build and maintain a deep understanding of each user. After every conversation, the `kyu_agent` internal agent analyzes the session and extracts user-relevant signals — explicit statements, implicit preferences, inferred personality traits, goals, and more — storing them in a structured profile.

This profile is automatically injected into the system prompt, giving the agent continuous awareness of who the user is and what they care about. The result is a progressively more personalized assistant that anticipates needs and tailors its behavior.

## How It Works

### Profile Storage

Each workspace has its own `KYU.md` file stored at:

```
~/.kora/workspaces/<workspace_id>/KYU.md
```

The file is a structured markdown document maintained entirely by the `kyu_agent`. It is never modified by the main agent directly.

### Lifecycle

1. **User interacts** — The user has a conversation with the agent through any channel (Telegram, Email, API, etc.)
2. **Session ends** — The main agent calls `finish()` to complete the session
3. **KYU agent runs** — The `kyu_agent` internal agent is triggered asynchronously (non-blocking)
4. **Profile analysis** — The KYU agent reads the current `KYU.md`, analyzes the conversation transcript, and identifies any new user insights
5. **Profile update** — If new information is found, the KYU agent rewrites `KYU.md` with merged content
6. **Next session** — The updated profile is injected into the system prompt for the next conversation

```
User Message → Dispatcher → LLM → finish() → kyu_agent → KYU.md
                  ↑                                          |
                  └──────────── System Prompt ←──────────────┘
```

### What Gets Captured

The KYU agent looks for these types of signals:

- **Explicit statements** — Things the user directly says about themselves ("I work as a DevOps engineer", "I prefer TypeScript")
- **Implicit signals** — Inferred from behavior, questions, tone, and choices
- **Preferences** — Tools, technologies, workflows, communication style
- **Context** — Projects, roles, relationships, routines
- **Personality traits** — How they think, what motivates them, what frustrates them
- **Goals** — Short-term tasks and long-term aspirations

### Profile Structure

The KYU agent maintains this structured format in `KYU.md`:

```markdown
# User Profile

## Personal
- Name, location, timezone, language, etc.

## Interests & Passions
- Hobbies, topics they enjoy, what excites them

## Professional Context
- Role, occupation, key projects, technical skills, tools used

## Goals & Objectives
- Short-term and long-term goals, aspirations

## Communication Style
- Preferred language, tone, formality level, response length preferences

## Values & Motivations
- What drives them, what they care about

## Patterns & Habits
- Recurring behaviors, routines, typical requests

## Important People & Context
- Family, colleagues, pets, organizations mentioned

## Likes
- Things they enjoy, prefer, or react positively to

## Dislikes & Sensitivities
- Things that annoy, frustrate, or should be avoided
```

Sections are added and refined over time as the agent learns more. Empty sections are omitted until relevant information is discovered.

## System Prompt Integration

The KYU profile is injected into the main agent's system prompt under the "Know Your User (KYU)" section, right after Long-Term Memory. The prompt also includes behavioral instructions:

- Naturally weave curiosity into conversations to learn more about the user
- Never interrogate — keep questions organic and contextual
- Anticipate user needs based on known preferences
- Personalize suggestions using profile knowledge
- The system handles profile updates automatically — the main agent does not need to do anything explicitly

When no profile exists yet (first interaction), the system prompt indicates this is a new user and encourages the agent to pay close attention.

## KYU vs Memory

KYU and Memory serve distinct purposes:

| Aspect                                   | KYU (`KYU.md`)                 | Memory (`MEMORY.md`)                           |
| ---------------------------------------- | ------------------------------ | ---------------------------------------------- |
| Purpose                                  | User personality and profile   | Factual session data and events                |
| Update method                            | Full rewrite by `kyu_agent`    | Append/remove entries by `memory_update_agent` |
| Scope                                    | Who the user is                | What happened                                  |
| Cleanup                                  | Holistic merge on every update | Separate cleanup agent removes duplicates      |
| Agent access                             | Read-only (injected in prompt) | Read-only (injected in prompt)                 |
| Location    work/workspaces/<id>/KYU.md` | `workspaces/<id>/MEMORY.md`    |

Both are injected into the system prompt and both are managed by internal agents after each session.

## Viewing the KYU Profile

### User Portal (Multi-User Mode)

Users can view their own KYU profile through the **My KYU Profile** page in the User Portal. This is a read-only view that shows exactly what the assistant knows about them.

### Web Admin

Administrators can view and edit any user's KYU profile:

- **Single-user mode** — Config tab "KYU Profile" in the Configuration page
- **Multi-user mode** — "KYU" tab in the User Detail page

### Direct File Access

The file can also be read directly:

```bash
cat ~/.kora/workspaces/<workspace_id>/KYU.md
```

Manual edits are picked up on the next interaction without requiring a restart.

## Internal Agent: kyu_agent

The `kyu_agent` is an internal agent that runs automatically after every non-heartbeat session. It uses two tools:

| Tool        | Description                       |
| ----------- | --------------------------------- |
| `kyu_read`  | Read the current KYU.md content   |
| `kyu_write` | Write the complete updated KYU.md |

The agent follows a read-merge-write pattern:
1. Read the current profile with `kyu_read`
2. Analyze the conversation transcript for new insights
3. Merge new information with existing profile data
4. Write the complete updated profile with `kyu_write`
5. Report completion with `task_report`

If no new information is found, the agent skips the write and reports success immediately.

The KYU agent runs asynchronously and does not delay the user's response. Failures are logged but do not affect the main conversation.

## Related Documentation

- [Memory System](MEMORY.md) — Long-term factual memory (complementary to KYU)
- [Architecture](architecture.md) — How the Dispatcher orchestrates the system prompt
- [Web Admin](web-admin.md) — Admin panel KYU management
- [User Portal](user-portal.md) — User-facing KYU view
- [Identity](identity.md) — Agent identity system (separate from user profiling)
