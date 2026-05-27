import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger.js';
import type { DatabaseManager } from './database.js';
import type { Identity } from './types.js';

interface IdentityRow {
  id: string;
  channel: string;
  channel_user_id: string;
  workspace_id: string | null;
  user_id: string | null;
  linked_at: string | null;
  pairing_code: string | null;
}

function rowToIdentity(row: IdentityRow): Identity {
  return {
    id: row.id,
    channel: row.channel,
    channelUserId: row.channel_user_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    linkedAt: row.linked_at ? new Date(row.linked_at) : null,
    pairingCode: row.pairing_code,
  };
}

export class IdentityManager {
  private dbManager: DatabaseManager;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  resolve(channel: string, channelUserId: string): Identity | null {
    const rows = this.dbManager.db
      .prepare('SELECT * FROM identities WHERE channel = ? AND channel_user_id = ?')
      .all(channel, channelUserId) as IdentityRow[];

    if (rows.length === 0) {
      const bareId = channelUserId.replace(`${channel}:`, '');
      if (bareId !== channelUserId) {
        return this.resolve(channel, bareId);
      }
      return null;
    }
    if (rows.length === 1) return rowToIdentity(rows[0]);

    const linked = rows.find(r => r.user_id !== null);
    if (linked) {
      for (const dup of rows) {
        if (dup.id !== linked.id) {
          this.dbManager.db.prepare('DELETE FROM identities WHERE id = ?').run(dup.id);
          logger.info('identity', `Cleaned up duplicate identity ${dup.id} (kept ${linked.id})`);
        }
      }
      return rowToIdentity(linked);
    }

    return rowToIdentity(rows[0]);
  }

  create(channel: string, channelUserId: string, workspaceId?: string, userId?: string): Identity {
    const id = uuidv4();
    const linkedAt = workspaceId ? new Date().toISOString() : null;

    this.dbManager.db
      .prepare(
        'INSERT INTO identities (id, channel, channel_user_id, workspace_id, user_id, linked_at, pairing_code) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, channel, channelUserId, workspaceId ?? null, userId ?? null, linkedAt, null);

    logger.info('identity', `Created identity ${id} for ${channel}:${channelUserId}`);

    return {
      id,
      channel,
      channelUserId,
      workspaceId: workspaceId ?? null,
      userId: userId ?? null,
      linkedAt: linkedAt ? new Date(linkedAt) : null,
      pairingCode: null,
    };
  }

  resolveOrCreate(channel: string, channelUserId: string, defaultWorkspaceId: string): Identity {
    const existing = this.resolve(channel, channelUserId);
    if (existing) return existing;

    const bareId = channelUserId.replace(`${channel}:`, '');
    if (bareId !== channelUserId) {
      const byBare = this.resolve(channel, bareId);
      if (byBare) {
        this.dbManager.db.prepare('UPDATE identities SET channel_user_id = ? WHERE id = ?').run(channelUserId, byBare.id);
        logger.info('identity', `Normalized channel_user_id from "${bareId}" to "${channelUserId}" for identity ${byBare.id}`);
        byBare.channelUserId = channelUserId;
        return byBare;
      }
    }

    return this.create(channel, channelUserId, defaultWorkspaceId);
  }

  generatePairingCode(identityId: string): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    this.dbManager.db
      .prepare('UPDATE identities SET pairing_code = ? WHERE id = ?')
      .run(code, identityId);

    logger.debug('identity', `Generated pairing code for identity ${identityId}`);
    return code;
  }

  linkToUser(identityId: string, userId: string, workspaceId: string): void {
    const now = new Date().toISOString();
    this.dbManager.db
      .prepare('UPDATE identities SET user_id = ?, workspace_id = ?, linked_at = ? WHERE id = ?')
      .run(userId, workspaceId, now, identityId);
    logger.info('identity', `Linked identity ${identityId} to user ${userId}, workspace ${workspaceId}`);
  }

  getByUserId(userId: string): Identity[] {
    const rows = this.dbManager.db
      .prepare('SELECT * FROM identities WHERE user_id = ?')
      .all(userId) as IdentityRow[];
    return rows.map(rowToIdentity);
  }

  linkWithCode(code: string, workspaceId: string): boolean {
    const row = this.dbManager.db
      .prepare('SELECT * FROM identities WHERE pairing_code = ?')
      .get(code) as IdentityRow | undefined;

    if (!row) return false;

    const now = new Date().toISOString();
    this.dbManager.db
      .prepare('UPDATE identities SET workspace_id = ?, linked_at = ?, pairing_code = NULL WHERE id = ?')
      .run(workspaceId, now, row.id);

    logger.info('identity', `Linked identity ${row.id} to workspace ${workspaceId} via pairing code`);
    return true;
  }

  getByWorkspace(workspaceId: string): Identity[] {
    const rows = this.dbManager.db
      .prepare('SELECT * FROM identities WHERE workspace_id = ?')
      .all(workspaceId) as IdentityRow[];

    return rows.map(rowToIdentity);
  }

  listByChannel(channel: string): Identity[] {
    const rows = this.dbManager.db
      .prepare('SELECT * FROM identities WHERE channel = ?')
      .all(channel) as IdentityRow[];

    return rows.map(rowToIdentity);
  }

  listByWorkspace(workspaceId: string): Identity[] {
    const rows = this.dbManager.db
      .prepare('SELECT * FROM identities WHERE workspace_id = ?')
      .all(workspaceId) as IdentityRow[];

    return rows.map(rowToIdentity);
  }

  listAll(): Identity[] {
    const rows = this.dbManager.db
      .prepare('SELECT * FROM identities')
      .all() as IdentityRow[];

    return rows.map(rowToIdentity);
  }
}
