import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { logger } from '../core/logger.js';
import type { Dispatcher } from '../core/dispatcher.js';
import type { Router } from '../core/router.js';
import type { ConfigManager } from '../core/config.js';
import type { DatabaseManager } from '../core/database.js';
import type { UserManager } from '../core/user.js';
import type { WorkspaceManager } from '../core/workspace.js';
import type { IdentityManager } from '../core/identity.js';
import type { IncomingEvent } from '../core/types.js';
import {
  generateTotpSecret, generateTotpQrCode, verifyTotpCode,
  generatePasskeyRegistrationOptions, verifyPasskeyRegistration,
  generatePasskeyAuthenticationOptions, verifyPasskeyAuthentication,
  createTwoFactorTempToken, consumeTwoFactorTempToken,
} from '../core/two-factor.js';
import { eventBus } from '../core/event-bus.js';

const SCOPE = 'client-api';
const API_PREFIX = '/api/v1';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_MAX = 10;

interface ApiSession {
  userId: string;
  workspaceId: string;
  email: string;
  createdAt: number;
}

interface DeviceAuthRequest {
  deviceCode: string;
  createdAt: number;
  expiresAt: number;
  approved: boolean;
  userId?: string;
  email?: string;
  token?: string;
  workspaceId?: string;
}

interface ChatSession {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  lastMessageAt: string;
}

export interface ClientApiContext {
  config: ConfigManager;
  db: DatabaseManager;
  userManager: UserManager;
  workspaceManager: WorkspaceManager;
  identityManager: IdentityManager;
  dispatcher: Dispatcher;
  router: Router;
  getMainSessionKey?: (workspaceId: string) => string | undefined;
}

export class ClientApi {
  private ctx: ClientApiContext;
  private sessions = new Map<string, ApiSession>();
  private streamClients = new Map<string, Set<WebSocket>>();
  private deviceAuthRequests = new Map<string, DeviceAuthRequest>();
  private loginAttempts = new Map<string, { count: number; firstAt: number }>();

  constructor(ctx: ClientApiContext) {
    this.ctx = ctx;
    this.initDb();
  }

  private isLoginRateLimited(ip: string): boolean {
    const entry = this.loginAttempts.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.firstAt > LOGIN_RATE_WINDOW_MS) {
      this.loginAttempts.delete(ip);
      return false;
    }
    return entry.count >= LOGIN_RATE_MAX;
  }

  private recordLoginAttempt(ip: string): void {
    const entry = this.loginAttempts.get(ip);
    if (!entry || Date.now() - entry.firstAt > LOGIN_RATE_WINDOW_MS) {
      this.loginAttempts.set(ip, { count: 1, firstAt: Date.now() });
    } else {
      entry.count++;
    }
  }

  private initDb(): void {
    this.ctx.db.db.exec(`
      CREATE TABLE IF NOT EXISTS api_chat_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT DEFAULT 'New Chat',
        created_at TEXT NOT NULL,
        last_message_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES api_chat_sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_api_msg_session ON api_chat_messages(session_id, created_at);
    `);
  }

  canHandle(pathname: string): boolean {
    return pathname.startsWith(API_PREFIX);
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, body: string): Promise<void> {
    const method = req.method ?? 'GET';
    const route = pathname.slice(API_PREFIX.length);

    res.setHeader('Content-Type', 'application/json');

    const clientIp = req.socket.remoteAddress ?? 'unknown';

    if (method === 'POST' && route === '/auth/login') {
      if (this.isLoginRateLimited(clientIp)) {
        res.writeHead(429);
        res.end(JSON.stringify({ error: 'Too many login attempts. Try again later.' }));
        return;
      }
      return this.handleLogin(req, body, res);
    }

    if (method === 'POST' && route.startsWith('/auth/2fa/')) {
      return this.handle2FA(req, route, body, res);
    }

    if (method === 'POST' && route === '/auth/device') {
      if (this.isLoginRateLimited(clientIp)) {
        res.writeHead(429);
        res.end(JSON.stringify({ error: 'Too many requests. Try again later.' }));
        return;
      }
      return this.handleDeviceAuth(body, res);
    }

    if (method === 'POST' && route === '/auth/device/poll') {
      return this.handleDevicePoll(body, res);
    }

    const session = this.authenticate(req);
    if (!session) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unauthorized. Login via POST /api/v1/auth/login' }));
      return;
    }

    if (method === 'POST' && route === '/auth/logout') {
      return this.handleLogout(req, res);
    }

    if (method === 'GET' && route === '/me') {
      res.end(JSON.stringify({ userId: session.userId, email: session.email, workspaceId: session.workspaceId }));
      return;
    }

    if (method === 'GET' && route === '/sessions') {
      return this.handleListSessions(session, res);
    }
    if (method === 'POST' && route === '/sessions') {
      return this.handleCreateSession(session, body, res);
    }

    const sessionMatch = route.match(/^\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      if (method === 'GET') return this.handleGetSession(session, sessionId, res);
      if (method === 'PATCH') return this.handleUpdateSession(session, sessionId, body, res);
      if (method === 'DELETE') return this.handleDeleteSession(session, sessionId, res);
    }

    const messagesMatch = route.match(/^\/sessions\/([^/]+)\/messages$/);
    if (messagesMatch) {
      const sessionId = messagesMatch[1];
      if (method === 'GET') return this.handleGetMessages(session, sessionId, res);
      if (method === 'POST') return this.handleSendMessage(session, sessionId, body, res);
    }

    if (method === 'GET' && route === '/models') {
      return this.handleListModels(res);
    }

    if (method === 'GET' && route === '/main-session') {
      return this.handleGetMainSession(session, res);
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  handleWebSocket(ws: WebSocket, session: ApiSession, chatSessionId: string): void {
    const key = `${session.workspaceId}:${chatSessionId}`;
    if (!this.streamClients.has(key)) this.streamClients.set(key, new Set());
    this.streamClients.get(key)!.add(ws);

    const isMainSession = chatSessionId.startsWith('tg-chat:');
    if (isMainSession) {
      const history = this.ctx.dispatcher.getHistory(chatSessionId);
      for (const msg of history) {
        const ts = msg.timestamp?.toISOString?.() ?? new Date().toISOString();
        if (msg.role === 'user' && msg.content) {
          ws.send(JSON.stringify({ type: 'user_message', id: crypto.randomUUID(), content: String(msg.content), created_at: ts }));
        } else if (msg.role === 'assistant' && msg.injected && msg.content) {
          ws.send(JSON.stringify({ type: 'assistant_message', id: crypto.randomUUID(), content: String(msg.content), created_at: ts }));
        } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            if (tc.name === 'notify' && tc.arguments?.message) {
              ws.send(JSON.stringify({ type: 'assistant_message', id: crypto.randomUUID(), content: String(tc.arguments.message), created_at: ts }));
            }
          }
        }
      }
    }

    let pendingReplyResolver: ((reply: string | null) => void) | null = null;

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'reply' && pendingReplyResolver) {
          const resolver = pendingReplyResolver;
          pendingReplyResolver = null;
          resolver(msg.content || null);
          return;
        }
        if (msg.type === 'message' && msg.content) {
          await this.processChatMessage(session, chatSessionId, msg.content, ws, (resolver) => { pendingReplyResolver = resolver; });
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', error: (err as Error).message }));
      }
    });

    ws.on('close', () => {
      this.streamClients.get(key)?.delete(ws);
      if (pendingReplyResolver) {
        pendingReplyResolver(null);
        pendingReplyResolver = null;
      }
    });
  }

  authenticateFromRequest(req: http.IncomingMessage): ApiSession | null {
    return this.authenticate(req);
  }

  private authenticate(req: http.IncomingMessage): ApiSession | null {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return null;
    const token = auth.slice(7);
    const session = this.sessions.get(token);
    if (!session) return null;
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  private getRpId(req: http.IncomingMessage): string {
    const host = req.headers.host || 'localhost';
    return host.split(':')[0];
  }

  private getOrigin(req: http.IncomingMessage): string {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host || 'localhost';
    return `${proto}://${host}`;
  }

  private createApiSession(userId: string, email: string): { token: string; workspaceId: string } | null {
    const identities = this.ctx.identityManager.getByUserId(userId);
    const workspaceId = identities.find(i => i.workspaceId)?.workspaceId
      ?? this.ctx.workspaceManager.getByOwner(userId)?.id;
    if (!workspaceId) return null;
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, { userId, workspaceId, email, createdAt: Date.now() });
    return { token, workspaceId };
  }

  private async handleLogin(req: http.IncomingMessage, body: string, res: http.ServerResponse): Promise<void> {
    try {
      const { email, password } = JSON.parse(body);
      if (!email || !password) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'email and password are required' }));
        return;
      }

      const authResult = await this.ctx.userManager.authenticate(email, password);
      if (!authResult.user) {
        this.recordLoginAttempt(req.socket.remoteAddress ?? 'unknown');
        res.writeHead(401);
        res.end(JSON.stringify({ error: authResult.reason === 'suspended' ? 'Account suspended' : 'Invalid credentials' }));
        return;
      }
      const user = authResult.user;
      const um = this.ctx.userManager;

      if (um.has2FA(user.id)) {
        const method2fa = um.get2FAMethod(user.id);
        const tempToken = createTwoFactorTempToken(user.id, 'client');
        if (method2fa === 'passkey') {
          const passkeys = um.getPasskeys(user.id);
          const rpId = this.getRpId(req);
          const { options, challengeKey } = await generatePasskeyAuthenticationOptions(rpId, passkeys);
          res.end(JSON.stringify({ needs2FA: true, method: 'passkey', tempToken, challengeKey, options }));
        } else {
          res.end(JSON.stringify({ needs2FA: true, method: 'totp', tempToken }));
        }
        return;
      }

      const tempToken = createTwoFactorTempToken(user.id, 'client');
      res.end(JSON.stringify({ needs2FASetup: true, tempToken, userId: user.id, email: user.email }));
    } catch (err) {
      logger.error(SCOPE, `Login failed: ${(err as Error).message}`);
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  }

  private async handle2FA(req: http.IncomingMessage, route: string, body: string, res: http.ServerResponse): Promise<void> {
    try {
      const parsed = JSON.parse(body);
      const um = this.ctx.userManager;

      if (route === '/auth/2fa/setup/totp') {
        const userId = consumeTwoFactorTempToken(parsed.tempToken, 'client');
        if (!userId) { res.writeHead(401); res.end(JSON.stringify({ error: 'Invalid session' })); return; }
        const user = um.getById(userId);
        const newTempToken = createTwoFactorTempToken(userId, 'client');
        const setup = generateTotpSecret('Kora', user?.email || userId);
        const qrCodeDataUrl = await generateTotpQrCode(setup.uri);
        um.setupTotp(userId, setup.secret);
        res.end(JSON.stringify({ ok: true, tempToken: newTempToken, qrCodeDataUrl, secret: setup.secret }));
        return;
      }

      if (route === '/auth/2fa/setup/totp/verify') {
        const userId = consumeTwoFactorTempToken(parsed.tempToken, 'client');
        if (!userId) { res.writeHead(401); res.end(JSON.stringify({ error: 'Invalid session' })); return; }
        const secret = um.getPendingTotpSecret(userId);
        if (!secret || !verifyTotpCode(secret, String(parsed.code))) {
          const newTempToken = createTwoFactorTempToken(userId, 'client');
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid code', tempToken: newTempToken }));
          return;
        }
        um.verifyAndActivateTotp(userId);
        const user = um.getById(userId);
        const sess = this.createApiSession(userId, user?.email ?? '');
        if (!sess) { res.writeHead(403); res.end(JSON.stringify({ error: 'No workspace' })); return; }
        res.end(JSON.stringify({ ok: true, token: sess.token, userId, email: user?.email, workspaceId: sess.workspaceId }));
        return;
      }

      if (route === '/auth/2fa/setup/passkey/register-options') {
        const userId = consumeTwoFactorTempToken(parsed.tempToken, 'client');
        if (!userId) { res.writeHead(401); res.end(JSON.stringify({ error: 'Invalid session' })); return; }
        const user = um.getById(userId);
        const newTempToken = createTwoFactorTempToken(userId, 'client');
        const rpId = this.getRpId(req);
        const existing = um.getPasskeys(userId);
        const { options, challengeKey } = await generatePasskeyRegistrationOptions(
          userId, user?.email || userId, rpId, 'Kora', existing,
        );
        um.setupPasskeyMethod(userId);
        res.end(JSON.stringify({ ok: true, tempToken: newTempToken, challengeKey, options }));
        return;
      }

      if (route === '/auth/2fa/setup/passkey/register') {
        const userId = consumeTwoFactorTempToken(parsed.tempToken, 'client');
        if (!userId) { res.writeHead(401); res.end(JSON.stringify({ error: 'Invalid session' })); return; }
        const rpId = this.getRpId(req);
        const origin = this.getOrigin(req);
        const passkey = await verifyPasskeyRegistration(parsed.credential, parsed.challengeKey, rpId, origin);
        if (!passkey) { res.writeHead(400); res.end(JSON.stringify({ error: 'Registration failed' })); return; }
        um.savePasskey(userId, passkey);
        const user = um.getById(userId);
        const sess = this.createApiSession(userId, user?.email ?? '');
        if (!sess) { res.writeHead(403); res.end(JSON.stringify({ error: 'No workspace' })); return; }
        res.end(JSON.stringify({ ok: true, token: sess.token, userId, email: user?.email, workspaceId: sess.workspaceId }));
        return;
      }

      if (route === '/auth/2fa/verify/totp') {
        const userId = consumeTwoFactorTempToken(parsed.tempToken, 'client');
        if (!userId) { res.writeHead(401); res.end(JSON.stringify({ error: 'Invalid session' })); return; }
        const secret = um.getTotpSecret(userId);
        if (!secret || !verifyTotpCode(secret, String(parsed.code))) {
          const newTempToken = createTwoFactorTempToken(userId, 'client');
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'Invalid code', tempToken: newTempToken }));
          return;
        }
        const user = um.getById(userId);
        const sess = this.createApiSession(userId, user?.email ?? '');
        if (!sess) { res.writeHead(403); res.end(JSON.stringify({ error: 'No workspace' })); return; }
        logger.info(SCOPE, `User ${user?.email} logged in via client API (TOTP 2FA)`);
        res.end(JSON.stringify({ ok: true, token: sess.token, userId, email: user?.email, workspaceId: sess.workspaceId }));
        return;
      }

      if (route === '/auth/2fa/verify/passkey') {
        const userId = consumeTwoFactorTempToken(parsed.tempToken, 'client');
        if (!userId) { res.writeHead(401); res.end(JSON.stringify({ error: 'Invalid session' })); return; }
        const passkeys = um.getPasskeys(userId);
        const matchedPk = passkeys.find(pk => pk.credentialId === parsed.credential?.id);
        if (!matchedPk) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unknown passkey' })); return; }
        const rpId = this.getRpId(req);
        const origin = this.getOrigin(req);
        const result = await verifyPasskeyAuthentication(parsed.credential, parsed.challengeKey, rpId, origin, matchedPk);
        if (!result.verified) { res.writeHead(401); res.end(JSON.stringify({ error: 'Verification failed' })); return; }
        um.updatePasskeyCounter(matchedPk.credentialId, result.newCounter);
        const user = um.getById(userId);
        const sess = this.createApiSession(userId, user?.email ?? '');
        if (!sess) { res.writeHead(403); res.end(JSON.stringify({ error: 'No workspace' })); return; }
        logger.info(SCOPE, `User ${user?.email} logged in via client API (Passkey 2FA)`);
        res.end(JSON.stringify({ ok: true, token: sess.token, userId, email: user?.email, workspaceId: sess.workspaceId }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Unknown 2FA route' }));
    } catch (err) {
      logger.error(SCOPE, `2FA failed: ${(err as Error).message}`);
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  }

  private handleLogout(req: http.IncomingMessage, res: http.ServerResponse): void {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      this.sessions.delete(auth.slice(7));
    }
    res.end(JSON.stringify({ ok: true }));
  }

  private cleanupExpiredDeviceCodes(): void {
    const now = Date.now();
    for (const [code, req] of this.deviceAuthRequests) {
      if (now > req.expiresAt) this.deviceAuthRequests.delete(code);
    }
  }

  private handleDeviceAuth(body: string, res: http.ServerResponse): void {
    try {
      this.cleanupExpiredDeviceCodes();
      if (this.deviceAuthRequests.size >= 100) {
        res.writeHead(429);
        res.end(JSON.stringify({ error: 'Too many pending device codes. Try again later.' }));
        return;
      }
      const deviceCode = crypto.randomBytes(20).toString('hex');
      const now = Date.now();
      this.deviceAuthRequests.set(deviceCode, {
        deviceCode,
        createdAt: now,
        expiresAt: now + DEVICE_CODE_TTL_MS,
        approved: false,
      });
      const expiresIn = Math.floor(DEVICE_CODE_TTL_MS / 1000);
      res.end(JSON.stringify({ deviceCode, expiresIn }));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  }

  private handleDevicePoll(body: string, res: http.ServerResponse): void {
    try {
      const { deviceCode } = JSON.parse(body);
      if (!deviceCode) { res.writeHead(400); res.end(JSON.stringify({ error: 'deviceCode is required' })); return; }

      const req = this.deviceAuthRequests.get(deviceCode);
      if (!req) { res.writeHead(404); res.end(JSON.stringify({ error: 'Unknown device code' })); return; }

      if (Date.now() > req.expiresAt) {
        this.deviceAuthRequests.delete(deviceCode);
        res.end(JSON.stringify({ error: 'expired' }));
        return;
      }

      if (!req.approved || !req.token) {
        res.end(JSON.stringify({ pending: true }));
        return;
      }

      this.deviceAuthRequests.delete(deviceCode);
      res.end(JSON.stringify({
        token: req.token,
        email: req.email,
        workspaceId: req.workspaceId,
      }));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  }

  approveDeviceCode(deviceCode: string, userId: string): boolean {
    const req = this.deviceAuthRequests.get(deviceCode);
    if (!req || Date.now() > req.expiresAt) return false;

    const user = this.ctx.userManager.getById(userId);
    const sess = this.createApiSession(userId, user?.email ?? '');
    if (!sess) return false;

    req.approved = true;
    req.userId = userId;
    req.email = user?.email ?? '';
    req.token = sess.token;
    req.workspaceId = sess.workspaceId;
    logger.info(SCOPE, `Device code approved for user ${user?.email || userId}`);
    return true;
  }

  private handleListSessions(session: ApiSession, res: http.ServerResponse): void {
    const rows = this.ctx.db.db.prepare(
      'SELECT id, title, created_at, last_message_at FROM api_chat_sessions WHERE workspace_id = ? ORDER BY last_message_at DESC'
    ).all(session.workspaceId) as ChatSession[];
    res.end(JSON.stringify({ sessions: rows }));
  }

  private handleCreateSession(session: ApiSession, body: string, res: http.ServerResponse): void {
    const { title } = JSON.parse(body || '{}');
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.ctx.db.db.prepare(
      'INSERT INTO api_chat_sessions (id, workspace_id, title, created_at, last_message_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, session.workspaceId, title || 'New Chat', now, now);
    res.writeHead(201);
    res.end(JSON.stringify({ id, title: title || 'New Chat', createdAt: now }));
  }

  private handleGetSession(session: ApiSession, sessionId: string, res: http.ServerResponse): void {
    const row = this.ctx.db.db.prepare(
      'SELECT * FROM api_chat_sessions WHERE id = ? AND workspace_id = ?'
    ).get(sessionId, session.workspaceId) as ChatSession | undefined;
    if (!row) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    res.end(JSON.stringify(row));
  }

  private handleUpdateSession(session: ApiSession, sessionId: string, body: string, res: http.ServerResponse): void {
    const existing = this.ctx.db.db.prepare(
      'SELECT id FROM api_chat_sessions WHERE id = ? AND workspace_id = ?'
    ).get(sessionId, session.workspaceId);
    if (!existing) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    const { title } = JSON.parse(body || '{}');
    if (title) {
      this.ctx.db.db.prepare('UPDATE api_chat_sessions SET title = ? WHERE id = ?').run(title, sessionId);
    }
    res.end(JSON.stringify({ ok: true }));
  }

  private handleDeleteSession(session: ApiSession, sessionId: string, res: http.ServerResponse): void {
    this.ctx.db.db.prepare('DELETE FROM api_chat_messages WHERE session_id = ?').run(sessionId);
    const result = this.ctx.db.db.prepare(
      'DELETE FROM api_chat_sessions WHERE id = ? AND workspace_id = ?'
    ).run(sessionId, session.workspaceId);
    res.end(JSON.stringify({ ok: true, deleted: result.changes > 0 }));
  }

  private handleGetMessages(session: ApiSession, sessionId: string, res: http.ServerResponse): void {
    const chatSession = this.ctx.db.db.prepare(
      'SELECT id FROM api_chat_sessions WHERE id = ? AND workspace_id = ?'
    ).get(sessionId, session.workspaceId);
    if (!chatSession) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    const messages = this.ctx.db.db.prepare(
      'SELECT id, role, content, created_at FROM api_chat_messages WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId);
    res.end(JSON.stringify({ messages }));
  }

  private async handleSendMessage(session: ApiSession, sessionId: string, body: string, res: http.ServerResponse): Promise<void> {
    const chatSession = this.ctx.db.db.prepare(
      'SELECT id FROM api_chat_sessions WHERE id = ? AND workspace_id = ?'
    ).get(sessionId, session.workspaceId);
    if (!chatSession) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    const { content } = JSON.parse(body);
    if (!content) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'content is required' }));
      return;
    }

    const userMsgId = crypto.randomUUID();
    const now = new Date().toISOString();
    this.ctx.db.db.prepare(
      'INSERT INTO api_chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(userMsgId, sessionId, 'user', content, now);
    this.ctx.db.db.prepare(
      'UPDATE api_chat_sessions SET last_message_at = ? WHERE id = ?'
    ).run(now, sessionId);

    const identityId = `api:${session.userId}`;
    const collectedNotifications: string[] = [];

    const event: IncomingEvent = {
      channel: 'api',
      identityId,
      type: 'message',
      content,
      metadata: {
        sessionId: `api:${sessionId}`,
        historyKey: `api:${sessionId}`,
        workspaceId: session.workspaceId,
      },
      sendInterimMessage: async (text: string) => {
        collectedNotifications.push(text);
        const key = `${session.workspaceId}:${sessionId}`;
        const clients = this.streamClients.get(key);
        if (clients) {
          for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'notification', content: text }));
            }
          }
        }
      },
      sendFile: async (filePath: string, options?: { caption?: string; type?: 'photo' | 'document' }) => {
        try {
          const { readFileSync } = await import('node:fs');
          const { basename } = await import('node:path');
          const data = readFileSync(filePath).toString('base64');
          const fileName = basename(filePath);
          const key = `${session.workspaceId}:${sessionId}`;
          const clients = this.streamClients.get(key);
          if (clients) {
            for (const ws of clients) {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'file', fileName, data, caption: options?.caption, fileType: options?.type || 'document' }));
              }
            }
          }
        } catch { /* best effort */ }
      },
      sendToolStatus: (toolName: string, phase: 'start' | 'end') => {
        const key = `${session.workspaceId}:${sessionId}`;
        const clients = this.streamClients.get(key);
        if (clients) {
          for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'tool_status', tool: toolName, phase }));
            }
          }
        }
      },
      setTyping: (active: boolean) => {
        const key = `${session.workspaceId}:${sessionId}`;
        const clients = this.streamClients.get(key);
        if (clients) {
          for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'set_typing', active }));
            }
          }
        }
      },
    };

    try {
      const response = await this.ctx.dispatcher.handleIncomingEvent(event);
      const assistantContent = response.content || collectedNotifications.join('\n\n') || '';

      if (assistantContent) {
        const assistantMsgId = crypto.randomUUID();
        const assistantNow = new Date().toISOString();
        this.ctx.db.db.prepare(
          'INSERT INTO api_chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(assistantMsgId, sessionId, 'assistant', assistantContent, assistantNow);
        this.ctx.db.db.prepare(
          'UPDATE api_chat_sessions SET last_message_at = ? WHERE id = ?'
        ).run(assistantNow, sessionId);
      }

      res.end(JSON.stringify({
        ok: true,
        userMessage: { id: userMsgId, role: 'user', content, created_at: now },
        assistantMessage: assistantContent ? {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: assistantContent,
          created_at: new Date().toISOString(),
        } : null,
        notifications: collectedNotifications,
      }));
    } catch (err) {
      logger.error(SCOPE, `Chat API error: ${(err as Error).message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to process message' }));
    }
  }

  private async processChatMessage(
    session: ApiSession,
    sessionId: string,
    content: string,
    ws: WebSocket,
    setReplyResolver: (resolver: (reply: string | null) => void) => void,
  ): Promise<void> {
    const isMainSession = sessionId.startsWith('tg-chat:');
    const userMsgId = crypto.randomUUID();
    const now = new Date().toISOString();
    if (!isMainSession) {
      this.ctx.db.db.prepare(
        'INSERT INTO api_chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(userMsgId, sessionId, 'user', content, now);
      this.ctx.db.db.prepare(
        'UPDATE api_chat_sessions SET last_message_at = ? WHERE id = ?'
      ).run(now, sessionId);
    }

    ws.send(JSON.stringify({ type: 'user_message', id: userMsgId, content, created_at: now }));

    const historyKey = isMainSession ? sessionId : `api:${sessionId}`;
    const identityId = `api:${session.userId}`;
    const collectedNotifications: string[] = [];
    const event: IncomingEvent = {
      channel: 'api',
      identityId,
      type: 'message',
      content,
      metadata: {
        sessionId: isMainSession ? sessionId : `api:${sessionId}`,
        historyKey,
        workspaceId: session.workspaceId,
      },
      sendInterimMessage: async (text: string) => {
        collectedNotifications.push(text);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'notification', content: text }));
        }
      },
      sendFile: async (filePath: string, options?: { caption?: string; type?: 'photo' | 'document' }) => {
        try {
          const { readFileSync } = await import('node:fs');
          const { basename } = await import('node:path');
          const data = readFileSync(filePath).toString('base64');
          const fileName = basename(filePath);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'file', fileName, data, caption: options?.caption, fileType: options?.type || 'document' }));
          }
        } catch { /* best effort */ }
      },
      sendToolStatus: (toolName: string, phase: 'start' | 'end') => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'tool_status', tool: toolName, phase }));
        }
      },
      setTyping: (active: boolean) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'set_typing', active }));
        }
      },
      waitForReply: (timeoutMs: number) => {
        return new Promise<IncomingEvent | null>((resolve) => {
          if (ws.readyState !== WebSocket.OPEN) { resolve(null); return; }
          ws.send(JSON.stringify({ type: 'reply_requested', timeoutMs }));
          const timer = setTimeout(() => {
            setReplyResolver(() => { });
            resolve(null);
          }, timeoutMs);
          setReplyResolver((reply: string | null) => {
            clearTimeout(timer);
            if (!reply) { resolve(null); return; }
            resolve({ channel: 'api', identityId, type: 'message', content: reply });
          });
        });
      },
    };

    try {
      const response = await this.ctx.dispatcher.handleIncomingEvent(event);
      const fromNotify = collectedNotifications.join('\n\n');

      if (isMainSession) {
        ws.send(JSON.stringify({ type: 'done' }));
        return;
      }

      let assistantContent = (response.content || '').trim() || fromNotify;
      const onlyNotifyBubbles = !(response.content || '').trim() && collectedNotifications.length > 0;

      if (assistantContent) {
        const assistantMsgId = crypto.randomUUID();
        const assistantNow = new Date().toISOString();
        this.ctx.db.db.prepare(
          'INSERT INTO api_chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(assistantMsgId, sessionId, 'assistant', assistantContent, assistantNow);

        if (!onlyNotifyBubbles) {
          ws.send(JSON.stringify({
            type: 'assistant_message',
            id: assistantMsgId,
            content: assistantContent,
            created_at: assistantNow,
          }));
        }
      }

      ws.send(JSON.stringify({ type: 'done' }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', error: (err as Error).message }));
    }
  }

  private handleListModels(res: http.ServerResponse): void {
    const providers = this.ctx.config.loadProviders();
    const models = providers.flatMap(p =>
      p.models.map(m => ({
        id: m.id,
        name: m.name,
        provider: p.id,
        roles: m.roles || [],
      }))
    );
    res.end(JSON.stringify({ models }));
  }

  private handleGetMainSession(session: ApiSession, res: http.ServerResponse): void {
    const mainKey = this.findMainSessionKey(session.workspaceId);
    if (!mainKey) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'No active main session. Start a conversation in Telegram first.' }));
      return;
    }
    const history = this.ctx.dispatcher.getHistory(mainKey);
    const messages: Array<{ role: string; content: string; timestamp: string }> = [];
    for (const m of history) {
      const ts = m.timestamp?.toISOString?.() ?? new Date().toISOString();
      if (m.role === 'user' && m.content) {
        messages.push({ role: 'user', content: String(m.content), timestamp: ts });
      } else if (m.role === 'assistant' && m.injected && m.content) {
        messages.push({ role: 'assistant', content: String(m.content), timestamp: ts });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          if (tc.name === 'notify' && tc.arguments?.message) {
            messages.push({ role: 'assistant', content: String(tc.arguments.message), timestamp: ts });
          }
        }
      }
    }
    res.end(JSON.stringify({ historyKey: mainKey, messages }));
  }

  private findMainSessionKey(workspaceId: string): string | null {
    const fromMap = this.ctx.getMainSessionKey?.(workspaceId);
    if (fromMap) return fromMap;

    const identities = this.ctx.identityManager.getByWorkspace(workspaceId);
    const tgIdentities = identities.filter(i => i.channel === 'telegram');
    const historyKeys = this.ctx.dispatcher.getHistoryKeys();
    for (const identity of tgIdentities) {
      const rawId = identity.channelUserId.replace(/^telegram:/, '');
      const candidate = `tg-chat:${rawId}`;
      if (historyKeys.includes(candidate)) {
        logger.info(SCOPE, `Resolved main session from history fallback: ${candidate}`);
        return candidate;
      }
    }
    return null;
  }

  resolveSessionId(session: ApiSession, requestedSession: string): string | null {
    if (requestedSession === 'main') {
      return this.findMainSessionKey(session.workspaceId);
    }
    return requestedSession;
  }

  startListening(): void {
    eventBus.on('audit_entry', (entry) => {
      if (entry.type !== 'notify' && entry.type !== 'user_msg') return;
      if (entry.channel === 'api') return;
      const wsId = entry.workspaceId;
      if (!wsId) return;
      const mainKey = this.findMainSessionKey(wsId);
      if (!mainKey) return;
      const streamKey = `${wsId}:${mainKey}`;
      const clients = this.streamClients.get(streamKey);
      if (!clients || clients.size === 0) return;

      let payload: string | undefined;
      if (entry.type === 'notify' && entry.data.delivered && entry.data.message) {
        payload = JSON.stringify({
          type: 'assistant_message',
          id: crypto.randomUUID(),
          content: String(entry.data.message),
          created_at: entry.timestamp,
        });
      } else if (entry.type === 'user_msg' && entry.data.content) {
        payload = JSON.stringify({
          type: 'user_message',
          id: crypto.randomUUID(),
          content: String(entry.data.content),
          created_at: entry.timestamp,
        });
      }

      if (!payload) return;
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
      }
    });
    logger.info(SCOPE, 'Listening for main session events via eventBus');
  }
}
