import type BetterSqlite3 from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../core/logger.js';
import type { ScheduledTask } from '../core/types.js';

export interface TaskLog {
  id: number;
  taskId: string;
  startedAt: Date;
  finishedAt: Date;
  status: string;
  output: string;
  error?: string;
}

interface TaskRow {
  id: string;
  workspace_id: string;
  name: string;
  cron_expression: string;
  agent_id: string;
  skill_name: string | null;
  prompt: string | null;
  enabled: number;
  last_run: string | null;
  next_run: string | null;
  created_at: string;
}

interface TaskLogRow {
  id: number;
  task_id: string;
  started_at: string;
  finished_at: string;
  status: string;
  output: string;
  error: string | null;
}

function rowToTask(row: TaskRow): ScheduledTask {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    cronExpression: row.cron_expression,
    agentId: row.agent_id,
    skillName: row.skill_name ?? undefined,
    prompt: row.prompt ?? undefined,
    enabled: row.enabled === 1,
    lastRun: row.last_run ? new Date(row.last_run) : null,
    nextRun: row.next_run ? new Date(row.next_run) : null,
    createdAt: new Date(row.created_at),
  };
}

function rowToTaskLog(row: TaskLogRow): TaskLog {
  return {
    id: row.id,
    taskId: row.task_id,
    startedAt: new Date(row.started_at),
    finishedAt: new Date(row.finished_at),
    status: row.status,
    output: row.output,
    error: row.error ?? undefined,
  };
}

export class TaskStore {
  private db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        skill_name TEXT,
        prompt TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run TEXT,
        next_run TEXT,
        created_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        status TEXT NOT NULL,
        output TEXT NOT NULL,
        error TEXT,
        FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
      )
    `);

    logger.info('task-store', 'Task tables initialized');
  }

  create(task: Omit<ScheduledTask, 'lastRun' | 'nextRun' | 'createdAt'>): ScheduledTask {
    const id = task.id || uuidv4();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO scheduled_tasks (id, workspace_id, name, cron_expression, agent_id, skill_name, prompt, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      task.workspaceId,
      task.name,
      task.cronExpression,
      task.agentId,
      task.skillName ?? null,
      task.prompt ?? null,
      task.enabled ? 1 : 0,
      now,
    );

    logger.info('task-store', `Created task "${task.name}" (${id})`);
    return this.get(id)!;
  }

  get(id: string): ScheduledTask | null {
    const row = this.db.prepare(
      'SELECT * FROM scheduled_tasks WHERE id = ?',
    ).get(id) as TaskRow | undefined;

    if (row) return rowToTask(row);

    if (id.length >= 8) {
      const prefixRow = this.db.prepare(
        'SELECT * FROM scheduled_tasks WHERE id LIKE ? LIMIT 1',
      ).get(`${id}%`) as TaskRow | undefined;

      if (prefixRow) return rowToTask(prefixRow);
    }

    return null;
  }

  list(workspaceId: string): ScheduledTask[] {
    const rows = this.db.prepare(
      'SELECT * FROM scheduled_tasks WHERE workspace_id = ? ORDER BY created_at DESC',
    ).all(workspaceId) as TaskRow[];

    return rows.map(rowToTask);
  }

  listAll(): ScheduledTask[] {
    const rows = this.db.prepare(
      'SELECT * FROM scheduled_tasks ORDER BY created_at DESC',
    ).all() as TaskRow[];

    return rows.map(rowToTask);
  }

  update(id: string, updates: Partial<ScheduledTask>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.workspaceId !== undefined) { fields.push('workspace_id = ?'); values.push(updates.workspaceId); }
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.cronExpression !== undefined) { fields.push('cron_expression = ?'); values.push(updates.cronExpression); }
    if (updates.agentId !== undefined) { fields.push('agent_id = ?'); values.push(updates.agentId); }
    if (updates.skillName !== undefined) { fields.push('skill_name = ?'); values.push(updates.skillName); }
    if (updates.prompt !== undefined) { fields.push('prompt = ?'); values.push(updates.prompt); }
    if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
    if (updates.lastRun !== undefined) { fields.push('last_run = ?'); values.push(updates.lastRun?.toISOString() ?? null); }
    if (updates.nextRun !== undefined) { fields.push('next_run = ?'); values.push(updates.nextRun?.toISOString() ?? null); }

    if (fields.length === 0) return;

    values.push(id);
    this.db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    logger.debug('task-store', `Updated task ${id}: ${fields.map(f => f.split(' ')[0]).join(', ')}`);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
    logger.info('task-store', `Deleted task ${id}`);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE scheduled_tasks SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    logger.info('task-store', `Task ${id} ${enabled ? 'enabled' : 'disabled'}`);
  }

  logExecution(taskId: string, status: string, output: string, error?: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO task_logs (task_id, started_at, finished_at, status, output, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskId, now, now, status, output, error ?? null);

    logger.debug('task-store', `Logged execution for task ${taskId}: ${status}`);
  }

  getTaskLogs(taskId: string, limit: number = 50): TaskLog[] {
    const rows = this.db.prepare(
      'SELECT * FROM task_logs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?',
    ).all(taskId, limit) as TaskLogRow[];

    return rows.map(rowToTaskLog);
  }
}
