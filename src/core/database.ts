import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { logger } from './logger.js';

const SCOPE = 'database';

export class DatabaseManager {
  private _db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');
    logger.debug(SCOPE, `Opened database at ${dbPath}`);
  }

  get db(): BetterSqlite3.Database {
    return this._db;
  }

  initialize(): void {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'pending',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        subscription_status TEXT NOT NULL DEFAULT 'none',
        subscription_start_date TEXT,
        plan_id TEXT,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      )
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_user_id TEXT,
        created_at TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0
      )
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS identities (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        channel_user_id TEXT NOT NULL,
        workspace_id TEXT,
        user_id TEXT,
        linked_at TEXT,
        pairing_code TEXT
      )
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        metadata TEXT
      )
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS permission_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        permission TEXT NOT NULL,
        decision TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS registration_codes (
        code TEXT PRIMARY KEY,
        telegram_chat_id TEXT NOT NULL,
        telegram_username TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_by_user_id TEXT
      )
    `);
    try { this._db.exec('ALTER TABLE registration_codes ADD COLUMN email TEXT'); } catch { /* column exists */ }

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        provider_id TEXT,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS verification_codes (
        code TEXT PRIMARY KEY,
        user_id TEXT,
        type TEXT NOT NULL,
        email TEXT,
        telegram_chat_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      )
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS admin_credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS user_2fa (
        user_id TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        totp_secret TEXT,
        totp_verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS user_passkeys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        credential_id TEXT NOT NULL UNIQUE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT,
        device_name TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS admin_2fa (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        method TEXT NOT NULL,
        totp_secret TEXT,
        totp_verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS admin_passkeys (
        id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL UNIQUE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT,
        device_name TEXT,
        created_at TEXT NOT NULL
      )
    `);

    this.migrate();
    logger.info(SCOPE, 'All tables initialized');
  }

  private migrate(): void {
    const addColumnIfMissing = (table: string, column: string, definition: string) => {
      const info = this._db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!info.some(col => col.name === column)) {
        this._db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        logger.info(SCOPE, `Migration: added ${table}.${column}`);
      }
    };

    addColumnIfMissing('workspaces', 'owner_user_id', 'TEXT');
    addColumnIfMissing('identities', 'user_id', 'TEXT');
    addColumnIfMissing('users', 'subscription_start_date', 'TEXT');
  }

  close(): void {
    try {
      this._db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      logger.warn(SCOPE, `WAL checkpoint failed: ${(err as Error).message}`);
    }
    this._db.close();
    logger.debug(SCOPE, 'Database connection closed');
  }
}
