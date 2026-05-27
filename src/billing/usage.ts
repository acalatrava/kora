import type BetterSqlite3 from 'better-sqlite3';
import { logger } from '../core/logger.js';
import type { BillingSettings } from '../core/types.js';

const SCOPE = 'usage-tracker';

const DEFAULT_DAILY_LIMIT = 1000;

function todayBounds(): { dayStart: string; dayEnd: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { dayStart: start.toISOString(), dayEnd: end.toISOString() };
}

export class UsageTracker {
  private db: BetterSqlite3.Database;
  private billing: BillingSettings | undefined;

  constructor(db: BetterSqlite3.Database, billing?: BillingSettings) {
    this.db = db;
    this.billing = billing;
  }

  setBilling(billing: BillingSettings | undefined): void {
    this.billing = billing;
  }

  private get effectiveDailyLimit(): number {
    if (this.billing?.dailyLimit === -1) return Infinity;
    return this.billing?.dailyLimit ?? DEFAULT_DAILY_LIMIT;
  }

  canMakeCall(userId: string, model?: string): { allowed: boolean; reason?: string } {
    if (!this.billing?.enabled) return { allowed: true };

    const { dayStart, dayEnd } = todayBounds();

    const globalLimit = this.effectiveDailyLimit;
    // If globalLimit is set, use only the global limit
    if (globalLimit !== Infinity) {
      const row = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM usage_logs WHERE user_id = ? AND created_at >= ? AND created_at < ?`,
      ).get(userId, dayStart, dayEnd) as { cnt: number };
      if (row.cnt >= globalLimit) {
        return { allowed: false, reason: `Daily request limit reached (${globalLimit}). Try again tomorrow.` };
      }
      return { allowed: true };
    }

    if (model) {
      const modelConfig = this.billing.models?.[model];
      if (modelConfig?.included_calls && modelConfig.included_calls > 0) {
        const row = this.db.prepare(
          `SELECT COUNT(*) as cnt FROM usage_logs WHERE user_id = ? AND model = ? AND created_at >= ? AND created_at < ?`,
        ).get(userId, model, dayStart, dayEnd) as { cnt: number };
        if (row.cnt >= modelConfig.included_calls) {
          return { allowed: false, reason: `Daily limit for model ${model} reached (${modelConfig.included_calls}). Try again tomorrow.` };
        }
      }
    }

    return { allowed: true };
  }

  logUsage(
    userId: string, workspaceId: string,
    providerId: string, model: string,
    inputTokens: number, outputTokens: number,
  ): void {
    this.db.prepare(
      `INSERT INTO usage_logs (user_id, workspace_id, provider_id, model, input_tokens, output_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(userId, workspaceId, providerId, model, inputTokens, outputTokens, new Date().toISOString());

    logger.debug(SCOPE, `Logged usage: user=${userId} model=${model} in=${inputTokens} out=${outputTokens}`);
  }

  getDailyUsage(userId: string, workspaceId?: string): {
    periodStart: string;
    periodEnd: string;
    totalCalls: number;
    limit: number;
    models: Array<{ model: string; callCount: number; inputTokens: number; outputTokens: number; modelLimit?: number }>;
  } {
    const { dayStart, dayEnd } = todayBounds();
    const whereClause = workspaceId
      ? `(user_id = ? OR workspace_id = ?) AND created_at >= ? AND created_at < ?`
      : `user_id = ? AND created_at >= ? AND created_at < ?`;
    const params = workspaceId
      ? [userId, workspaceId, dayStart, dayEnd]
      : [userId, dayStart, dayEnd];

    const rows = this.db.prepare(
      `SELECT model, COUNT(*) as call_count, SUM(input_tokens) as input_tokens,
              SUM(output_tokens) as output_tokens
       FROM usage_logs WHERE ${whereClause}
       GROUP BY model`,
    ).all(...params) as Array<Record<string, unknown>>;

    let totalCalls = 0;
    const models = rows.map(r => {
      const cc = Number(r.call_count);
      totalCalls += cc;
      const modelName = String(r.model);
      const modelConfig = this.billing?.models?.[modelName];
      return {
        model: modelName,
        callCount: cc,
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        modelLimit: modelConfig?.included_calls,
      };
    });

    const limit = this.effectiveDailyLimit === Infinity ? -1 : this.effectiveDailyLimit;
    return { periodStart: dayStart, periodEnd: dayEnd, totalCalls, limit, models };
  }
}
