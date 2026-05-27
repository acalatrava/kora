import type { ToolDefinition } from '../core/types.js';
import { logger } from '../core/logger.js';
import type { SubAgentManager } from '../core/sub-agent.js';

const SCOPE = 'subagent-tool';

export interface SubAgentToolContext {
  subAgentManager: SubAgentManager;
  workspaceId: string;
}

export const subAgentToolDefinitions: ToolDefinition[] = [
  {
    name: 'subagent_create',
    description: 'Create a new sub-agent specialized for a specific domain. Does NOT execute anything — use subagent_dispatch to assign tasks. Check the available models in the system prompt to choose the best model for the sub-agent.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name for the sub-agent' },
        description: { type: 'string', description: 'What this sub-agent specializes in' },
        system_prompt: { type: 'string', description: 'System prompt defining the sub-agent behavior' },
        model: { type: 'string', description: 'Model ID to use for this sub-agent (optional, uses default if not specified). Check Available Models section for options.' },
      },
      required: ['name', 'description', 'system_prompt'],
    },
  },
  {
    name: 'subagent_dispatch',
    description: 'Dispatch one or more tasks to sub-agents for parallel execution. All tasks run concurrently. You MUST wait for the results — they will be injected into your next turn automatically. Always notify the user that you are delegating work before calling this.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Array of tasks to dispatch',
          items: {
            type: 'object',
            properties: {
              agent_id: { type: 'string', description: 'ID of an existing sub-agent' },
              task: { type: 'string', description: 'Task description to execute' },
            },
            required: ['agent_id', 'task'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'subagent_list',
    description: 'List all sub-agents and their status.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'subagent_remove',
    description: 'Remove a sub-agent by ID.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'ID of the sub-agent to remove' },
      },
      required: ['agent_id'],
    },
  },
];

export interface SubAgentDispatchResult {
  dispatched: boolean;
  taskResults?: Array<{ agentId: string; agentName: string; task: string; result: string; status: string }>;
}

export async function handleSubAgentTool(
  name: string,
  args: Record<string, unknown>,
  context: SubAgentToolContext,
): Promise<string> {
  try {
    switch (name) {
      case 'subagent_create': {
        const agent = context.subAgentManager.create({
          name: args.name as string,
          description: args.description as string,
          systemPrompt: args.system_prompt as string,
          model: args.model as string | undefined,
          createdBy: 'main-agent',
          workspaceId: context.workspaceId,
        });
        return JSON.stringify({ ok: true, agentId: agent.config.id, name: agent.config.name, model: agent.config.model || 'default', status: 'created' });
      }

      case 'subagent_delete': {
        if (!args.agent_id) {
          return JSON.stringify({ ok: false, error: 'agent_id is required' });
        }
        const deleted = context.subAgentManager.remove(args.agent_id as string, context.workspaceId);
        return JSON.stringify({ ok: deleted, message: deleted ? 'Deleted' : 'Not found or does not belong to you' });
      }

      case 'subagent_dispatch': {
        const tasks = args.tasks as Array<{ agent_id: string; task: string }>;
        if (!tasks || tasks.length === 0) {
          return JSON.stringify({ ok: false, error: 'No tasks provided' });
        }

        // Check if fields are defined
        if (!tasks.every(t => t.agent_id)) {
          return JSON.stringify({ ok: false, error: 'agent_id is required' });
        }

        if (!tasks.every(t => t.task)) {
          return JSON.stringify({ ok: false, error: 'task is required' });
        }

        for (const t of tasks) {
          const agent = context.subAgentManager.get(t.agent_id, context.workspaceId);
          if (!agent) {
            return JSON.stringify({ ok: false, error: `Sub-agent ${t.agent_id} not found` });
          }
        }

        logger.info(SCOPE, `Dispatching ${tasks.length} sub-agent task(s) in parallel`);

        const promises = tasks.map(async (t) => {
          const agent = context.subAgentManager.get(t.agent_id, context.workspaceId)!;
          const agentName = agent.config.name;
          try {
            const result = await context.subAgentManager.runTask(t.agent_id, t.task, context.workspaceId);
            const updatedAgent = context.subAgentManager.get(t.agent_id, context.workspaceId);
            const status = updatedAgent?.config.status === 'failed' ? 'failed' as const : 'completed' as const;
            return { agentId: t.agent_id, agentName, task: t.task, result, status };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { agentId: t.agent_id, agentName, task: t.task, result: `Error: ${msg}`, status: 'failed' as const };
          }
        });

        const results = await Promise.all(promises);
        logger.info(SCOPE, `All ${results.length} sub-agent task(s) completed`);

        return JSON.stringify({ ok: true, dispatched: true, results });
      }

      case 'subagent_list': {
        const agents = context.subAgentManager.list(context.workspaceId);
        return JSON.stringify({ ok: true, agents });
      }

      case 'subagent_remove': {
        if (!args.agent_id) {
          return JSON.stringify({ ok: false, error: 'agent_id is required' });
        }
        const removed = context.subAgentManager.remove(args.agent_id as string, context.workspaceId);
        return JSON.stringify({ ok: removed, message: removed ? 'Removed' : 'Not found' });
      }

      default:
        return JSON.stringify({ ok: false, error: `Unknown subagent tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(SCOPE, `${name} failed: ${msg}`);
    return JSON.stringify({ ok: false, error: msg });
  }
}
