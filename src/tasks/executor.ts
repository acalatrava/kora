import { logger } from '../core/logger.js';
import type { ScheduledTask } from '../core/types.js';
import type { TaskStore } from './store.js';
import type { TaskScheduler } from './scheduler.js';

export class TaskExecutor {
  private store: TaskStore;
  private scheduler: TaskScheduler;
  private handler: ((task: ScheduledTask) => Promise<string>) | null = null;

  constructor(store: TaskStore, scheduler: TaskScheduler) {
    this.store = store;
    this.scheduler = scheduler;
  }

  setHandler(handler: (task: ScheduledTask) => Promise<string>): void {
    this.handler = handler;
    logger.debug('executor', 'Task handler registered');
  }

  async execute(task: ScheduledTask): Promise<void> {
    if (!this.handler) {
      logger.warn('executor', `No handler set, skipping task "${task.name}"`);
      return;
    }

    logger.info('executor', `Executing task "${task.name}" (${task.id})`);
    const startedAt = new Date();

    try {
      const output = await this.handler(task);
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      this.store.logExecution(task.id, 'success', output);
      logger.info('executor', `Task "${task.name}" completed in ${durationMs}ms`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.store.logExecution(task.id, 'error', '', errorMsg);
      logger.error('executor', `Task "${task.name}" failed: ${errorMsg}`);
    }
  }

  startAll(): void {
    logger.info('executor', 'Starting all scheduled tasks');
    this.scheduler.start((task) => this.execute(task));
  }

  stopAll(): void {
    logger.info('executor', 'Stopping all scheduled tasks');
    this.scheduler.stop();
  }
}
