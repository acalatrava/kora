You are my senior open-source lead engineer. You are working in a hospital environment, failure is not an option. My boss is looking. Build the MVP for a local-first multi-channel AI Agent runtime.

PROJECT NAME: "Kora"

HIGH-LEVEL GOAL
Build an easy-to-install, open-source agent runtime that:
- Runs on macOS, Linux, and Windows (at least WSL; prefer native Windows too).
- Installs via a curl one-liner and guides the user through a step-by-step TUI wizard.
- Uses Markdown-based configuration and skills (AgentSkills spec: SKILL.md with YAML frontmatter + markdown body; optional extra files/scripts).
- Supports multiple LLM providers: OpenAI, Anthropic, and OpenAI-compatible endpoints (Ollama + LM Studio). Must support local models that can do tool calling (e.g., Qwen via Ollama/LM Studio).
- Communicates via channels. MVP channels: Telegram bot (primary UX) + Email (IMAP inbound + SMTP outbound). Must be multi-channel-ready via identity linking (workspace ≠ channel).
- Has a task scheduler (cron-like by default) and can trigger tasks from events (MVP: cron + email inbound; add MQTT Home Assistant device integration in MVP as a skill).
- It can use MCP spec to use tools and you can install more tools.
- Uses a sandbox to run tool/skill code WITHOUT Docker. Use Deno sandboxing as the default runner for skills/tools with allow-read/allow-write/allow-net restrictions.
- Stores chats from day 1 in a local vector store (local-first). Use a simple embedded DB approach for MVP.
- If used in single user mode, all the settings and configurations can be managed via Telegram. If multi user mode, only authorized chats (via yaml config file) can access admin access.

DEFAULT PRODUCT STANCE / UX
- Installation must be idiot-proof: curl | bash => downloads binary/package => runs `kora setup` TUI => done.
- Default is single-user, but internal design must be multi-user capable later (namespaces/workspaces).
- The main agent is the only one that talks to the user. Sub-agents are internal workers (no direct user messaging).
- Main agent personality: dry, arrogant, knows-it-all, snarky (Gilfoyle vibe). Keep responses short.
- Users can administrate via CLI + mini local web admin (optional), but Telegram should be enough for most operations.

NON-GOALS (MVP)
- No cloud backend required.
- No webhook HTTP server exposed by default (but architecture should allow it later).
- No complex multi-tenant auth (single-user only).
- No heavy UI (just TUI + optional minimal web admin).

CORE CONCEPTS
1) Workspace
- A workspace represents a “user/project life”: memory, vector DB namespace, tasks, configs.
- Workspaces are NOT tied to a channel.
1) Identity + Linking (if multiuser is selected during setup wizard, if single user is selected then all channels use the same workspace without questions)
- Each incoming message yields identity_id, e.g.:
  - telegram:<user_id or chat_id>
  - email:<address>
  - matrix:<mxid> (future)
  - whatsapp:<phone> (future)
- A link table maps identity_id -> workspace_id.
- If unknown identity arrives, create a pending workspace and require linking with a pairing code:
  - /link CODE (Telegram) or email subject/body “LINK CODE”
1) Memory
- Each workspace has MEMORY.md used as curated context. The main agent can append/update it with guardrails.
1) Skills
- Follow AgentSkills spec:
  - skills/<skill_name>/SKILL.md (frontmatter YAML + markdown body)
  - optional scripts/assets next to it
- Runtime loads all installed skills and exposes them as tools to the model.
1) Sandbox execution
- Use Deno as the default runner for skill scripts:
  - enforce allow-read/write/net per skill permissions
  - default deny everything
- Skill permissions live in skill folder (permissions.yml) and/or in SKILL.md frontmatter if you prefer; pick ONE canonical method and document it.
1) Providers
- Provide a normalized internal API for chat + tool calling.
- Providers:
  - openai
  - anthropic
  - openai_compat (for Ollama + LM Studio)
- Add per-model “tool_call_profile” to handle Qwen/Ollama/LMStudio quirks if needed.
1) Tasks
- Scheduler supports cron expressions.
- Tasks stored in SQLite per workspace.
- Each task has assigned_agent_id (main or sub-agent).
- Task execution results are delivered to the main agent, which decides notification.

MCP TOOLS (MUST IMPLEMENT)
A) scheduler
- create/list/pause/resume/run_now/delete
- cron support
- logs per task
B) mail
- IMAP inbound (IDLE if possible, fallback polling)
- SMTP outbound
- Gmail “easy mode” supported 
C) browser
- headless automation
D) web_search 
- use API key for popular web search apis like brave
E) homeassistant_mqtt_device
- Implement MQTT discovery so Home Assistant sees a device
- Allow HA to send commands to create/run tasks and to request status
- Keep it as a skill so users can skip it

During setup, you can choose wich tools enable/disable. If enabled it allows you to config it if needed.

CHANNELS (MVP)
- Telegram: advanced bot UX with inline buttons for:
  - approve/deny permission prompts
  - task create/list/run/pause
  - link identities
  - show status
- Email channel:
  - inbound -> events -> main agent summarises + optional actions
  - outbound notifications

TECH STACK
- Node.js (TypeScript)
- Deno installed/bootstrapped (installer should check and install or guide; on Windows prefer winget/choco instructions; on WSL apt)
- SQLite for tasks + metadata
- Vector DB: MVP can be sqlite+embedding table, or a small embedded vector library; keep it local and simple. Provide an interface so we can swap later.

PLATFORM SUPPORT
- macOS + Linux: first-class
- Windows:
  - must work at least in WSL2
  - prefer native Windows if feasible (Node + Deno should run)
- Installer:
  - Provide separate install instructions for Windows (PowerShell) but core request is curl one-liner for Unix-like and WSL.

REPO STRUCTURE (TARGET)
- /src
  - /core (router, identity, workspace, memory, dispatcher)
  - /providers (openai, anthropic, openai_compat)
  - /channels (telegram, email)
  - /skills_runtime (loader, registry, permissions)
  - /runner (deno runner)
  - /tasks (scheduler, store, executor)
  - /web_admin (minimal optional)
  - /cli (commands + TUI setup)
- /skills_builtin (bundled skills)
- /install (install scripts)
- /docs

CONFIG FILES (MVP)
- ~/.kora/
  - config/
    - AGENT.md (main agent definition including personality of the bot, by default it should be dry, arrogant, knows-it-all, snarky (Gilfoyle vibe) Keep responses short)
    - providers.yml
    - channels.yml
    - settings.yml
  - skills/ (installed skills)
  - tools/ (installed tools)
  - workspaces/<workspace_id>/
    - MEMORY.md
    - tasks.db
    - vector.db (or tables)
    - agents/ (sub-agent instances if created)
  - logs/

AGENT DEFINITIONS (MVP)
- config/AGENT.md for main agent
- config/SUBAGENT.md as template for sub-agents
- Sub-agents are created by cloning template into workspace agents folder with overrides.

SECURITY / PERMISSIONS (MVP)
- Default deny:
  - filesystem access
  - network
  - shell
- Each skill declares required permissions. When a skill requests something not granted:
  - prompt user in Telegram with Allow once / Always allow / Deny
  - store decision per workspace
- Deno runner enforces the allowlists strictly.

SETUP WIZARD (TUI) MUST DO
- pick provider(s) and enter API keys or base_url
- detect ollama/lmstudio endpoints optionally
- configure default model
- configure telegram token (optional)
- configure email (gmail or smtp/imap) (optional)
- configure default tools
- choose storage path
- run a “doctor” test and print next steps
