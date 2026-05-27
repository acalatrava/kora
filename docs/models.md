# Model Configuration

Kora supports multiple LLM providers and models, each with configurable roles that help the system choose the right model for each situation.

## Model Roles

Each model can be assigned one or more roles:

| Role       | Description                                     |
| ---------- | ----------------------------------------------- |
| `default`  | Primary model used for all conversations        |
| `fallback` | Automatically used when the primary model fails |
| `fast`     | Optimized for quick, simple tasks               |
| `capable`  | Best reasoning and complex tasks                |
| `vision`   | Supports image/multimodal input                 |
| `coding`   | Optimized for code generation                   |

### Configuring Roles

**During setup (`kora setup`):**

After adding models to a provider, you'll be prompted to assign roles:

```
Assign roles to models (helps the system choose the right model for each task):
Available roles: default, fallback, fast, capable, vision, coding

Roles for gpt-4o (comma-separated, or empty): default, capable
  ✓ gpt-4o: [default, capable]
Roles for gpt-4o-mini (comma-separated, or empty): fast, fallback
  ✓ gpt-4o-mini: [fast, fallback]
```

**In the admin panel:**

Navigate to the Providers section. Each model displays clickable role badges. Click a badge to toggle it on/off.

## Fallback Model

When a model with the `fallback` role is configured, the system automatically retries failed LLM requests using the fallback model. This applies to:

- Main conversation loop in the dispatcher
- Sub-agent execution

The failover is transparent to the user and logged for debugging:

```
[WARN] [dispatcher] Primary model failed (rate limit), falling back to gpt-4o-mini
```

## Model Selection for Sub-Agents

The main agent is informed about all available models and their roles in the system prompt. When creating sub-agents, the agent can specify which model to use:

```
subagent_create(
  name: "researcher",
  description: "Web research specialist",
  system_prompt: "...",
  model: "gpt-4o-mini"  // Uses the fast model
)
```

Users can also select a model when creating sub-agents from the user portal, via a dropdown populated with all available models and their roles.

## Configuration File

Models are stored in the providers section of `.kora/config.yml`:

```yaml
providers:
  - id: openai
    type: openai
    apiKey: sk-...
    models:
      - id: gpt-4o
        name: gpt-4o
        roles:
          - default
          - capable
      - id: gpt-4o-mini
        name: gpt-4o-mini
        roles:
          - fast
          - fallback
```
