import type BetterSqlite3 from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger.js';

const SCOPE = 'tool-approval';
const APPROVAL_TIMEOUT_MS = 120_000;
const INTERNAL_APPROVAL_TIMEOUT_MS = 300_000;

export type ApprovalDecision = 'allow_once' | 'allow_always' | 'deny_once' | 'deny_always';

export interface ApprovalRequest {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  channel: string;
  identityId: string;
  workspaceId: string;
  timestamp: number;
}

interface PendingApproval extends ApprovalRequest {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type ApprovalNotifier = (request: ApprovalRequest) => Promise<void>;

const SENSITIVE_TOOLS = new Set([
  'shell_exec',
  'mcp_install',
  'mcp_remove',
  'settings_update',
  'agent_prompt_write',
]);


const DANGEROUS_SHELL_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*\s+)\//, // rm -rf / variants
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /\b(shutdown|reboot|poweroff|halt|init\s+0)\b/,
  />\s*\/dev\/sd[a-z]/,
  /\bcurl\b.*\|\s*(ba)?sh/,
  /\bwget\b.*\|\s*(ba)?sh/,
  /\bchmod\s+777\s+\//,
  /\bchown\s+.*\s+\//,
  /:(){ :|:& };:/,  // fork bomb
  /\beval\b.*\$\(/,
];

export class ToolApprovalManager {
  private db: BetterSqlite3.Database;
  private pending: Map<string, PendingApproval> = new Map();
  private notifier: ApprovalNotifier | null = null;
  private _unlimitedMode = false;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
    this.initTable();
  }

  get unlimitedMode(): boolean {
    return this._unlimitedMode;
  }

  setUnlimitedMode(enabled: boolean): void {
    this._unlimitedMode = enabled;
    if (enabled) {
      logger.warn(SCOPE, 'UNLIMITED MODE ACTIVATED — all tool approvals bypassed. This is a security risk.');
    } else {
      logger.info(SCOPE, 'Unlimited mode deactivated — tool approvals re-enabled.');
    }
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        decision TEXT NOT NULL,
        args_summary TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(workspace_id, tool_name, decision)
      )
    `);
  }

  setNotifier(notifier: ApprovalNotifier): void {
    this.notifier = notifier;
  }

  isSensitive(toolName: string): boolean {
    return SENSITIVE_TOOLS.has(toolName);
  }

  isBlockedCommand(command: string): { blocked: boolean; reason?: string } {
    for (const pattern of DANGEROUS_SHELL_PATTERNS) {
      if (pattern.test(command)) {
        return { blocked: true, reason: `Blocked dangerous pattern: ${pattern.source}` };
      }
    }
    return { blocked: false };
  }

  hasStandingApproval(toolName: string, workspaceId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT decision FROM tool_approvals
         WHERE workspace_id = ? AND tool_name = ? AND decision = 'allow_always'
         LIMIT 1`,
      )
      .get(workspaceId, toolName) as { decision: string } | undefined;

    return !!row;
  }

  isAlwaysDenied(toolName: string, workspaceId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT decision FROM tool_approvals
         WHERE workspace_id = ? AND tool_name = ? AND decision = 'deny_always'
         LIMIT 1`,
      )
      .get(workspaceId, toolName) as { decision: string } | undefined;

    return !!row;
  }

  async requestApproval(
    toolName: string,
    args: Record<string, unknown>,
    channel: string,
    identityId: string,
    workspaceId: string,
  ): Promise<ApprovalDecision> {
    if (this._unlimitedMode) {
      logger.debug(SCOPE, `Unlimited mode: auto-approving "${toolName}"`);
      return 'allow_once';
    }

    if (this.isAlwaysDenied(toolName, workspaceId)) {
      logger.info(SCOPE, `Tool "${toolName}" permanently denied for workspace ${workspaceId}`);
      return 'deny_always';
    }

    const isInternal = channel === 'internal';

    if (this.hasStandingApproval(toolName, workspaceId)) {
      logger.debug(SCOPE, `Standing approval found for "${toolName}" in workspace ${workspaceId} (channel=${channel})`);
      return 'allow_always';
    }

    if (isInternal) {
      logger.warn(SCOPE, `Auto-approving "${toolName}" for internal event (channel=${channel}, identity=${identityId}, workspace=${workspaceId}) — scheduler/sub-agent inherits workspace permissions`);
      return 'allow_once';
    }

    if (!this.notifier) {
      logger.warn(SCOPE, `No notifier set — cannot request approval for "${toolName}" (channel=${channel}, identity=${identityId}). Tool denied.`);
      return 'deny_once';
    }

    const timeout = isInternal ? INTERNAL_APPROVAL_TIMEOUT_MS : APPROVAL_TIMEOUT_MS;
    const timeoutLabel = isInternal ? '5min' : '2min';

    logger.info(SCOPE, `Requesting approval for "${toolName}" (channel=${channel}, identity=${identityId}, timeout=${timeoutLabel})`);

    const id = uuidv4();
    const request: ApprovalRequest = {
      id,
      toolName,
      args,
      channel,
      identityId,
      workspaceId,
      timestamp: Date.now(),
    };

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        logger.warn(SCOPE, `Approval timed out for "${toolName}" after ${timeoutLabel} (${id}) — denied`);
        resolve('deny_once');
      }, timeout);

      this.pending.set(id, { ...request, resolve, timer });

      this.notifier!(request).catch((err) => {
        logger.error(SCOPE, `Failed to send approval request for "${toolName}": ${(err as Error).message}`);
        clearTimeout(timer);
        this.pending.delete(id);
        resolve('deny_once');
      });
    });
  }

  resolveApproval(id: string, decision: ApprovalDecision): boolean {
    const pending = this.pending.get(id);
    if (!pending) {
      logger.warn(SCOPE, `No pending approval with id ${id}`);
      return false;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (decision === 'allow_always' || decision === 'deny_always') {
      this.storeDecision(pending.workspaceId, pending.toolName, decision);
    }

    logger.info(SCOPE, `Approval "${decision}" for "${pending.toolName}" (${id})`);
    pending.resolve(decision);
    return true;
  }

  private storeDecision(workspaceId: string, toolName: string, decision: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tool_approvals (workspace_id, tool_name, decision, created_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .run(workspaceId, toolName, decision);
  }

  revokeApproval(toolName: string, workspaceId: string): void {
    this.db
      .prepare(`DELETE FROM tool_approvals WHERE workspace_id = ? AND tool_name = ?`)
      .run(workspaceId, toolName);
    logger.info(SCOPE, `Revoked all approvals for "${toolName}" in workspace ${workspaceId}`);
  }

  listApprovals(workspaceId: string): Array<{ toolName: string; decision: string; createdAt: string }> {
    const rows = this.db
      .prepare(
        `SELECT tool_name, decision, created_at FROM tool_approvals WHERE workspace_id = ? ORDER BY created_at DESC`,
      )
      .all(workspaceId) as Array<{ tool_name: string; decision: string; created_at: string }>;

    return rows.map((r) => ({
      toolName: r.tool_name,
      decision: r.decision,
      createdAt: r.created_at,
    }));
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  static getSensitiveTools(): string[] {
    return [...SENSITIVE_TOOLS];
  }
}
