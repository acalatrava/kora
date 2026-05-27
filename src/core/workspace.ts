import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger.js';
import type { DatabaseManager } from './database.js';
import type { ConfigManager } from './config.js';
import type { Workspace } from './types.js';

interface WorkspaceRow {
  id: string;
  name: string;
  owner_user_id: string | null;
  created_at: string;
  is_default: number;
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    createdAt: new Date(row.created_at),
    isDefault: row.is_default === 1,
  };
}

export class WorkspaceManager {
  private dbManager: DatabaseManager;
  private configManager: ConfigManager;

  constructor(dbManager: DatabaseManager, configManager: ConfigManager) {
    this.dbManager = dbManager;
    this.configManager = configManager;
  }

  create(name: string, isDefault = false, ownerUserId?: string): Workspace {
    const id = uuidv4();
    const createdAt = new Date().toISOString();

    this.dbManager.db
      .prepare('INSERT INTO workspaces (id, name, owner_user_id, created_at, is_default) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, ownerUserId ?? null, createdAt, isDefault ? 1 : 0);

    this.configManager.ensureWorkspaceDir(id);
    logger.info('workspace', `Created workspace "${name}" (${id}) owner=${ownerUserId ?? 'system'}`);

    return { id, name, ownerUserId: ownerUserId ?? null, createdAt: new Date(createdAt), isDefault };
  }

  get(id: string): Workspace | null {
    const row = this.dbManager.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(id) as WorkspaceRow | undefined;

    return row ? rowToWorkspace(row) : null;
  }

  getDefault(): Workspace | null {
    const row = this.dbManager.db
      .prepare('SELECT * FROM workspaces WHERE is_default = 1')
      .get() as WorkspaceRow | undefined;

    return row ? rowToWorkspace(row) : null;
  }

  getByOwner(userId: string): Workspace | null {
    const row = this.dbManager.db
      .prepare('SELECT * FROM workspaces WHERE owner_user_id = ? ORDER BY created_at ASC LIMIT 1')
      .get(userId) as WorkspaceRow | undefined;

    return row ? rowToWorkspace(row) : null;
  }

  listByOwner(userId: string): Workspace[] {
    const rows = this.dbManager.db
      .prepare('SELECT * FROM workspaces WHERE owner_user_id = ? ORDER BY created_at ASC')
      .all(userId) as WorkspaceRow[];

    return rows.map(rowToWorkspace);
  }

  isOwnedBy(workspaceId: string, userId: string): boolean {
    const row = this.dbManager.db
      .prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?')
      .get(workspaceId, userId);
    return !!row;
  }

  list(): Workspace[] {
    const rows = this.dbManager.db
      .prepare('SELECT * FROM workspaces ORDER BY created_at ASC')
      .all() as WorkspaceRow[];

    return rows.map(rowToWorkspace);
  }

  setOwner(workspaceId: string, ownerUserId: string): void {
    this.dbManager.db.prepare('UPDATE workspaces SET owner_user_id = ? WHERE id = ?')
      .run(ownerUserId, workspaceId);
    logger.info('workspace', `Set owner of workspace ${workspaceId} to ${ownerUserId}`);
  }

  ensureDefault(): Workspace {
    const existing = this.getDefault();
    if (existing) return existing;

    logger.info('workspace', 'No default workspace found, creating one');
    return this.create('default', true);
  }
}
