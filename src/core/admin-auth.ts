import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { logger } from './logger.js';
import type { DatabaseManager } from './database.js';
import type { StoredPasskey } from './two-factor.js';

const SCOPE = 'admin-auth';
const BCRYPT_ROUNDS = 12;

export class AdminAuth {
  constructor(private dbManager: DatabaseManager) { }

  initialize(): void {
    this.dbManager.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  hasCredentials(): boolean {
    const row = this.dbManager.db.prepare('SELECT id FROM admin_credentials WHERE id = 1').get();
    return !!row;
  }

  async setCredentials(username: string, password: string): Promise<void> {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const now = new Date().toISOString();

    this.dbManager.db.prepare(`
      INSERT INTO admin_credentials (id, username, password_hash, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash, updated_at = excluded.updated_at
    `).run(username, hash, now, now);

    logger.info(SCOPE, `Admin credentials set for user "${username}"`);
  }

  async verify(username: string, password: string): Promise<boolean> {
    const row = this.dbManager.db.prepare(
      'SELECT username, password_hash FROM admin_credentials WHERE id = 1'
    ).get() as { username: string; password_hash: string } | undefined;

    if (!row) return false;
    if (row.username !== username) return false;
    return bcrypt.compare(password, row.password_hash);
  }

  getUsername(): string | null {
    const row = this.dbManager.db.prepare(
      'SELECT username FROM admin_credentials WHERE id = 1'
    ).get() as { username: string } | undefined;
    return row?.username ?? null;
  }

  // ── 2FA ──

  has2FA(): boolean {
    return this.get2FAMethod() !== null;
  }

  get2FAMethod(): 'totp' | 'passkey' | null {
    const row = this.dbManager.db.prepare(
      'SELECT method, totp_verified FROM admin_2fa WHERE id = 1'
    ).get() as { method: string; totp_verified: number } | undefined;
    if (!row) return null;
    if (row.method === 'totp' && !row.totp_verified) return null;
    if (row.method === 'passkey') {
      const pkCount = this.dbManager.db.prepare(
        'SELECT COUNT(*) as cnt FROM admin_passkeys'
      ).get() as { cnt: number };
      if (!pkCount.cnt) return null;
    }
    return row.method as 'totp' | 'passkey';
  }

  getTotpSecret(): string | null {
    const row = this.dbManager.db.prepare(
      'SELECT totp_secret FROM admin_2fa WHERE id = 1 AND method = \'totp\' AND totp_verified = 1'
    ).get() as { totp_secret: string } | undefined;
    return row?.totp_secret ?? null;
  }

  setupTotp(secret: string): void {
    const now = new Date().toISOString();
    this.dbManager.db.prepare(`
      INSERT INTO admin_2fa (id, method, totp_secret, totp_verified, created_at, updated_at)
      VALUES (1, 'totp', ?, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET method = 'totp', totp_secret = excluded.totp_secret, totp_verified = 0, updated_at = excluded.updated_at
    `).run(secret, now, now);
  }

  verifyAndActivateTotp(): void {
    this.dbManager.db.prepare(
      'UPDATE admin_2fa SET totp_verified = 1, updated_at = ? WHERE id = 1'
    ).run(new Date().toISOString());
    logger.info(SCOPE, 'Admin TOTP 2FA activated');
  }

  setupPasskeyMethod(): void {
    const now = new Date().toISOString();
    this.dbManager.db.prepare(`
      INSERT INTO admin_2fa (id, method, totp_secret, totp_verified, created_at, updated_at)
      VALUES (1, 'passkey', NULL, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET method = 'passkey', totp_secret = NULL, totp_verified = 0, updated_at = excluded.updated_at
    `).run(now, now);
    logger.info(SCOPE, 'Admin Passkey 2FA method set');
  }

  savePasskey(passkey: StoredPasskey): void {
    const id = crypto.randomUUID();
    this.dbManager.db.prepare(`
      INSERT INTO admin_passkeys (id, credential_id, public_key, counter, transports, device_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, passkey.credentialId, passkey.publicKey, passkey.counter,
      passkey.transports ? JSON.stringify(passkey.transports) : null,
      passkey.deviceName ?? null, new Date().toISOString(),
    );
    logger.info(SCOPE, `Admin passkey saved: ${id}`);
  }

  getPasskeys(): StoredPasskey[] {
    const rows = this.dbManager.db.prepare(
      'SELECT credential_id, public_key, counter, transports, device_name FROM admin_passkeys'
    ).all() as Array<{ credential_id: string; public_key: Buffer; counter: number; transports: string | null; device_name: string | null }>;
    return rows.map(r => ({
      credentialId: r.credential_id,
      publicKey: Buffer.from(r.public_key),
      counter: r.counter,
      transports: r.transports ? JSON.parse(r.transports) : undefined,
      deviceName: r.device_name ?? undefined,
    }));
  }

  updatePasskeyCounter(credentialId: string, newCounter: number): void {
    this.dbManager.db.prepare(
      'UPDATE admin_passkeys SET counter = ? WHERE credential_id = ?'
    ).run(newCounter, credentialId);
  }

  clear2FA(): void {
    this.dbManager.db.prepare('DELETE FROM admin_2fa WHERE id = 1').run();
    this.dbManager.db.prepare('DELETE FROM admin_passkeys').run();
    logger.info(SCOPE, 'Admin 2FA cleared');
  }
}
