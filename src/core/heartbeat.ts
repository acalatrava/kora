import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import type { ConfigManager } from './config.js';

const SCOPE = 'heartbeat';

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMs: number;
}

const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  enabled: true,
  intervalMs: 5 * 60 * 1000,
};

export type HeartbeatHandler = (prompt: string) => Promise<string | null>;
export type ChannelActivityChecker = () => boolean;

export class Heartbeat {
  private config: HeartbeatConfig;
  private configManager: ConfigManager;
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private handler: HeartbeatHandler | null = null;
  private activityChecker: ChannelActivityChecker | null = null;
  private running = false;
  private lastRunAt: Date | null = null;
  private runCount = 0;
  private skippedCount = 0;

  constructor(configManager: ConfigManager, config?: Partial<HeartbeatConfig>) {
    this.configManager = configManager;
    this.config = { ...DEFAULT_HEARTBEAT_CONFIG, ...config };
  }

  setHandler(handler: HeartbeatHandler): void {
    this.handler = handler;
  }

  setActivityChecker(checker: ChannelActivityChecker): void {
    this.activityChecker = checker;
  }

  start(): void {
    if (this.timer) return;
    if (!this.config.enabled) {
      logger.info(SCOPE, 'Heartbeat disabled in config');
      return;
    }

    logger.info(SCOPE, `Heartbeat started (every ${this.config.intervalMs / 1000}s)`);

    this.timer = setInterval(() => {
      this.tick().catch(err => {
        logger.error(SCOPE, `Heartbeat tick failed: ${(err as Error).message}`);
      });
    }, this.config.intervalMs);

    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      this.tick().catch(err => {
        logger.error(SCOPE, `Initial heartbeat tick failed: ${(err as Error).message}`);
      });
    }, 30_000);
  }

  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info(SCOPE, 'Heartbeat stopped');
  }

  private async tick(): Promise<void> {
    if (this.running) {
      logger.debug(SCOPE, 'Previous heartbeat still running, skipping');
      return;
    }

    if (this.activityChecker && this.activityChecker()) {
      this.skippedCount++;
      logger.debug(SCOPE, 'Channel is active, deferring heartbeat');
      return;
    }

    this.running = true;
    this.runCount++;
    this.lastRunAt = new Date();

    try {
      const prompt = this.loadHeartbeatPrompt();
      if (!prompt) {
        logger.debug(SCOPE, 'No HEARTBEAT.md found, skipping');
        this.running = false;
        return;
      }

      const contextualPrompt = this.buildContextualPrompt(prompt);

      logger.info(SCOPE, `Heartbeat tick #${this.runCount}`);

      if (this.handler) {
        const result = await this.handler(contextualPrompt);
        if (result) {
          logger.info(SCOPE, `Heartbeat result: ${result.slice(0, 200)}`);
        }
      }
    } catch (err) {
      logger.error(SCOPE, `Heartbeat error: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private loadHeartbeatPrompt(): string | null {
    const heartbeatPath = path.join(this.configManager.configPath, 'HEARTBEAT.md');
    if (!fs.existsSync(heartbeatPath)) return null;
    const content = fs.readFileSync(heartbeatPath, 'utf-8').trim();
    return content || null;
  }

  private buildContextualPrompt(basePrompt: string): string {
    const now = new Date();
    const parts = [
      `[HEARTBEAT] Current time: ${now.toISOString()}`,
      `[HEARTBEAT] Tick #${this.runCount}`,
    ];

    if (this.lastRunAt) {
      parts.push(`[HEARTBEAT] Last run: ${this.lastRunAt.toISOString()}`);
    }

    parts.push('');
    parts.push(basePrompt);
    parts.push('');
    parts.push(
      'CRITICAL — NOTIFICATION POLICY (read this first):\n' +
      '- NEVER call notify() unless you have performed a concrete action that produced NEW information or results for the user.\n' +
      '- If you only checked things and found nothing new, call finish() silently. NO notification.\n' +
      '- DO NOT notify to say: "everything is fine", "nothing new", "no pending tasks", "all systems normal", ' +
      '"I checked and found nothing", "no updates", or any variation of "I looked but there is nothing to report".\n' +
      '- The ONLY valid reasons to notify are: a completed task with results, a detected problem that requires attention, ' +
      'new data the user explicitly asked to monitor, or an answer to a pending question.\n' +
      '- When in doubt, DO NOT notify. The user prefers silence over noise.\n\n' +
      'This is an autonomous heartbeat task. You are waking up on your own. ' +
      'Review your memories to see if there is anything pending, anything you should check on, ' +
      'or any proactive action to take. If there is nothing to do, call finish() immediately without using any tools. Keep it brief.\n\n' +
      'RULES:\n' +
      '- If you perform any action or find anything noteworthy, save a memory using memory_append ' +
      'so you can pick it up in a future heartbeat. Heartbeat conversation history is NOT preserved between beats.\n' +
      '- Periodically clean up outdated or irrelevant memories using memory_delete to keep your memory lean and useful.\n' +
      '- Call finish() when you have completed the task. Otherwise, the loop continues automatically if you have more work to do.'
    );

    return parts.join('\n');
  }

  updateConfig(config: Partial<HeartbeatConfig>): void {
    const wasEnabled = this.config.enabled;
    const oldInterval = this.config.intervalMs;
    this.config = { ...this.config, ...config };

    if (wasEnabled && !this.config.enabled) {
      this.stop();
    } else if (!wasEnabled && this.config.enabled) {
      this.start();
    } else if (this.config.enabled && oldInterval !== this.config.intervalMs && this.timer) {
      this.stop();
      this.start();
    }
    logger.info(SCOPE, `Config updated: enabled=${this.config.enabled}, interval=${this.config.intervalMs / 1000}s`);
  }

  getStatus(): { running: boolean; lastRunAt: Date | null; runCount: number; skippedCount: number; intervalMs: number; enabled: boolean } {
    return {
      running: this.running,
      lastRunAt: this.lastRunAt,
      runCount: this.runCount,
      skippedCount: this.skippedCount,
      intervalMs: this.config.intervalMs,
      enabled: this.config.enabled,
    };
  }
}
