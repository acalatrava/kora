import type { DatabaseManager } from '../core/database.js';
import { logger } from '../core/logger.js';

type Decision = 'allow' | 'deny' | 'ask';

export class PermissionManager {
  private database: DatabaseManager;

  constructor(database: DatabaseManager) {
    this.database = database;
  }

  check(workspaceId: string, skillName: string, permission: string): Decision {
    const row = this.database.db
      .prepare(
        `SELECT decision FROM permission_decisions
         WHERE workspace_id = ? AND skill_name = ? AND permission = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(workspaceId, skillName, permission) as { decision: string } | undefined;

    if (!row) {
      logger.debug('permissions', `No decision found for ${skillName}:${permission} in workspace ${workspaceId}`);
      return 'ask';
    }

    return row.decision as Decision;
  }

  grant(workspaceId: string, skillName: string, permission: string): void {
    this.database.db
      .prepare(
        `INSERT INTO permission_decisions (workspace_id, skill_name, permission, decision, created_at)
         VALUES (?, ?, ?, 'allow', datetime('now'))`,
      )
      .run(workspaceId, skillName, permission);

    logger.info('permissions', `Granted "${permission}" to skill "${skillName}" in workspace ${workspaceId}`);
  }

  deny(workspaceId: string, skillName: string, permission: string): void {
    this.database.db
      .prepare(
        `INSERT INTO permission_decisions (workspace_id, skill_name, permission, decision, created_at)
         VALUES (?, ?, ?, 'deny', datetime('now'))`,
      )
      .run(workspaceId, skillName, permission);

    logger.info('permissions', `Denied "${permission}" to skill "${skillName}" in workspace ${workspaceId}`);
  }

  getPendingRequests(workspaceId: string): Array<{ skillName: string; permission: string }> {
    const rows = this.database.db
      .prepare(
        `SELECT DISTINCT skill_name, permission FROM permission_decisions
         WHERE workspace_id = ?
         GROUP BY skill_name, permission
         HAVING MAX(created_at) = (
           SELECT MAX(created_at) FROM permission_decisions pd2
           WHERE pd2.workspace_id = permission_decisions.workspace_id
             AND pd2.skill_name = permission_decisions.skill_name
             AND pd2.permission = permission_decisions.permission
         ) AND decision = 'ask'`,
      )
      .all(workspaceId) as Array<{ skill_name: string; permission: string }>;

    return rows.map((r) => ({
      skillName: r.skill_name,
      permission: r.permission,
    }));
  }
}
