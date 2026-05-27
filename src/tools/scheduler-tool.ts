import type { ToolDefinition, ScheduledTask } from '../core/types.js';
import type { TaskStore } from '../tasks/store.js';
import { TaskScheduler } from '../tasks/scheduler.js';
import { logger } from '../core/logger.js';

const SCOPE = 'scheduler-tool';

export interface SchedulerToolContext {
  workspaceId: string;
  taskStore: TaskStore;
  taskScheduler: TaskScheduler;
}

export const schedulerToolDefinitions: ToolDefinition[] = [
  {
    name: 'scheduler_create',
    description: 'Create a new scheduled task with a cron expression.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable task name' },
        cron_expression: { type: 'string', description: 'Cron expression (e.g. "0 9 * * *" for daily at 9am)' },
        prompt: { type: 'string', description: 'The prompt/instruction the agent will execute on each run' },
      },
      required: ['name', 'cron_expression', 'prompt'],
    },
  },
  {
    name: 'scheduler_list',
    description: 'List all scheduled tasks in the current workspace.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'scheduler_pause',
    description: 'Pause a scheduled task so it stops running.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the task to pause' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'scheduler_resume',
    description: 'Resume a previously paused task.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the task to resume' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'scheduler_run_now',
    description: 'Trigger immediate execution of a task, regardless of its schedule.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the task to run now' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'scheduler_delete',
    description: 'Permanently delete a scheduled task.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the task to delete' },
      },
      required: ['task_id'],
    },
  },
];

function formatTask(t: ScheduledTask): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    cron: t.cronExpression,
    enabled: t.enabled,
    lastRun: t.lastRun?.toISOString() ?? null,
    nextRun: t.nextRun?.toISOString() ?? null,
    prompt: t.prompt ?? null,
  };
}

export async function handleSchedulerTool(
  name: string,
  args: Record<string, unknown>,
  context: SchedulerToolContext,
): Promise<string> {
  try {
    switch (name) {
      case 'scheduler_create': {
        const taskName = args.name as string;
        const cronExpr = args.cron_expression as string;
        const prompt = args.prompt as string;

        const validation = TaskScheduler.validateMinInterval(cronExpr);
        if (!validation.valid) {
          const msg = validation.intervalMinutes !== undefined
            ? `Minimum interval is 30 minutes. This cron runs every ${Math.round(validation.intervalMinutes)} minutes.`
            : 'Invalid cron expression.';
          return JSON.stringify({ ok: false, error: msg });
        }

        const task = context.taskStore.create({
          id: '',
          workspaceId: context.workspaceId,
          name: taskName,
          cronExpression: cronExpr,
          agentId: 'main',
          prompt,
          enabled: true,
        });

        const handler = context.taskScheduler.getDefaultHandler();
        if (handler) {
          context.taskScheduler.schedule(task, handler);
        }

        logger.info(SCOPE, `Created and scheduled task "${taskName}" (${task.id})`);
        return JSON.stringify({ ok: true, task: formatTask(task) });
      }

      case 'scheduler_list': {
        const tasks = context.taskStore.list(context.workspaceId);
        return JSON.stringify({ ok: true, tasks: tasks.map(formatTask) });
      }

      case 'scheduler_pause': {
        const taskId = args.task_id as string;
        context.taskStore.setEnabled(taskId, false);
        context.taskScheduler.unschedule(taskId);
        logger.info(SCOPE, `Paused task ${taskId}`);
        return JSON.stringify({ ok: true, message: `Task ${taskId} paused` });
      }

      case 'scheduler_resume': {
        const taskId = args.task_id as string;
        context.taskStore.setEnabled(taskId, true);
        const task = context.taskStore.get(taskId);
        const handler = context.taskScheduler.getDefaultHandler();
        if (task && handler) {
          context.taskScheduler.schedule(task, handler);
        }
        logger.info(SCOPE, `Resumed task ${taskId}`);
        return JSON.stringify({ ok: true, message: `Task ${taskId} resumed` });
      }

      case 'scheduler_run_now': {
        const taskId = args.task_id as string;
        const handler = context.taskScheduler.getDefaultHandler();
        if (!handler) {
          return JSON.stringify({ ok: false, error: 'No task handler configured' });
        }
        await context.taskScheduler.runNow(taskId, handler);
        return JSON.stringify({ ok: true, message: `Task ${taskId} executed` });
      }

      case 'scheduler_delete': {
        const taskId = args.task_id as string;
        context.taskScheduler.unschedule(taskId);
        context.taskStore.delete(taskId);
        logger.info(SCOPE, `Deleted task ${taskId}`);
        return JSON.stringify({ ok: true, message: `Task ${taskId} deleted` });
      }

      default:
        return JSON.stringify({ ok: false, error: `Unknown scheduler tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(SCOPE, `${name} failed: ${msg}`);
    return JSON.stringify({ ok: false, error: msg });
  }
}
