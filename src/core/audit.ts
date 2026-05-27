import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { eventBus } from './event-bus.js';
import type { AuditEntry } from './event-bus.js';
import { logger } from './logger.js';

const SCOPE = 'audit';

export class AuditLog {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
    this.subscribeToEvents();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        channel TEXT DEFAULT '',
        identity_id TEXT DEFAULT '',
        workspace_id TEXT DEFAULT '',
        data TEXT DEFAULT '{}',
        duration_ms INTEGER DEFAULT 0
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log(type)`);
    logger.debug(SCOPE, 'Audit log initialized');
  }

  private subscribeToEvents(): void {
    eventBus.on('audit_entry', (entry) => {
      this.persistEntry(entry);
    });
  }

  private persistEntry(entry: AuditEntry): void {
    try {
      this.db.prepare(
        `INSERT INTO audit_log (id, session_id, timestamp, type, channel, identity_id, workspace_id, data, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entry.id,
        entry.sessionId,
        entry.timestamp,
        entry.type,
        entry.channel,
        entry.identityId,
        entry.workspaceId,
        JSON.stringify(entry.data),
        entry.durationMs ?? 0,
      );
    } catch (err) {
      logger.error(SCOPE, `Failed to persist audit entry: ${(err as Error).message}`);
    }
  }

  emit(
    sessionId: string,
    type: AuditEntry['type'],
    data: Record<string, unknown>,
    opts?: { channel?: string; identityId?: string; workspaceId?: string; durationMs?: number },
  ): void {
    const entry: AuditEntry = {
      id: uuidv4(),
      sessionId,
      timestamp: new Date().toISOString(),
      type,
      channel: opts?.channel ?? '',
      identityId: opts?.identityId ?? '',
      workspaceId: opts?.workspaceId ?? '',
      data,
      durationMs: opts?.durationMs,
    };
    eventBus.emit('audit_entry', entry);
  }

  getSessions(limit = 50, offset = 0): Array<{
    sessionId: string;
    startedAt: string;
    lastActivityAt: string;
    channel: string;
    identityId: string;
    workspaceId: string;
    entryCount: number;
    chatContext?: { type: string; chatId?: number; threadId?: number; chatTitle?: string };
  }> {
    const rows = this.db.prepare(`
      SELECT
        session_id as sessionId,
        MIN(timestamp) as startedAt,
        MAX(timestamp) as lastActivityAt,
        MAX(channel) as channel,
        MAX(identity_id) as identityId,
        MAX(workspace_id) as workspaceId,
        COUNT(*) as entryCount,
        (SELECT data FROM audit_log s WHERE s.session_id = audit_log.session_id AND s.type = 'session_start' LIMIT 1) as sessionStartData
      FROM audit_log
      GROUP BY session_id
      ORDER BY lastActivityAt DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as Array<{
      sessionId: string; startedAt: string; lastActivityAt: string; channel: string;
      identityId: string; workspaceId: string; entryCount: number; sessionStartData?: string;
    }>;
    return rows.map(row => {
      const { sessionStartData, ...rest } = row;
      let chatContext: { type: string; chatId?: number; threadId?: number; chatTitle?: string } | undefined;
      if (sessionStartData) {
        try {
          const parsed = JSON.parse(sessionStartData);
          if (parsed.chatContext) chatContext = parsed.chatContext;
        } catch { /* ignore */ }
      }
      return { ...rest, chatContext };
    });
  }

  getSession(sessionId: string, limit = 0, offset = 0, sort: 'asc' | 'desc' = 'desc'): AuditEntry[] {
    const order = sort === 'asc' ? 'ASC' : 'DESC';
    const sql = limit > 0
      ? `SELECT * FROM audit_log WHERE session_id = ? ORDER BY timestamp ${order} LIMIT ? OFFSET ?`
      : `SELECT * FROM audit_log WHERE session_id = ? ORDER BY timestamp ${order}`;
    const params = limit > 0 ? [sessionId, limit, offset] : [sessionId];
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string; session_id: string; timestamp: string; type: string;
      channel: string; identity_id: string; workspace_id: string;
      data: string; duration_ms: number;
    }>;
    return rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      timestamp: r.timestamp,
      type: r.type as AuditEntry['type'],
      channel: r.channel,
      identityId: r.identity_id,
      workspaceId: r.workspace_id,
      data: JSON.parse(r.data || '{}'),
      durationMs: r.duration_ms,
    }));
  }

  getSessionEntryCount(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM audit_log WHERE session_id = ?`
    ).get(sessionId) as { count: number };
    return row.count;
  }

  getRecentEntries(limit = 100): AuditEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?`
    ).all(limit) as Array<{
      id: string; session_id: string; timestamp: string; type: string;
      channel: string; identity_id: string; workspace_id: string;
      data: string; duration_ms: number;
    }>;
    return rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      timestamp: r.timestamp,
      type: r.type as AuditEntry['type'],
      channel: r.channel,
      identityId: r.identity_id,
      workspaceId: r.workspace_id,
      data: JSON.parse(r.data || '{}'),
      durationMs: r.duration_ms,
    }));
  }

  getEntriesSince(since: string, limit = 200): AuditEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM audit_log WHERE timestamp > ? ORDER BY timestamp ASC LIMIT ?`
    ).all(since, limit) as Array<{
      id: string; session_id: string; timestamp: string; type: string;
      channel: string; identity_id: string; workspace_id: string;
      data: string; duration_ms: number;
    }>;
    return rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      timestamp: r.timestamp,
      type: r.type as AuditEntry['type'],
      channel: r.channel,
      identityId: r.identity_id,
      workspaceId: r.workspace_id,
      data: JSON.parse(r.data || '{}'),
      durationMs: r.duration_ms,
    }));
  }

  search(query: string, limit = 50): AuditEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM audit_log WHERE data LIKE ? ORDER BY timestamp DESC LIMIT ?`
    ).all(`%${query}%`, limit) as Array<{
      id: string; session_id: string; timestamp: string; type: string;
      channel: string; identity_id: string; workspace_id: string;
      data: string; duration_ms: number;
    }>;
    return rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      timestamp: r.timestamp,
      type: r.type as AuditEntry['type'],
      channel: r.channel,
      identityId: r.identity_id,
      workspaceId: r.workspace_id,
      data: JSON.parse(r.data || '{}'),
      durationMs: r.duration_ms,
    }));
  }

  getSessionCount(): number {
    const row = this.db.prepare(`SELECT COUNT(DISTINCT session_id) as count FROM audit_log`).get() as { count: number };
    return row.count;
  }

  deleteSession(sessionId: string): number {
    const result = this.db.prepare(`DELETE FROM audit_log WHERE session_id = ?`).run(sessionId);
    logger.debug(SCOPE, `Deleted ${result.changes} entries for session ${sessionId}`);
    return result.changes;
  }

  deleteSessionsByIdentity(pattern: string): number {
    const result = this.db.prepare(`DELETE FROM audit_log WHERE identity_id LIKE ?`).run(pattern);
    logger.info(SCOPE, `Deleted ${result.changes} entries matching identity pattern "${pattern}"`);
    return result.changes;
  }

  deleteAllSessions(): number {
    const result = this.db.prepare(`DELETE FROM audit_log`).run();
    logger.info(SCOPE, `Deleted all ${result.changes} audit entries`);
    return result.changes;
  }

  backfillChatContext(sessionId: string, chatContext: Record<string, unknown>): void {
    try {
      const row = this.db.prepare(
        `SELECT id, data FROM audit_log WHERE session_id = ? AND type = 'session_start' LIMIT 1`
      ).get(sessionId) as { id: string; data: string } | undefined;
      if (!row) return;
      const parsed = JSON.parse(row.data || '{}');
      if (parsed.chatContext) return;
      parsed.chatContext = chatContext;
      this.db.prepare(`UPDATE audit_log SET data = ? WHERE id = ?`).run(JSON.stringify(parsed), row.id);
    } catch { /* best effort */ }
  }

  cleanup(olderThanDays = 30): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`DELETE FROM audit_log WHERE timestamp < ?`).run(cutoff);
    return result.changes;
  }
}
