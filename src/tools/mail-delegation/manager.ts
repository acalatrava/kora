import { v4 as uuidv4 } from 'uuid';
import type BetterSqlite3 from 'better-sqlite3';
import { logger } from '../../core/logger.js';
import { DelegatedMailAccount, GmailDelegatedAccount, ImapDelegatedAccount } from './account.js';
import type {
  DelegationConfig,
  DelegationCredentials,
  DelegationPermissions,
  DelegationGlobalConfig,
} from './types.js';

const SCOPE = 'DelegationManager';

interface DelegationRow {
  id: string;
  workspace_id: string;
  provider: 'gmail' | 'imap';
  email: string;
  credentials: string;
  permissions: string;
  auto_check_minutes: number;
  last_checked_at: string | null;
  created_at: string;
}

function rowToConfig(row: DelegationRow): DelegationConfig {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    email: row.email,
    credentials: JSON.parse(row.credentials) as DelegationCredentials,
    permissions: JSON.parse(row.permissions) as DelegationPermissions,
    autoCheckMinutes: row.auto_check_minutes,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
  };
}

export class DelegationManager {
  private db: BetterSqlite3.Database;
  private globalConfig: DelegationGlobalConfig;
  private accountCache = new Map<string, DelegatedMailAccount>();

  constructor(db: BetterSqlite3.Database, globalConfig: DelegationGlobalConfig = {}) {
    this.db = db;
    this.globalConfig = globalConfig;
    this.initTable();
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_delegations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        email TEXT NOT NULL,
        credentials TEXT NOT NULL,
        permissions TEXT NOT NULL,
        auto_check_minutes INTEGER NOT NULL DEFAULT 0,
        last_checked_at TEXT,
        created_at TEXT NOT NULL
      )
    `);
    logger.debug(SCOPE, 'mail_delegations table ready');
  }

  setGlobalConfig(config: DelegationGlobalConfig): void {
    this.globalConfig = config;
    this.accountCache.clear();
  }

  add(
    workspaceId: string,
    provider: 'gmail' | 'imap',
    email: string,
    credentials: DelegationCredentials,
    permissions: DelegationPermissions = { read: true, send: false },
    autoCheckMinutes = 0,
  ): DelegationConfig {
    const id = uuidv4();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO mail_delegations (id, workspace_id, provider, email, credentials, permissions, auto_check_minutes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, workspaceId, provider, email, JSON.stringify(credentials), JSON.stringify(permissions), autoCheckMinutes, now);

    logger.info(SCOPE, `Added ${provider} delegation for ${email} in workspace ${workspaceId}`);

    return {
      id, workspaceId, provider, email, credentials, permissions,
      autoCheckMinutes, lastCheckedAt: null, createdAt: now,
    };
  }

  remove(id: string): boolean {
    const changes = this.db.prepare('DELETE FROM mail_delegations WHERE id = ?').run(id).changes;
    if (changes > 0) {
      this.accountCache.delete(id);
      logger.info(SCOPE, `Removed delegation ${id}`);
    }
    return changes > 0;
  }

  update(id: string, updates: Partial<Pick<DelegationConfig, 'permissions' | 'autoCheckMinutes' | 'credentials'>>): boolean {
    const existing = this.get(id);
    if (!existing) return false;

    if (updates.permissions) {
      this.db.prepare('UPDATE mail_delegations SET permissions = ? WHERE id = ?')
        .run(JSON.stringify(updates.permissions), id);
    }
    if (updates.autoCheckMinutes !== undefined) {
      this.db.prepare('UPDATE mail_delegations SET auto_check_minutes = ? WHERE id = ?')
        .run(updates.autoCheckMinutes, id);
    }
    if (updates.credentials) {
      this.db.prepare('UPDATE mail_delegations SET credentials = ? WHERE id = ?')
        .run(JSON.stringify(updates.credentials), id);
      this.accountCache.delete(id);
    }

    return true;
  }

  updateLastChecked(id: string): void {
    this.db.prepare('UPDATE mail_delegations SET last_checked_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  get(id: string): DelegationConfig | null {
    const row = this.db.prepare('SELECT * FROM mail_delegations WHERE id = ?')
      .get(id) as DelegationRow | undefined;
    return row ? rowToConfig(row) : null;
  }

  listForWorkspace(workspaceId: string): DelegationConfig[] {
    const rows = this.db.prepare('SELECT * FROM mail_delegations WHERE workspace_id = ? ORDER BY created_at')
      .all(workspaceId) as DelegationRow[];
    return rows.map(rowToConfig);
  }

  listAll(): DelegationConfig[] {
    const rows = this.db.prepare('SELECT * FROM mail_delegations ORDER BY workspace_id, created_at')
      .all() as DelegationRow[];
    return rows.map(rowToConfig);
  }

  findByEmail(workspaceId: string, email: string): DelegationConfig | null {
    const row = this.db.prepare('SELECT * FROM mail_delegations WHERE workspace_id = ? AND email = ?')
      .get(workspaceId, email.toLowerCase()) as DelegationRow | undefined;
    return row ? rowToConfig(row) : null;
  }

  getDueForAutoCheck(): DelegationConfig[] {
    const rows = this.db.prepare(`
      SELECT * FROM mail_delegations
      WHERE auto_check_minutes > 0
      AND (last_checked_at IS NULL
           OR (julianday('now') - julianday(last_checked_at)) * 1440 >= auto_check_minutes)
    `).all() as DelegationRow[];
    return rows.map(rowToConfig);
  }

  getAccount(config: DelegationConfig): DelegatedMailAccount {
    const cached = this.accountCache.get(config.id);
    if (cached) return cached;

    let account: DelegatedMailAccount;

    if (config.provider === 'gmail') {
      if (!this.globalConfig.google_client_id || !this.globalConfig.google_client_secret) {
        throw new Error('Google OAuth2 credentials not configured globally. Set mail_delegation.google_client_id and google_client_secret in settings.');
      }
      account = new GmailDelegatedAccount(
        config.email,
        config.credentials,
        this.globalConfig.google_client_id,
        this.globalConfig.google_client_secret,
        config.permissions,
      );
    } else {
      account = new ImapDelegatedAccount(
        config.email,
        config.credentials,
        config.permissions,
      );
    }

    this.accountCache.set(config.id, account);
    return account;
  }

  resolveAccount(workspaceId: string, emailHint?: string): { config: DelegationConfig; account: DelegatedMailAccount } {
    const configs = this.listForWorkspace(workspaceId);
    if (configs.length === 0) {
      throw new Error('No delegated email accounts configured for this workspace. Ask the user to set one up via web admin or /link.');
    }

    let config: DelegationConfig;
    if (emailHint) {
      const match = configs.find(c => c.email.toLowerCase() === emailHint.toLowerCase());
      if (!match) throw new Error(`No delegated account found for "${emailHint}". Available: ${configs.map(c => c.email).join(', ')}`);
      config = match;
    } else {
      config = configs[0];
    }

    return { config, account: this.getAccount(config) };
  }
}
