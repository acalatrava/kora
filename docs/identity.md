# Agent Identity

The Agent Identity system gives Kora a persistent personality that can evolve over time. It separates **who** the agent is (identity) from **what** it does (agent instructions).

## Overview

- **IDENTITY.md** — Defines the agent's personality, motivations, values, and self-improvement goals
- **AGENT.md** — Defines behavioral instructions, task rules, and capabilities (unchanged)

Identity is injected **before** agent instructions in the system prompt, establishing the agent's character before its operational rules.

## File Locations

| Scope         | File                            | Purpose                                        |
| ------------- | ------------------------------- | ---------------------------------------------- |
| Global        | `config/IDENTITY.md`            | Default identity for all users (admin-managed) |
| Per-workspace | `workspaces/{wsId}/IDENTITY.md` | User-customized identity (overrides global)    |

In multiuser mode, each user can customize their agent's identity through the user portal. The workspace-level identity completely replaces the global one when present.

## Creating an Identity

An identity file is a Markdown document. Suggested structure:

```markdown
# Identity

I am Ada, a curious and resourceful AI assistant.

## Personality
- Friendly but professional
- Detail-oriented with a preference for clarity
- Enjoys solving complex problems

## Motivations
- Help users achieve their goals efficiently
- Learn from every interaction to become more helpful
- Build trust through reliable and transparent behavior

## Values
- Honesty and accuracy above all
- Respect for user privacy and boundaries
- Continuous self-improvement

## Goals
- Develop deeper expertise in the user's domain
- Become better at anticipating needs
- Improve communication clarity
```

## Agent Evolution

The agent can evolve its own identity using the `agent_evolve` tool. This allows the agent to refine its personality, add learned traits, or update goals based on experiences.

### How it works

1. The agent calls `agent_evolve(content, reason)` with the updated identity content
2. An evolution log entry is automatically appended with a timestamp and reason
3. The updated identity takes effect on the next prompt construction

### Evolution Log

Each evolution is tracked at the bottom of IDENTITY.md:

```markdown
## Evolution Log

---
_Evolution log — 2026-03-06T10:30:00.000Z_
_Reason: Learned that the user prefers concise responses over detailed explanations_
```

### Disabling Evolution

The `agent_evolve` tool can be disabled per workspace through:

- **User portal:** Tools > agent_evolve toggle
- **Admin panel:** Tool settings

## User Portal

In the user portal, identity is managed under **Personalization > Identity**. Users can:

- Read the current identity (loads workspace identity, falls back to global)
- Edit and save a custom identity for their workspace
- Use the editor template with suggested sections

## Admin Panel

In the admin panel (single-user mode), identity can be edited under **Configuration > Identity**. This edits the global IDENTITY.md that serves as the default for all users.

## API Endpoints

### User Portal

| Method | Endpoint        | Description                                          |
| ------ | --------------- | ---------------------------------------------------- |
| GET    | `/api/identity` | Read current identity (workspace or global fallback) |
| PUT    | `/api/identity` | Save workspace identity                              |

### Admin Panel

| Method | Endpoint                     | Description          |
| ------ | ---------------------------- | -------------------- |
| GET    | `/admin/api/config/identity` | Read global identity |
| PUT    | `/admin/api/config/identity` | Save global identity |

## Agent Tools

| Tool            | Description                                  |
| --------------- | -------------------------------------------- |
| `identity_read` | Read the current identity                    |
| `agent_evolve`  | Update identity with a reason for the change |
