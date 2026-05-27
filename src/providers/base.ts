import type { ChatRequest, ChatResponse, ToolDefinition } from '../core/types.js';
import { logger } from '../core/logger.js';

export class SubscriptionRequiredError extends Error {
  constructor(public workspaceId: string) {
    super('Active subscription required to use the AI agent.');
    this.name = 'SubscriptionRequiredError';
  }
}

export class DailyLimitError extends Error {
  constructor(public workspaceId: string, reason: string) {
    super(reason);
    this.name = 'DailyLimitError';
  }
}

const MAX_RETRIES = 3;
const MAX_RETRIES_429 = 6;
const RETRY_DELAYS_MS = [2000, 5000, 10000];
const RATE_LIMIT_BASE_DELAY_MS = 5000;

const NON_RETRYABLE_PATTERNS = [
  'context window exceeds',
  'context_length_exceeded',
  'maximum context length',
  'too many tokens',
  'tool call id is invalid',
  'invalid_request_error',
];

function getErrorStatus(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const anyErr = err as unknown as Record<string, unknown>;
  return anyErr.status as number | undefined;
}

function getRetryAfterMs(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const anyErr = err as unknown as Record<string, unknown>;
  const headers = anyErr.headers as Record<string, string> | undefined;
  const retryAfter = headers?.['retry-after']
    ?? (anyErr.error as Record<string, unknown> | undefined)?.retry_after as string | undefined;
  if (!retryAfter) return undefined;
  const secs = Number(retryAfter);
  if (!isNaN(secs) && secs > 0) return Math.min(secs * 1000, 120_000);
  return undefined;
}

function isRateLimitError(err: unknown): boolean {
  const status = getErrorStatus(err);
  if (status === 429 || status === 529) return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('quota exceeded')) return true;
  }
  return false;
}

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (isRateLimitError(err)) return true;
  const status = getErrorStatus(err);
  if (status && status >= 400 && status < 500) return false;
  const msg = err.message.toLowerCase();
  if (NON_RETRYABLE_PATTERNS.some(p => msg.includes(p))) return false;
  return true;
}

export function isContextWindowError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('context window exceeds') ||
    msg.includes('context_length_exceeded') ||
    msg.includes('maximum context length') ||
    msg.includes('too many tokens');
}

export abstract class LLMProvider {
  abstract readonly id: string;
  abstract readonly type: string;

  private static _subscriptionChecker: ((workspaceId: string) => boolean) | null = null;
  private static _dailyLimitChecker: ((workspaceId: string, model?: string) => { allowed: boolean; reason?: string }) | null = null;

  static setSubscriptionChecker(checker: ((workspaceId: string) => boolean) | null): void {
    LLMProvider._subscriptionChecker = checker;
  }

  static checkSubscription(workspaceId: string): boolean {
    if (!LLMProvider._subscriptionChecker) return true;
    return LLMProvider._subscriptionChecker(workspaceId);
  }

  static setDailyLimitChecker(checker: ((workspaceId: string, model?: string) => { allowed: boolean; reason?: string }) | null): void {
    LLMProvider._dailyLimitChecker = checker;
  }

  protected abstract chatImpl(request: ChatRequest): Promise<ChatResponse>;
  abstract listModels(): Promise<string[]>;
  abstract supportsToolCalling(): boolean;

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (request.workspaceId && LLMProvider._subscriptionChecker) {
      if (!LLMProvider._subscriptionChecker(request.workspaceId)) {
        throw new SubscriptionRequiredError(request.workspaceId);
      }
    }
    if (request.workspaceId && LLMProvider._dailyLimitChecker) {
      const check = LLMProvider._dailyLimitChecker(request.workspaceId, request.model);
      if (!check.allowed) {
        throw new DailyLimitError(request.workspaceId, check.reason || 'Daily limit reached.');
      }
    }

    let lastError: Error | undefined;
    const maxAttempts = MAX_RETRIES;

    for (let attempt = 0; attempt <= MAX_RETRIES_429; attempt++) {
      try {
        return await this.chatImpl(request);
      } catch (err) {
        lastError = err as Error;
        const rateLimited = isRateLimitError(err);
        const effectiveMax = rateLimited ? MAX_RETRIES_429 : maxAttempts;

        if (attempt < effectiveMax && (rateLimited || isRetryableError(err))) {
          let delay: number;
          if (rateLimited) {
            const retryAfter = getRetryAfterMs(err);
            delay = retryAfter ?? RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt);
            delay = Math.min(delay, 120_000);
            const jitter = Math.random() * 1000;
            delay += jitter;
          } else {
            delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
          }
          logger.warn(this.id, `Chat attempt ${attempt + 1} failed (${rateLimited ? '429 rate limited' : 'retryable'}): ${lastError.message}. Retrying in ${(delay / 1000).toFixed(1)}s...`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          throw lastError;
        }
      }
    }
    throw lastError;
  }

  protected normalizeTools(tools: ToolDefinition[]): unknown {
    return tools;
  }
}
