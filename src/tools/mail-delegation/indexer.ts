import type BetterSqlite3 from 'better-sqlite3';
import { logger } from '../../core/logger.js';
import type { EmbeddingProvider, VectorStore } from '../../core/vector-store.js';
import { createVectorStore, generateVectorId } from '../../core/vector-store.js';
import type { ConfigManager } from '../../core/config.js';
import type { ContentGuard } from '../../core/content-guard.js';
import type { DelegationManager } from './manager.js';
import type { DelegationConfig, DelegatedEmailDetail } from './types.js';

const SCOPE = 'MailIndexer';
const CHUNK_SIZE = 8000;
const BATCH_DELAY_MS = 500;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

export interface IndexingProgress {
  delegationId: string;
  accountEmail: string;
  workspaceId: string;
  status: 'running' | 'paused' | 'completed' | 'error';
  totalMessages: number;
  indexedCount: number;
  skippedSensitive: number;
  lastMessageDate: string | null;
  error: string | null;
  startedAt: string | null;
  updatedAt: string;
}

interface IndexingProgressRow {
  delegation_id: string;
  workspace_id: string;
  account_email: string;
  status: string;
  total_messages: number;
  indexed_count: number;
  skipped_sensitive: number;
  last_message_date: string | null;
  error: string | null;
  started_at: string | null;
  updated_at: string;
}

function rowToProgress(row: IndexingProgressRow): IndexingProgress {
  return {
    delegationId: row.delegation_id,
    accountEmail: row.account_email,
    workspaceId: row.workspace_id,
    status: row.status as IndexingProgress['status'],
    totalMessages: row.total_messages,
    indexedCount: row.indexed_count,
    skippedSensitive: row.skipped_sensitive ?? 0,
    lastMessageDate: row.last_message_date,
    error: row.error,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

export class MailIndexer {
  private db: BetterSqlite3.Database;
  private delegationManager: DelegationManager;
  private config: ConfigManager;
  private embeddingProvider: EmbeddingProvider;
  private contentGuard?: ContentGuard;
  private sensitiveMailFilter = true;
  private vectorStores = new Map<string, VectorStore>();
  private runningJobs = new Map<string, boolean>();
  private abortFlags = new Map<string, boolean>();

  constructor(
    db: BetterSqlite3.Database,
    delegationManager: DelegationManager,
    config: ConfigManager,
    embeddingProvider: EmbeddingProvider,
    contentGuard?: ContentGuard,
  ) {
    this.db = db;
    this.delegationManager = delegationManager;
    this.config = config;
    this.embeddingProvider = embeddingProvider;
    this.contentGuard = contentGuard;
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_indexing_progress (
        delegation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        account_email TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        total_messages INTEGER NOT NULL DEFAULT 0,
        indexed_count INTEGER NOT NULL DEFAULT 0,
        skipped_sensitive INTEGER NOT NULL DEFAULT 0,
        last_message_date TEXT,
        error TEXT,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (delegation_id)
      )
    `);
    try {
      this.db.exec(`ALTER TABLE mail_indexing_progress ADD COLUMN skipped_sensitive INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_indexed_ids (
        delegation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        PRIMARY KEY (delegation_id, message_id)
      )
    `);
    logger.debug(SCOPE, 'Mail indexing tables ready');
  }

  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
  }

  setContentGuard(guard: ContentGuard): void {
    this.contentGuard = guard;
  }

  setSensitiveMailFilter(enabled: boolean): void {
    this.sensitiveMailFilter = enabled;
  }

  private getVectorStore(workspaceId: string): VectorStore {
    let store = this.vectorStores.get(workspaceId);
    if (!store) {
      const wsPath = this.config.getWorkspacePath(workspaceId);
      store = createVectorStore(wsPath);
      this.vectorStores.set(workspaceId, store);
    }
    return store;
  }

  /**
   * Start background indexing for all delegation accounts in a workspace.
   * Processes newest emails first going back one year.
   */
  async startIndexing(workspaceId: string): Promise<void> {
    const configs = this.delegationManager.listForWorkspace(workspaceId);
    if (configs.length === 0) {
      logger.debug(SCOPE, `No delegations for workspace ${workspaceId}, skipping`);
      return;
    }

    for (const cfg of configs) {
      if (!cfg.permissions.read) continue;
      if (this.runningJobs.get(cfg.id)) {
        logger.debug(SCOPE, `Indexing already running for ${cfg.email}`);
        continue;
      }

      const existing = this.getProgressForDelegation(cfg.id);
      if (existing && existing.status === 'completed') {
        logger.info(SCOPE, `Indexing already completed for ${cfg.email}, skipping`);
        continue;
      }

      this.abortFlags.set(cfg.id, false);
      this.runJob(cfg).catch(err => {
        logger.error(SCOPE, `Indexing job for ${cfg.email} crashed: ${(err as Error).message}`);
      });
    }
  }

  private getProgressForDelegation(delegationId: string): IndexingProgress | null {
    const row = this.db.prepare(
      'SELECT * FROM mail_indexing_progress WHERE delegation_id = ?'
    ).get(delegationId) as IndexingProgressRow | undefined;
    return row ? rowToProgress(row) : null;
  }

  private getIndexedCount(delegationId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM mail_indexed_ids WHERE delegation_id = ?'
    ).get(delegationId) as { cnt: number };
    return row.cnt;
  }

  stopIndexing(workspaceId: string): void {
    const configs = this.delegationManager.listForWorkspace(workspaceId);
    for (const cfg of configs) {
      this.abortFlags.set(cfg.id, true);
    }
  }

  stopAll(): void {
    for (const key of this.runningJobs.keys()) {
      this.abortFlags.set(key, true);
    }
  }

  closeVectorStores(): void {
    for (const store of this.vectorStores.values()) {
      try { store.close(); } catch { /* best effort */ }
    }
    this.vectorStores.clear();
  }

  /**
   * Reset indexing for a workspace. Optionally scoped to a single delegation account.
   * Deletes indexed IDs, vector store entries, progress rows, then optionally restarts.
   */
  async resetIndexing(workspaceId: string, delegationId?: string, restart = true): Promise<void> {
    const configs = delegationId
      ? this.delegationManager.listForWorkspace(workspaceId).filter(c => c.id === delegationId)
      : this.delegationManager.listForWorkspace(workspaceId);

    for (const cfg of configs) {
      this.abortFlags.set(cfg.id, true);
    }

    await this.delay(1000);

    for (const cfg of configs) {
      this.db.prepare('DELETE FROM mail_indexed_ids WHERE delegation_id = ?').run(cfg.id);
      this.db.prepare('DELETE FROM mail_indexing_progress WHERE delegation_id = ?').run(cfg.id);
      logger.info(SCOPE, `Reset indexing data for ${cfg.email} (delegation ${cfg.id})`);
    }

    try {
      const store = this.getVectorStore(workspaceId);
      if (delegationId) {
        const cfg = configs[0];
        if (cfg) {
          store.deleteByMetadata('accountEmail', cfg.email);
          logger.info(SCOPE, `Deleted vectors for account ${cfg.email}`);
        }
      } else {
        store.deleteByMetadata('source', 'mail_delegation');
        logger.info(SCOPE, `Deleted all mail_delegation vectors for workspace ${workspaceId}`);
      }
    } catch (err) {
      logger.warn(SCOPE, `Vector cleanup during reset: ${(err as Error).message}`);
    }

    if (restart) {
      await this.startIndexing(workspaceId);
    }
  }

  getProgress(workspaceId: string): IndexingProgress[] {
    const rows = this.db.prepare(
      'SELECT * FROM mail_indexing_progress WHERE workspace_id = ?'
    ).all(workspaceId) as IndexingProgressRow[];
    return rows.map(rowToProgress);
  }

  getAllProgress(): IndexingProgress[] {
    const rows = this.db.prepare(
      'SELECT * FROM mail_indexing_progress ORDER BY workspace_id'
    ).all() as IndexingProgressRow[];
    return rows.map(rowToProgress);
  }

  /**
   * Index a single email into the vector store (for real-time new mail).
   */
  async indexSingleEmail(
    workspaceId: string,
    delegationId: string,
    email: DelegatedEmailDetail,
    accountEmail: string,
  ): Promise<void> {
    if (this.isAlreadyIndexed(delegationId, email.id)) return;

    if (this.sensitiveMailFilter && this.contentGuard) {
      const scan = await this.contentGuard.scanEmail(email.subject, email.body || '', email.snippet);
      if (scan.blocked) {
        logger.debug(SCOPE, `Skipping sensitive email "${email.subject}" (single-index): ${scan.reasons[0]}`);
        return;
      }
    }

    const content = this.buildEmailDocument(email, accountEmail);
    const store = this.getVectorStore(workspaceId);
    await this.indexDocument(store, content, {
      source: 'mail_delegation',
      messageId: email.id,
      date: email.date,
      from: email.from,
      to: email.to,
      subject: email.subject,
      accountEmail,
      workspaceId,
    });

    this.markIndexed(delegationId, email.id);
  }

  /**
   * Fetch new emails since a given date for all delegation accounts in a workspace.
   * Returns formatted summaries suitable for heartbeat context.
   */
  async getNewEmailsSince(workspaceId: string, since: Date): Promise<string[]> {
    const configs = this.delegationManager.listForWorkspace(workspaceId);
    const summaries: string[] = [];

    for (const cfg of configs) {
      if (!cfg.permissions.read) continue;
      try {
        const account = this.delegationManager.getAccount(cfg);
        const emails = await account.getInbox(20, false);
        for (const email of emails) {
          const emailDate = new Date(email.date);
          if (emailDate > since) {
            if (this.sensitiveMailFilter && this.contentGuard) {
              const scan = await this.contentGuard.scanEmail(email.subject, '', email.snippet);
              if (scan.blocked) {
                logger.debug(SCOPE, `Filtered sensitive new email "${email.subject}" from heartbeat`);
                continue;
              }
            }
            summaries.push(
              `[${cfg.email}] From: ${email.from} | Subject: ${email.subject} | Date: ${email.date}` +
              (email.snippet ? ` | Preview: ${email.snippet.slice(0, 120)}` : '')
            );
          }
        }
      } catch (err) {
        logger.warn(SCOPE, `Failed to fetch new emails for ${cfg.email}: ${(err as Error).message}`);
      }
    }

    return summaries;
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private async runJob(cfg: DelegationConfig): Promise<void> {
    this.runningJobs.set(cfg.id, true);
    const now = new Date().toISOString();

    const existingProgress = this.getProgressForDelegation(cfg.id);
    const previouslyIndexed = this.getIndexedCount(cfg.id);
    const resuming = previouslyIndexed > 0;

    if (resuming && existingProgress) {
      this.updateProgressFields(cfg.id, {
        status: 'running',
        error: null,
        updated_at: now,
      });
      logger.info(SCOPE, `Resuming indexing for ${cfg.email} (${previouslyIndexed} already indexed)`);
    } else {
      this.upsertProgress(cfg.id, {
        workspace_id: cfg.workspaceId,
        account_email: cfg.email,
        status: 'running',
        total_messages: 0,
        indexed_count: 0,
        skipped_sensitive: 0,
        error: null,
        started_at: now,
        updated_at: now,
      });
      logger.info(SCOPE, `Starting indexing for ${cfg.email} (workspace ${cfg.workspaceId})`);
    }

    try {
      const account = this.delegationManager.getAccount(cfg);
      const store = this.getVectorStore(cfg.workspaceId);
      const afterDate = new Date(Date.now() - THREE_MONTHS_MS);

      let totalSeen = 0;
      let indexedInRun = previouslyIndexed;
      let skippedSensitive = existingProgress?.skippedSensitive ?? 0;

      for await (const batch of account.listMessageIds(afterDate)) {
        if (this.abortFlags.get(cfg.id)) {
          logger.info(SCOPE, `Indexing aborted for ${cfg.email}`);
          this.updateProgressField(cfg.id, 'status', 'paused');
          break;
        }

        totalSeen += batch.length;
        this.updateProgressField(cfg.id, 'total_messages', totalSeen);

        for (const msgId of batch) {
          if (this.abortFlags.get(cfg.id)) break;
          if (this.isAlreadyIndexed(cfg.id, msgId)) continue;

          try {
            const email = await account.readMessage(msgId);

            if (this.sensitiveMailFilter && this.contentGuard) {
              const scan = await this.contentGuard.scanEmail(email.subject, email.body || '', email.snippet);
              if (scan.blocked) {
                skippedSensitive++;
                this.updateProgressFields(cfg.id, {
                  skipped_sensitive: skippedSensitive,
                  updated_at: new Date().toISOString(),
                });
                logger.debug(SCOPE, `Skipped sensitive email "${email.subject}" from ${cfg.email}: ${scan.reasons[0]}`);
                await this.delay(BATCH_DELAY_MS);
                continue;
              }
            }

            const content = this.buildEmailDocument(email, cfg.email);

            await this.indexDocument(store, content, {
              source: 'mail_delegation',
              messageId: msgId,
              date: email.date,
              from: email.from,
              to: email.to,
              subject: email.subject,
              accountEmail: cfg.email,
              workspaceId: cfg.workspaceId,
            });

            this.markIndexed(cfg.id, msgId);
            indexedInRun++;

            this.updateProgressFields(cfg.id, {
              indexed_count: indexedInRun,
              last_message_date: email.date,
              updated_at: new Date().toISOString(),
            });

          } catch (err) {
            logger.warn(SCOPE, `Failed to index message ${msgId} from ${cfg.email}: ${(err as Error).message}`);
          }

          await this.delay(BATCH_DELAY_MS);
        }
      }

      if (!this.abortFlags.get(cfg.id)) {
        this.updateProgressFields(cfg.id, {
          status: 'completed',
          total_messages: totalSeen,
          indexed_count: indexedInRun,
          skipped_sensitive: skippedSensitive,
          updated_at: new Date().toISOString(),
        });
        logger.info(SCOPE, `Indexing completed for ${cfg.email}: ${indexedInRun} indexed, ${skippedSensitive} sensitive skipped`);
      }

    } catch (err) {
      const msg = (err as Error).message;
      logger.error(SCOPE, `Indexing failed for ${cfg.email}: ${msg}`);
      this.updateProgressFields(cfg.id, {
        status: 'error',
        error: msg,
        updated_at: new Date().toISOString(),
      });
    } finally {
      this.runningJobs.delete(cfg.id);
      this.abortFlags.delete(cfg.id);
    }
  }

  private buildEmailDocument(email: DelegatedEmailDetail, accountEmail: string): string {
    const lines: string[] = [
      `Date: ${email.date}`,
      `From: ${email.from}`,
      `To: ${email.to}`,
      `Account: ${accountEmail}`,
      `Subject: ${email.subject}`,
    ];

    if (email.attachments && email.attachments.length > 0) {
      const attList = email.attachments.map(a => `${a.filename} (${a.mimeType})`).join(', ');
      lines.push(`Attachments: ${attList}`);
    }

    lines.push('');
    lines.push(email.body || email.snippet || '');

    return lines.join('\n');
  }

  private async indexDocument(
    store: VectorStore,
    content: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const chunks = this.chunkText(content, CHUNK_SIZE);
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await this.embeddingProvider.embed(chunks[i]);
      store.insert({
        id: generateVectorId(),
        content: chunks[i],
        embedding,
        metadata: { ...metadata, chunkIndex: i, totalChunks: chunks.length },
      });
    }
  }

  private chunkText(text: string, maxChars: number): string[] {
    const lines = text.split('\n');
    const chunks: string[] = [];
    let current = '';
    for (const line of lines) {
      if (current.length + line.length + 1 > maxChars && current.length > 0) {
        chunks.push(current);
        current = '';
      }
      current += (current ? '\n' : '') + line;
    }
    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : [''];
  }

  private isAlreadyIndexed(delegationId: string, messageId: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM mail_indexed_ids WHERE delegation_id = ? AND message_id = ?'
    ).get(delegationId, messageId);
    return !!row;
  }

  private markIndexed(delegationId: string, messageId: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO mail_indexed_ids (delegation_id, message_id, indexed_at) VALUES (?, ?, ?)'
    ).run(delegationId, messageId, new Date().toISOString());
  }

  private upsertProgress(delegationId: string, fields: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO mail_indexing_progress
        (delegation_id, workspace_id, account_email, status, total_messages, indexed_count, skipped_sensitive, last_message_date, error, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      delegationId,
      fields.workspace_id,
      fields.account_email,
      fields.status,
      fields.total_messages,
      fields.indexed_count,
      fields.skipped_sensitive ?? 0,
      fields.last_message_date ?? null,
      fields.error ?? null,
      fields.started_at ?? null,
      fields.updated_at,
    );
  }

  private updateProgressField(delegationId: string, field: string, value: unknown): void {
    this.db.prepare(
      `UPDATE mail_indexing_progress SET ${field} = ?, updated_at = ? WHERE delegation_id = ?`
    ).run(value, new Date().toISOString(), delegationId);
  }

  private updateProgressFields(delegationId: string, fields: Record<string, unknown>): void {
    const keys = Object.keys(fields);
    const setClause = keys.map(k => `${k} = ?`).join(', ');
    this.db.prepare(
      `UPDATE mail_indexing_progress SET ${setClause} WHERE delegation_id = ?`
    ).run(...keys.map(k => fields[k] ?? null), delegationId);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
