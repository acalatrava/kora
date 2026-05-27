import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { logger } from './logger.js';
import type { DatabaseManager } from './database.js';
import type { User, UserRole, UserStatus, SubscriptionStatus, RegistrationCode } from './types.js';
import type { StoredPasskey } from './two-factor.js';

const SCOPE = 'user';
const BCRYPT_ROUNDS = 12;
const REG_CODE_TTL_MS = 10 * 60 * 1000;
const VERIFICATION_CODE_TTL_MS = 15 * 60 * 1000;

interface UserRow {
  id: string;
  email: string | null;
  password_hash: string;
  display_name: string | null;
  role: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string;
  subscription_start_date: string | null;
  plan_id: string | null;
  created_at: string;
  last_login_at: string | null;
}

interface RegCodeRow {
  code: string;
  telegram_chat_id: string;
  telegram_username: string | null;
  email: string | null;
  created_at: string;
  expires_at: string;
  used_by_user_id: string | null;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    role: row.role as UserRole,
    status: row.status as UserStatus,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    subscriptionStatus: row.subscription_status as SubscriptionStatus,
    subscriptionStartDate: row.subscription_start_date ? new Date(row.subscription_start_date) : null,
    planId: row.plan_id,
    createdAt: new Date(row.created_at),
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : null,
  };
}

function rowToRegCode(row: RegCodeRow): RegistrationCode {
  return {
    code: row.code,
    telegramChatId: row.telegram_chat_id,
    telegramUsername: row.telegram_username,
    email: row.email,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    usedByUserId: row.used_by_user_id,
  };
}

export class UserManager {
  private dbManager: DatabaseManager;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  async create(email: string, password: string, displayName?: string, role: UserRole = 'user'): Promise<User> {
    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const createdAt = new Date().toISOString();

    this.dbManager.db.prepare(`
      INSERT INTO users (id, email, password_hash, display_name, role, status, subscription_status, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', 'none', ?)
    `).run(id, email.toLowerCase(), passwordHash, displayName ?? null, role, createdAt);

    logger.info(SCOPE, `Created user ${id} (${email}), role=${role}`);

    return {
      id, email: email.toLowerCase(), passwordHash, displayName: displayName ?? null,
      role, status: 'active', stripeCustomerId: null, stripeSubscriptionId: null,
      subscriptionStatus: 'none', subscriptionStartDate: null, planId: null, createdAt: new Date(createdAt), lastLoginAt: null,
    };
  }

  async authenticate(email: string, password: string): Promise<{ user: User | null; reason?: string }> {
    const row = this.dbManager.db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email.toLowerCase()) as UserRow | undefined;

    if (!row) return { user: null, reason: 'invalid_credentials' };

    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) return { user: null, reason: 'invalid_credentials' };

    if (row.status === 'suspended') return { user: null, reason: 'suspended' };
    if (row.status === 'pending_verification') return { user: null, reason: 'pending_verification' };

    this.dbManager.db
      .prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
      .run(new Date().toISOString(), row.id);

    return { user: rowToUser(row) };
  }

  getById(id: string): User | null {
    const row = this.dbManager.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  getByEmail(email: string): User | null {
    const row = this.dbManager.db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email.toLowerCase()) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  listAll(): User[] {
    const rows = this.dbManager.db
      .prepare('SELECT * FROM users ORDER BY created_at ASC')
      .all() as UserRow[];
    return rows.map(rowToUser);
  }

  suspend(userId: string): void {
    this.dbManager.db.prepare('UPDATE users SET status = ? WHERE id = ?').run('suspended', userId);
    logger.info(SCOPE, `Suspended user ${userId}`);
  }

  activate(userId: string): void {
    this.dbManager.db.prepare('UPDATE users SET status = ? WHERE id = ?').run('active', userId);
    logger.info(SCOPE, `Activated user ${userId}`);
  }

  createAnonymousUser(displayName: string): User {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.dbManager.db.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, role, status, subscription_status, created_at)
       VALUES (?, NULL, '', ?, 'user', 'active', 'none', ?)`
    ).run(id, displayName, now);
    logger.info(SCOPE, `Created anonymous user ${id} (${displayName})`);
    return this.getById(id)!;
  }

  async updatePassword(userId: string, newPassword: string): Promise<void> {
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    this.dbManager.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
    logger.info(SCOPE, `Password updated for user ${userId}`);
  }

  deleteUser(userId: string): boolean {
    const user = this.getById(userId);
    if (!user) return false;

    const db = this.dbManager.db;
    const workspaces = db.prepare('SELECT id FROM workspaces WHERE owner_user_id = ?').all(userId) as { id: string }[];
    const wsIds = workspaces.map(w => w.id);

    db.transaction(() => {
      db.prepare('DELETE FROM user_passkeys WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM user_2fa WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM verification_codes WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM usage_logs WHERE user_id = ?').run(userId);
      for (const wsId of wsIds) {
        db.prepare('DELETE FROM scheduled_tasks WHERE workspace_id = ?').run(wsId);
        db.prepare('DELETE FROM sub_agents WHERE workspace_id = ?').run(wsId);
        db.prepare('DELETE FROM messages WHERE workspace_id = ?').run(wsId);
        db.prepare('DELETE FROM permission_decisions WHERE workspace_id = ?').run(wsId);
        db.prepare('DELETE FROM tool_approvals WHERE workspace_id = ?').run(wsId);
        db.prepare('DELETE FROM mail_delegations WHERE workspace_id = ?').run(wsId);
        db.prepare('DELETE FROM api_chat_sessions WHERE workspace_id = ?').run(wsId);
        db.prepare('DELETE FROM workspaces WHERE id = ?').run(wsId);
      }
      db.prepare('DELETE FROM identities WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    })();

    logger.info(SCOPE, `Deleted user ${userId} (email: ${user.email}, workspaces: ${wsIds.length})`);
    return true;
  }

  setRole(userId: string, role: UserRole): void {
    this.dbManager.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
    logger.info(SCOPE, `Set role for user ${userId} to ${role}`);
  }

  updateSubscription(userId: string, data: {
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    subscriptionStatus?: SubscriptionStatus;
    subscriptionStartDate?: Date;
    planId?: string;
  }): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (data.stripeCustomerId !== undefined) { sets.push('stripe_customer_id = ?'); params.push(data.stripeCustomerId); }
    if (data.stripeSubscriptionId !== undefined) { sets.push('stripe_subscription_id = ?'); params.push(data.stripeSubscriptionId); }
    if (data.subscriptionStatus !== undefined) { sets.push('subscription_status = ?'); params.push(data.subscriptionStatus); }
    if (data.subscriptionStartDate !== undefined) { sets.push('subscription_start_date = ?'); params.push(data.subscriptionStartDate.toISOString()); }
    if (data.planId !== undefined) { sets.push('plan_id = ?'); params.push(data.planId); }
    if (sets.length === 0) return;

    params.push(userId);
    this.dbManager.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    logger.info(SCOPE, `Updated subscription for user ${userId}`);
  }

  generateRegistrationCode(telegramChatId: string, telegramUsername?: string, email?: string): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + REG_CODE_TTL_MS);

    this.dbManager.db.prepare(`
      INSERT OR REPLACE INTO registration_codes (code, telegram_chat_id, telegram_username, email, created_at, expires_at, used_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(code, String(telegramChatId), telegramUsername ?? null, email?.toLowerCase() ?? null, now.toISOString(), expiresAt.toISOString());

    logger.info(SCOPE, `Generated registration code ${code} for chat ${telegramChatId}${email ? ` (email: ${email})` : ''}`);
    return code;
  }

  validateRegistrationCode(code: string): RegistrationCode | null {
    const row = this.dbManager.db
      .prepare('SELECT * FROM registration_codes WHERE code = ?')
      .get(code.toUpperCase()) as RegCodeRow | undefined;

    if (!row) return null;

    const regCode = rowToRegCode(row);
    if (regCode.usedByUserId) return null;
    if (new Date() > regCode.expiresAt) return null;

    return regCode;
  }

  markRegistrationCodeUsed(code: string, userId: string): void {
    this.dbManager.db
      .prepare('UPDATE registration_codes SET used_by_user_id = ? WHERE code = ?')
      .run(userId, code.toUpperCase());
  }

  cleanExpiredCodes(): void {
    const now = new Date().toISOString();
    this.dbManager.db
      .prepare('DELETE FROM registration_codes WHERE expires_at < ? AND used_by_user_id IS NULL')
      .run(now);
  }

  async createPendingVerification(
    email: string, password: string, displayName?: string, role: UserRole = 'user',
  ): Promise<User> {
    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const createdAt = new Date().toISOString();

    this.dbManager.db.prepare(`
      INSERT INTO users (id, email, password_hash, display_name, role, status, subscription_status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending_verification', 'none', ?)
    `).run(id, email.toLowerCase(), passwordHash, displayName ?? null, role, createdAt);

    logger.info(SCOPE, `Created pending user ${id} (${email}), awaiting email verification`);

    return {
      id, email: email.toLowerCase(), passwordHash, displayName: displayName ?? null,
      role, status: 'pending_verification', stripeCustomerId: null, stripeSubscriptionId: null,
      subscriptionStatus: 'none', subscriptionStartDate: null, planId: null, createdAt: new Date(createdAt), lastLoginAt: null,
    };
  }

  activateUser(userId: string): void {
    this.dbManager.db.prepare('UPDATE users SET status = ? WHERE id = ?').run('active', userId);
    logger.info(SCOPE, `Activated user ${userId} (email verified)`);
  }

  private generateCode(length = 6): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < length; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
  }

  generateEmailVerificationCode(userId: string, email: string): string {
    const code = this.generateCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + VERIFICATION_CODE_TTL_MS);
    this.dbManager.db.prepare(`
      INSERT OR REPLACE INTO verification_codes (code, user_id, type, email, created_at, expires_at, used)
      VALUES (?, ?, 'email_verification', ?, ?, ?, 0)
    `).run(code, userId, email.toLowerCase(), now.toISOString(), expiresAt.toISOString());
    logger.info(SCOPE, `Generated email verification code for user ${userId}`);
    return code;
  }

  validateEmailVerificationCode(code: string): { userId: string; email: string } | null {
    const row = this.dbManager.db.prepare(
      `SELECT * FROM verification_codes WHERE code = ? AND type = 'email_verification'`,
    ).get(code.toUpperCase()) as { user_id: string; email: string; expires_at: string; used: number } | undefined;
    if (!row || row.used) return null;
    if (new Date() > new Date(row.expires_at)) return null;
    return { userId: row.user_id, email: row.email };
  }

  markVerificationCodeUsed(code: string): void {
    this.dbManager.db.prepare(
      `UPDATE verification_codes SET used = 1 WHERE code = ?`,
    ).run(code.toUpperCase());
  }

  generatePasswordResetCode(userId: string, email: string, telegramChatId?: string): string {
    const code = this.generateCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + VERIFICATION_CODE_TTL_MS);
    this.dbManager.db.prepare(`
      INSERT OR REPLACE INTO verification_codes (code, user_id, type, email, telegram_chat_id, created_at, expires_at, used)
      VALUES (?, ?, 'password_reset', ?, ?, ?, ?, 0)
    `).run(code, userId, email, telegramChatId ?? null, now.toISOString(), expiresAt.toISOString());
    logger.info(SCOPE, `Generated password reset code for user ${userId}`);
    return code;
  }

  validatePasswordResetCode(code: string): { userId: string; email: string } | null {
    const row = this.dbManager.db.prepare(
      `SELECT * FROM verification_codes WHERE code = ? AND type = 'password_reset'`,
    ).get(code.toUpperCase()) as { user_id: string; email: string; expires_at: string; used: number } | undefined;
    if (!row || row.used) return null;
    if (new Date() > new Date(row.expires_at)) return null;
    return { userId: row.user_id, email: row.email };
  }

  async resetPassword(code: string, newPassword: string): Promise<boolean> {
    const valid = this.validatePasswordResetCode(code);
    if (!valid) return false;

    if (String(newPassword).length < 8) return false;

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    this.dbManager.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, valid.userId);
    this.markVerificationCodeUsed(code);
    this.clear2FA(valid.userId);
    logger.info(SCOPE, `Password reset for user ${valid.userId} (2FA cleared)`);
    return true;
  }

  getUserByTelegramChatId(chatId: string): User | null {
    const identity = this.dbManager.db.prepare(
      `SELECT user_id FROM identities WHERE channel = 'telegram' AND channel_user_id = ? AND user_id IS NOT NULL`,
    ).get(`telegram:${chatId}`) as { user_id: string } | undefined;

    if (!identity?.user_id) {
      const identity2 = this.dbManager.db.prepare(
        `SELECT user_id FROM identities WHERE channel = 'telegram' AND channel_user_id = ? AND user_id IS NOT NULL`,
      ).get(chatId) as { user_id: string } | undefined;
      if (!identity2?.user_id) return null;
      return this.getById(identity2.user_id);
    }
    return this.getById(identity.user_id);
  }

  cleanExpiredVerificationCodes(): void {
    const now = new Date().toISOString();
    this.dbManager.db.prepare('DELETE FROM verification_codes WHERE expires_at < ? AND used = 0').run(now);
  }

  // ── 2FA ──

  has2FA(userId: string): boolean {
    return this.get2FAMethod(userId) !== null;
  }

  get2FAMethod(userId: string): 'totp' | 'passkey' | null {
    const row = this.dbManager.db.prepare(
      'SELECT method, totp_verified FROM user_2fa WHERE user_id = ?'
    ).get(userId) as { method: string; totp_verified: number } | undefined;
    if (!row) return null;
    if (row.method === 'totp' && !row.totp_verified) return null;
    if (row.method === 'passkey') {
      const pkCount = this.dbManager.db.prepare(
        'SELECT COUNT(*) as cnt FROM user_passkeys WHERE user_id = ?'
      ).get(userId) as { cnt: number };
      if (!pkCount.cnt) return null;
    }
    return row.method as 'totp' | 'passkey';
  }

  getTotpSecret(userId: string): string | null {
    const row = this.dbManager.db.prepare(
      "SELECT totp_secret FROM user_2fa WHERE user_id = ? AND method = 'totp' AND totp_verified = 1"
    ).get(userId) as { totp_secret: string } | undefined;
    return row?.totp_secret ?? null;
  }

  getPendingTotpSecret(userId: string): string | null {
    const row = this.dbManager.db.prepare(
      "SELECT totp_secret FROM user_2fa WHERE user_id = ? AND method = 'totp'"
    ).get(userId) as { totp_secret: string } | undefined;
    return row?.totp_secret ?? null;
  }

  setupTotp(userId: string, secret: string): void {
    const now = new Date().toISOString();
    this.dbManager.db.prepare(`
      INSERT INTO user_2fa (user_id, method, totp_secret, totp_verified, created_at, updated_at)
      VALUES (?, 'totp', ?, 0, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET method = 'totp', totp_secret = excluded.totp_secret, totp_verified = 0, updated_at = excluded.updated_at
    `).run(userId, secret, now, now);
  }

  verifyAndActivateTotp(userId: string): void {
    this.dbManager.db.prepare(
      'UPDATE user_2fa SET totp_verified = 1, updated_at = ? WHERE user_id = ?'
    ).run(new Date().toISOString(), userId);
    logger.info(SCOPE, `User ${userId} TOTP 2FA activated`);
  }

  setupPasskeyMethod(userId: string): void {
    const now = new Date().toISOString();
    this.dbManager.db.prepare(`
      INSERT INTO user_2fa (user_id, method, totp_secret, totp_verified, created_at, updated_at)
      VALUES (?, 'passkey', NULL, 0, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET method = 'passkey', totp_secret = NULL, totp_verified = 0, updated_at = excluded.updated_at
    `).run(userId, now, now);
  }

  savePasskey(userId: string, passkey: StoredPasskey): void {
    const id = crypto.randomUUID();
    this.dbManager.db.prepare(`
      INSERT INTO user_passkeys (id, user_id, credential_id, public_key, counter, transports, device_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, userId, passkey.credentialId, passkey.publicKey, passkey.counter,
      passkey.transports ? JSON.stringify(passkey.transports) : null,
      passkey.deviceName ?? null, new Date().toISOString(),
    );
  }

  getPasskeys(userId: string): StoredPasskey[] {
    const rows = this.dbManager.db.prepare(
      'SELECT credential_id, public_key, counter, transports, device_name FROM user_passkeys WHERE user_id = ?'
    ).all(userId) as Array<{ credential_id: string; public_key: Buffer; counter: number; transports: string | null; device_name: string | null }>;
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
      'UPDATE user_passkeys SET counter = ? WHERE credential_id = ?'
    ).run(newCounter, credentialId);
  }

  clear2FA(userId: string): void {
    this.dbManager.db.prepare('DELETE FROM user_2fa WHERE user_id = ?').run(userId);
    this.dbManager.db.prepare('DELETE FROM user_passkeys WHERE user_id = ?').run(userId);
    logger.info(SCOPE, `User ${userId} 2FA cleared`);
  }
}
