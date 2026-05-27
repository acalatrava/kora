import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { logger } from '../core/logger.js';
import { eventBus } from '../core/event-bus.js';
import type { AuditLog } from '../core/audit.js';
import type { ConfigManager } from '../core/config.js';
import type { McpManager } from '../mcp/manager.js';
import type { AuditEntry } from '../core/event-bus.js';
import type { ScheduledTask } from '../core/types.js';
import { getAuthUrl as gmailAuthUrl, exchangeCode as gmailExchangeCode } from '../channels/gmail/index.js';
import type { MemoryManager } from '../core/memory.js';
import type { SkillRegistry } from '../skills_runtime/registry.js';
import type { UserManager } from '../core/user.js';
import type { WorkspaceManager } from '../core/workspace.js';
import type { IdentityManager } from '../core/identity.js';
import { loadSkill } from '../skills_runtime/loader.js';
import type { DatabaseManager } from '../core/database.js';
import type { AdminAuth } from '../core/admin-auth.js';
import { execFileSync } from 'node:child_process';
import { ClientApi } from '../api/client-api.js';
import {
  generateTotpSecret, generateTotpQrCode, verifyTotpCode,
  generatePasskeyRegistrationOptions, verifyPasskeyRegistration,
  generatePasskeyAuthenticationOptions, verifyPasskeyAuthentication,
  createTwoFactorTempToken, consumeTwoFactorTempToken, removeTwoFactorTempToken,
} from '../core/two-factor.js';

const SCOPE = 'web-admin';
const MAX_BODY_SIZE = 512_000;
const MAX_UPLOAD_SIZE = 10_000_000;
const COOKIE_NAME = 'korabot_session';
const PORTAL_COOKIE_NAME = 'korabot_user_session';
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
const PORTAL_SESSION_TTL_MS = 24 * 60 * 60 * 1000;


export interface WebAdminContext {
  auditLog: AuditLog;
  config: ConfigManager;
  mcpManager: McpManager;
  getStatus: () => Record<string, unknown>;
  getHistory: (workspaceId: string) => Array<Record<string, unknown>>;
  getHistoryKeys: () => string[];
  clearHistory?: (key: string) => void;
  clearAllHistory?: () => void;
  getEnabledTools: () => string[];
  adminAuth?: AdminAuth;
  listTasks?: () => ScheduledTask[];
  getTask?: (id: string) => ScheduledTask | null;
  createTask?: (task: { name: string; cronExpression: string; prompt: string }) => ScheduledTask;
  updateTask?: (id: string, updates: Partial<ScheduledTask>) => void;
  deleteTask?: (id: string) => void;
  runTaskNow?: (id: string) => Promise<void>;
  getTaskLogs?: (taskId: string, limit?: number) => Array<Record<string, unknown>>;
  shutdown?: () => Promise<void>;
  reload?: () => Promise<void>;
  getUnlimitedMode?: () => boolean;
  setUnlimitedMode?: (enabled: boolean) => void;
  getPermissions?: () => Array<{ tool: string; decision: string; workspace: string }>;
  revokePermission?: (tool: string) => boolean;
  listSubAgents?: (workspaceId?: string) => Array<Record<string, unknown>>;
  createSubAgent?: (task: string, workspaceId?: string) => Promise<Record<string, unknown>>;
  createSubAgentConfig?: (data: Record<string, unknown>) => Record<string, unknown>;
  updateSubAgent?: (id: string, data: Record<string, unknown>) => boolean;
  removeSubAgent?: (id: string, workspaceId?: string) => boolean;
  runSubAgent?: (id: string, task: string, workspaceId?: string) => Promise<string>;
  memoryManager?: MemoryManager;
  skillRegistry?: SkillRegistry;
  getDefaultWorkspaceId?: () => string;
  listWorkspaces?: () => Array<{ id: string; name: string; isDefault: boolean }>;
  delegationManager?: import('../tools/mail-delegation/index.js').DelegationManager;
  contentGuard?: import('../core/content-guard.js').ContentGuard;
  mailIndexer?: import('../tools/mail-delegation/indexer.js').MailIndexer;
  userManager?: UserManager;
  workspaceManager?: WorkspaceManager;
  identityManager?: IdentityManager;
  dbManager?: DatabaseManager;
  multiUserEnabled?: boolean;
  telegramChannel?: { addAllowedChatId: (id: number) => void };
  stripeManager?: import('../billing/stripe.js').StripeManager;
  billingEnabled?: boolean;
  systemMailer?: import('../core/system-mailer.js').SystemMailer;
  portalBaseUrl?: string;
  sandboxStatus?: import('../tools/sandbox.js').SandboxStatus;
  subAgentManager?: import('../core/sub-agent.js').SubAgentManager;
  baseUrl?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolvePublicDir(): string {
  const candidates = [
    path.join(__dirname, 'public'),
    path.join(__dirname, '..', '..', 'src', 'web_admin', 'public'),
    path.join(process.cwd(), 'src', 'web_admin', 'public'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return candidates[0];
}

const PUBLIC_DIR = resolvePublicDir();

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function readBodyRaw(req: http.IncomingMessage, maxSize = MAX_UPLOAD_SIZE): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        reject(new Error('Upload too large (max 10MB)'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const header = req.headers.cookie || '';
  const cookies: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = decodeURIComponent(rest.join('=').trim());
  }
  return cookies;
}

const secureSuffix = (process.env.KORA_BASE_URL || '').startsWith('https') ? '; Secure' : '';

function setSessionCookie(res: http.ServerResponse, value: string): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secureSuffix}`);
}

function clearSessionCookie(res: http.ServerResponse): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureSuffix}`);
}

function setPortalCookie(res: http.ServerResponse, value: string): void {
  const existing = res.getHeader('Set-Cookie');
  const cookie = `${PORTAL_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secureSuffix}`;
  if (existing) {
    res.setHeader('Set-Cookie', [existing as string, cookie]);
  } else {
    res.setHeader('Set-Cookie', cookie);
  }
}

function clearPortalCookie(res: http.ServerResponse): void {
  const existing = res.getHeader('Set-Cookie');
  const cookie = `${PORTAL_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureSuffix}`;
  if (existing) {
    res.setHeader('Set-Cookie', [existing as string, cookie]);
  } else {
    res.setHeader('Set-Cookie', cookie);
  }
}

function sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://esm.sh https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'",
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cache-Control': 'no-store',
  };
  const existing = res.getHeader('Set-Cookie');
  if (existing) headers['Set-Cookie'] = existing as string;
  res.writeHead(status, headers);
  res.end(body);
}

function redactSecrets(raw: string): string {
  return raw.replace(/(api[_-]?key|token|password|secret)\s*:\s*\S+/gi, (match) => {
    const colonIdx = match.indexOf(':');
    const key = match.slice(0, colonIdx + 1);
    const val = match.slice(colonIdx + 1).trim();
    if (val.length <= 4) return match;
    return `${key} ${val.slice(0, 4)}${'*'.repeat(Math.min(val.length - 4, 20))}`;
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(a));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function isPathWithin(child: string, parent: string): boolean {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + path.sep);
}

export class WebAdminServer {
  private ctx: WebAdminContext;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clientWss: WebSocketServer | null = null;
  private auditListener: ((entry: AuditEntry) => void) | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private sessions: Map<string, number> = new Map();
  private loginAttempts: Map<string, { count: number; firstAt: number }> = new Map();
  private piperVoicesCache: any = null;
  private piperVoicesCacheTime = 0;
  private apiRateLimits: Map<string, { count: number; resetAt: number }> = new Map();
  private clientApi: ClientApi | null = null;
  private static API_RATE_LIMIT = 100;
  private static API_RATE_WINDOW_MS = 60 * 1000;

  constructor(ctx: WebAdminContext) {
    this.ctx = ctx;
  }

  setClientApi(api: ClientApi): void {
    this.clientApi = api;
    api.startListening();
  }

  private resolveWorkspaceId(input?: string | null): string {
    if (input && input !== 'default') return input;
    return this.ctx.getDefaultWorkspaceId?.() ?? 'default';
  }

  private getRpId(req: http.IncomingMessage): string {
    const host = req.headers.host || 'localhost';
    return host.split(':')[0];
  }

  private getOrigin(req: http.IncomingMessage): string {
    if (process.env.KORA_BASE_URL) {
      return process.env.KORA_BASE_URL.replace(/\/+$/, '');
    }
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host || 'localhost';
    return `${proto}://${host}`;
  }

  private getGmailOAuthCredentials(): { clientId: string; clientSecret: string } | null {
    const channels = this.ctx.config.loadChannels();
    const gmailChannel = channels.find(c => c.type === 'gmail');
    if (gmailChannel) {
      const cfg = gmailChannel.config as unknown as Record<string, unknown>;
      if (cfg.clientId && cfg.clientSecret) {
        return { clientId: String(cfg.clientId), clientSecret: String(cfg.clientSecret) };
      }
    }
    return null;
  }

  async start(port: number): Promise<void> {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.clientWss = this.clientApi ? new WebSocketServer({ noServer: true }) : null;
    const clientWss = this.clientWss;

    this.wss.on('connection', (ws) => {
      let lastActivity = Date.now();
      const idleCheck = setInterval(() => {
        if (Date.now() - lastActivity > 30 * 60 * 1000) {
          ws.close(1000, 'Idle timeout');
          clearInterval(idleCheck);
        }
      }, 60_000);

      ws.on('message', (raw) => {
        lastActivity = Date.now();
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === 'ping') {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'pong' }));
            }
          }
        } catch { /* ignore non-JSON */ }
      });

      ws.on('close', () => clearInterval(idleCheck));
    });

    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

      if (url.pathname === '/admin/ws') {
        if (!this.ctx.adminAuth) { socket.destroy(); return; }
        if (this.ctx.adminAuth.hasCredentials()) {
          const cookies = parseCookies(request);
          if (!cookies[COOKIE_NAME] || !this.isValidToken(cookies[COOKIE_NAME])) {
            socket.destroy();
            return;
          }
        }
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      } else if (url.pathname === '/api/v1/ws' && clientWss && this.clientApi) {
        const token = url.searchParams.get('token');
        if (!token) { socket.destroy(); return; }
        const session = this.clientApi.authenticateFromRequest(
          { headers: { authorization: `Bearer ${token}` } } as any
        );
        if (!session) { socket.destroy(); return; }
        const rawSessionId = url.searchParams.get('session');
        if (!rawSessionId) { socket.destroy(); return; }
        const resolvedSessionId = this.clientApi.resolveSessionId(session, rawSessionId);
        if (!resolvedSessionId) { socket.destroy(); return; }
        clientWss.handleUpgrade(request, socket, head, (ws) => {
          this.clientApi!.handleWebSocket(ws, session, resolvedSessionId);
        });
      } else {
        socket.destroy();
      }
    });

    this.auditListener = (entry: AuditEntry) => {
      const msg = JSON.stringify({ type: 'audit_entry', data: entry });
      for (const client of this.wss!.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg);
        }
      }
    };
    eventBus.on('audit_entry', this.auditListener);

    this.cleanupTimer = setInterval(() => {
      this.cleanExpiredPortalSessions();
      this.ctx.userManager?.cleanExpiredCodes();
      this.ctx.userManager?.cleanExpiredVerificationCodes();
    }, 60 * 60 * 1000);

    return new Promise<void>((resolve) => {
      this.server!.listen(port, () => {
        logger.info(SCOPE, `Web admin listening on port ${port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.auditListener) {
      eventBus.off('audit_entry', this.auditListener);
      this.auditListener = null;
    }

    if (this.clientWss) {
      for (const client of this.clientWss.clients) {
        client.close();
      }
      this.clientWss.close();
      this.clientWss = null;
    }

    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close();
      }
      this.wss.close();
      this.wss = null;
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          logger.warn(SCOPE, 'Server close timed out after 5s, forcing exit');
          this.server = null;
          resolve();
        }, 5000);

        this.server!.close(() => {
          clearTimeout(timeout);
          logger.info(SCOPE, 'Web admin server stopped');
          this.server = null;
          resolve();
        });
      });
    }
  }

  private isValidToken(token: string): boolean {
    const sessionCreatedAt = this.sessions.get(token);
    if (sessionCreatedAt !== undefined) {
      if (Date.now() - sessionCreatedAt > 24 * 60 * 60 * 1000) {
        this.sessions.delete(token);
        return false;
      }
      return true;
    }
    return false;
  }

  private isLoginRateLimited(ip: string): boolean {
    const entry = this.loginAttempts.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
      this.loginAttempts.delete(ip);
      return false;
    }
    return entry.count >= MAX_LOGIN_ATTEMPTS;
  }

  private recordLoginAttempt(ip: string): void {
    const entry = this.loginAttempts.get(ip);
    if (!entry || Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
      this.loginAttempts.set(ip, { count: 1, firstAt: Date.now() });
    } else {
      entry.count++;
    }
  }

  private checkAuth(req: http.IncomingMessage): boolean {
    if (!this.ctx.adminAuth) return false;
    if (!this.ctx.adminAuth.hasCredentials()) return true;

    const cookies = parseCookies(req);
    const cookieToken = cookies[COOKIE_NAME];
    if (cookieToken && this.isValidToken(cookieToken)) return true;

    const safePath = (req.url || '/').split('?')[0];
    logger.debug(SCOPE, `Auth failed: ${req.method} ${safePath} | cookie=${cookieToken ? 'yes' : 'no'}`);
    return false;
  }

  private serveStaticWithAuth(req: http.IncomingMessage, res: http.ServerResponse, prefix = ''): void {
    let urlPath = req.url || '/';
    const qIdx = urlPath.indexOf('?');
    const searchStr = qIdx !== -1 ? urlPath.slice(qIdx + 1) : '';
    if (qIdx !== -1) urlPath = urlPath.slice(0, qIdx);

    if (prefix && urlPath.startsWith(prefix)) {
      urlPath = urlPath.slice(prefix.length) || '/';
    }

    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.resolve(PUBLIC_DIR, urlPath.replace(/^\/+/, ''));

    if (!isPathWithin(filePath, PUBLIC_DIR)) {
      sendJson(res, { error: 'Forbidden' }, 403);
      return;
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const contentType = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      });
      fs.createReadStream(indexPath).pipe(res);
    } else {
      sendJson(res, { error: 'Not Found' }, 404);
    }
  }

  private serveLoginPage(res: http.ServerResponse, error?: string): void {
    const escError = error ? error.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '';
    const errorHtml = escError ? `<div class="error">${escError}</div>` : '';
    const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Kora — Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:40px;width:380px}
h2{text-align:center;margin-bottom:6px}
.sub{text-align:center;color:#7d8590;margin-bottom:24px;font-size:14px}
.error{background:rgba(248,81,73,.15);color:#f85149;padding:10px 14px;border-radius:6px;margin-bottom:16px;font-size:14px}
label{display:block;margin-bottom:4px;font-size:13px;color:#7d8590}
input{width:100%;padding:10px 14px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#e6edf3;margin-bottom:16px;font-size:14px}
input:focus{outline:none;border-color:#1f6feb}
button[type=submit]{width:100%;padding:12px;background:#238636;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-weight:600}
button[type=submit]:hover{background:#2ea043}
.hint{text-align:center;margin-top:16px;font-size:12px;color:#7d8590}
.hint code{background:#0d1117;padding:2px 6px;border-radius:3px;font-size:11px}
</style>
</head><body>
<div class="card">
<h2>Kora</h2>
<p class="sub">Web Admin Login</p>
${errorHtml}
<form method="POST" action="/admin/login">
<label>Username</label><input type="text" name="username" autocomplete="username" required>
<label>Password</label><input type="password" name="password" autocomplete="current-password" required>
<button type="submit">Log In</button>
<p class="hint">Set credentials via <code>kora reset-admin</code> or Telegram <code>/webadmin user pass</code></p>
</form>
</div>
</body></html>`;
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(html);
  }

  private isApiRateLimited(key: string): boolean {
    const now = Date.now();
    const entry = this.apiRateLimits.get(key);
    if (!entry || now > entry.resetAt) {
      this.apiRateLimits.set(key, { count: 1, resetAt: now + WebAdminServer.API_RATE_WINDOW_MS });
      return false;
    }
    entry.count++;
    return entry.count > WebAdminServer.API_RATE_LIMIT;
  }

  private createPortalSession(userId: string): string {
    const db = this.ctx.dbManager?.db;
    if (!db) throw new Error('Database not available');

    const token = crypto.randomUUID();
    const csrfToken = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PORTAL_SESSION_TTL_MS);

    db.prepare(`
      INSERT INTO user_sessions (token, user_id, csrf_token, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(token, userId, csrfToken, now.toISOString(), expiresAt.toISOString());

    return token;
  }

  private getPortalSession(token: string): { userId: string; csrfToken: string } | null {
    const db = this.ctx.dbManager?.db;
    if (!db) return null;

    const row = db.prepare(
      'SELECT user_id, csrf_token, expires_at FROM user_sessions WHERE token = ?'
    ).get(token) as { user_id: string; csrf_token: string; expires_at: string } | undefined;

    if (!row) return null;
    if (new Date() > new Date(row.expires_at)) {
      db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
      return null;
    }

    return { userId: row.user_id, csrfToken: row.csrf_token };
  }

  private deletePortalSession(token: string): void {
    this.ctx.dbManager?.db?.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
  }

  private cleanExpiredPortalSessions(): void {
    this.ctx.dbManager?.db?.prepare(
      'DELETE FROM user_sessions WHERE expires_at < ?'
    ).run(new Date().toISOString());
  }

  private resolvePortalUser(req: http.IncomingMessage): { userId: string; csrfToken: string } | null {
    const cookies = parseCookies(req);
    const token = cookies[PORTAL_COOKIE_NAME];
    if (!token) return null;
    return this.getPortalSession(token);
  }

  private migrateWorkspaceData(oldWsId: string, newWsId: string): void {
    try {
      const allAgents = this.ctx.listSubAgents?.() ?? [];
      for (const a of allAgents) {
        if (a.workspaceId === oldWsId) {
          this.ctx.updateSubAgent?.(a.id as string, { workspaceId: newWsId } as any);
          logger.info(SCOPE, `Migrated sub-agent "${a.name}" from workspace ${oldWsId} to ${newWsId}`);
        }
      }
      const allTasks = this.ctx.listTasks?.() ?? [];
      for (const t of allTasks) {
        if (t.workspaceId === oldWsId) {
          this.ctx.updateTask?.(t.id, { workspaceId: newWsId } as any);
          logger.info(SCOPE, `Migrated task "${t.name}" from workspace ${oldWsId} to ${newWsId}`);
        }
      }
    } catch (err) {
      logger.error(SCOPE, `Workspace data migration failed: ${(err as Error).message}`);
    }
  }

  private getAllWorkspaceIdsForUser(userId: string): Set<string> {
    const wsIds = new Set<string>();
    const owned = this.ctx.workspaceManager?.getByOwner(userId);
    if (owned) wsIds.add(owned.id);
    const allOwned = this.ctx.workspaceManager?.listByOwner?.(userId) ?? [];
    for (const ws of allOwned) wsIds.add(ws.id);
    const identities = this.ctx.identityManager?.listAll().filter(i => i.userId === userId) ?? [];
    for (const ident of identities) {
      if (ident.workspaceId) wsIds.add(ident.workspaceId);
    }
    if (!this.ctx.multiUserEnabled) {
      const defaultWs = this.ctx.workspaceManager?.getDefault?.();
      if (defaultWs) wsIds.add(defaultWs.id);
    }
    return wsIds;
  }

  private getUserWorkspaceIds(user: { id: string }, primaryWorkspace: { id: string }): Set<string> {
    const wsIds = new Set<string>([primaryWorkspace.id]);
    const identities = this.ctx.identityManager?.listAll().filter(i => i.userId === user.id) ?? [];
    for (const ident of identities) {
      if (ident.workspaceId) wsIds.add(ident.workspaceId);
    }
    if (!this.ctx.multiUserEnabled) {
      const defaultWs = this.ctx.workspaceManager?.getDefault?.();
      if (defaultWs) wsIds.add(defaultWs.id);
    }
    return wsIds;
  }

  /**
   * Resolve workspace IDs for an admin-panel user entry, handling both
   * real User IDs and identity-based pseudo-IDs.
   */
  private resolveAllWorkspacesForAdminUser(userId: string): Set<string> {
    if (userId.startsWith('identity:')) {
      const identId = userId.slice('identity:'.length);
      const ident = this.ctx.identityManager?.listAll().find(i => i.id === identId);
      if (!ident?.workspaceId) return new Set();
      return new Set([ident.workspaceId]);
    }
    return this.getAllWorkspaceIdsForUser(userId);
  }

  private resolveWorkspaceForAdminUser(userId: string): string | null {
    if (userId.startsWith('identity:')) {
      const identId = userId.slice('identity:'.length);
      const ident = this.ctx.identityManager?.listAll().find(i => i.id === identId);
      return ident?.workspaceId ?? null;
    }
    const ws = this.ctx.workspaceManager?.getByOwner(userId) ?? null;
    if (ws) return ws.id;
    const identities = this.ctx.identityManager?.listAll().filter(i => i.userId === userId) ?? [];
    return identities.find(i => i.workspaceId)?.workspaceId ?? null;
  }

  /**
   * Get all identity IDs that belong to a specific user (by user_id link or by
   * sharing a workspace owned by / linked to this user).
   */
  private getIdentityIdsForUser(userId: string): Set<string> {
    const ids = new Set<string>();
    const wsIds = this.getAllWorkspaceIdsForUser(userId);
    const allIdentities = this.ctx.identityManager?.listAll() ?? [];
    for (const ident of allIdentities) {
      if (ident.channelUserId.startsWith('system:heartbeat')) continue;
      if (ident.userId === userId) {
        ids.add(ident.channelUserId);
        continue;
      }
      if (ident.workspaceId && wsIds.has(ident.workspaceId)) {
        ids.add(ident.channelUserId);
      }
    }
    return ids;
  }

  private getTelegramChatIdForUser(userId: string): string | null {
    const row = this.ctx.dbManager?.db?.prepare(
      `SELECT channel_user_id FROM identities WHERE user_id = ? AND channel = 'telegram' LIMIT 1`,
    ).get(userId) as { channel_user_id: string } | undefined;
    if (!row) return null;
    return row.channel_user_id.replace('telegram:', '');
  }

  private resolvePortalPublicDir(): string {
    const candidates = [
      path.join(__dirname, '..', 'web_portal', 'public'),
      path.join(__dirname, '..', '..', 'src', 'web_portal', 'public'),
      path.join(process.cwd(), 'src', 'web_portal', 'public'),
    ];
    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
    }
    return candidates[0];
  }

  private async handlePortalRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    method: string,
    url: string,
  ): Promise<boolean> {
    const qIdx = url.indexOf('?');

    if (method === 'POST' && pathname === '/api/register') {
      const clientIp = req.socket.remoteAddress ?? 'unknown';
      if (this.isLoginRateLimited(clientIp)) {
        sendJson(res, { error: 'Too many attempts. Try again later.' }, 429);
        return true;
      }
      try {
        const body = JSON.parse(await readBody(req));
        const { code, email, password, displayName } = body;

        if (!code || !email || !password) {
          sendJson(res, { error: 'code, email, and password are required' }, 400);
          return true;
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          sendJson(res, { error: 'Invalid email format' }, 400);
          return true;
        }

        if (String(password).length < 8) {
          sendJson(res, { error: 'Password must be at least 8 characters' }, 400);
          return true;
        }

        const um = this.ctx.userManager;
        const wm = this.ctx.workspaceManager;
        const im = this.ctx.identityManager;
        if (!um || !wm || !im) {
          sendJson(res, { error: 'Multi-user mode not configured' }, 500);
          return true;
        }

        const regCode = um.validateRegistrationCode(code);
        if (!regCode) {
          this.recordLoginAttempt(clientIp);
          sendJson(res, { error: 'Invalid or expired registration code' }, 400);
          return true;
        }

        if (regCode.email && regCode.email !== email.toLowerCase()) {
          sendJson(res, { error: 'This code was sent to a different email address' }, 400);
          return true;
        }

        const existingUser = um.getByEmail(email);

        const linkWorkspaceAndIdentities = (userId: string) => {
          const existingIdent = im.resolve('telegram', `telegram:${regCode.telegramChatId}`);
          let workspace = existingIdent?.workspaceId ? wm.get(existingIdent.workspaceId) : null;
          if (workspace) {
            if (!workspace.ownerUserId) wm.setOwner(workspace.id, userId);
          } else {
            workspace = wm.create(displayName || email.split('@')[0], false, userId);
          }
          if (existingIdent) {
            im.linkToUser(existingIdent.id, userId, workspace!.id);
          } else {
            im.linkToUser(
              im.create('telegram', regCode.telegramChatId, workspace!.id, userId).id,
              userId, workspace!.id,
            );
          }
          const emailIdentId = `email:${email}`;
          if (!im.resolve('email', emailIdentId)) {
            im.create('email', emailIdentId, workspace!.id, userId);
          }
          um.markRegistrationCodeUsed(code, userId);
          this.ctx.telegramChannel?.addAllowedChatId(Number(regCode.telegramChatId));
          return workspace!;
        };

        const emailPreVerified = !!regCode.email;

        if (existingUser) {
          await um.updatePassword(existingUser.id, password);
          const workspace = linkWorkspaceAndIdentities(existingUser.id);

          if (!emailPreVerified && this.ctx.systemMailer && existingUser.status !== 'active') {
            const verifyCode = um.generateEmailVerificationCode(existingUser.id, email);
            try {
              await this.ctx.systemMailer.sendVerificationCode(email, verifyCode);
            } catch (mailErr) {
              logger.error(SCOPE, `Failed to send verification email: ${(mailErr as Error).message}`);
            }
            sendJson(res, { requiresVerification: true, userId: existingUser.id });
            return true;
          }

          if (existingUser.status !== 'active') {
            um.activateUser(existingUser.id);
          }

          const sessionToken = this.createPortalSession(existingUser.id);
          setPortalCookie(res, sessionToken);
          sendJson(res, { ok: true, userId: existingUser.id, workspaceId: workspace.id });
          return true;
        }

        if (!emailPreVerified && this.ctx.systemMailer) {
          const user = await um.createPendingVerification(email, password, displayName);
          const verifyCode = um.generateEmailVerificationCode(user.id, email);
          linkWorkspaceAndIdentities(user.id);

          try {
            await this.ctx.systemMailer.sendVerificationCode(email, verifyCode);
          } catch (mailErr) {
            logger.error(SCOPE, `Failed to send verification email: ${(mailErr as Error).message}`);
          }

          sendJson(res, { requiresVerification: true, userId: user.id });
          return true;
        }

        const user = await um.create(email, password, displayName);
        const workspace = linkWorkspaceAndIdentities(user.id);

        const sessionToken = this.createPortalSession(user.id);
        setPortalCookie(res, sessionToken);
        sendJson(res, { ok: true, userId: user.id, workspaceId: workspace.id });
      } catch (err) {
        logger.error(SCOPE, `Portal registration failed: ${(err as Error).message}`);
        sendJson(res, { error: 'Registration failed' }, 500);
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/login') {
      const clientIp = req.socket.remoteAddress ?? 'unknown';
      if (this.isLoginRateLimited(clientIp)) {
        sendJson(res, { error: 'Too many login attempts. Try again later.' }, 429);
        return true;
      }
      try {
        const body = JSON.parse(await readBody(req));
        const { email, password } = body;
        if (!email || !password) {
          sendJson(res, { error: 'email and password are required' }, 400);
          return true;
        }

        const um = this.ctx.userManager;
        if (!um) {
          sendJson(res, { error: 'Multi-user mode not configured' }, 500);
          return true;
        }

        const result = await um.authenticate(email, password);
        if (!result.user) {
          this.recordLoginAttempt(clientIp);
          if (result.reason === 'suspended') {
            sendJson(res, { error: 'Account is suspended' }, 403);
          } else if (result.reason === 'pending_verification') {
            sendJson(res, { error: 'Please verify your email before logging in. Check your inbox for the verification code.' }, 403);
          } else {
            sendJson(res, { error: 'Invalid email or password' }, 401);
          }
          return true;
        }

        if (um.has2FA(result.user.id)) {
          const method2fa = um.get2FAMethod(result.user.id);
          const tempToken = createTwoFactorTempToken(result.user.id, 'user');
          if (method2fa === 'passkey') {
            const passkeys = um.getPasskeys(result.user.id);
            const rpId = this.getRpId(req);
            const { options, challengeKey } = await generatePasskeyAuthenticationOptions(rpId, passkeys);
            sendJson(res, { ok: true, needs2FA: true, method: 'passkey', tempToken, challengeKey, options });
          } else {
            sendJson(res, { ok: true, needs2FA: true, method: 'totp', tempToken });
          }
        } else {
          const tempToken = createTwoFactorTempToken(result.user.id, 'user');
          sendJson(res, { ok: true, needs2FASetup: true, tempToken, userId: result.user.id, email: result.user.email });
        }
      } catch (err) {
        logger.error(SCOPE, `Portal login failed: ${(err as Error).message}`);
        sendJson(res, { error: 'Login failed' }, 500);
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/2fa/setup/totp') {
      try {
        const { tempToken } = JSON.parse(await readBody(req));
        const userId = consumeTwoFactorTempToken(tempToken, 'user');
        if (!userId) { sendJson(res, { error: 'Invalid or expired session' }, 401); return true; }
        const um = this.ctx.userManager!;
        const user = um.getById(userId);
        const newTempToken = createTwoFactorTempToken(userId, 'user');
        const setup = generateTotpSecret('Kora', user?.email || userId);
        const qrCodeDataUrl = await generateTotpQrCode(setup.uri);
        um.setupTotp(userId, setup.secret);
        sendJson(res, { ok: true, tempToken: newTempToken, qrCodeDataUrl, secret: setup.secret });
      } catch { sendJson(res, { error: 'Invalid request' }, 400); }
      return true;
    }

    if (method === 'POST' && pathname === '/api/2fa/setup/totp/verify') {
      try {
        const { tempToken, code } = JSON.parse(await readBody(req));
        const userId = consumeTwoFactorTempToken(tempToken, 'user');
        if (!userId) { sendJson(res, { error: 'Invalid or expired session' }, 401); return true; }
        const um = this.ctx.userManager!;
        const secret = um.getPendingTotpSecret(userId);
        if (!secret || !verifyTotpCode(secret, String(code))) {
          const newTempToken = createTwoFactorTempToken(userId, 'user');
          sendJson(res, { error: 'Invalid code. Try again.', tempToken: newTempToken }, 400);
          return true;
        }
        um.verifyAndActivateTotp(userId);
        const sessionToken = this.createPortalSession(userId);
        setPortalCookie(res, sessionToken);
        const user = um.getById(userId);
        sendJson(res, { ok: true, verified: true, userId, email: user?.email });
      } catch { sendJson(res, { error: 'Invalid request' }, 400); }
      return true;
    }

    if (method === 'POST' && pathname === '/api/2fa/setup/passkey/register-options') {
      try {
        const { tempToken } = JSON.parse(await readBody(req));
        const userId = consumeTwoFactorTempToken(tempToken, 'user');
        if (!userId) { sendJson(res, { error: 'Invalid or expired session' }, 401); return true; }
        const um = this.ctx.userManager!;
        const user = um.getById(userId);
        const newTempToken = createTwoFactorTempToken(userId, 'user');
        const rpId = this.getRpId(req);
        const existing = um.getPasskeys(userId);
        const { options, challengeKey } = await generatePasskeyRegistrationOptions(
          userId, user?.email || userId, rpId, 'Kora', existing,
        );
        um.setupPasskeyMethod(userId);
        sendJson(res, { ok: true, tempToken: newTempToken, challengeKey, options });
      } catch { sendJson(res, { error: 'Invalid request' }, 400); }
      return true;
    }

    if (method === 'POST' && pathname === '/api/2fa/setup/passkey/register') {
      try {
        const { tempToken, challengeKey, credential } = JSON.parse(await readBody(req));
        const userId = consumeTwoFactorTempToken(tempToken, 'user');
        if (!userId) { sendJson(res, { error: 'Invalid or expired session' }, 401); return true; }
        const rpId = this.getRpId(req);
        const origin = this.getOrigin(req);
        const passkey = await verifyPasskeyRegistration(credential, challengeKey, rpId, origin);
        if (!passkey) { sendJson(res, { error: 'Passkey registration failed' }, 400); return true; }
        const um = this.ctx.userManager!;
        um.savePasskey(userId, passkey);
        const sessionToken = this.createPortalSession(userId);
        setPortalCookie(res, sessionToken);
        const user = um.getById(userId);
        sendJson(res, { ok: true, verified: true, userId, email: user?.email });
      } catch { sendJson(res, { error: 'Invalid request' }, 400); }
      return true;
    }

    if (method === 'POST' && pathname === '/api/2fa/setup/skip') {
      try {
        const { tempToken } = JSON.parse(await readBody(req));
        const userId = consumeTwoFactorTempToken(tempToken, 'user');
        if (!userId) { sendJson(res, { error: 'Invalid or expired session' }, 401); return true; }
        const sessionToken = this.createPortalSession(userId);
        setPortalCookie(res, sessionToken);
        const user = this.ctx.userManager!.getById(userId);
        sendJson(res, { ok: true, userId, email: user?.email });
      } catch { sendJson(res, { error: 'Invalid request' }, 400); }
      return true;
    }

    if (method === 'POST' && pathname === '/api/2fa/verify/totp') {
      try {
        const { tempToken, code } = JSON.parse(await readBody(req));
        const userId = consumeTwoFactorTempToken(tempToken, 'user');
        if (!userId) { sendJson(res, { error: 'Invalid or expired session' }, 401); return true; }
        const um = this.ctx.userManager!;
        const secret = um.getTotpSecret(userId);
        if (!secret || !verifyTotpCode(secret, String(code))) {
          const newTempToken = createTwoFactorTempToken(userId, 'user');
          sendJson(res, { error: 'Invalid code', tempToken: newTempToken }, 401);
          return true;
        }
        const sessionToken = this.createPortalSession(userId);
        setPortalCookie(res, sessionToken);
        const user = um.getById(userId);
        sendJson(res, { ok: true, userId, email: user?.email });
      } catch { sendJson(res, { error: 'Invalid request' }, 400); }
      return true;
    }

    if (method === 'POST' && pathname === '/api/2fa/verify/passkey') {
      try {
        const { tempToken, challengeKey, credential } = JSON.parse(await readBody(req));
        const userId = consumeTwoFactorTempToken(tempToken, 'user');
        if (!userId) { sendJson(res, { error: 'Invalid or expired session' }, 401); return true; }
        const um = this.ctx.userManager!;
        const passkeys = um.getPasskeys(userId);
        const matchedPk = passkeys.find(pk => pk.credentialId === credential.id);
        if (!matchedPk) { sendJson(res, { error: 'Unknown passkey' }, 401); return true; }
        const rpId = this.getRpId(req);
        const origin = this.getOrigin(req);
        const result = await verifyPasskeyAuthentication(credential, challengeKey, rpId, origin, matchedPk);
        if (!result.verified) { sendJson(res, { error: 'Passkey verification failed' }, 401); return true; }
        um.updatePasskeyCounter(matchedPk.credentialId, result.newCounter);
        const sessionToken = this.createPortalSession(userId);
        setPortalCookie(res, sessionToken);
        const user = um.getById(userId);
        sendJson(res, { ok: true, userId, email: user?.email });
      } catch { sendJson(res, { error: 'Invalid request' }, 400); }
      return true;
    }

    if (method === 'POST' && pathname === '/api/password-reset/passkey-start') {
      const clientIpPk = req.socket.remoteAddress ?? 'unknown';
      if (this.isLoginRateLimited(clientIpPk)) {
        sendJson(res, { error: 'Too many attempts. Try again later.' }, 429);
        return true;
      }
      try {
        const { email } = JSON.parse(await readBody(req));
        const um = this.ctx.userManager!;
        const user = um.getByEmail(email);
        if (!user || !um.has2FA(user.id) || um.get2FAMethod(user.id) !== 'passkey') {
          sendJson(res, { ok: true, message: 'If an account with a passkey exists, you will be prompted.' });
          return true;
        }
        const passkeys = um.getPasskeys(user.id);
        if (passkeys.length === 0) {
          sendJson(res, { ok: true, message: 'No passkeys found.' });
          return true;
        }
        const rpId = this.getRpId(req);
        const { options, challengeKey } = await generatePasskeyAuthenticationOptions(rpId, passkeys);
        const tempToken = createTwoFactorTempToken(user.id, 'user');
        sendJson(res, { ok: true, hasPasskey: true, tempToken, challengeKey, options });
      } catch { sendJson(res, { error: 'Invalid request' }, 400); }
      return true;
    }

    if (method === 'POST' && pathname === '/api/password-reset/passkey-complete') {
      try {
        const { tempToken, challengeKey, credential, newPassword } = JSON.parse(await readBody(req));
        const userId = consumeTwoFactorTempToken(tempToken, 'user');
        if (!userId) { sendJson(res, { error: 'Invalid or expired session' }, 401); return true; }
        const um = this.ctx.userManager!;
        const passkeys = um.getPasskeys(userId);
        const matchedPk = passkeys.find(pk => pk.credentialId === credential.id);
        if (!matchedPk) { sendJson(res, { error: 'Unknown passkey' }, 401); return true; }
        const rpId = this.getRpId(req);
        const origin = this.getOrigin(req);
        const result = await verifyPasskeyAuthentication(credential, challengeKey, rpId, origin, matchedPk);
        if (!result.verified) { sendJson(res, { error: 'Passkey verification failed' }, 401); return true; }
        um.updatePasskeyCounter(matchedPk.credentialId, result.newCounter);
        if (!newPassword || String(newPassword).length < 8) {
          sendJson(res, { error: 'Password must be at least 8 characters' }, 400);
          return true;
        }
        const bcryptMod = await import('bcryptjs');
        const hash = await bcryptMod.default.hash(newPassword, 12);
        this.ctx.dbManager!.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
        sendJson(res, { ok: true, message: 'Password reset successfully.' });
      } catch { sendJson(res, { error: 'Invalid request' }, 400); }
      return true;
    }

    if (method === 'POST' && pathname === '/api/device/approve') {
      const session = this.resolvePortalUser(req);
      if (!session) { sendJson(res, { error: 'Not authenticated' }, 401); return true; }
      const csrfHeader = req.headers['x-csrf-token'] as string | undefined;
      if (!csrfHeader || csrfHeader !== session.csrfToken) {
        sendJson(res, { error: 'Invalid CSRF token' }, 403);
        return true;
      }
      try {
        const { deviceCode } = JSON.parse(await readBody(req));
        if (!deviceCode) { sendJson(res, { error: 'deviceCode is required' }, 400); return true; }
        if (!this.clientApi) { sendJson(res, { error: 'Not available' }, 503); return true; }
        const ok = this.clientApi.approveDeviceCode(deviceCode, session.userId);
        if (!ok) { sendJson(res, { error: 'Invalid or expired device code' }, 400); return true; }
        sendJson(res, { ok: true });
      } catch { sendJson(res, { error: 'Invalid request' }, 400); }
      return true;
    }

    if (method === 'POST' && pathname === '/api/logout') {
      const cookies = parseCookies(req);
      const token = cookies[PORTAL_COOKIE_NAME];
      if (token) this.deletePortalSession(token);
      clearPortalCookie(res);
      sendJson(res, { ok: true });
      return true;
    }

    if (method === 'GET' && pathname === '/api/auth/check') {
      const session = this.resolvePortalUser(req);
      sendJson(res, { authenticated: !!session });
      return true;
    }

    if (method === 'POST' && pathname === '/api/verify-email') {
      const clientIpVe = req.socket.remoteAddress ?? 'unknown';
      if (this.isLoginRateLimited(clientIpVe)) {
        sendJson(res, { error: 'Too many attempts. Try again later.' }, 429);
        return true;
      }
      try {
        const body = JSON.parse(await readBody(req));
        const { code } = body;
        if (!code) { sendJson(res, { error: 'Verification code is required' }, 400); return true; }

        const um = this.ctx.userManager;
        const wm = this.ctx.workspaceManager;
        if (!um || !wm) { sendJson(res, { error: 'Not configured' }, 500); return true; }

        const valid = um.validateEmailVerificationCode(code);
        if (!valid) { sendJson(res, { error: 'Invalid or expired verification code' }, 400); return true; }

        um.markVerificationCodeUsed(code);
        um.activateUser(valid.userId);

        this.ctx.telegramChannel?.addAllowedChatId(
          Number(this.getTelegramChatIdForUser(valid.userId)),
        );

        const sessionToken = this.createPortalSession(valid.userId);
        setPortalCookie(res, sessionToken);
        sendJson(res, { ok: true, userId: valid.userId });
      } catch (err) {
        logger.error(SCOPE, `Email verification failed: ${(err as Error).message}`);
        sendJson(res, { error: 'Verification failed' }, 500);
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/resend-verification') {
      const clientIpRv = req.socket.remoteAddress ?? 'unknown';
      if (this.isLoginRateLimited(clientIpRv)) {
        sendJson(res, { error: 'Too many attempts. Try again later.' }, 429);
        return true;
      }
      try {
        const body = JSON.parse(await readBody(req));
        const { userId } = body;
        const um = this.ctx.userManager;
        if (!um || !userId) { sendJson(res, { error: 'Missing data' }, 400); return true; }

        const user = um.getById(userId);
        if (!user || user.status !== 'pending_verification' || !user.email) {
          sendJson(res, { error: 'Cannot resend' }, 400);
          return true;
        }

        const code = um.generateEmailVerificationCode(user.id, user.email);
        if (this.ctx.systemMailer) {
          await this.ctx.systemMailer.sendVerificationCode(user.email, code);
        }
        sendJson(res, { ok: true });
      } catch (err) {
        logger.error(SCOPE, `Resend verification failed: ${(err as Error).message}`);
        sendJson(res, { error: 'Failed to resend' }, 500);
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/password-reset/request') {
      const clientIp = req.socket.remoteAddress ?? 'unknown';
      if (this.isLoginRateLimited(clientIp)) {
        sendJson(res, { error: 'Too many attempts. Try again later.' }, 429);
        return true;
      }
      try {
        const body = JSON.parse(await readBody(req));
        const { email } = body;
        if (!email) { sendJson(res, { error: 'Email is required' }, 400); return true; }

        const um = this.ctx.userManager;
        if (!um) { sendJson(res, { error: 'Not configured' }, 500); return true; }

        const user = um.getByEmail(email);
        if (user && user.email) {
          const code = um.generatePasswordResetCode(user.id, user.email);

          if (this.ctx.systemMailer) {
            try { await this.ctx.systemMailer.sendPasswordResetCode(user.email, code); } catch (e) {
              logger.error(SCOPE, `Failed to send reset email: ${(e as Error).message}`);
            }
          } else {
            logger.info(SCOPE, `Mail not configured. Password reset for ${user.email} requested. Code generated: ${code}`);
          }
        }

        sendJson(res, { ok: true, message: 'If an account exists with that email, a reset code has been sent.' });
      } catch (err) {
        logger.error(SCOPE, `Password reset request failed: ${(err as Error).message}`);
        sendJson(res, { error: 'Request failed' }, 500);
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/password-reset/confirm') {
      const clientIp = req.socket.remoteAddress ?? 'unknown';
      if (this.isLoginRateLimited(clientIp)) {
        sendJson(res, { error: 'Too many attempts. Try again later.' }, 429);
        return true;
      }
      try {
        const body = JSON.parse(await readBody(req));
        const { code, newPassword } = body;
        if (!code || !newPassword) { sendJson(res, { error: 'Code and new password are required' }, 400); return true; }
        if (String(newPassword).length < 8) { sendJson(res, { error: 'Password must be at least 8 characters' }, 400); return true; }

        const um = this.ctx.userManager;
        if (!um) { sendJson(res, { error: 'Not configured' }, 500); return true; }

        const success = await um.resetPassword(code, newPassword);
        if (!success) {
          this.recordLoginAttempt(clientIp);
          sendJson(res, { error: 'Invalid or expired reset code' }, 400);
          return true;
        }

        sendJson(res, { ok: true });
      } catch (err) {
        logger.error(SCOPE, `Password reset confirm failed: ${(err as Error).message}`);
        sendJson(res, { error: 'Reset failed' }, 500);
      }
      return true;
    }

    if (pathname.startsWith('/api/')) {
      const session = this.resolvePortalUser(req);
      if (!session) {
        sendJson(res, { error: 'Unauthorized' }, 401);
        return true;
      }

      if (this.isApiRateLimited(`portal:${session.userId}`)) {
        sendJson(res, { error: 'Rate limit exceeded. Try again later.' }, 429);
        return true;
      }

      const um = this.ctx.userManager;
      const wm = this.ctx.workspaceManager;
      if (!um || !wm) {
        sendJson(res, { error: 'Multi-user mode not configured' }, 500);
        return true;
      }

      const user = um.getById(session.userId);
      if (!user || user.status !== 'active') {
        sendJson(res, { error: 'Account unavailable' }, 403);
        return true;
      }

      if (method !== 'GET') {
        const csrfHeader = req.headers['x-csrf-token'] as string | undefined;
        if (!csrfHeader || csrfHeader !== session.csrfToken) {
          sendJson(res, { error: 'Invalid CSRF token' }, 403);
          return true;
        }
      }

      let workspace = wm.getByOwner(user.id);
      if (!workspace) {
        const im = this.ctx.identityManager;
        if (im) {
          const userIdentities = im.getByUserId(user.id);
          for (const ident of userIdentities) {
            if (ident.workspaceId) {
              workspace = wm.get(ident.workspaceId);
              if (workspace) {
                wm.setOwner(workspace.id, user.id);
                logger.info(SCOPE, `Auto-linked workspace ${workspace.id} to user ${user.id} via identity ${ident.id}`);
                break;
              }
            }
          }
        }
      }
      if (!workspace) {
        sendJson(res, { error: 'No workspace found. Use /start in Telegram to create one.' }, 404);
        return true;
      }

      if (method === 'GET' && pathname === '/api/me') {
        let effectiveSubStatus = user.subscriptionStatus;
        if (this.ctx.billingEnabled && effectiveSubStatus === 'none' && !user.stripeCustomerId) {
          const im = this.ctx.identityManager;
          if (im) {
            const identities = im.getByUserId(user.id);
            for (const ident of identities) {
              if (ident.workspaceId) {
                const wsIdentities = im.getByWorkspace(ident.workspaceId);
                for (const wsIdent of wsIdentities) {
                  if (wsIdent.userId && wsIdent.userId !== user.id) {
                    const otherUser = um.getById(wsIdent.userId);
                    if (otherUser?.subscriptionStatus === 'active' && otherUser.stripeCustomerId) {
                      um.updateSubscription(user.id, {
                        stripeCustomerId: otherUser.stripeCustomerId,
                        stripeSubscriptionId: otherUser.stripeSubscriptionId ?? undefined,
                        subscriptionStatus: 'active',
                        subscriptionStartDate: otherUser.subscriptionStartDate ?? undefined,
                      });
                      effectiveSubStatus = 'active';
                      logger.info(SCOPE, `Synced subscription from user ${otherUser.id} to ${user.id} (same workspace)`);
                      break;
                    }
                  }
                }
                if (effectiveSubStatus === 'active') break;
              }
            }
          }
        }

        sendJson(res, {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          subscriptionStatus: effectiveSubStatus,
          planId: user.planId,
          stripeCustomerId: user.stripeCustomerId || null,
          billingEnabled: !!this.ctx.billingEnabled,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          csrfToken: session.csrfToken,
        });
        return true;
      }

      if (method === 'GET' && pathname === '/api/profile/identities') {
        const im = this.ctx.identityManager;
        if (!im) { sendJson(res, []); return true; }
        const identities = im.getByWorkspace(workspace.id)
          .filter(i => !i.channelUserId.startsWith('scheduler:') && i.channel !== 'internal');
        sendJson(res, identities.map(i => ({
          id: i.id,
          channel: i.channel,
          channelUserId: i.channelUserId,
          linkedAt: i.linkedAt?.toISOString() ?? null,
        })));
        return true;
      }

      if (method === 'GET' && pathname === '/api/workspace') {
        sendJson(res, {
          id: workspace.id,
          name: workspace.name,
          createdAt: workspace.createdAt,
        });
        return true;
      }

      if (method === 'GET' && pathname === '/api/usage') {
        const db = this.ctx.dbManager?.db;
        if (!db) { sendJson(res, { totalCalls: 0, limit: 1000, models: [] }); return true; }

        const { UsageTracker: UT } = await import('../billing/usage.js');
        const globalSettings = this.ctx.config.loadSettings();
        const tracker = new UT(db, globalSettings.billing);
        const usage = tracker.getDailyUsage(user.id, workspace.id);
        sendJson(res, usage);
        return true;
      }

      if (method === 'GET' && pathname === '/api/heartbeat') {
        const wsSettings = this.ctx.config.loadWorkspaceSettings(workspace.id);
        sendJson(res, { enabled: wsSettings.heartbeat?.enabled !== false });
        return true;
      }

      if (method === 'PUT' && pathname === '/api/heartbeat') {
        const body = JSON.parse(await readBody(req));
        const wsDir = this.ctx.config.getWorkspacePath(workspace.id);
        fs.mkdirSync(wsDir, { recursive: true });
        const wsSettingsPath = path.join(wsDir, 'settings.yml');
        let current: Record<string, unknown> = {};
        if (fs.existsSync(wsSettingsPath)) {
          current = (parseYaml(fs.readFileSync(wsSettingsPath, 'utf-8')) as Record<string, unknown>) || {};
        }
        current.heartbeat = { ...(current.heartbeat as Record<string, unknown> || {}), enabled: !!body.enabled };
        fs.writeFileSync(wsSettingsPath, stringifyYaml(current), 'utf-8');
        sendJson(res, { ok: true, enabled: !!body.enabled });
        return true;
      }

      if (method === 'GET' && pathname === '/api/tools') {
        const globalSettings = this.ctx.config.loadSettings();
        const globalTools = (globalSettings.tools || {}) as Record<string, unknown>;
        let wsTools: Record<string, unknown> = {};
        const wsSettingsPath = path.join(this.ctx.config.getWorkspacePath(workspace.id), 'settings.yml');
        if (fs.existsSync(wsSettingsPath)) {
          const parsed = parseYaml(fs.readFileSync(wsSettingsPath, 'utf-8')) as Record<string, unknown> | null;
          wsTools = (parsed?.tools || {}) as Record<string, unknown>;
        }
        const merged = { ...globalTools, ...wsTools };
        const locked: string[] = [];
        for (const [key, val] of Object.entries(globalTools)) {
          if (val === false) {
            merged[key] = false;
            locked.push(key);
          }
        }
        sendJson(res, { tools: merged, locked });
        return true;
      }

      if (method === 'PUT' && pathname === '/api/tools') {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const globalSettings = this.ctx.config.loadSettings();
        const globalTools = (globalSettings.tools || {}) as Record<string, unknown>;
        for (const key of Object.keys(body)) {
          if (globalTools[key] === false) delete body[key];
        }
        const wsDir = this.ctx.config.getWorkspacePath(workspace.id);
        fs.mkdirSync(wsDir, { recursive: true });
        const wsSettingsPath = path.join(wsDir, 'settings.yml');
        let current: Record<string, unknown> = {};
        if (fs.existsSync(wsSettingsPath)) {
          current = (parseYaml(fs.readFileSync(wsSettingsPath, 'utf-8')) as Record<string, unknown>) || {};
        }
        current.tools = { ...(current.tools as Record<string, unknown> || {}), ...body };
        fs.writeFileSync(wsSettingsPath, stringifyYaml(current), 'utf-8');
        sendJson(res, { ok: true });
        return true;
      }

      if (method === 'GET' && pathname === '/api/mcp') {
        const wsDir = this.ctx.config.getWorkspacePath(workspace.id);
        const mcpPath = path.join(wsDir, 'mcp.yml');
        if (fs.existsSync(mcpPath)) {
          const parsed = parseYaml(fs.readFileSync(mcpPath, 'utf-8')) as Record<string, unknown> | null;
          const servers = Array.isArray(parsed?.servers) ? parsed.servers : [];
          sendJson(res, servers);
        } else {
          sendJson(res, []);
        }
        return true;
      }

      if (method === 'POST' && pathname === '/api/mcp') {
        const body = JSON.parse(await readBody(req));
        if (this.ctx.multiUserEnabled && body.transport !== 'sse') {
          sendJson(res, { error: 'Only remote SSE servers are allowed in multi-user mode. Local (stdio) servers can only be installed by the admin.' }, 403);
          return true;
        }
        const wsDir = this.ctx.config.getWorkspacePath(workspace.id);
        fs.mkdirSync(wsDir, { recursive: true });
        const mcpPath = path.join(wsDir, 'mcp.yml');
        let current: Record<string, unknown> = {};
        if (fs.existsSync(mcpPath)) {
          current = (parseYaml(fs.readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>) || {};
        }
        const servers = Array.isArray(current.servers) ? current.servers : [];
        servers.push(body);
        current.servers = servers;
        fs.writeFileSync(mcpPath, stringifyYaml(current), 'utf-8');
        sendJson(res, { ok: true });
        return true;
      }

      const portalMcpMatch = pathname.match(/^\/api\/mcp\/([^/]+)$/);
      if (method === 'DELETE' && portalMcpMatch) {
        const serverId = decodeURIComponent(portalMcpMatch[1]);
        const wsDir = this.ctx.config.getWorkspacePath(workspace.id);
        const mcpPath = path.join(wsDir, 'mcp.yml');
        if (fs.existsSync(mcpPath)) {
          const current = (parseYaml(fs.readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>) || {};
          const servers = Array.isArray(current.servers) ? current.servers : [];
          current.servers = servers.filter((s: Record<string, unknown>) => s.id !== serverId && s.name !== serverId);
          fs.writeFileSync(mcpPath, stringifyYaml(current), 'utf-8');
        }
        sendJson(res, { ok: true });
        return true;
      }

      if (method === 'GET' && pathname === '/api/skills') {
        const wsSkillsDir = path.join(this.ctx.config.getWorkspacePath(workspace.id), 'skills');
        const skills: Array<Record<string, unknown>> = [];
        if (fs.existsSync(wsSkillsDir)) {
          for (const entry of fs.readdirSync(wsSkillsDir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              const skillMd = path.join(wsSkillsDir, entry.name, 'SKILL.md');
              if (fs.existsSync(skillMd)) {
                const manifest = loadSkill(skillMd);
                skills.push({
                  name: manifest?.name ?? entry.name,
                  installed: true,
                  description: manifest?.description ?? null,
                  version: manifest?.version ?? null,
                });
              }
            }
          }
        }
        sendJson(res, skills);
        return true;
      }

      if (method === 'POST' && pathname === '/api/skills') {
        const body = JSON.parse(await readBody(req));
        const skillName = (body.name as string || '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
        const content = body.content as string;
        if (!skillName || !content) {
          sendJson(res, { error: 'Both "name" and "content" (SKILL.md) are required' }, 400);
          return true;
        }
        const wsSkillsDir = path.join(this.ctx.config.getWorkspacePath(workspace.id), 'skills');
        const skillDir = path.resolve(wsSkillsDir, skillName);
        if (!isPathWithin(skillDir, wsSkillsDir)) {
          sendJson(res, { error: 'Invalid skill name' }, 400);
          return true;
        }
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
        sendJson(res, { ok: true, name: skillName });
        return true;
      }

      if (method === 'POST' && pathname === '/api/skills/upload') {
        try {
          const wsSkillsDir = path.join(this.ctx.config.getWorkspacePath(workspace.id), 'skills');
          const rawBody = await readBodyRaw(req);

          const boundary = (req.headers['content-type'] ?? '').match(/boundary=(.+)/)?.[1];
          if (!boundary) {
            sendJson(res, { error: 'Multipart boundary not found' }, 400);
            return true;
          }

          const parts = parseMultipart(rawBody, boundary);
          const namePart = parts.find(p => p.name === 'name');
          const filePart = parts.find(p => p.name === 'file');

          if (!namePart?.value || !filePart?.data) {
            sendJson(res, { error: 'Both "name" and "file" fields are required' }, 400);
            return true;
          }

          const skillName = namePart.value.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
          if (!skillName) {
            sendJson(res, { error: 'Invalid skill name' }, 400);
            return true;
          }

          const skillDir = path.resolve(wsSkillsDir, skillName);
          if (!isPathWithin(skillDir, wsSkillsDir)) {
            sendJson(res, { error: 'Invalid skill name' }, 400);
            return true;
          }
          fs.mkdirSync(skillDir, { recursive: true });

          const zipPath = path.join(skillDir, '__upload.zip');
          fs.writeFileSync(zipPath, filePart.data);

          try {
            execFileSync('unzip', ['-o', zipPath, '-d', skillDir], { timeout: 30_000 });
          } catch {
            fs.rmSync(skillDir, { recursive: true, force: true });
            sendJson(res, { error: 'Failed to extract zip. Make sure the file is a valid zip archive.' }, 400);
            return true;
          }

          try { fs.unlinkSync(zipPath); } catch { /* ignore */ }

          const verifyPathSafety = (dir: string): boolean => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const fullPath = path.resolve(dir, entry.name);
              if (!isPathWithin(fullPath, skillDir)) return false;
              if (entry.isDirectory() && !verifyPathSafety(fullPath)) return false;
            }
            return true;
          };
          if (!verifyPathSafety(skillDir)) {
            fs.rmSync(skillDir, { recursive: true, force: true });
            sendJson(res, { error: 'Zip contains files with unsafe paths' }, 400);
            return true;
          }

          const skillMdPath = path.join(skillDir, 'SKILL.md');
          if (!fs.existsSync(skillMdPath)) {
            const entries = fs.readdirSync(skillDir);
            const subDir = entries.find(e => fs.existsSync(path.join(skillDir, e, 'SKILL.md')));
            if (subDir) {
              const innerDir = path.join(skillDir, subDir);
              for (const f of fs.readdirSync(innerDir)) {
                fs.renameSync(path.join(innerDir, f), path.join(skillDir, f));
              }
              fs.rmSync(innerDir, { recursive: true, force: true });
            }
          }

          if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
            fs.rmSync(skillDir, { recursive: true, force: true });
            sendJson(res, { error: 'Zip must contain a SKILL.md file' }, 400);
            return true;
          }

          sendJson(res, { ok: true, name: skillName });
        } catch (err) {
          logger.error(SCOPE, `Skill upload failed: ${(err as Error).message}`);
          sendJson(res, { error: 'Upload failed' }, 500);
        }
        return true;
      }

      const portalSkillDelete = pathname.match(/^\/api\/skills\/([^/]+)$/);
      if (method === 'DELETE' && portalSkillDelete) {
        const skillName = decodeURIComponent(portalSkillDelete[1]).replace(/[^a-zA-Z0-9_-]/g, '_');
        const wsSkillsDir = path.join(this.ctx.config.getWorkspacePath(workspace.id), 'skills');
        const skillDir = path.resolve(wsSkillsDir, skillName);
        if (!isPathWithin(skillDir, wsSkillsDir)) {
          sendJson(res, { error: 'Invalid skill name' }, 400);
          return true;
        }
        if (fs.existsSync(skillDir)) {
          fs.rmSync(skillDir, { recursive: true, force: true });
        }
        sendJson(res, { ok: true });
        return true;
      }

      if (method === 'GET' && pathname === '/api/tasks') {
        const allTasks = this.ctx.listTasks?.() ?? [];
        const userWsIds = this.getUserWorkspaceIds(user, workspace);
        sendJson(res, allTasks.filter((t: any) => userWsIds.has(t.workspaceId)));
        return true;
      }

      const portalTaskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (portalTaskMatch) {
        const taskId = decodeURIComponent(portalTaskMatch[1]);
        if (method === 'GET') {
          const task = this.ctx.getTask?.(taskId);
          if (!task || !this.getUserWorkspaceIds(user, workspace).has(task.workspaceId)) {
            sendJson(res, { error: 'Task not found' }, 404);
            return true;
          }
          const logs = this.ctx.getTaskLogs?.(taskId, 20) ?? [];
          sendJson(res, { ...task, logs });
          return true;
        }
        if (method === 'PUT') {
          const task = this.ctx.getTask?.(taskId);
          if (!task || !this.getUserWorkspaceIds(user, workspace).has(task.workspaceId)) {
            sendJson(res, { error: 'Task not found' }, 404);
            return true;
          }
          const body = JSON.parse(await readBody(req));
          this.ctx.updateTask?.(taskId, body);
          sendJson(res, { ok: true });
          return true;
        }
        if (method === 'DELETE') {
          const task = this.ctx.getTask?.(taskId);
          if (!task || !this.getUserWorkspaceIds(user, workspace).has(task.workspaceId)) {
            sendJson(res, { error: 'Task not found' }, 404);
            return true;
          }
          this.ctx.deleteTask?.(taskId);
          sendJson(res, { ok: true });
          return true;
        }
      }

      const portalTaskRun = pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
      if (method === 'POST' && portalTaskRun) {
        const taskId = decodeURIComponent(portalTaskRun[1]);
        const task = this.ctx.getTask?.(taskId);
        if (!task || !this.getUserWorkspaceIds(user, workspace).has(task.workspaceId)) {
          sendJson(res, { error: 'Task not found' }, 404);
          return true;
        }
        try {
          await this.ctx.runTaskNow?.(taskId);
          sendJson(res, { ok: true });
        } catch (e) {
          sendJson(res, { error: (e as Error).message }, 500);
        }
        return true;
      }

      if (method === 'GET' && pathname === '/api/subagents') {
        const agents = this.ctx.listSubAgents?.(workspace.id) ?? [];
        const baseUrl = this.ctx.baseUrl || '';
        const enriched = agents.map(a => ({
          ...a,
          webhookUrl: a.webhookToken ? `${baseUrl}/api/webhook/subagent/${a.webhookToken}` : null,
        }));
        sendJson(res, enriched);
        return true;
      }

      if (method === 'POST' && pathname === '/api/subagents') {
        const body = JSON.parse(await readBody(req));
        try {
          const sa = this.ctx.createSubAgentConfig?.({
            ...body,
            workspaceId: workspace.id,
          });
          sendJson(res, sa ?? { ok: true });
        } catch (e) {
          sendJson(res, { error: (e as Error).message }, 500);
        }
        return true;
      }

      const portalSubagentMatch = pathname.match(/^\/api\/subagents\/([^/]+)$/);
      if (portalSubagentMatch) {
        const agentId = decodeURIComponent(portalSubagentMatch[1]);
        if (method === 'PUT') {
          const body = JSON.parse(await readBody(req));
          const ok = this.ctx.updateSubAgent?.(agentId, { ...body, workspaceId: workspace.id }) ?? false;
          sendJson(res, { ok });
          return true;
        }
        if (method === 'DELETE') {
          const ok = this.ctx.removeSubAgent?.(agentId, workspace.id) ?? false;
          sendJson(res, { ok });
          return true;
        }
      }

      const portalSubagentRun = pathname.match(/^\/api\/subagents\/([^/]+)\/run$/);
      if (method === 'POST' && portalSubagentRun) {
        const agentId = decodeURIComponent(portalSubagentRun[1]);
        const body = JSON.parse(await readBody(req));
        if (!body.task) { sendJson(res, { error: 'task required' }, 400); return true; }
        try {
          const result = await this.ctx.runSubAgent?.(agentId, body.task, workspace.id);
          sendJson(res, { ok: true, result: result ?? '' });
        } catch (e) {
          sendJson(res, { error: (e as Error).message }, 500);
        }
        return true;
      }

      if (method === 'GET' && pathname === '/api/models') {
        const settings = this.ctx.config.loadSettings();
        const wsSettings = this.ctx.config.loadWorkspaceSettings(workspace.id);
        const providers = this.ctx.config.loadProviders?.() || [];
        const models: Array<Record<string, unknown>> = [];
        for (const p of providers) {
          for (const m of (p.models || [])) {
            const billingInfo = settings.billing?.models?.[m.id] || settings.billing?.models?.[m.name];
            models.push({
              id: m.id,
              name: m.name,
              provider: p.id,
              roles: m.roles || [],
              ...(billingInfo ? {
                includedCalls: billingInfo.included_calls,
              } : {}),
            });
          }
        }
        sendJson(res, {
          models,
          currentModel: wsSettings.defaultModel || settings.defaultModel,
          currentProvider: wsSettings.defaultProvider || settings.defaultProvider,
        });
        return true;
      }

      if (method === 'PUT' && pathname === '/api/model') {
        const body = JSON.parse(await readBody(req));
        const wsDir = this.ctx.config.getWorkspacePath(workspace.id);
        fs.mkdirSync(wsDir, { recursive: true });
        const wsSettingsPath = path.join(wsDir, 'settings.yml');
        let current: Record<string, unknown> = {};
        if (fs.existsSync(wsSettingsPath)) {
          current = (parseYaml(fs.readFileSync(wsSettingsPath, 'utf-8')) as Record<string, unknown>) || {};
        }
        if (body.defaultModel) current.defaultModel = body.defaultModel;
        if (body.defaultProvider) current.defaultProvider = body.defaultProvider;
        fs.writeFileSync(wsSettingsPath, stringifyYaml(current), 'utf-8');
        sendJson(res, { ok: true });
        return true;
      }

      if (method === 'GET' && pathname === '/api/agent-prompt') {
        const wsDir = this.ctx.config.getWorkspacePath(workspace.id);
        const agentMd = path.join(wsDir, 'AGENT.md');
        const content = fs.existsSync(agentMd) ? fs.readFileSync(agentMd, 'utf-8') : '';
        sendJson(res, { content });
        return true;
      }

      if (method === 'PUT' && pathname === '/api/agent-prompt') {
        const body = JSON.parse(await readBody(req));
        const wsDir = this.ctx.config.getWorkspacePath(workspace.id);
        fs.mkdirSync(wsDir, { recursive: true });
        fs.writeFileSync(path.join(wsDir, 'AGENT.md'), body.content || '', 'utf-8');
        sendJson(res, { ok: true });
        return true;
      }

      if (method === 'GET' && pathname === '/api/identity') {
        const wsIdentity = this.ctx.config.loadWorkspaceIdentityMd(workspace.id);
        const globalIdentity = this.ctx.config.loadIdentityMd();
        sendJson(res, { content: wsIdentity || globalIdentity, source: wsIdentity ? 'workspace' : 'global' });
        return true;
      }

      if (method === 'PUT' && pathname === '/api/identity') {
        const body = JSON.parse(await readBody(req));
        this.ctx.config.saveWorkspaceIdentityMd(workspace.id, body.content || '');
        sendJson(res, { ok: true });
        return true;
      }

      if (method === 'GET' && pathname === '/api/kyu') {
        sendJson(res, { content: this.ctx.config.loadKyuMd(workspace.id) });
        return true;
      }

      if (method === 'GET' && pathname === '/api/memory') {
        if (!this.ctx.memoryManager) { sendJson(res, []); return true; }
        sendJson(res, this.ctx.memoryManager.list(workspace.id));
        return true;
      }

      if (method === 'GET' && pathname === '/api/memory/raw') {
        if (!this.ctx.memoryManager) { sendJson(res, { content: '' }); return true; }
        sendJson(res, { content: this.ctx.memoryManager.load(workspace.id) });
        return true;
      }

      const portalMemoryEntryMatch = pathname.match(/^\/api\/memory\/([^/]+)$/);
      if (method === 'PUT' && portalMemoryEntryMatch) {
        if (!this.ctx.memoryManager) { sendJson(res, { error: 'Memory manager not available' }, 500); return true; }
        const body = JSON.parse(await readBody(req));
        if (!body.content) { sendJson(res, { error: 'content required' }, 400); return true; }
        const ok = this.ctx.memoryManager.update(workspace.id, portalMemoryEntryMatch[1], body.content);
        sendJson(res, { ok });
        return true;
      }

      if (method === 'DELETE' && portalMemoryEntryMatch) {
        if (!this.ctx.memoryManager) { sendJson(res, { error: 'Memory manager not available' }, 500); return true; }
        const ok = this.ctx.memoryManager.remove(workspace.id, portalMemoryEntryMatch[1]);
        sendJson(res, { ok });
        return true;
      }

      if (method === 'GET' && pathname === '/api/mail-delegations') {
        if (!this.ctx.delegationManager) { sendJson(res, []); return true; }
        const configs = this.ctx.delegationManager.listForWorkspace(workspace.id);
        const safe = configs.map(c => ({ ...c, credentials: { provider: c.provider, hasCredentials: true } }));
        sendJson(res, safe);
        return true;
      }

      if (method === 'POST' && pathname === '/api/mail-delegations') {
        if (!this.ctx.delegationManager) {
          sendJson(res, { error: 'Mail delegation not available' }, 500);
          return true;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const dlgConfig = this.ctx.delegationManager.add(
            workspace.id,
            body.provider,
            body.email.toLowerCase(),
            body.credentials,
            body.permissions || { read: true, send: false },
            body.autoCheckMinutes || 0,
          );
          if (this.ctx.mailIndexer) {
            this.ctx.mailIndexer.startIndexing(workspace.id).catch(() => { });
          }
          sendJson(res, { ok: true, id: dlgConfig.id });
        } catch (e: any) {
          sendJson(res, { ok: false, error: e.message }, 400);
        }
        return true;
      }

      const portalDelegationDelete = pathname.match(/^\/api\/mail-delegations\/([^/]+)$/);
      if (method === 'DELETE' && portalDelegationDelete) {
        if (!this.ctx.delegationManager) {
          sendJson(res, { error: 'Mail delegation not available' }, 500);
          return true;
        }
        const ok = this.ctx.delegationManager.remove(portalDelegationDelete[1]);
        sendJson(res, { ok });
        return true;
      }

      if (method === 'POST' && pathname === '/api/mail-delegations/oauth-url') {
        try {
          const creds = this.getGmailOAuthCredentials();
          if (!creds) {
            sendJson(res, { ok: false, error: 'No Gmail channel configured. The admin must set up a Gmail channel first so OAuth credentials are available.' }, 400);
            return true;
          }
          const authUrl = gmailAuthUrl(creds.clientId, creds.clientSecret);
          sendJson(res, { ok: true, url: authUrl });
        } catch (e: any) {
          sendJson(res, { ok: false, error: e.message }, 400);
        }
        return true;
      }

      if (method === 'POST' && pathname === '/api/mail-delegations/oauth-exchange') {
        try {
          const creds = this.getGmailOAuthCredentials();
          if (!creds) {
            sendJson(res, { ok: false, error: 'No Gmail channel configured' }, 400);
            return true;
          }
          const body = JSON.parse(await readBody(req));
          const result = await gmailExchangeCode(creds.clientId, creds.clientSecret, body.code);
          sendJson(res, { ok: true, ...result });
        } catch (e: any) {
          sendJson(res, { ok: false, error: e.message }, 400);
        }
        return true;
      }

      if (method === 'GET' && pathname === '/api/mail-indexing') {
        if (!this.ctx.mailIndexer) { sendJson(res, []); return true; }
        const progress = this.ctx.mailIndexer.getProgress(workspace.id);
        sendJson(res, progress);
        return true;
      }

      if (method === 'POST' && pathname === '/api/mail-indexing/start') {
        if (!this.ctx.mailIndexer) { sendJson(res, { error: 'Mail indexer not available' }, 500); return true; }
        this.ctx.mailIndexer.startIndexing(workspace.id).catch(() => { });
        sendJson(res, { ok: true });
        return true;
      }

      if (method === 'POST' && pathname === '/api/mail-indexing/stop') {
        if (!this.ctx.mailIndexer) { sendJson(res, { error: 'Mail indexer not available' }, 500); return true; }
        this.ctx.mailIndexer.stopIndexing(workspace.id);
        sendJson(res, { ok: true });
        return true;
      }

      if (method === 'POST' && pathname === '/api/mail-indexing/reset') {
        if (!this.ctx.mailIndexer) { sendJson(res, { error: 'Mail indexer not available' }, 500); return true; }
        const body = JSON.parse(await readBody(req));
        const delegationId = body.delegationId as string | undefined;
        const restart = body.restart !== false;
        this.ctx.mailIndexer.resetIndexing(workspace.id, delegationId, restart).catch((err: Error) => {
          logger.error('web-portal', `Mail indexing reset failed: ${err.message}`);
        });
        sendJson(res, { ok: true });
        return true;
      }

      if (method === 'GET' && pathname === '/api/mail-delegation-settings') {
        const wsSettings = this.ctx.config.loadWorkspaceSettings(workspace.id);
        const security = (wsSettings as unknown as Record<string, unknown>).mail_delegation_security as Record<string, unknown> | undefined;
        sendJson(res, { sensitiveMailFilter: security?.sensitiveMailFilter !== false });
        return true;
      }

      if (method === 'PUT' && pathname === '/api/mail-delegation-settings') {
        const body = JSON.parse(await readBody(req));
        const wsSettings = this.ctx.config.loadWorkspaceSettings(workspace.id) as unknown as Record<string, unknown>;
        wsSettings.mail_delegation_security = {
          ...(wsSettings.mail_delegation_security as Record<string, unknown> || {}),
          sensitiveMailFilter: body.sensitiveMailFilter !== false,
        };
        this.ctx.config.saveWorkspaceSettings(workspace.id, wsSettings as Record<string, unknown>);
        if (this.ctx.mailIndexer) {
          this.ctx.mailIndexer.setSensitiveMailFilter(body.sensitiveMailFilter !== false);
        }
        sendJson(res, { ok: true });
        return true;
      }

      if (method === 'POST' && pathname === '/api/stripe/checkout') {
        if (!this.ctx.stripeManager || !this.ctx.billingEnabled) {
          sendJson(res, { error: 'Billing not available' }, 400);
          return true;
        }
        if (user.subscriptionStatus === 'active') {
          sendJson(res, { error: 'You already have an active subscription' }, 400);
          return true;
        }
        try {
          const checkoutUrl = await this.ctx.stripeManager.createPortalCheckoutSession(user.id);
          sendJson(res, { url: checkoutUrl });
        } catch (e: any) {
          sendJson(res, { error: e.message }, 500);
        }
        return true;
      }

      if (method === 'POST' && pathname === '/api/stripe/portal') {
        if (!this.ctx.stripeManager || !user.stripeCustomerId) {
          sendJson(res, { error: 'Billing not available' }, 400);
          return true;
        }
        try {
          const portalUrl = await this.ctx.stripeManager.createPortalSession(user.stripeCustomerId);
          sendJson(res, { url: portalUrl });
        } catch (e: any) {
          sendJson(res, { error: e.message }, 500);
        }
        return true;
      }

      sendJson(res, { error: 'Not found' }, 404);
      return true;
    }

    {
      const portalDir = this.resolvePortalPublicDir();
      let filePath = pathname.replace(/^\/+/, '') || 'index.html';
      if (filePath === '') filePath = 'index.html';
      const fullPath = path.resolve(portalDir, filePath);

      if (isPathWithin(fullPath, portalDir) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath);
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
        });
        fs.createReadStream(fullPath).pipe(res);
      } else {
        const indexPath = path.join(portalDir, 'index.html');
        if (fs.existsSync(indexPath)) {
          res.writeHead(200, {
            'Content-Type': 'text/html',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          });
          fs.createReadStream(indexPath).pipe(res);
        } else {
          sendJson(res, { error: 'Portal not found. Make sure the portal frontend is built.' }, 404);
        }
      }
      return true;
    }
  }

  private async handleSubAgentWebhook(req: http.IncomingMessage, res: http.ServerResponse, token: string): Promise<void> {
    const clientIp = req.socket.remoteAddress ?? 'unknown';
    if (this.isApiRateLimited(`webhook:${clientIp}`)) {
      sendJson(res, { error: 'Too many requests' }, 429);
      return;
    }
    const sam = this.ctx.subAgentManager;
    if (!sam) {
      sendJson(res, { error: 'Not available' }, 503);
      return;
    }
    const agent = sam.getByWebhookToken(token);
    if (!agent) {
      sendJson(res, { error: 'Not found' }, 404);
      return;
    }
    if (agent.config.status === 'running') {
      sendJson(res, { error: 'Agent busy' }, 409);
      return;
    }
    const body = await readBody(req);
    let task: string;
    try {
      const parsed = JSON.parse(body);
      task = typeof parsed === 'string' ? parsed : (parsed.task || parsed.message || parsed.content || JSON.stringify(parsed));
    } catch {
      task = body || 'Webhook triggered (no payload)';
    }
    sendJson(res, { ok: true, agentId: agent.config.id, status: 'started' });
    sam.runTask(agent.config.id, task, agent.config.workspaceId).catch(err => {
      logger.error(SCOPE, `Webhook sub-agent run failed: ${(err as Error).message}`);
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '/';
    const method = req.method || 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const clientIp = req.socket.remoteAddress ?? 'unknown';
    if (this.isApiRateLimited(`global:${clientIp}`)) {
      sendJson(res, { error: 'Too many requests' }, 429);
      return;
    }

    try {
      const qIdx = url.indexOf('?');
      const pathname = qIdx !== -1 ? url.slice(0, qIdx) : url;

      if (this.clientApi && this.clientApi.canHandle(pathname)) {
        const body = await readBody(req);
        return this.clientApi.handle(req, res, pathname, body);
      }

      if (pathname === '/stripe/webhook' || pathname.startsWith('/stripe/')) {
        return this.handleAdminRoutes(req, res, pathname, method, url);
      }

      const webhookMatch = pathname.match(/^\/api\/webhook\/subagent\/([a-f0-9-]+)$/);
      if (webhookMatch && method === 'POST') {
        return this.handleSubAgentWebhook(req, res, webhookMatch[1]);
      }

      if (pathname.startsWith('/admin')) {
        const adminPath = pathname.replace(/^\/admin/, '') || '/';
        return this.handleAdminRoutes(req, res, adminPath, method, url);
      }

      if (this.ctx.multiUserEnabled) {
        if (await this.handlePortalRequest(req, res, pathname, method, url)) return;
        sendJson(res, { error: 'Not Found' }, 404);
        return;
      }

      res.writeHead(302, { Location: '/admin' });
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      logger.error(SCOPE, `Request error: ${msg}`);
      sendJson(res, { error: 'Internal server error' }, 500);
    }
  }

  private async handleAdminRoutes(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    method: string,
    url: string,
  ): Promise<void> {
    const qIdx = url.indexOf('?');

    if (method === 'POST' && pathname === '/login') {
      const clientIp = req.socket.remoteAddress ?? 'unknown';
      if (this.isLoginRateLimited(clientIp)) {
        this.serveLoginPage(res, 'Too many login attempts. Try again later.');
        return;
      }
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const username = params.get('username')?.trim() ?? '';
      const password = params.get('password') ?? '';

      let authenticated = false;
      if (this.ctx.adminAuth) {
        authenticated = await this.ctx.adminAuth.verify(username, password);
      }

      if (authenticated) {
        const sessionId = crypto.randomUUID();
        this.sessions.set(sessionId, Date.now());
        setSessionCookie(res, sessionId);
        res.writeHead(302, { 'Location': '/admin' });
        res.end();
      } else {
        this.recordLoginAttempt(clientIp);
        this.serveLoginPage(res, 'Invalid username or password');
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/login') {
      const clientIp = req.socket.remoteAddress ?? 'unknown';
      if (this.isLoginRateLimited(clientIp)) {
        sendJson(res, { error: 'Too many login attempts. Try again later.' }, 429);
        return;
      }
      const body = await readBody(req);
      try {
        const { username, password } = JSON.parse(body);
        const u = String(username ?? '');
        const p = String(password ?? '');

        let authenticated = false;
        if (this.ctx.adminAuth) {
          authenticated = await this.ctx.adminAuth.verify(u, p);
        }

        if (authenticated) {
          const admin = this.ctx.adminAuth!;
          if (admin.has2FA()) {
            const method2fa = admin.get2FAMethod();
            const tempToken = createTwoFactorTempToken('admin', 'admin');
            if (method2fa === 'passkey') {
              const passkeys = admin.getPasskeys();
              const rpId = this.getRpId(req);
              const { options, challengeKey } = await generatePasskeyAuthenticationOptions(rpId, passkeys);
              sendJson(res, { ok: true, needs2FA: true, method: 'passkey', tempToken, challengeKey, options });
            } else {
              sendJson(res, { ok: true, needs2FA: true, method: 'totp', tempToken });
            }
          } else {
            const tempToken = createTwoFactorTempToken('admin', 'admin');
            sendJson(res, { ok: true, needs2FASetup: true, tempToken });
          }
        } else {
          this.recordLoginAttempt(clientIp);
          sendJson(res, { error: 'Invalid credentials' }, 401);
        }
      } catch (err) {
        logger.error(SCOPE, `Admin portal login failed: ${(err as Error).message}`);
        sendJson(res, { error: 'Invalid request' }, 400);
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/2fa/setup/totp') {
      const body = await readBody(req);
      try {
        const { tempToken } = JSON.parse(body);
        const userId = consumeTwoFactorTempToken(tempToken, 'admin');
        if (!userId) { sendJson(res, { error: 'Invalid or expired session' }, 401); return; }
        const newTempToken = createTwoFactorTempToken('admin', 'admin');
        const admin = this.ctx.adminAuth!;
        const setup = generateTotpSecret('Kora Admin', admin.getUsername() || 'admin');
        const qrCodeDataUrl = await generateTotpQrCode(setup.uri);
        admin.setupTotp(setup.secret);
        sendJson(res, { ok: true, tempToken: newTempToken, qrCodeDataUrl, secret: setup.secret });
      } catch { sendJson(res, { error: 'Invalid request' }, 400); }
      return;
    }

    if (method === 'POST' && pathname === '/api/2fa/setup/totp/verify') {
      const body = await readBody(req);
      try {
        const { tempToken, code } = JSON.parse(body);
        const userId = consumeTwoFactorTempToken(tempToken, 'admin');
        if (!userId) { sendJson(res, { error: 'Invalid or expired session' }, 401); return; }
        const admin = this.ctx.adminAuth!;
        const row = this.ctx.dbManager?.db.prepare(
          'SELECT totp_secret FROM admin_2fa WHERE id = 1'
        ).get() as { totp_secret: string } | undefined;
        if (!row?.totp_secret || !verifyTotpCode(row.totp_secret, String(code))) {
          const newTempToken = createTwoFactorTempToken('admin', 'admin');
          sendJson(res, { error: 'Invalid code. Try again.', tempToken: newTempToken }, 400);
          return;
        }
        admin.verifyAndActivateTotp();
        const sessionId = crypto.randomUUID();
        this.sessions.set(sessionId, Date.now());
        setSessionCookie(res, sessionId);
        sendJson(res, { ok: true, verified: true });
      } catch { sendJson(res, { error: 'Invalid request' }, 400); }
      return;
    }

    if (method === 'POST' && pathname === '/api/2fa/setup/passkey/register-options') {
      const body = await readBody(req);
      try {
        const { tempToken } = JSON.parse(body);
        const userId = consumeTwoFactorTempToken(tempToken, 'admin');
        if (!userId) { sendJson(res, { error: 'Invalid or expired session' }, 401); return; }
        const newTempToken = createTwoFactorTempToken('admin', 'admin');
        const admin = this.ctx.adminAuth!;
        const rpId = this.getRpId(req);
        const rpName = 'Kora Admin';
        const existing = admin.getPasskeys();
        const { options, challengeKey } = await generatePasskeyRegistrationOptions(
          'admin', admin.getUsername() || 'admin', rpId, rpName, existing,
        );
        admin.setupPasskeyMethod();
        sendJson(res, { ok: true, tempToken: newTempToken, challengeKey, options });
      } catch { sendJson(res, { error: 'Invalid request' }, 400); }
      return;
    }

    if (method === 'POST' && pathname === '/api/2fa/setup/passkey/register') {
      const body = await readBody(req);
      try {
        const { tempToken, challengeKey, credential } = JSON.parse(body);
        const userId = consumeTwoFactorTempToken(tempToken, 'admin');
        const admin = this.ctx.adminAuth!;
        if (!userId) { sendJson(res, { error: 'Invalid or expired session' }, 401); return; }
        const rpId = this.getRpId(req);
        const origin = this.getOrigin(req);
        const passkey = await verifyPasskeyRegistration(credential, challengeKey, rpId, origin);
        if (!passkey) { sendJson(res, { error: 'Passkey registration failed' }, 400); return; }
        admin.savePasskey(passkey);
        admin.verifyAndActivateTotp();
        const sessionId = crypto.randomUUID();
        this.sessions.set(sessionId, Date.now());
        setSessionCookie(res, sessionId);
        sendJson(res, { ok: true, verified: true });
      } catch { sendJson(res, { error: 'Invalid request' }, 400); }
      return;
    }

    if (method === 'POST' && pathname === '/api/2fa/setup/skip') {
      try {
        const { tempToken } = JSON.parse(await readBody(req));
        const userId = consumeTwoFactorTempToken(tempToken, 'admin');
        if (!userId) { sendJson(res, { error: 'Invalid or expired session' }, 401); return; }
        const sessionId = crypto.randomUUID();
        this.sessions.set(sessionId, Date.now());
        setSessionCookie(res, sessionId);
        sendJson(res, { ok: true, verified: true });
      } catch { sendJson(res, { error: 'Invalid request' }, 400); }
      return;
    }

    if (method === 'POST' && pathname === '/api/2fa/verify/totp') {
      const body = await readBody(req);
      try {
        const { tempToken, code } = JSON.parse(body);
        const userId = consumeTwoFactorTempToken(tempToken, 'admin');
        if (!userId) { sendJson(res, { error: 'Invalid or expired session' }, 401); return; }
        const secret = this.ctx.adminAuth!.getTotpSecret();
        if (!secret || !verifyTotpCode(secret, String(code))) {
          const newTempToken = createTwoFactorTempToken('admin', 'admin');
          sendJson(res, { error: 'Invalid code', tempToken: newTempToken }, 401);
          return;
        }
        const sessionId = crypto.randomUUID();
        this.sessions.set(sessionId, Date.now());
        setSessionCookie(res, sessionId);
        sendJson(res, { ok: true });
      } catch { sendJson(res, { error: 'Invalid request' }, 400); }
      return;
    }

    if (method === 'POST' && pathname === '/api/2fa/verify/passkey') {
      const body = await readBody(req);
      try {
        const { tempToken, challengeKey, credential } = JSON.parse(body);
        const userId = consumeTwoFactorTempToken(tempToken, 'admin');
        if (!userId) { sendJson(res, { error: 'Invalid or expired session' }, 401); return; }
        const admin = this.ctx.adminAuth!;
        const passkeys = admin.getPasskeys();
        const matchedPk = passkeys.find(pk => pk.credentialId === credential.id);
        if (!matchedPk) { sendJson(res, { error: 'Unknown passkey' }, 401); return; }
        const rpId = this.getRpId(req);
        const origin = this.getOrigin(req);
        const result = await verifyPasskeyAuthentication(credential, challengeKey, rpId, origin, matchedPk);
        if (!result.verified) { sendJson(res, { error: 'Passkey verification failed' }, 401); return; }
        admin.updatePasskeyCounter(matchedPk.credentialId, result.newCounter);
        const sessionId = crypto.randomUUID();
        this.sessions.set(sessionId, Date.now());
        setSessionCookie(res, sessionId);
        sendJson(res, { ok: true });
      } catch { sendJson(res, { error: 'Invalid request' }, 400); }
      return;
    }

    if (method === 'GET' && pathname === '/api/auth/check') {
      const isAuthed = this.checkAuth(req);
      sendJson(res, { authenticated: isAuthed });
      return;
    }

    if (pathname.startsWith('/api/') && pathname !== '/api/auth/check' && !this.checkAuth(req)) {
      sendJson(res, { error: 'Unauthorized' }, 401);
      return;
    }

    if (method === 'GET' && pathname === '/api/status') {
      const status = this.ctx.getStatus();
      sendJson(res, {
        ...status,
        multiUserEnabled: !!this.ctx.multiUserEnabled,
        billingEnabled: !!this.ctx.billingEnabled,
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/sessions') {
      const searchParams = new URLSearchParams(qIdx !== -1 ? url.slice(qIdx + 1) : '');
      const limit = parseInt(searchParams.get('limit') || '50', 10);
      const offset = parseInt(searchParams.get('offset') || '0', 10);
      sendJson(res, this.ctx.auditLog.getSessions(limit, offset));
      return;
    }

    if (method === 'GET' && pathname === '/api/audit/poll') {
      const searchParams = new URLSearchParams(qIdx !== -1 ? url.slice(qIdx + 1) : '');
      const since = searchParams.get('since') || new Date(0).toISOString();
      const limit = parseInt(searchParams.get('limit') || '100', 10);
      sendJson(res, this.ctx.auditLog.getEntriesSince(since, limit));
      return;
    }

    if (method === 'DELETE' && pathname === '/api/sessions') {
      const searchParams = new URLSearchParams(qIdx !== -1 ? url.slice(qIdx + 1) : '');
      const identity = searchParams.get('identity');
      let deleted: number;
      if (identity) {
        deleted = this.ctx.auditLog.deleteSessionsByIdentity(identity);
      } else {
        deleted = this.ctx.auditLog.deleteAllSessions();
      }
      sendJson(res, { ok: true, deleted });
      return;
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/(.+)$/);
    if (method === 'GET' && sessionMatch) {
      const sessionId = sessionMatch[1];
      const searchParams = new URLSearchParams(qIdx !== -1 ? url.slice(qIdx + 1) : '');
      const limit = parseInt(searchParams.get('limit') || '0', 10);
      const offset = parseInt(searchParams.get('offset') || '0', 10);
      const sort = (searchParams.get('sort') === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';
      if (limit > 0) {
        const entries = this.ctx.auditLog.getSession(sessionId, limit, offset, sort);
        const total = this.ctx.auditLog.getSessionEntryCount(sessionId);
        sendJson(res, { entries, total, limit, offset, sort });
      } else {
        sendJson(res, this.ctx.auditLog.getSession(sessionId, 0, 0, sort));
      }
      return;
    }

    if (method === 'DELETE' && sessionMatch) {
      const deleted = this.ctx.auditLog.deleteSession(sessionMatch[1]);
      sendJson(res, { ok: true, deleted });
      return;
    }

    if (method === 'GET' && pathname === '/api/config/settings') {
      const filePath = path.join(this.ctx.config.configPath, 'settings.yml');
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        sendJson(res, parseYaml(raw) ?? {});
      } else {
        sendJson(res, {});
      }
      return;
    }

    if (method === 'PUT' && pathname === '/api/config/settings') {
      const body = await readBody(req);
      const updates = JSON.parse(body);
      this.ctx.config.saveSettings(updates);
      sendJson(res, { ok: true });
      return;
    }

    if (method === 'GET' && pathname === '/api/config/agent') {
      sendJson(res, { content: this.ctx.config.loadAgentMd() });
      return;
    }

    if (method === 'PUT' && pathname === '/api/config/agent') {
      const body = await readBody(req);
      const { content } = JSON.parse(body);
      this.ctx.config.saveAgentMd(content);
      sendJson(res, { ok: true });
      return;
    }

    if (method === 'GET' && pathname === '/api/config/identity') {
      sendJson(res, { content: this.ctx.config.loadIdentityMd() });
      return;
    }

    if (method === 'PUT' && pathname === '/api/config/identity') {
      const body = await readBody(req);
      const { content } = JSON.parse(body);
      this.ctx.config.saveIdentityMd(content);
      sendJson(res, { ok: true });
      return;
    }

    if (method === 'GET' && pathname === '/api/config/kyu') {
      const defaultWs = this.ctx.workspaceManager?.getDefault();
      const content = defaultWs ? this.ctx.config.loadKyuMd(defaultWs.id) : '';
      sendJson(res, { content });
      return;
    }

    if (method === 'PUT' && pathname === '/api/config/kyu') {
      const body = await readBody(req);
      const { content } = JSON.parse(body);
      const defaultWs = this.ctx.workspaceManager?.getDefault();
      if (defaultWs) {
        this.ctx.config.saveKyuMd(defaultWs.id, content);
      }
      sendJson(res, { ok: true });
      return;
    }

    if (method === 'GET' && pathname === '/api/config/heartbeat') {
      const filePath = path.join(this.ctx.config.configPath, 'HEARTBEAT.md');
      const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
      sendJson(res, { content });
      return;
    }

    if (method === 'PUT' && pathname === '/api/config/heartbeat') {
      const body = await readBody(req);
      const { content } = JSON.parse(body);
      const filePath = path.join(this.ctx.config.configPath, 'HEARTBEAT.md');
      fs.writeFileSync(filePath, content, 'utf-8');
      sendJson(res, { ok: true });
      return;
    }

    if (method === 'GET' && pathname === '/api/config/providers') {
      const filePath = path.join(this.ctx.config.configPath, 'providers.yml');
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = parseYaml(raw) as Record<string, unknown> | null;
        const providers = Array.isArray(parsed?.providers) ? parsed.providers : (Array.isArray(parsed) ? parsed : []);
        const redacted = JSON.parse(redactSecrets(JSON.stringify(providers)));
        sendJson(res, redacted);
      } else {
        sendJson(res, []);
      }
      return;
    }

    if (method === 'PUT' && pathname === '/api/config/providers') {
      const body = await readBody(req);
      const providers = JSON.parse(body);
      const data = Array.isArray(providers) ? providers : (providers.providers ?? providers);
      const filePath = path.join(this.ctx.config.configPath, 'providers.yml');
      fs.writeFileSync(filePath, stringifyYaml({ providers: data }), 'utf-8');
      sendJson(res, { ok: true });
      return;
    }

    if (method === 'GET' && pathname === '/api/config/channels') {
      const filePath = path.join(this.ctx.config.configPath, 'channels.yml');
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = parseYaml(raw) as Record<string, unknown> | null;
        const channels = Array.isArray(parsed?.channels) ? parsed.channels : (Array.isArray(parsed) ? parsed : []);
        const redacted = JSON.parse(redactSecrets(JSON.stringify(channels)));
        sendJson(res, redacted);
      } else {
        sendJson(res, []);
      }
      return;
    }

    if (method === 'PUT' && pathname === '/api/config/channels') {
      const body = await readBody(req);
      const channels = JSON.parse(body);
      const data = Array.isArray(channels) ? channels : (channels.channels ?? channels);
      const filePath = path.join(this.ctx.config.configPath, 'channels.yml');
      fs.writeFileSync(filePath, stringifyYaml({ channels: data }), 'utf-8');
      sendJson(res, { ok: true });
      return;
    }

    if (method === 'GET' && pathname === '/api/piper-voices') {
      try {
        if (!this.piperVoicesCache || Date.now() - this.piperVoicesCacheTime > 86400000) {
          const r = await fetch('https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json');
          if (!r.ok) throw new Error(`HF returned ${r.status}`);
          this.piperVoicesCache = await r.json();
          this.piperVoicesCacheTime = Date.now();
        }
        sendJson(res, this.piperVoicesCache);
      } catch (e: any) {
        sendJson(res, { error: e.message }, 502);
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/gmail/auth-url') {
      try {
        const body = JSON.parse(await readBody(req));
        const url = gmailAuthUrl(body.clientId, body.clientSecret);
        sendJson(res, { ok: true, url });
      } catch (e: any) {
        sendJson(res, { ok: false, error: e.message }, 400);
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/gmail/exchange') {
      try {
        const body = JSON.parse(await readBody(req));
        const result = await gmailExchangeCode(body.clientId, body.clientSecret, body.code);
        sendJson(res, { ok: true, ...result });
      } catch (e: any) {
        sendJson(res, { ok: false, error: e.message }, 400);
      }
      return;
    }

    // ─── Mail Delegation API ────────────────────────────────────────────
    if (pathname.startsWith('/api/mail-delegations') && this.ctx.delegationManager) {
      const dm = this.ctx.delegationManager;

      if (method === 'GET' && pathname === '/api/mail-delegations') {
        const searchParams = new URLSearchParams(qIdx !== -1 ? url.slice(qIdx + 1) : '');
        const wsId = searchParams.get('workspace') || undefined;
        const configs = wsId ? dm.listForWorkspace(wsId) : dm.listAll();
        const safe = configs.map(c => ({ ...c, credentials: { provider: c.provider, hasCredentials: true } }));
        sendJson(res, safe);
        return;
      }

      if (method === 'POST' && pathname === '/api/mail-delegations') {
        try {
          const body = JSON.parse(await readBody(req));
          const dlgConfig = dm.add(
            body.workspaceId,
            body.provider,
            body.email.toLowerCase(),
            body.credentials,
            body.permissions || { read: true, send: false },
            body.autoCheckMinutes || 0,
          );
          if (this.ctx.mailIndexer && body.workspaceId) {
            this.ctx.mailIndexer.startIndexing(body.workspaceId).catch(() => { });
          }
          sendJson(res, { ok: true, id: dlgConfig.id });
        } catch (e: any) {
          sendJson(res, { ok: false, error: e.message }, 400);
        }
        return;
      }

      const delegationIdMatch = pathname.match(/^\/api\/mail-delegations\/([^/]+)$/);
      if (delegationIdMatch) {
        const id = delegationIdMatch[1];

        if (method === 'PUT') {
          try {
            const body = JSON.parse(await readBody(req));
            const ok = dm.update(id, body);
            sendJson(res, { ok });
          } catch (e: any) {
            sendJson(res, { ok: false, error: e.message }, 400);
          }
          return;
        }

        if (method === 'DELETE') {
          const ok = dm.remove(id);
          sendJson(res, { ok });
          return;
        }
      }

      if (method === 'POST' && pathname === '/api/mail-delegations/oauth-url') {
        try {
          const creds = this.getGmailOAuthCredentials();
          if (!creds) {
            sendJson(res, { ok: false, error: 'No Gmail channel configured. Set up a Gmail channel first so OAuth credentials are available.' }, 400);
            return;
          }
          const authUrl = gmailAuthUrl(creds.clientId, creds.clientSecret);
          sendJson(res, { ok: true, url: authUrl });
        } catch (e: any) {
          sendJson(res, { ok: false, error: e.message }, 400);
        }
        return;
      }

      if (method === 'POST' && pathname === '/api/mail-delegations/oauth-exchange') {
        try {
          const creds = this.getGmailOAuthCredentials();
          if (!creds) {
            sendJson(res, { ok: false, error: 'No Gmail channel configured' }, 400);
            return;
          }
          const body = JSON.parse(await readBody(req));
          const result = await gmailExchangeCode(creds.clientId, creds.clientSecret, body.code);
          sendJson(res, { ok: true, ...result });
        } catch (e: any) {
          sendJson(res, { ok: false, error: e.message }, 400);
        }
        return;
      }
    }

    if (method === 'GET' && pathname === '/api/mail-indexing') {
      if (!this.ctx.mailIndexer) { sendJson(res, []); return; }
      const searchParams = new URLSearchParams(qIdx !== -1 ? url.slice(qIdx + 1) : '');
      const wsId = searchParams.get('workspace');
      const progress = wsId ? this.ctx.mailIndexer.getProgress(wsId) : this.ctx.mailIndexer.getAllProgress();
      sendJson(res, progress);
      return;
    }

    if (method === 'POST' && pathname === '/api/mail-indexing/start') {
      if (!this.ctx.mailIndexer) { sendJson(res, { error: 'Mail indexer not available' }, 500); return; }
      const body = JSON.parse(await readBody(req));
      const wsId = body.workspaceId;
      if (!wsId) { sendJson(res, { error: 'workspaceId required' }, 400); return; }
      this.ctx.mailIndexer.startIndexing(wsId).catch(() => { });
      sendJson(res, { ok: true });
      return;
    }

    if (method === 'POST' && pathname === '/api/mail-indexing/stop') {
      if (!this.ctx.mailIndexer) { sendJson(res, { error: 'Mail indexer not available' }, 500); return; }
      const body = JSON.parse(await readBody(req));
      const wsId = body.workspaceId;
      if (!wsId) { sendJson(res, { error: 'workspaceId required' }, 400); return; }
      this.ctx.mailIndexer.stopIndexing(wsId);
      sendJson(res, { ok: true });
      return;
    }

    if (method === 'POST' && pathname === '/api/mail-indexing/reset') {
      if (!this.ctx.mailIndexer) { sendJson(res, { error: 'Mail indexer not available' }, 500); return; }
      const body = JSON.parse(await readBody(req));
      const wsId = body.workspaceId;
      if (!wsId) { sendJson(res, { error: 'workspaceId required' }, 400); return; }
      const delegationId = body.delegationId as string | undefined;
      const restart = body.restart !== false;
      this.ctx.mailIndexer.resetIndexing(wsId, delegationId, restart).catch((err: Error) => {
        logger.error('web-admin', `Mail indexing reset failed: ${err.message}`);
      });
      sendJson(res, { ok: true });
      return;
    }

    if (method === 'GET' && pathname === '/api/tools') {
      sendJson(res, this.ctx.getEnabledTools());
      return;
    }

    if (method === 'GET' && pathname === '/api/tools/settings') {
      const s = this.ctx.config.loadSettings();
      sendJson(res, s.tools || {});
      return;
    }

    if (method === 'PUT' && pathname === '/api/tools/settings') {
      const body = await readBody(req);
      const updates = JSON.parse(body);
      const current = this.ctx.config.loadSettings();
      const merged = { ...current.tools, ...updates };
      this.ctx.config.saveSettings({ tools: merged });
      sendJson(res, { ok: true, tools: merged, note: 'Restart required for changes to take effect' });
      return;
    }

    if (method === 'GET' && pathname === '/api/mcp/servers') {
      sendJson(res, this.ctx.mcpManager.listServersWithTools());
      return;
    }

    if (method === 'POST' && pathname === '/api/mcp/install') {
      try {
        const body = await readBody(req);
        const { source, env, args, transport, url, command, name } = JSON.parse(body);
        const result = await this.ctx.mcpManager.install(source ?? '', { env, args, transport, url, command, name });
        sendJson(res, result);
      } catch (err) {
        logger.error(SCOPE, `MCP install failed: ${(err as Error).message}`);
        sendJson(res, { error: 'Installation failed' }, 500);
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/logout') {
      const cookies = parseCookies(req);
      const sessionToken = cookies[COOKIE_NAME];
      if (sessionToken) this.sessions.delete(sessionToken);
      clearSessionCookie(res);
      sendJson(res, { ok: true });
      return;
    }

    if (method === 'POST' && pathname === '/api/reload') {
      try {
        await this.ctx.reload?.();
        sendJson(res, { ok: true, message: 'Settings reloaded successfully' });
      } catch (e) {
        sendJson(res, { ok: false, error: (e as Error).message }, 500);
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/security/unlimited') {
      sendJson(res, { unlimited: this.ctx.getUnlimitedMode?.() ?? false });
      return;
    }

    if (method === 'POST' && pathname === '/api/security/unlimited') {
      const body = await readBody(req);
      const { enabled } = JSON.parse(body);
      this.ctx.setUnlimitedMode?.(!!enabled);
      sendJson(res, { ok: true, unlimited: !!enabled });
      return;
    }

    if (method === 'GET' && pathname === '/api/security/permissions') {
      sendJson(res, this.ctx.getPermissions?.() ?? []);
      return;
    }

    const permMatch = pathname.match(/^\/api\/security\/permissions\/(.+)$/);
    if (method === 'DELETE' && permMatch) {
      const ok = this.ctx.revokePermission?.(decodeURIComponent(permMatch[1])) ?? false;
      sendJson(res, { ok });
      return;
    }

    if (method === 'GET' && pathname === '/api/security/sandbox-status') {
      const status = this.ctx.sandboxStatus ?? { available: false, activeBackend: null, firejailAvailable: false, dockerAvailable: false, seatbeltAvailable: false };
      const settings = this.ctx.config.loadSettings();
      sendJson(res, {
        ...status,
        enabled: !!settings.shell_sandbox?.containerEnabled,
        configuredBackend: settings.shell_sandbox?.backend ?? 'auto',
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/subagents') {
      sendJson(res, this.ctx.listSubAgents?.() ?? []);
      return;
    }

    if (method === 'POST' && pathname === '/api/subagents') {
      const body = await readBody(req);
      const data = JSON.parse(body);
      if (data.task) {
        try {
          const agent = await this.ctx.createSubAgent?.(data.task, data.workspaceId);
          sendJson(res, agent ?? { ok: true });
        } catch (e) {
          logger.error(SCOPE, `Sub-agent creation failed: ${(e as Error).message}`);
          sendJson(res, { error: 'Failed to create sub-agent' }, 500);
        }
      } else {
        try {
          const agent = this.ctx.createSubAgentConfig?.(data);
          sendJson(res, agent ?? { ok: true });
        } catch (e) {
          logger.error(SCOPE, `Sub-agent config failed: ${(e as Error).message}`);
          sendJson(res, { error: 'Failed to create sub-agent configuration' }, 500);
        }
      }
      return;
    }

    const subAgentMatch = pathname.match(/^\/api\/subagents\/([^/]+)$/);
    if (subAgentMatch) {
      const agentId = decodeURIComponent(subAgentMatch[1]);

      if (method === 'PUT') {
        const body = await readBody(req);
        const data = JSON.parse(body);
        const ok = this.ctx.updateSubAgent?.(agentId, data) ?? false;
        sendJson(res, { ok });
        return;
      }
      if (method === 'DELETE') {
        const searchParams = new URLSearchParams(qIdx !== -1 ? url.slice(qIdx + 1) : '');
        const workspaceId = this.resolveWorkspaceId(searchParams.get('workspace'));
        const ok = this.ctx.removeSubAgent?.(agentId, workspaceId!) ?? false;
        sendJson(res, { ok });
        return;
      }
    }

    const subAgentRunMatch = pathname.match(/^\/api\/subagents\/([^/]+)\/run$/);
    if (method === 'POST' && subAgentRunMatch) {
      const agentId = decodeURIComponent(subAgentRunMatch[1]);
      const body = await readBody(req);
      const data = JSON.parse(body);
      const { task, workspaceId: runWsId } = data;
      if (!task) { sendJson(res, { error: 'task required' }, 400); return; }
      try {
        const allAgents = this.ctx.listSubAgents?.() ?? [];
        const agentData = allAgents.find((a: any) => a.id === agentId);
        const wsId = runWsId || (agentData as any)?.workspaceId || undefined;
        const result = await this.ctx.runSubAgent?.(agentId, task, wsId);
        sendJson(res, { ok: true, result: result ?? '' });
      } catch (e) {
        logger.error(SCOPE, `Sub-agent run failed: ${(e as Error).message}`);
        sendJson(res, { error: 'Failed to run sub-agent' }, 500);
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/workspaces') {
      const workspaces = this.ctx.listWorkspaces?.() ?? [];
      sendJson(res, workspaces);
      return;
    }

    if (method === 'GET' && pathname === '/api/memory') {
      if (!this.ctx.memoryManager) { sendJson(res, []); return; }
      const searchParams = new URLSearchParams(qIdx !== -1 ? url.slice(qIdx + 1) : '');
      const workspaceId = this.resolveWorkspaceId(searchParams.get('workspace'));
      sendJson(res, this.ctx.memoryManager.list(workspaceId));
      return;
    }

    if (method === 'GET' && pathname === '/api/memory/raw') {
      if (!this.ctx.memoryManager) { sendJson(res, { content: '' }); return; }
      const searchParams = new URLSearchParams(qIdx !== -1 ? url.slice(qIdx + 1) : '');
      const workspaceId = this.resolveWorkspaceId(searchParams.get('workspace'));
      sendJson(res, { content: this.ctx.memoryManager.load(workspaceId) });
      return;
    }

    if (method === 'POST' && pathname === '/api/memory') {
      if (!this.ctx.memoryManager) { sendJson(res, { error: 'Memory manager not available' }, 500); return; }
      const body = await readBody(req);
      const { content, workspace } = JSON.parse(body);
      if (!content) { sendJson(res, { error: 'content required' }, 400); return; }
      const workspaceId = this.resolveWorkspaceId(workspace);
      const entry = this.ctx.memoryManager.append(workspaceId, content);
      sendJson(res, entry);
      return;
    }

    if (method === 'PUT' && pathname === '/api/memory/raw') {
      if (!this.ctx.memoryManager) { sendJson(res, { error: 'Memory manager not available' }, 500); return; }
      const body = await readBody(req);
      const { content, workspace } = JSON.parse(body);
      const workspaceId = this.resolveWorkspaceId(workspace);
      this.ctx.memoryManager.save(workspaceId, content || '');
      sendJson(res, { ok: true });
      return;
    }

    const memoryEntryMatch = pathname.match(/^\/api\/memory\/([^/]+)$/);
    if (method === 'PUT' && memoryEntryMatch) {
      if (!this.ctx.memoryManager) { sendJson(res, { error: 'Memory manager not available' }, 500); return; }
      const body = await readBody(req);
      const { content, workspace } = JSON.parse(body);
      if (!content) { sendJson(res, { error: 'content required' }, 400); return; }
      const workspaceId = this.resolveWorkspaceId(workspace);
      const ok = this.ctx.memoryManager.update(workspaceId, memoryEntryMatch[1], content);
      sendJson(res, { ok });
      return;
    }

    const memoryDeleteMatch = pathname.match(/^\/api\/memory\/([^/]+)$/);
    if (method === 'DELETE' && memoryDeleteMatch) {
      if (!this.ctx.memoryManager) { sendJson(res, { error: 'Memory manager not available' }, 500); return; }
      const searchParams = new URLSearchParams(qIdx !== -1 ? url.slice(qIdx + 1) : '');
      const workspaceId = this.resolveWorkspaceId(searchParams.get('workspace'));
      const ok = this.ctx.memoryManager.remove(workspaceId, memoryDeleteMatch[1]);
      sendJson(res, { ok });
      return;
    }

    const mcpReconnectMatch = pathname.match(/^\/api\/mcp\/([^/]+)\/reconnect$/);
    if (method === 'POST' && mcpReconnectMatch) {
      const server = this.ctx.mcpManager.getServer(mcpReconnectMatch[1]);
      if (!server) { sendJson(res, { error: 'Not found' }, 404); return; }
      try {
        const client = await this.ctx.mcpManager.connectServer(server);
        sendJson(res, { ok: true, tools: client.tools.map(t => t.name) });
      } catch (err) {
        logger.error(SCOPE, `MCP reconnect failed: ${(err as Error).message}`);
        sendJson(res, { ok: false, error: 'Failed to reconnect MCP server' }, 500);
      }
      return;
    }

    const mcpMatch = pathname.match(/^\/api\/mcp\/([^/]+)$/);
    if (mcpMatch) {
      const serverId = mcpMatch[1];
      if (method === 'PUT') {
        const body = await readBody(req);
        const updates = JSON.parse(body);
        const result = this.ctx.mcpManager.update(serverId, updates);
        if (!result) { sendJson(res, { error: 'Not found' }, 404); return; }
        sendJson(res, result);
        return;
      }
      if (method === 'DELETE') {
        const removed = this.ctx.mcpManager.remove(serverId);
        sendJson(res, { ok: removed });
        return;
      }
      if (method === 'GET') {
        const server = this.ctx.mcpManager.getServer(serverId);
        if (!server) { sendJson(res, { error: 'Not found' }, 404); return; }
        sendJson(res, server);
        return;
      }
    }

    if (method === 'GET' && pathname === '/api/history') {
      sendJson(res, this.ctx.getHistoryKeys());
      return;
    }

    const historyMatch = pathname.match(/^\/api\/history\/(.+)$/);
    if (method === 'GET' && historyMatch) {
      sendJson(res, this.ctx.getHistory(decodeURIComponent(historyMatch[1])));
      return;
    }

    if (method === 'DELETE' && pathname === '/api/history') {
      if (!this.ctx.clearAllHistory) {
        sendJson(res, { error: 'Not supported' }, 501);
        return;
      }
      this.ctx.clearAllHistory();
      sendJson(res, { ok: true, message: 'All session histories cleared' });
      return;
    }

    const historyDeleteMatch = pathname.match(/^\/api\/history\/(.+)$/);
    if (method === 'DELETE' && historyDeleteMatch) {
      if (!this.ctx.clearHistory) {
        sendJson(res, { error: 'Not supported' }, 501);
        return;
      }
      const key = decodeURIComponent(historyDeleteMatch[1]);
      this.ctx.clearHistory(key);
      sendJson(res, { ok: true, message: `History "${key}" cleared` });
      return;
    }

    if (method === 'GET' && pathname === '/api/tasks') {
      sendJson(res, this.ctx.listTasks?.() ?? []);
      return;
    }

    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const taskId = taskMatch[1];
      if (method === 'GET') {
        const task = this.ctx.getTask?.(taskId);
        if (!task) { sendJson(res, { error: 'Task not found' }, 404); return; }
        const logs = this.ctx.getTaskLogs?.(taskId, 20) ?? [];
        sendJson(res, { ...task, logs });
        return;
      }
      if (method === 'PUT') {
        const body = await readBody(req);
        const updates = JSON.parse(body);
        this.ctx.updateTask?.(taskId, updates);
        sendJson(res, { ok: true });
        return;
      }
      if (method === 'DELETE') {
        this.ctx.deleteTask?.(taskId);
        sendJson(res, { ok: true });
        return;
      }
    }

    if (method === 'POST' && pathname === '/api/tasks') {
      const body = await readBody(req);
      const { name, cronExpression, prompt } = JSON.parse(body);
      if (!name || !cronExpression || !prompt) {
        sendJson(res, { error: 'name, cronExpression, and prompt are required' }, 400);
        return;
      }
      const task = this.ctx.createTask?.({ name, cronExpression, prompt });
      sendJson(res, task ?? { error: 'Task creation not available' }, task ? 201 : 500);
      return;
    }

    if (method === 'POST' && pathname.match(/^\/api\/tasks\/([^/]+)\/run$/)) {
      const id = pathname.match(/^\/api\/tasks\/([^/]+)\/run$/)![1];
      try {
        await this.ctx.runTaskNow?.(id);
        sendJson(res, { ok: true });
      } catch (err) {
        logger.error(SCOPE, `Task run failed: ${(err as Error).message}`);
        sendJson(res, { error: 'Failed to run task' }, 500);
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/skills') {
      const skills = this.ctx.skillRegistry?.list() ?? [];
      sendJson(res, skills.map(s => ({
        name: s.name,
        description: s.description,
        ...(s.version && { version: s.version }),
        ...(s.author && { author: s.author }),
        ...(s.emoji && { emoji: s.emoji }),
        ...(s.homepage && { homepage: s.homepage }),
        ...(s.requires && { requires: s.requires }),
        hasInstructions: !!s.instructions,
      })));
      return;
    }

    if (method === 'POST' && pathname === '/api/skills/upload') {
      try {
        const skillsDir = this.ctx.config.skillsPath;
        const rawBody = await readBodyRaw(req);

        const boundary = (req.headers['content-type'] ?? '').match(/boundary=(.+)/)?.[1];
        if (!boundary) {
          sendJson(res, { error: 'Multipart boundary not found' }, 400);
          return;
        }

        const parts = parseMultipart(rawBody, boundary);
        const namePart = parts.find(p => p.name === 'name');
        const filePart = parts.find(p => p.name === 'file');

        if (!namePart?.value || !filePart?.data) {
          sendJson(res, { error: 'Both "name" and "file" fields are required' }, 400);
          return;
        }

        const skillName = namePart.value.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
        if (!skillName) {
          sendJson(res, { error: 'Invalid skill name' }, 400);
          return;
        }

        const skillDir = path.resolve(skillsDir, skillName);
        if (!isPathWithin(skillDir, skillsDir)) {
          sendJson(res, { error: 'Invalid skill name' }, 400);
          return;
        }
        fs.mkdirSync(skillDir, { recursive: true });

        const zipPath = path.join(skillDir, '__upload.zip');
        fs.writeFileSync(zipPath, filePart.data);

        try {
          execFileSync('unzip', ['-o', zipPath, '-d', skillDir], { timeout: 30_000 });
        } catch {
          fs.rmSync(skillDir, { recursive: true, force: true });
          sendJson(res, { error: 'Failed to extract zip. Make sure the file is a valid zip archive.' }, 400);
          return;
        }

        try { fs.unlinkSync(zipPath); } catch { /* ignore */ }

        const verifyPathSafety = (dir: string): boolean => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.resolve(dir, entry.name);
            if (!isPathWithin(fullPath, skillDir)) return false;
            if (entry.isDirectory() && !verifyPathSafety(fullPath)) return false;
          }
          return true;
        };
        if (!verifyPathSafety(skillDir)) {
          fs.rmSync(skillDir, { recursive: true, force: true });
          sendJson(res, { error: 'Zip contains files with unsafe paths (possible zip-slip attack)' }, 400);
          return;
        }

        const skillMdPath = path.join(skillDir, 'SKILL.md');
        if (!fs.existsSync(skillMdPath)) {
          const entries = fs.readdirSync(skillDir);
          const subDir = entries.find(e => fs.existsSync(path.join(skillDir, e, 'SKILL.md')));
          if (subDir) {
            const innerDir = path.join(skillDir, subDir);
            for (const f of fs.readdirSync(innerDir)) {
              fs.renameSync(path.join(innerDir, f), path.join(skillDir, f));
            }
            fs.rmSync(innerDir, { recursive: true, force: true });
          }
        }

        if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
          fs.rmSync(skillDir, { recursive: true, force: true });
          sendJson(res, { error: 'Zip must contain a SKILL.md file (at root or in a single subdirectory)' }, 400);
          return;
        }

        this.ctx.skillRegistry?.loadFromDirectory(skillsDir);
        const loaded = this.ctx.skillRegistry?.get(skillName);

        sendJson(res, {
          ok: true,
          name: skillName,
          loaded: !!loaded,
          description: loaded?.description ?? null,
        }, 201);
      } catch (err) {
        logger.error(SCOPE, `Skill upload failed: ${(err as Error).message}`);
        sendJson(res, { error: 'Failed to install skill' }, 500);
      }
      return;
    }

    const skillDeleteMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
    if (method === 'DELETE' && skillDeleteMatch) {
      const skillName = decodeURIComponent(skillDeleteMatch[1]).replace(/[^a-zA-Z0-9_-]/g, '_');
      const skillDir = path.resolve(this.ctx.config.skillsPath, skillName);
      if (!isPathWithin(skillDir, this.ctx.config.skillsPath)) {
        sendJson(res, { error: 'Invalid skill name' }, 400);
        return;
      }
      if (!fs.existsSync(skillDir)) {
        sendJson(res, { error: 'Skill not found' }, 404);
        return;
      }
      fs.rmSync(skillDir, { recursive: true, force: true });
      this.ctx.skillRegistry?.loadFromDirectory(this.ctx.config.skillsPath);
      sendJson(res, { ok: true });
      return;
    }

    if (method === 'POST' && pathname === '/stripe/webhook') {
      if (!this.ctx.stripeManager) {
        sendJson(res, { error: 'Stripe not configured' }, 400);
        return;
      }
      try {
        const rawBody = await readBodyRaw(req);
        const signature = req.headers['stripe-signature'] as string;
        await this.ctx.stripeManager.handleWebhook(rawBody, signature);
        sendJson(res, { received: true });
      } catch (err) {
        logger.error(SCOPE, `Stripe webhook error: ${(err as Error).message}`);
        sendJson(res, { error: 'Webhook error' }, 400);
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/users') {
      if (!this.ctx.userManager) { sendJson(res, []); return; }
      const searchParams = new URLSearchParams(qIdx !== -1 ? url.slice(qIdx + 1) : '');
      const query = searchParams.get('q')?.toLowerCase();
      let users = this.ctx.userManager.listAll();
      if (query) {
        users = users.filter(u =>
          (u.email && u.email.toLowerCase().includes(query)) ||
          (u.displayName && u.displayName.toLowerCase().includes(query)) ||
          u.id.toLowerCase().includes(query),
        );
        if (!users.length && this.ctx.identityManager) {
          const idents = this.ctx.identityManager.listByChannel('telegram');
          const matchedUserIds = new Set<string>();
          for (const i of idents) {
            const chatId = (i.channelUserId || '').replace('telegram:', '');
            if (chatId.includes(query) && i.userId) matchedUserIds.add(i.userId);
          }
          if (matchedUserIds.size > 0) {
            users = this.ctx.userManager.listAll().filter(u => matchedUserIds.has(u.id));
          }
        }
      }
      const result: Array<Record<string, unknown>> = users.map(u => ({
        id: u.id, email: u.email, displayName: u.displayName,
        role: u.role, status: u.status,
        subscriptionStatus: u.subscriptionStatus, planId: u.planId,
        createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
      }));

      if (this.ctx.multiUserEnabled && this.ctx.identityManager) {
        const linkedUserIds = new Set(result.map(r => String(r.id)));
        const allIdentities = this.ctx.identityManager.listAll();
        const orphanIdentities = allIdentities.filter(i =>
          !i.userId
          && i.channel !== 'system'
          && i.channel !== 'internal'
          && !i.channelUserId.startsWith('system:')
          && !i.channelUserId.startsWith('scheduler:')
          && !i.channelUserId.startsWith('internal:'),
        );
        const seenOrphans = new Set<string>();
        const um = this.ctx.userManager;
        const im = this.ctx.identityManager;
        const wm = this.ctx.workspaceManager;
        for (const ident of orphanIdentities) {
          const wsId = ident.workspaceId;
          if (!wsId) continue;
          const ws = wm?.get(wsId);
          if (ws?.ownerUserId && linkedUserIds.has(ws.ownerUserId)) continue;
          const key = wsId;
          if (seenOrphans.has(key)) continue;
          seenOrphans.add(key);

          const chatId = ident.channelUserId.replace(`${ident.channel}:`, '');
          const displayName = `${ident.channel}:${chatId}`;
          const matchesQuery = !query || chatId.includes(query)
            || ident.channel.includes(query) || (ws?.name || '').toLowerCase().includes(query);
          if (!matchesQuery) continue;

          if (um) {
            const newUser = um.createAnonymousUser(displayName);
            im.linkToUser(ident.id, newUser.id, wsId);
            if (wm) wm.setOwner(wsId, newUser.id);
            linkedUserIds.add(newUser.id);

            result.push({
              id: newUser.id,
              email: null,
              displayName,
              role: 'user' as const,
              status: 'active' as const,
              subscriptionStatus: 'none' as const,
              planId: null,
              createdAt: newUser.createdAt,
              lastLoginAt: null,
              telegramChatId: ident.channel === 'telegram' ? chatId : null,
              identityId: ident.id,
              workspaceId: wsId,
            });
          }
        }
      }

      sendJson(res, result);
      return;
    }

    const userDetailMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (method === 'GET' && userDetailMatch) {
      const userId = decodeURIComponent(userDetailMatch[1]);
      if (!this.ctx.userManager) { sendJson(res, { error: 'Not available' }, 500); return; }

      if (userId.startsWith('identity:')) {
        const identId = userId.slice('identity:'.length);
        const ident = this.ctx.identityManager?.listAll().find(i => i.id === identId);
        if (!ident) { sendJson(res, { error: 'Identity not found' }, 404); return; }
        const ws = ident.workspaceId ? this.ctx.workspaceManager?.get(ident.workspaceId) ?? null : null;
        const chatId = ident.channelUserId.replace(`${ident.channel}:`, '');
        sendJson(res, {
          id: userId,
          email: null,
          displayName: `${ident.channel}:${chatId}`,
          role: 'user',
          status: 'unregistered',
          subscriptionStatus: 'none',
          planId: null,
          createdAt: ident.linkedAt,
          lastLoginAt: null,
          workspace: ws ? { id: ws.id, name: ws.name } : null,
          telegramChatId: ident.channel === 'telegram' ? chatId : null,
          identities: [{ id: ident.id, channel: ident.channel, channelUserId: ident.channelUserId }],
          usage: [],
          usagePeriodStart: '',
          usagePeriodEnd: '',
        });
        return;
      }

      const user = this.ctx.userManager.getById(userId);
      if (!user) { sendJson(res, { error: 'User not found' }, 404); return; }

      const identities = this.ctx.identityManager?.listAll().filter(i => i.userId === userId) ?? [];
      let workspace = this.ctx.workspaceManager?.getByOwner(userId) ?? null;
      if (!workspace) {
        const wsId = identities.find(i => i.workspaceId)?.workspaceId;
        if (wsId) workspace = this.ctx.workspaceManager?.get(wsId) ?? null;
      }

      const telegramIdent = identities.find(i => i.channel === 'telegram');
      const telegramChatId = telegramIdent?.channelUserId?.replace('telegram:', '') ?? null;

      let dailyUsage: Record<string, unknown> = { totalCalls: 0, limit: 1000, models: [] };
      if (this.ctx.dbManager?.db) {
        const { UsageTracker: UT } = await import('../billing/usage.js');
        const globalSettings = this.ctx.config.loadSettings();
        const tracker = new UT(this.ctx.dbManager.db, globalSettings.billing);
        dailyUsage = tracker.getDailyUsage(userId);
      }

      sendJson(res, {
        id: user.id, email: user.email, displayName: user.displayName,
        role: user.role, status: user.status,
        subscriptionStatus: user.subscriptionStatus, planId: user.planId,
        stripeCustomerId: user.stripeCustomerId, stripeSubscriptionId: user.stripeSubscriptionId,
        subscriptionStartDate: user.subscriptionStartDate,
        createdAt: user.createdAt, lastLoginAt: user.lastLoginAt,
        workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
        telegramChatId,
        identities: identities.map(i => ({ id: i.id, channel: i.channel, channelUserId: i.channelUserId })),
        usage: dailyUsage,
      });
      return;
    }

    const userRoleMatch = pathname.match(/^\/api\/users\/([^/]+)\/role$/);
    if (method === 'PATCH' && userRoleMatch) {
      const userId = decodeURIComponent(userRoleMatch[1]);
      if (!this.ctx.userManager) { sendJson(res, { error: 'Not available' }, 500); return; }
      const user = this.ctx.userManager.getById(userId);
      if (!user) { sendJson(res, { error: 'User not found' }, 404); return; }
      const body = JSON.parse(await readBody(req));
      const role = body.role;
      if (role !== 'admin' && role !== 'user') {
        sendJson(res, { error: 'Invalid role. Must be "admin" or "user".' }, 400);
        return;
      }
      this.ctx.userManager.setRole(userId, role);
      sendJson(res, { ok: true, role });
      return;
    }

    const userSuspendMatch = pathname.match(/^\/api\/users\/([^/]+)\/suspend$/);
    if (method === 'POST' && userSuspendMatch) {
      const userId = decodeURIComponent(userSuspendMatch[1]);
      if (!this.ctx.userManager) { sendJson(res, { error: 'Not available' }, 500); return; }
      const user = this.ctx.userManager.getById(userId);
      if (!user) { sendJson(res, { error: 'User not found' }, 404); return; }
      this.ctx.userManager.suspend(userId);
      sendJson(res, { ok: true, status: 'suspended' });
      return;
    }

    const userActivateMatch = pathname.match(/^\/api\/users\/([^/]+)\/activate$/);
    if (method === 'POST' && userActivateMatch) {
      const userId = decodeURIComponent(userActivateMatch[1]);
      if (!this.ctx.userManager) { sendJson(res, { error: 'Not available' }, 500); return; }
      const user = this.ctx.userManager.getById(userId);
      if (!user) { sendJson(res, { error: 'User not found' }, 404); return; }
      this.ctx.userManager.activate(userId);
      sendJson(res, { ok: true, status: 'active' });
      return;
    }

    const userDeleteMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (method === 'DELETE' && userDeleteMatch) {
      const userId = decodeURIComponent(userDeleteMatch[1]);
      if (!this.ctx.userManager) { sendJson(res, { error: 'Not available' }, 500); return; }
      const user = this.ctx.userManager.getById(userId);
      if (!user) { sendJson(res, { error: 'User not found' }, 404); return; }
      const deleted = this.ctx.userManager.deleteUser(userId);
      if (!deleted) { sendJson(res, { error: 'Failed to delete user' }, 500); return; }
      sendJson(res, { ok: true });
      return;
    }

    const userSessionsMatch = pathname.match(/^\/api\/users\/([^/]+)\/sessions$/);
    if (method === 'GET' && userSessionsMatch) {
      const userId = decodeURIComponent(userSessionsMatch[1]);
      const searchParams = new URLSearchParams(qIdx !== -1 ? url.slice(qIdx + 1) : '');
      const limit = parseInt(searchParams.get('limit') || '50', 10);
      const offset = parseInt(searchParams.get('offset') || '0', 10);

      let wsIds: Set<string>;
      let identityIds: Set<string>;

      if (userId.startsWith('identity:')) {
        const identId = userId.slice('identity:'.length);
        const ident = this.ctx.identityManager?.listAll().find(i => i.id === identId);
        if (!ident) { sendJson(res, []); return; }
        wsIds = new Set(ident.workspaceId ? [ident.workspaceId] : []);
        identityIds = new Set([ident.channelUserId]);
      } else {
        wsIds = this.getAllWorkspaceIdsForUser(userId);
        identityIds = this.getIdentityIdsForUser(userId);
      }

      const userTaskIds = new Set<string>();
      const allTasks = this.ctx.listTasks?.() ?? [];
      for (const t of allTasks) {
        if (wsIds.has((t as any).workspaceId)) {
          userTaskIds.add(`scheduler:${(t as any).id}`);
        }
      }

      const heartbeatIds = new Set<string>();
      for (const wid of wsIds) heartbeatIds.add(`system:heartbeat:${wid}`);

      const allSessions = this.ctx.auditLog.getSessions(1000, 0);
      const filtered = allSessions.filter((s: Record<string, unknown>) => {
        const sid = String(s.identityId || '');
        if (heartbeatIds.has(sid)) return true;
        if (identityIds.has(sid)) return true;
        if (userTaskIds.has(sid)) return true;
        const sWsId = String(s.workspaceId || '');
        if (String(s.channel || '') === 'subagent' && sWsId && wsIds.has(sWsId)) return true;
        if (String(s.channel || '') === 'internal' && sWsId && wsIds.has(sWsId) && !sid.startsWith('system:heartbeat')) return true;
        if (sWsId && wsIds.has(sWsId) && !this.ctx.multiUserEnabled) return true;
        return false;
      });
      sendJson(res, filtered.slice(offset, offset + limit));
      return;
    }

    const userMemoryMatch = pathname.match(/^\/api\/users\/([^/]+)\/memory$/);
    if (method === 'GET' && userMemoryMatch) {
      const userId = decodeURIComponent(userMemoryMatch[1]);
      const wsId = this.resolveWorkspaceForAdminUser(userId);
      if (!wsId || !this.ctx.memoryManager) { sendJson(res, []); return; }
      sendJson(res, this.ctx.memoryManager.list(wsId));
      return;
    }

    const userKyuMatch = pathname.match(/^\/api\/users\/([^/]+)\/kyu$/);
    if (userKyuMatch) {
      const userId = decodeURIComponent(userKyuMatch[1]);
      const wsId = this.resolveWorkspaceForAdminUser(userId);
      if (!wsId) { sendJson(res, { content: '' }); return; }
      if (method === 'GET') {
        sendJson(res, { content: this.ctx.config.loadKyuMd(wsId) });
        return;
      }
      if (method === 'PUT') {
        const body = await readBody(req);
        const { content } = JSON.parse(body);
        this.ctx.config.saveKyuMd(wsId, content || '');
        sendJson(res, { ok: true });
        return;
      }
    }

    const userTasksMatch = pathname.match(/^\/api\/users\/([^/]+)\/tasks$/);
    if (method === 'GET' && userTasksMatch) {
      const userId = decodeURIComponent(userTasksMatch[1]);
      const wsIds = this.resolveAllWorkspacesForAdminUser(userId);
      if (wsIds.size === 0) { sendJson(res, []); return; }
      const allTasks = this.ctx.listTasks?.() ?? [];
      sendJson(res, allTasks.filter((t: any) => wsIds.has(t.workspaceId)));
      return;
    }

    const userSubagentsMatch = pathname.match(/^\/api\/users\/([^/]+)\/subagents$/);
    if (method === 'GET' && userSubagentsMatch) {
      const userId = decodeURIComponent(userSubagentsMatch[1]);
      const wsIds = this.resolveAllWorkspacesForAdminUser(userId);
      if (wsIds.size === 0) { sendJson(res, []); return; }
      const allAgents = this.ctx.listSubAgents?.() ?? [];
      sendJson(res, allAgents.filter((a: any) => wsIds.has(a.workspaceId)));
      return;
    }

    const userDelegationMatch = pathname.match(/^\/api\/users\/([^/]+)\/delegation$/);
    if (method === 'GET' && userDelegationMatch) {
      const userId = decodeURIComponent(userDelegationMatch[1]);
      const wsIds = this.resolveAllWorkspacesForAdminUser(userId);
      if (wsIds.size === 0) { sendJson(res, { delegations: [], indexing: [] }); return; }
      const delegations = this.ctx.delegationManager
        ? [...wsIds].flatMap(wsId => this.ctx.delegationManager!.listForWorkspace(wsId).map(c => ({ ...c, credentials: { provider: c.provider, hasCredentials: true } })))
        : [];
      const indexing = this.ctx.mailIndexer
        ? [...wsIds].flatMap(wsId => this.ctx.mailIndexer!.getProgress(wsId))
        : [];
      sendJson(res, { delegations, indexing });
      return;
    }

    this.serveStaticWithAuth(req, res, '/admin');
  }
}

interface MultipartPart {
  name: string;
  filename?: string;
  value?: string;
  data?: Buffer;
}

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const sep = Buffer.from(`--${boundary}`);

  let start = 0;
  while (true) {
    const idx = body.indexOf(sep, start);
    if (idx === -1) break;

    if (start > 0) {
      const partBuf = body.subarray(start, idx);
      const headerEnd = partBuf.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const headers = partBuf.subarray(0, headerEnd).toString();
        const nameMatch = headers.match(/name="([^"]+)"/);
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        if (nameMatch) {
          let data = partBuf.subarray(headerEnd + 4);
          if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
            data = data.subarray(0, data.length - 2);
          }
          if (filenameMatch) {
            parts.push({ name: nameMatch[1], filename: filenameMatch[1], data });
          } else {
            parts.push({ name: nameMatch[1], value: data.toString() });
          }
        }
      }
    }

    start = idx + sep.length;
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    if (body[start] === 0x0d) start += 2;
  }

  return parts;
}
