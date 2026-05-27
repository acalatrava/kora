import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { logger } from './logger.js';
import type { ConfigManager } from './config.js';
import type { MemoryManager } from './memory.js';
import type { AuditLog } from './audit.js';
import type { ChatMessage, ChatResponse, ToolDefinition, ToolCall } from './types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { LLMProvider } from '../providers/base.js';
import { taskReportToolDefinition } from '../tools/notify-tool.js';
import { Dispatcher } from './dispatcher.js';

const SCOPE = 'sub-agent';

const THINK_RE = /<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>/gi;

function stripThink(t: string) { return t.replace(THINK_RE, '').replace(/<\/think(?:ing)?>/gi, '').replace(/<think(?:ing)?>\s*$/gim, '').trim(); }

export interface SubAgentConfig {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  maxIterations?: number;
  createdAt: string;
  createdBy: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  lastRunAt?: string;
  lastResult?: string;
  webhookToken?: string;
}

export class SubAgent {
  config: SubAgentConfig;
  private providerRegistry: ProviderRegistry;
  private tools: ToolDefinition[];
  private executeToolFn: ((toolCall: ToolCall, workspaceId: string) => Promise<{ callId: string; content: string; isError?: boolean }>) | null = null;
  private baseContextBuilder: ((workspaceId: string) => string) | null = null;
  auditLog: AuditLog | null = null;

  constructor(
    config: SubAgentConfig,
    providerRegistry: ProviderRegistry,
    tools: ToolDefinition[] = [],
  ) {
    this.config = config;
    this.providerRegistry = providerRegistry;
    const blockedToolNames = new Set(['finish', 'notify', 'memory_write', 'memory_remove', 'memory_list', 'subagent_dispatch', 'subagent_create', 'subagent_run', 'subagent_remove']);
    const filteredTools = tools.filter(t => !blockedToolNames.has(t.name));
    const controlToolNames = new Set(filteredTools.map(t => t.name));
    const withControl = [...filteredTools];
    if (!controlToolNames.has('task_report')) withControl.push(taskReportToolDefinition);
    this.tools = withControl;
  }

  setToolExecutor(fn: (toolCall: ToolCall, workspaceId: string) => Promise<{ callId: string; content: string; isError?: boolean }>): void {
    this.executeToolFn = fn;
  }

  setBaseContextBuilder(fn: (workspaceId: string) => string): void {
    this.baseContextBuilder = fn;
  }

  private emitRequest(
    sessionId: string, messages: ChatMessage[], tools: ToolDefinition[],
    iteration: number, auditOpts: Record<string, string>, providerId: string, reason = 'primary',
  ): void {
    const messageSummary = messages.map((m, i) => {
      const content = m.content ?? '';
      const preview = content.length > 500 ? content.slice(0, 500) + '…' : content;
      const entry: Record<string, unknown> = { idx: i, role: m.role, length: content.length };
      if (m.role === 'system') entry.preview = content.slice(0, 200) + (content.length > 200 ? '…' : '');
      else entry.preview = preview;
      if (m.toolCalls?.length) entry.toolCalls = m.toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments }));
      if (m.toolCallId) entry.toolCallId = m.toolCallId;
      return entry;
    });
    this.auditLog?.emit(sessionId, 'llm_request', {
      messageCount: messages.length,
      toolCount: tools.length,
      provider: providerId,
      model: this.config.model ?? 'default',
      iteration,
      reason,
      messages: messageSummary,
      tools: tools.length > 0 ? tools.map(t => ({ name: t.name, description: (t.description ?? '').slice(0, 120) })) : undefined,
    }, auditOpts);
  }

  private emitResponse(
    sessionId: string, response: ChatResponse, durationMs: number,
    auditOpts: Record<string, string>, providerId: string, reason = 'primary',
  ): void {
    const raw = response.content ?? '';
    const hasTools = !!(response.toolCalls && response.toolCalls.length > 0);
    this.auditLog?.emit(sessionId, 'llm_response', {
      hasToolCalls: hasTools,
      toolCallCount: response.toolCalls?.length ?? 0,
      contentLength: raw.length,
      visibleContentLength: stripThink(raw).length,
      finishReason: response.finishReason,
      provider: providerId,
      model: this.config.model ?? 'default',
      contentPreview: raw.length > 0 ? raw.slice(0, 500) : (hasTools ? '(tool calls only)' : '(empty)'),
      reasoning: response.reasoning || null,
      toolNames: hasTools ? response.toolCalls!.map(tc => tc.name) : undefined,
      reason,
      usage: response.usage ?? null,
    }, { ...auditOpts, durationMs });
  }

  async run(task: string, workspaceId: string): Promise<string> {
    this.config.status = 'running';
    this.config.lastRunAt = new Date().toISOString();
    const sessionId = uuidv4();
    const auditOpts = { channel: 'subagent', identityId: `subagent:${this.config.name}`, workspaceId };
    const startTime = Date.now();

    logger.info(SCOPE, `Sub-agent "${this.config.name}" starting task: ${task.slice(0, 100)}`);

    let systemContent = '';
    if (this.baseContextBuilder) {
      systemContent = this.baseContextBuilder(workspaceId) + '\n\n';
    }
    if (this.config.systemPrompt) {
      systemContent += '## Task Instructions\n\n' + this.config.systemPrompt + '\n';
    }

    systemContent += '\n\n## Turn Control\n' +
      'The loop continues automatically — just keep calling tools as needed.\n' +
      'When your task is done, call `task_report(status, summary, ...)` to return results to the main agent.\n' +
      '\n**You are an isolated worker. Only the main agent can communicate with the user.**\n' +
      'Focus on completing your task and report results via `task_report()`.\n';

    this.auditLog?.emit(sessionId, 'system_prompt', {
      agentName: this.config.name,
      agentId: this.config.id,
      task: task.slice(0, 2000),
      model: this.config.model ?? 'default',
      maxIterations: this.config.maxIterations ?? 100,
      length: systemContent.length,
      content: systemContent,
    }, auditOpts);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemContent },
      { role: 'user', content: task },
    ];

    let provider: LLMProvider;
    let usedProviderId: string;
    if (this.config.model) {
      const resolved = this.providerRegistry.resolveByModelId(this.config.model);
      if (resolved) {
        provider = resolved.provider;
        usedProviderId = resolved.providerId;
        logger.debug(SCOPE, `Sub-agent "${this.config.name}" resolved model "${this.config.model}" → provider "${resolved.providerId}"`);
      } else {
        provider = this.providerRegistry.getDefault();
        usedProviderId = provider.id;
        logger.warn(SCOPE, `Sub-agent "${this.config.name}" model "${this.config.model}" not found in any provider, falling back to default`);
      }
    } else {
      provider = this.providerRegistry.getDefault();
      usedProviderId = provider.id;
    }
    const maxIter = this.config.maxIterations ?? 100;
    let iterations = 0;
    let totalToolCalls = 0;
    let lastCleanedContent = '';

    const hardLimit = maxIter * 3;
    let llmCalls = 0;

    try {
      while (iterations < maxIter && llmCalls < hardLimit) {
        llmCalls++;

        const llmStart = Date.now();
        this.emitRequest(sessionId, messages, this.tools, llmCalls, auditOpts, usedProviderId);

        let response: ChatResponse;
        try {
          response = await provider.chat({
            messages,
            tools: this.tools.length > 0 ? this.tools : undefined,
            model: this.config.model,
          });
        } catch (primaryErr) {
          const fallback = this.providerRegistry.getFallback();
          if (fallback && fallback.model.id !== this.config.model) {
            logger.warn(SCOPE, `Sub-agent "${this.config.name}" primary model failed, falling back to ${fallback.model.id}`);
            try {
              response = await fallback.provider.chat({
                messages,
                tools: this.tools.length > 0 ? this.tools : undefined,
                model: fallback.model.id,
              });
            } catch {
              throw primaryErr;
            }
          } else {
            throw primaryErr;
          }
        }

        if (response.finishReason === 'error' && !response.content && !response.toolCalls?.length) {
          const fallback = this.providerRegistry.getFallback();
          if (fallback && fallback.model.id !== this.config.model) {
            logger.warn(SCOPE, `Sub-agent "${this.config.name}" primary model returned error, falling back to ${fallback.providerId}/${fallback.model.id}`);
            try {
              response = await fallback.provider.chat({
                messages,
                tools: this.tools.length > 0 ? this.tools : undefined,
                model: fallback.model.id,
              });
            } catch (fbErr) {
              logger.error(SCOPE, `Sub-agent "${this.config.name}" fallback also failed: ${(fbErr as Error).message}`);
            }
          }
          if (response.finishReason === 'error') {
            logger.error(SCOPE, `Sub-agent "${this.config.name}" provider returned error response, aborting`);
            return `Error: LLM provider returned an error for model "${this.config.model}". The model may be unavailable.`;
          }
        }

        this.emitResponse(sessionId, response, Date.now() - llmStart, auditOpts, usedProviderId);

        if (response.toolCalls && response.toolCalls.length > 0) {
          messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });
          let controlSignal: 'finish' | null = null;

          for (const tc of response.toolCalls) {
            const toolStart = Date.now();
            this.auditLog?.emit(sessionId, 'tool_call', {
              name: tc.name,
              arguments: tc.arguments,
              iteration: llmCalls,
            }, auditOpts);

            let result: { callId: string; content: string; isError?: boolean };
            if (tc.name === 'task_report') {
              controlSignal = 'finish';
              result = { callId: tc.id, content: JSON.stringify({ ok: true }) };
            } else if (tc.name === 'finish') {
              controlSignal = 'finish';
              result = { callId: tc.id, content: JSON.stringify({ ok: true }) };
            } else if (tc.name === 'notify') {
              result = { callId: tc.id, content: JSON.stringify({ ok: false, error: 'Sub-agents cannot use notify. Report results via task_report().' }) };
            } else if (tc.name === 'memory_write' || tc.name === 'memory_remove' || tc.name === 'memory_list') {
              result = { callId: tc.id, content: JSON.stringify({ ok: false, error: 'Sub-agents do not have access to memory. You are an isolated worker.' }) };
            } else if (tc.name === 'subagent_dispatch' || tc.name === 'subagent_create' || tc.name === 'subagent_run' || tc.name === 'subagent_remove') {
              result = { callId: tc.id, content: JSON.stringify({ ok: false, error: 'Sub-agents cannot dispatch other sub-agents.' }) };
            } else if (this.executeToolFn) {
              result = await this.executeToolFn(tc, workspaceId);
            } else {
              result = { callId: tc.id, content: JSON.stringify({ ok: false, error: 'No tool executor available.' }) };
            }

            this.auditLog?.emit(sessionId, 'tool_result', {
              name: tc.name,
              callId: result.callId,
              isError: result.isError ?? false,
              resultPreview: result.content.slice(0, 500),
            }, { ...auditOpts, durationMs: Date.now() - toolStart });
            messages.push({ role: 'tool', content: result.content, toolCallId: result.callId });
            totalToolCalls++;
          }

          if (controlSignal === 'finish') {
            const reportCall = response.toolCalls!.find(tc => tc.name === 'task_report');
            let finalResult: string;

            if (reportCall?.arguments) {
              const report = reportCall.arguments as Record<string, unknown>;
              const parts: string[] = [];
              parts.push(`**Status**: ${report.status ?? 'success'}`);
              if (report.summary) parts.push(`**Summary**: ${report.summary}`);
              if (report.result) parts.push(`**Result**: ${report.result}`);
              if (Array.isArray(report.findings) && report.findings.length > 0) {
                parts.push(`**Findings**:\n${(report.findings as string[]).map(f => `- ${f}`).join('\n')}`);
              }
              if (Array.isArray(report.actions_taken) && report.actions_taken.length > 0) {
                parts.push(`**Actions taken**:\n${(report.actions_taken as string[]).map(a => `- ${a}`).join('\n')}`);
              }
              if (Array.isArray(report.blockers) && report.blockers.length > 0) {
                parts.push(`**Blockers**:\n${(report.blockers as string[]).map(b => `- ${b}`).join('\n')}`);
              }
              finalResult = parts.join('\n\n');
            } else {
              const contentOnly = response.content ?? '';
              finalResult = stripThink(contentOnly) || contentOnly;
            }

            this.config.status = 'completed';
            this.config.lastResult = finalResult;

            this.auditLog?.emit(sessionId, 'session_end', {
              agentName: this.config.name,
              status: 'completed',
              totalDurationMs: Date.now() - startTime,
              iterations: llmCalls,
              llmCalls,
              toolCallsTotal: totalToolCalls,
              resultPreview: this.config.lastResult.slice(0, 500),
            }, { ...auditOpts, durationMs: Date.now() - startTime });

            logger.info(SCOPE, `Sub-agent "${this.config.name}" [completed] via task_report() in ${llmCalls} LLM calls`);
            return this.config.lastResult;
          }

          continue;
        }

        iterations++;
        logger.debug(SCOPE, `Sub-agent "${this.config.name}" content iteration ${iterations}/${maxIter} (llm call ${llmCalls})`);

        const contentOnly = response.content ?? '';
        const contentWithReasoning = response.reasoning
          ? `<think>${response.reasoning}</think>${contentOnly ? '\n' + contentOnly : ''}`
          : contentOnly;

        const cleaned = stripThink(contentOnly);
        lastCleanedContent = cleaned;

        messages.push({ role: 'assistant', content: contentWithReasoning });

        messages.push({
          role: 'user',
          content: 'You must call task_report() when your task is done. The loop continues automatically — just keep calling tools.',
        });
      }

      this.config.status = 'completed';
      this.config.lastResult = lastCleanedContent || 'Reached max iterations.';

      this.auditLog?.emit(sessionId, 'session_end', {
        agentName: this.config.name,
        status: 'max_iterations',
        totalDurationMs: Date.now() - startTime,
        iterations,
        llmCalls,
        toolCallsTotal: totalToolCalls,
      }, { ...auditOpts, durationMs: Date.now() - startTime });

      return this.config.lastResult;
    } catch (err) {
      const msg = (err as Error).message;
      this.config.status = 'failed';
      this.config.lastResult = `Error: ${msg}`;

      this.auditLog?.emit(sessionId, 'error', {
        agentName: this.config.name,
        error: msg,
        iterations,
        llmCalls,
        toolCallsTotal: totalToolCalls,
      }, { ...auditOpts, durationMs: Date.now() - startTime });

      logger.error(SCOPE, `Sub-agent "${this.config.name}" failed: ${msg}`);
      return this.config.lastResult;
    }
  }
}

export class SubAgentManager {
  private agents: Map<string, SubAgent> = new Map();
  private configManager: ConfigManager;
  private providerRegistry: ProviderRegistry;
  private tools: ToolDefinition[];
  private toolExecutor: ((toolCall: ToolCall, workspaceId: string) => Promise<{ callId: string; content: string; isError?: boolean }>) | null = null;
  private baseContextBuilder: ((workspaceId: string) => string) | null = null;
  private db: BetterSqlite3.Database | null = null;
  private auditLog: AuditLog | null = null;

  constructor(
    configManager: ConfigManager,
    providerRegistry: ProviderRegistry,
    tools: ToolDefinition[] = [],
  ) {
    this.configManager = configManager;
    this.providerRegistry = providerRegistry;
    this.tools = tools;
  }

  setAuditLog(auditLog: AuditLog): void {
    this.auditLog = auditLog;
    for (const agent of this.agents.values()) {
      agent.auditLog = auditLog;
    }
  }

  initDb(db: BetterSqlite3.Database): void {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS sub_agents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        model TEXT,
        max_iterations INTEGER DEFAULT 100,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'system',
        status TEXT NOT NULL DEFAULT 'idle',
        last_run_at TEXT,
        last_result TEXT,
        webhook_token TEXT
      )
    `);
    try {
      db.exec(`ALTER TABLE sub_agents ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`);
    } catch { /* column already exists */ }
    try {
      db.exec(`ALTER TABLE sub_agents ADD COLUMN webhook_token TEXT`);
    } catch { /* column already exists */ }
    this.loadFromDb();
  }

  private loadFromDb(): void {
    if (!this.db) return;
    const rows = this.db.prepare('SELECT * FROM sub_agents').all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const cfg: SubAgentConfig = {
        id: row.id as string,
        workspaceId: (row.workspace_id as string) || '',
        name: row.name as string,
        description: (row.description as string) || '',
        systemPrompt: (row.system_prompt as string) || '',
        model: row.model as string | undefined,
        maxIterations: (row.max_iterations as number) ?? 100,
        createdAt: row.created_at as string,
        createdBy: (row.created_by as string) || 'system',
        status: (row.status as SubAgentConfig['status']) || 'idle',
        lastRunAt: row.last_run_at as string | undefined,
        lastResult: row.last_result as string | undefined,
        webhookToken: row.webhook_token as string | undefined,
      };
      if (cfg.status === 'running') cfg.status = 'idle';
      const agent = new SubAgent(cfg, this.providerRegistry, this.tools);
      if (this.toolExecutor) agent.setToolExecutor(this.toolExecutor);
      if (this.baseContextBuilder) agent.setBaseContextBuilder(this.baseContextBuilder);
      if (this.auditLog) agent.auditLog = this.auditLog;
      this.agents.set(cfg.id, agent);
    }
    logger.info(SCOPE, `Loaded ${rows.length} sub-agent(s) from database`);
  }

  private persistAgent(config: SubAgentConfig): void {
    if (!this.db) return;
    this.db.prepare(`
      INSERT OR REPLACE INTO sub_agents (id, workspace_id, name, description, system_prompt, model, max_iterations, created_at, created_by, status, last_run_at, last_result, webhook_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(config.id, config.workspaceId, config.name, config.description, config.systemPrompt, config.model ?? null, config.maxIterations ?? 100, config.createdAt, config.createdBy, config.status, config.lastRunAt ?? null, config.lastResult ?? null, config.webhookToken ?? null);
  }

  setToolExecutor(fn: (toolCall: ToolCall, workspaceId: string) => Promise<{ callId: string; content: string; isError?: boolean }>): void {
    this.toolExecutor = fn;
    for (const agent of this.agents.values()) {
      agent.setToolExecutor(fn);
    }
  }

  setBaseContextBuilder(fn: (workspaceId: string) => string): void {
    this.baseContextBuilder = fn;
    for (const agent of this.agents.values()) {
      agent.setBaseContextBuilder(fn);
    }
  }

  create(opts: {
    name: string;
    description: string;
    systemPrompt: string;
    model?: string;
    maxIterations?: number;
    createdBy?: string;
    workspaceId?: string;
  }): SubAgent {
    const config: SubAgentConfig = {
      id: uuidv4(),
      workspaceId: opts.workspaceId ?? '',
      name: opts.name,
      description: opts.description,
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      maxIterations: opts.maxIterations ?? 100,
      createdAt: new Date().toISOString(),
      createdBy: opts.createdBy ?? 'system',
      status: 'idle',
      webhookToken: uuidv4(),
    };
    const agent = new SubAgent(config, this.providerRegistry, this.tools);
    if (this.toolExecutor) agent.setToolExecutor(this.toolExecutor);
    if (this.baseContextBuilder) agent.setBaseContextBuilder(this.baseContextBuilder);
    if (this.auditLog) agent.auditLog = this.auditLog;
    this.agents.set(config.id, agent);
    this.persistAgent(config);
    logger.info(SCOPE, `Created sub-agent "${config.name}" (${config.id})`);
    return agent;
  }

  update(id: string, updates: Partial<Pick<SubAgentConfig, 'name' | 'description' | 'systemPrompt' | 'model' | 'maxIterations' | 'workspaceId'>>): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    if (updates.name !== undefined) agent.config.name = updates.name;
    if (updates.description !== undefined) agent.config.description = updates.description;
    if (updates.systemPrompt !== undefined) agent.config.systemPrompt = updates.systemPrompt;
    if (updates.model !== undefined) agent.config.model = updates.model;
    if (updates.maxIterations !== undefined) agent.config.maxIterations = updates.maxIterations;
    if (updates.workspaceId !== undefined) agent.config.workspaceId = updates.workspaceId;
    this.persistAgent(agent.config);
    return true;
  }

  get(id: string, workspaceId: string): SubAgent | undefined {
    const agent = this.agents.get(id);
    if (!agent || agent.config.workspaceId !== workspaceId) return undefined;
    return agent;
  }

  list(workspaceId?: string): SubAgentConfig[] {
    const all = Array.from(this.agents.values()).map(a => ({ ...a.config }));
    if (!workspaceId) return all;
    return all.filter(a => a.workspaceId === workspaceId || a.workspaceId === '');
  }

  getByWebhookToken(token: string): SubAgent | undefined {
    for (const agent of this.agents.values()) {
      if (agent.config.webhookToken === token) return agent;
    }
    return undefined;
  }

  remove(id: string, workspaceId: string): boolean {
    const agent = this.agents.get(id);
    if (!agent || agent.config.workspaceId !== workspaceId) return false;
    const ok = this.agents.delete(id);
    if (ok && this.db) {
      this.db.prepare('DELETE FROM sub_agents WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
    }
    return ok;
  }

  async runTask(id: string, task: string, workspaceId: string): Promise<string> {
    const agent = this.agents.get(id);
    if (!agent) return 'Sub-agent not found.';
    if (agent.config.workspaceId && agent.config.workspaceId !== workspaceId) {
      return 'Sub-agent does not belong to this workspace.';
    }
    const result = await agent.run(task, workspaceId);
    this.persistAgent(agent.config);
    return result;
  }
}
