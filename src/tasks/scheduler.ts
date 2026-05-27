import { Cron } from 'croner';
import { logger } from '../core/logger.js';
import type { ScheduledTask } from '../core/types.js';
import type { TaskStore } from './store.js';

const MIN_INTERVAL_MINUTES = 30;

export class TaskScheduler {
  private store: TaskStore;
  private jobs: Map<string, Cron> = new Map();
  private runningTasks: Set<string> = new Set();
  private defaultHandler: ((task: ScheduledTask) => Promise<void>) | null = null;

  constructor(store: TaskStore) {
    this.store = store;
  }

  static validateMinInterval(cronExpression: string, minMinutes: number = MIN_INTERVAL_MINUTES): { valid: boolean; intervalMinutes?: number } {
    try {
      const job = new Cron(cronExpression);
      const first = job.nextRun();
      if (!first) return { valid: false };
      const second = job.nextRun(first);
      job.stop();
      if (!second) return { valid: true };
      const intervalMs = second.getTime() - first.getTime();
      const intervalMinutes = intervalMs / (1000 * 60);
      return { valid: intervalMinutes >= minMinutes, intervalMinutes };
    } catch {
      return { valid: false };
    }
  }

  getDefaultHandler(): ((task: ScheduledTask) => Promise<void>) | null {
    return this.defaultHandler;
  }

  start(handler: (task: ScheduledTask) => Promise<void>): void {
    this.stop();
    this.defaultHandler = handler;

    const tasks = this.store.listAll();
    logger.info('scheduler', `Loading enabled tasks...`);

    for (const task of tasks) {
      if (task.enabled) {
        this.schedule(task, handler);
      }
    }

    logger.info('scheduler', `Scheduler started with ${this.jobs.size} active jobs`);
  }

  startForWorkspace(workspaceId: string, handler: (task: ScheduledTask) => Promise<void>): void {
    const tasks = this.store.list(workspaceId);

    for (const task of tasks) {
      if (task.enabled && !this.jobs.has(task.id)) {
        this.schedule(task, handler);
      }
    }
  }

  stop(): void {
    for (const [taskId, job] of this.jobs) {
      job.stop();
      logger.debug('scheduler', `Stopped job for task ${taskId}`);
    }
    this.jobs.clear();
    logger.info('scheduler', 'All scheduled jobs stopped');
  }

  schedule(task: ScheduledTask, handler: (task: ScheduledTask) => Promise<void>): void {
    this.unschedule(task.id);

    try {
      const job = new Cron(task.cronExpression, async () => {
        if (this.runningTasks.has(task.id)) {
          logger.warn('scheduler', `Task "${task.name}" (${task.id}) is still running, skipping`);
          return;
        }

        logger.info('scheduler', `Cron triggered for task "${task.name}" (${task.id})`);
        this.runningTasks.add(task.id);

        const now = new Date();
        this.store.update(task.id, { lastRun: now });

        const nextDate = job.nextRun();
        if (nextDate) {
          this.store.update(task.id, { nextRun: nextDate });
        }

        try {
          await handler(task);
          this.store.logExecution(task.id, 'success', 'Task completed successfully');
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.error('scheduler', `Task "${task.name}" failed: ${errorMsg}`);
          this.store.logExecution(task.id, 'error', '', errorMsg);
        } finally {
          this.runningTasks.delete(task.id);
        }
      });

      const nextRun = job.nextRun();
      if (nextRun) {
        this.store.update(task.id, { nextRun: nextRun });
      }

      this.jobs.set(task.id, job);
      logger.info('scheduler', `Scheduled task "${task.name}" with cron "${task.cronExpression}"`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('scheduler', `Failed to schedule task "${task.name}": ${errorMsg}`);
    }
  }

  unschedule(taskId: string): void {
    const existing = this.jobs.get(taskId);
    if (existing) {
      existing.stop();
      this.jobs.delete(taskId);
      logger.debug('scheduler', `Unscheduled task ${taskId}`);
    }
  }

  async runNow(taskId: string, handler: (task: ScheduledTask) => Promise<void>): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (this.runningTasks.has(taskId)) {
      throw new Error(`Task "${task.name}" is already running`);
    }

    logger.info('scheduler', `Running task "${task.name}" immediately`);
    this.runningTasks.add(taskId);
    this.store.update(taskId, { lastRun: new Date() });

    try {
      await handler(task);
      this.store.logExecution(taskId, 'success', 'Manual execution completed');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('scheduler', `Manual run of task "${task.name}" failed: ${errorMsg}`);
      this.store.logExecution(taskId, 'error', '', errorMsg);
      throw err;
    } finally {
      this.runningTasks.delete(taskId);
    }
  }

  reschedule(taskId: string, cronExpression: string): void {
    const task = this.store.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    this.store.update(taskId, { cronExpression });

    const existingJob = this.jobs.get(taskId);
    if (existingJob) {
      existingJob.stop();
      this.jobs.delete(taskId);

      const updatedTask = this.store.get(taskId)!;
      const job = new Cron(cronExpression, async () => {
        const now = new Date();
        this.store.update(taskId, { lastRun: now });

        const nextDate = job.nextRun();
        if (nextDate) {
          this.store.update(taskId, { nextRun: nextDate });
        }
      });

      const nextRun = job.nextRun();
      if (nextRun) {
        this.store.update(taskId, { nextRun: nextRun });
      }

      this.jobs.set(taskId, job);
      logger.info('scheduler', `Rescheduled task "${updatedTask.name}" to "${cronExpression}"`);
    }
  }

  isRunning(taskId: string): boolean {
    return this.jobs.has(taskId);
  }

  get activeJobCount(): number {
    return this.jobs.size;
  }
}
