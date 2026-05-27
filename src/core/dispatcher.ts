import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger.js';
import type { AuditLog } from './audit.js';
import type { ConfigManager } from './config.js';
import type { IdentityManager } from './identity.js';
import type { WorkspaceManager } from './workspace.js';
import type { UserManager } from './user.js';
import type { MemoryManager } from './memory.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { isContextWindowError, SubscriptionRequiredError, DailyLimitError } from '../providers/base.js';
import type { SkillRegistry } from '../skills_runtime/registry.js';
import type { PermissionManager } from '../skills_runtime/permissions.js';
import type { ToolApprovalManager } from './tool-approval.js';
import {
  handleToolCall,
  getToolDefinitionsForEnabled,
  isToolEnabled,
  getToolCategory,
  buildManagedShellExecution,
} from '../tools/index.js';
import type { ToolExecutionContext, EnabledTools, ManagedExecution } from '../tools/index.js';
import { SubAgent } from './sub-agent.js';
import type { SubAgentConfig } from './sub-agent.js';
import { memoryToolDefinitions, handleMemoryTool } from '../tools/memory-tool.js';
import type { MemoryToolContext } from '../tools/memory-tool.js';
import { skillToolDefinitions, handleSkillTool } from '../tools/skill-tool.js';
import type { SkillToolContext } from '../tools/skill-tool.js';
import { identityToolDefinitions, handleIdentityTool } from '../tools/identity-tool.js';
import type { IdentityToolContext } from '../tools/identity-tool.js';
import { kyuToolDefinitions, handleKyuTool } from '../tools/kyu-tool.js';
import type { KyuToolContext } from '../tools/kyu-tool.js';
import type { McpManager } from '../mcp/manager.js';
import { ToolCatalog, findToolsDefinition } from '../tools/tool-catalog.js';
import type { SpeechToText } from '../tools/speech-tool.js';
import { estimateTokens, compactMessages } from './context-compactor.js';
import type {
  IncomingEvent,
  OutgoingEvent,
  ChatMessage,
  MultimodalPart,
  ToolCall,
  ToolResult,
  ToolDefinition,
} from './types.js';
import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { VectorStore, SimpleEmbeddingProvider, createVectorStore, generateVectorId } from './vector-store.js';
import type { EmbeddingProvider } from './vector-store.js';
import { parseDocument, canParse } from './document-parser.js';

const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_MAX_ITERATIONS_ENFORCED = 100;
const SCOPE = 'dispatcher';

export interface SandboxContextOpts {
  sandboxName: string;
  mounts: Array<{ hostPath: string; containerPath: string; mode: string }>;
  networkAccess: boolean;
  memoryLimitMb: number;
  wsWorkDir?: string | null;
  wsSkillsPath?: string | null;
}

export interface SkillContextOpts {
  skillRegistry: SkillRegistry;
  workspaceId: string;
}

export function buildSkillContextBlock(opts: SkillContextOpts): string {
  const parts: string[] = [];
  const loadedSkills = opts.skillRegistry.list(opts.workspaceId);
  parts.push('\n<installed-skills>\n');
  parts.push('Skills extend your capabilities with instructions, scripts, and reference files. They are NOT tools — ');
  parts.push('you follow the skill\'s instructions and execute them via shell commands, curl, python, etc.\n\n');
  parts.push('**Workflow:** Call `skill_read(name="...")` to load full instructions before using a skill.\n\n');
  parts.push('**Available skills:**\n');

  if (loadedSkills.length > 0) {
    for (const skill of loadedSkills) {
      const label = [
        skill.emoji,
        `**${skill.name}**`,
        skill.version ? `(v${skill.version})` : null,
      ].filter(Boolean).join(' ');
      const reqs: string[] = [];
      if (skill.requires?.bins?.length) reqs.push(`bins: ${skill.requires.bins.join(', ')}`);
      if (skill.requires?.env?.length) reqs.push(`env: ${skill.requires.env.join(', ')}`);
      const reqNote = reqs.length ? ` [requires: ${reqs.join('; ')}]` : '';
      parts.push(`- ${label}: ${skill.description}${reqNote}\n`);
    }
    parts.push('\nYou can also install new skills with `skill_create` or update them with `skill_update` or remove them with `skill_remove`.\n');
  } else {
    parts.push(' - No skills are installed.\n');
  }
  parts.push('</installed-skills>\n');

  return parts.join('');
}

export function buildSandboxContextBlock(opts: SandboxContextOpts): string {
  const parts: string[] = [];
  parts.push('\n## Sandbox Environment\n');
  parts.push(`Shell commands and file operations run inside a **${opts.sandboxName}** sandbox with restricted filesystem access.\n\n`);
  parts.push('**Accessible paths:**\n');
  if (opts.wsWorkDir) {
    parts.push(`- \`${opts.wsWorkDir}\` (read-write) — Your workspace directory. This is your default working directory.\n`);
    parts.push(`- \`${opts.wsWorkDir}/downloads\` — User attachments are stored here.\n`);
    if (opts.wsSkillsPath) {
      parts.push(`- \`${opts.wsSkillsPath}\` (read-write) — Workspace skills directory. Create skills here.\n`);
    }
  }
  if (opts.mounts.length > 0) {
    for (const m of opts.mounts) {
      parts.push(`- \`${m.hostPath}\` → \`${m.containerPath}\` (${m.mode})\n`);
    }
  }
  parts.push(`\n**Network access:** ${opts.networkAccess ? 'Allowed' : 'Blocked (no internet access from sandbox)'}\n`);
  parts.push(`**Memory limit:** ${opts.memoryLimitMb} MB\n`);
  parts.push('\nYou can only write to the paths listed above and /tmp. If you need write access to additional paths, inform the user that the admin must configure them.\n');
  return parts.join('');
}

const THINK_PATTERN = /<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>/gi;
const ORPHAN_THINK_CLOSE = /<\/think(?:ing)?>/gi;
const ORPHAN_THINK_OPEN = /<think(?:ing)?>\s*$/gim;
const CONTROL_TOOL_NAMES = new Set(['finish']);
const TOOL_DETACH_TIMEOUT_MS = 30_000;
const DETACHED_CLEANUP_TTL_MS = 10 * 60 * 1000;

interface DetachedExecution {
  promise: Promise<ToolResult>;
  startedAt: number;
  toolName: string;
  workspaceId: string;
  argsPreview: string;
  getPartialOutput?: () => { stdout: string; stderr: string };
  kill?: () => void;
}
const BASH_BLOCK_PATTERN = /```(?:bash|sh)\n([\s\S]*?)```/g;

function stripThinkBlocks(text: string): string {
  let result = text.replace(THINK_PATTERN, '');
  result = result.replace(/^[\s\S]*?<\/think(?:ing)?>/i, '');
  result = result.replace(ORPHAN_THINK_CLOSE, '');
  result = result.replace(ORPHAN_THINK_OPEN, '');
  return result.trim();
}

function getCleanContent(text: string): string {
  return stripThinkBlocks(text);
}

function extractBashBlocks(text: string): string[] {
  BASH_BLOCK_PATTERN.lastIndex = 0;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = BASH_BLOCK_PATTERN.exec(text)) !== null) {
    const code = m[1].trim();
    if (code) blocks.push(code);
  }
  return blocks;
}

const EMBEDDED_TOOL_CALL_PATTERN = /(?:<tool_call>\s*)?<function=(\w+)>([\s\S]*?)<\/function>(?:\s*<\/tool_call>)?/gi;
const PARAM_PATTERN = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/gi;
const INVOKE_TOOL_CALL_PATTERN = /<invoke\s+name="(\w+)">([\s\S]*?)<\/invoke>/gi;
const INVOKE_PARAM_PATTERN = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/gi;

function extractEmbeddedToolCalls(text: string): ToolCall[] {
  EMBEDDED_TOOL_CALL_PATTERN.lastIndex = 0;
  const calls: ToolCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = EMBEDDED_TOOL_CALL_PATTERN.exec(text)) !== null) {
    const name = m[1];
    const body = m[2];
    const args: Record<string, unknown> = {};
    PARAM_PATTERN.lastIndex = 0;
    let pm: RegExpExecArray | null;
    while ((pm = PARAM_PATTERN.exec(body)) !== null) {
      args[pm[1]] = pm[2].trim();
    }
    calls.push({ id: `embedded-${uuidv4().slice(0, 8)}`, name, arguments: args });
  }

  INVOKE_TOOL_CALL_PATTERN.lastIndex = 0;
  while ((m = INVOKE_TOOL_CALL_PATTERN.exec(text)) !== null) {
    const args: Record<string, unknown> = {};
    INVOKE_PARAM_PATTERN.lastIndex = 0;
    let pm: RegExpExecArray | null;
    while ((pm = INVOKE_PARAM_PATTERN.exec(m[2])) !== null) {
      args[pm[1]] = pm[2].trim();
    }
    calls.push({ id: `embedded-${uuidv4().slice(0, 8)}`, name: m[1], arguments: args });
  }

  return calls;
}

export class Dispatcher {
  private providerRegistry: ProviderRegistry;
  private skillRegistry: SkillRegistry;
  private identityManager: IdentityManager;
  private workspaceManager: WorkspaceManager;
  private memoryManager: MemoryManager;
  private config: ConfigManager;
  private permissionManager: PermissionManager;

  private toolContext: ToolExecutionContext | null = null;
  private enabledTools: EnabledTools = {};
  private mcpManager: McpManager | null = null;
  private auditLog: AuditLog | null = null;
  private toolApproval: ToolApprovalManager | null = null;
  private stt: SpeechToText | null = null;
  private userManager: UserManager | null = null;
  private subscriptionErrorHandler: ((workspaceId: string) => Promise<string>) | null = null;

  private messageHistory: Map<string, ChatMessage[]> = new Map();
  private maxHistoryMessages = 0; // Disable truncation of history
  private toolCatalog = new ToolCatalog();
  private sessionActivatedTools: Map<string, Set<string>> = new Map();
  private toolSearchThreshold = 15;
  private historySaveTimer: ReturnType<typeof setTimeout> | null = null;
  private historyDir: string;
  private vectorStores: Map<string, VectorStore> = new Map();
  private embeddingProvider: EmbeddingProvider = new SimpleEmbeddingProvider();
  private detachedExecutions: Map<string, DetachedExecution> = new Map();

  constructor(opts: {
    providerRegistry: ProviderRegistry;
    skillRegistry: SkillRegistry;
    identityManager: IdentityManager;
    workspaceManager: WorkspaceManager;
    memoryManager: MemoryManager;
    config: ConfigManager;
    permissionManager: PermissionManager;
  }) {
    this.providerRegistry = opts.providerRegistry;
    this.skillRegistry = opts.skillRegistry;
    this.identityManager = opts.identityManager;
    this.workspaceManager = opts.workspaceManager;
    this.memoryManager = opts.memoryManager;
    this.config = opts.config;
    this.permissionManager = opts.permissionManager;

    const settings = this.config.loadSettings();
    this.historyDir = join(settings.storagePath, 'history');
    mkdirSync(this.historyDir, { recursive: true });
    this.loadPersistedHistory();
  }

  setToolContext(context: ToolExecutionContext): void {
    this.toolContext = context;
  }

  getToolContext(): ToolExecutionContext | null {
    return this.toolContext;
  }

  setEnabledTools(enabled: EnabledTools): void {
    this.enabledTools = enabled;
  }

  setMcpManager(manager: McpManager): void {
    this.mcpManager = manager;
  }

  setAuditLog(audit: AuditLog): void {
    this.auditLog = audit;
  }

  setToolApproval(approval: ToolApprovalManager): void {
    this.toolApproval = approval;
  }

  setSpeechToText(stt: SpeechToText): void {
    this.stt = stt;
  }

  setUserManager(um: UserManager): void {
    this.userManager = um;
  }

  setSubscriptionErrorHandler(handler: (workspaceId: string) => Promise<string>): void {
    this.subscriptionErrorHandler = handler;
  }

  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
  }

  private getVectorStore(workspaceId: string): VectorStore {
    let store = this.vectorStores.get(workspaceId);
    if (!store) {
      const wsPath = this.config.getWorkspacePath(workspaceId);
      mkdirSync(wsPath, { recursive: true });
      store = createVectorStore(wsPath);
      this.vectorStores.set(workspaceId, store);
    }
    return store;
  }

  private async vectorizeDocument(workspaceId: string, content: string, metadata: Record<string, unknown>): Promise<void> {
    try {
      const store = this.getVectorStore(workspaceId);
      const chunks = this.chunkText(content, 10000);
      for (let i = 0; i < chunks.length; i++) {
        const embedding = await this.embeddingProvider.embed(chunks[i]);
        store.insert({
          id: generateVectorId(),
          content: chunks[i],
          embedding,
          metadata: { ...metadata, chunkIndex: i, totalChunks: chunks.length },
        });
      }
      logger.info(SCOPE, `Vectorized document: ${metadata.fileName || 'unknown'} (${chunks.length} chunks) for workspace ${workspaceId}`);
    } catch (err) {
      logger.warn(SCOPE, `Failed to vectorize document: ${(err as Error).message}`);
    }
  }

  private chunkText(text: string, maxChars: number): string[] {
    const lines = text.split('\n');
    const chunks: string[] = [];
    let current = '';
    for (const line of lines) {
      if (current.length + line.length + 1 > maxChars && current.length > 0) {
        chunks.push(current);
        current = '';
      }
      current += (current ? '\n' : '') + line;
    }
    if (current) chunks.push(current);
    return chunks;
  }

  private isNoiseNotification(message: string): boolean {
    const lower = message.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const noisePatterns = [
      /nothing (?:new|to report|pending|noteworthy|important)/,
      /no (?:new|pending|updates|changes|tasks|action|issues)/,
      /everything (?:is |looks |seems )?(?:fine|good|normal|ok|in order|up to date)/,
      /all (?:is |looks |seems )?(?:good|clear|well|fine|normal|quiet)/,
      /no (?:action|work) (?:needed|required|necessary)/,
      /checked (?:and |in )?.{0,20}nothing/,
      /just (?:a )?(?:quick )?check.{0,20}(?:everything|all|nothing)/,
      /(?:routine|regular) check/,
      /systems? (?:are |is )?(?:normal|running|operational)/,
      /nothing (?:needs|requires) (?:my |your )?attention/,
    ];
    return noisePatterns.some(p => p.test(lower));
  }

  private async searchRelevantDocuments(workspaceId: string, query: string, topK = 5): Promise<string> {
    try {
      const store = this.getVectorStore(workspaceId);
      if (store.count() === 0) return '';
      const queryEmbedding = await this.embeddingProvider.embed(query);
      const results = store.search(queryEmbedding, topK, 0.01);
      if (results.length === 0) return '';
      const lines: string[] = [];
      for (const r of results) {
        const meta = r.document.metadata || {};
        lines.push(`<doc_snippet score="${r.score.toFixed(2)}" source="${meta.fileName || meta.source || 'unknown'}">\n${r.document.content}\n</doc_snippet>`);
      }
      return lines.join('\n');
    } catch (err) {
      logger.warn(SCOPE, `Vector search failed: ${(err as Error).message}`);
      return '';
    }
  }

  private async saveTranscript(
    workspaceId: string,
    sessionId: string,
    summary: string,
    messages: ChatMessage[],
  ): Promise<void> {
    const now = new Date();
    const startTime = messages[0]?.timestamp ?? now;
    const ts = startTime.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const transcriptsDir = join(this.config.getWorkspacePath(workspaceId), 'transcripts');
    mkdirSync(transcriptsDir, { recursive: true });

    const lines: string[] = [
      `# Session Transcript ${ts}`,
      `**Session:** ${sessionId}`,
      `**Date:** ${startTime.toISOString()}`,
      `**Summary:** ${summary}`,
      '',
    ];

    for (const msg of messages) {
      if (msg.role === 'user') {
        lines.push(`## User ${msg.timestamp?.toISOString()}\n${typeof msg.content === 'string' ? msg.content : '[multimodal]'}\n`);
      } else if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (tc.name === 'notify' && tc.arguments?.message) {
            lines.push(`## Assistant ${msg.timestamp?.toISOString()}\n${String(tc.arguments.message)}\n`);
          }
        }
      }
    }

    const content = lines.join('\n');
    const filePath = join(transcriptsDir, `${ts}.md`);
    writeFileSync(filePath, content, 'utf-8');
    logger.info(SCOPE, `Saved transcript ${ts} for workspace ${workspaceId}`);

    this.memoryManager.append(workspaceId, `[transcript:${ts}] ${summary}`);

    const transcriptId = `transcript-${ts}`;
    try {
      const store = this.getVectorStore(workspaceId);
      store.deleteByMetadata('transcriptId', transcriptId);
    } catch { /* store may not exist yet */ }

    await this.vectorizeDocument(workspaceId, content, {
      fileName: `${transcriptId}.md`,
      type: 'transcript',
      transcriptId,
      sessionId,
    });
  }

  private async runInternalAgent(opts: {
    workspaceId: string;
    agentName: string;
    systemPrompt: string;
    task: string;
    tools: ToolDefinition[];
    executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
    maxIterations?: number;
  }): Promise<void> {
    const { workspaceId, agentName, systemPrompt, task, executeTool } = opts;
    const maxIter = opts.maxIterations ?? 10;
    const tools = [
      ...opts.tools,
      {
        name: 'task_report',
        description: 'Report that your work is done.',
        parameters: {
          type: 'object' as const,
          properties: {
            status: { type: 'string' as const, enum: ['success', 'partial', 'failed'] },
            summary: { type: 'string' as const, description: 'Brief description of what was done.' },
          },
          required: ['status', 'summary'],
        },
      },
    ];

    const defaultProvider = this.providerRegistry.getDefault();
    const sessionId = uuidv4();
    const auditOpts = { channel: 'internal', identityId: `internal:${agentName}`, workspaceId };
    const startTime = Date.now();

    this.auditLog?.emit(sessionId, 'session_start', {
      agentName,
      task: task.slice(0, 2000),
      tools: tools.map(t => ({ name: t.name, description: (t.description ?? '').slice(0, 120) })),
    }, auditOpts);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task },
    ];

    this.auditLog?.emit(sessionId, 'system_prompt', {
      agentName, length: systemPrompt.length, content: systemPrompt,
    }, auditOpts);

    let totalToolCalls = 0;
    let reportSummary = '';

    for (let i = 0; i < maxIter; i++) {
      const llmStart = Date.now();

      const messageSummary = messages.map((m, idx) => {
        const content = typeof m.content === 'string' ? m.content : '';
        const entry: Record<string, unknown> = { idx, role: m.role, length: content.length };
        if (m.role === 'system') entry.preview = content.slice(0, 200) + (content.length > 200 ? '…' : '');
        else entry.preview = content.length > 500 ? content.slice(0, 500) + '…' : content;
        if (m.toolCalls?.length) entry.toolCalls = m.toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments }));
        if (m.toolCallId) entry.toolCallId = m.toolCallId;
        return entry;
      });

      let usedProviderId = defaultProvider.id;
      let usedModel = '';

      this.auditLog?.emit(sessionId, 'llm_request', {
        messageCount: messages.length,
        toolCount: tools.length,
        provider: usedProviderId,
        model: usedModel || 'default',
        iteration: i + 1,
        reason: 'primary',
        messages: messageSummary,
        tools: i === 0 ? tools.map(t => ({ name: t.name, description: (t.description ?? '').slice(0, 120) })) : undefined,
      }, auditOpts);

      let response;
      try {
        response = await defaultProvider.chat({ messages, tools, workspaceId });
      } catch (primaryErr) {
        if (primaryErr instanceof SubscriptionRequiredError || primaryErr instanceof DailyLimitError) {
          logger.warn(SCOPE, `Internal agent "${agentName}" blocked (${primaryErr.name}) for workspace ${workspaceId}`);
          return;
        }
        const errorResponse: import('./types.js').ChatResponse = {
          content: (primaryErr as Error).message,
          reasoning: null,
          toolCalls: undefined,
          usage: undefined,
          finishReason: 'error',
        };
        this.emitLlmResponse(sessionId, errorResponse, Date.now() - llmStart, auditOpts);
        const fallback = this.providerRegistry.getFallback();
        if (fallback && fallback.model.id !== usedModel) {
          logger.warn(SCOPE, `Internal agent "${agentName}" primary failed (${(primaryErr as Error).message}), falling back to ${fallback.model.id}`);
          try {
            response = await fallback.provider.chat({ messages, tools, model: fallback.model.id, workspaceId });
            usedProviderId = fallback.providerId;
            usedModel = fallback.model.id;
          } catch (fallbackErr) {
            logger.error(SCOPE, `Internal agent "${agentName}" fallback also failed: ${(fallbackErr as Error).message}`);
            this.auditLog?.emit(sessionId, 'session_end', {
              agentName, status: 'error',
              error: `Primary: ${(primaryErr as Error).message}; Fallback: ${(fallbackErr as Error).message}`,
              totalDurationMs: Date.now() - startTime, iterations: i + 1, toolCallsTotal: totalToolCalls,
            }, { ...auditOpts, durationMs: Date.now() - startTime });
            return;
          }
        } else {
          this.auditLog?.emit(sessionId, 'session_end', {
            agentName, status: 'error', error: (primaryErr as Error).message,
            totalDurationMs: Date.now() - startTime, iterations: i + 1, toolCallsTotal: totalToolCalls,
          }, { ...auditOpts, durationMs: Date.now() - startTime });
          logger.warn(SCOPE, `Internal agent "${agentName}" LLM error: ${(primaryErr as Error).message}`);
          return;
        }
      }

      const rawContent = response.content ?? '';
      const hasTools = !!(response.toolCalls && response.toolCalls.length > 0);
      this.auditLog?.emit(sessionId, 'llm_response', {
        hasToolCalls: hasTools,
        toolCallCount: response.toolCalls?.length ?? 0,
        contentLength: rawContent.length,
        visibleContentLength: rawContent.length,
        finishReason: response.finishReason,
        provider: usedProviderId,
        model: usedModel || 'default',
        contentPreview: rawContent.length > 0 ? rawContent.slice(0, 500) : (hasTools ? '(tool calls only)' : '(empty)'),
        toolNames: hasTools ? response.toolCalls!.map(tc => tc.name) : undefined,
        reason: 'primary',
        usage: response.usage ?? null,
      }, { ...auditOpts, durationMs: Date.now() - llmStart });

      logger.debug(SCOPE, `Internal agent "${agentName}" [iter=${i + 1}, provider=${usedProviderId}]: finish=${response.finishReason}, tools=${response.toolCalls?.length ?? 0}, toolCalls=${response.toolCalls?.map(tc => tc.name).join(', ') ?? 'none'}`);

      if (!response.toolCalls || response.toolCalls.length === 0) {
        this.auditLog?.emit(sessionId, 'session_end', {
          agentName, status: 'completed', reason: 'no_tool_calls',
          totalDurationMs: Date.now() - startTime, iterations: i + 1, toolCallsTotal: totalToolCalls,
        }, { ...auditOpts, durationMs: Date.now() - startTime });
        return;
      }

      messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

      let done = false;
      for (const tc of response.toolCalls) {
        const toolStart = Date.now();
        this.auditLog?.emit(sessionId, 'tool_call', {
          name: tc.name, arguments: tc.arguments, iteration: i + 1,
        }, auditOpts);

        let result: string;
        let isError = false;

        if (tc.name === 'task_report') {
          done = true;
          reportSummary = String((tc.arguments as Record<string, unknown>)?.summary ?? '');
          if (reportSummary) {
            const now = new Date().toISOString();
            this.memoryManager.append(workspaceId, `[${now}] [source:internal_agent(${agentName})] ${reportSummary}`);
          }
          result = JSON.stringify({ ok: true });
        } else {
          try {
            result = await executeTool(tc.name, tc.arguments ?? {});
          } catch (err) {
            result = JSON.stringify({ ok: false, error: (err as Error).message });
            isError = true;
          }
        }

        messages.push({ role: 'tool', content: result, toolCallId: tc.id });
        this.auditLog?.emit(sessionId, 'tool_result', {
          name: tc.name, callId: tc.id, isError, resultPreview: result.slice(0, 500),
        }, { ...auditOpts, durationMs: Date.now() - toolStart });
        totalToolCalls++;
      }

      if (done) {
        this.auditLog?.emit(sessionId, 'session_end', {
          agentName, status: 'completed', summary: reportSummary,
          totalDurationMs: Date.now() - startTime, iterations: i + 1, toolCallsTotal: totalToolCalls,
        }, { ...auditOpts, durationMs: Date.now() - startTime });
        return;
      }
    }

    this.auditLog?.emit(sessionId, 'session_end', {
      agentName, status: 'max_iterations',
      totalDurationMs: Date.now() - startTime, iterations: maxIter, toolCallsTotal: totalToolCalls,
    }, { ...auditOpts, durationMs: Date.now() - startTime });
    logger.warn(SCOPE, `Internal agent "${agentName}" for workspace ${workspaceId} hit max iterations`);
  }

  private async runInternalMemoryAgent(
    workspaceId: string,
    agentName: string,
    task: string,
    allowedMemoryTools: string[],
  ): Promise<void> {
    const allowedSet = new Set(allowedMemoryTools);
    const tools = memoryToolDefinitions.filter(t => allowedSet.has(t.name));
    const memCtx: MemoryToolContext = { memoryManager: this.memoryManager, workspaceId };

    const systemPrompt = `**Role: Memory Management Agent (System-Level)**
You are responsible for maintaining the user's long-term memory store.
You operate as a deterministic, tool-driven agent.
Your goal is to ensure memory is accurate, minimal, structured, and useful for future reasoning.

**Core Responsibilities**
	•	Extract durable, user-relevant facts from inputs
	•	Ignore transient, noisy, or low-value information
	•	Update memory with precision and consistency
	•	Prevent duplication and contradictions
	•	Maintain a clean, normalized memory state

**Memory Guidelines**
Only store information that is:
	•	Stable over time (preferences, goals, traits, relationships, ongoing projects)
	•	Likely to improve future responses
	•	Explicitly stated or strongly implied

**Do NOT store:**
	•	Temporary states (mood, one-off actions)
	•	Redundant or already-known information
	•	Sensitive data unless explicitly required and safe

**Behavior Rules**
	•	Always prefer update over insert when possible
	•	Merge with existing memory when semantically similar
	•	Normalize formats (names, dates, entities)
	•	Be concise and structured in stored data
	•	If uncertain, skip storing rather than guessing

**Execution Flow**
	1.	Analyze input
	2.	Identify candidate memories
	3.	Validate against storage criteria
	4.	Deduplicate / merge with existing entries
	5.	Perform minimal necessary tool calls

**Tool Usage**
	•	Use memory tools only when a meaningful change is required
	•	Avoid unnecessary writes
	•	Ensure idempotency (same input → same memory state)

**Completion**
When all actions are finished, call:

task_report({
  status: "success",
  summary: "<brief description of actions taken>",
})

Do not produce conversational output. Only act through tools and final report.`;

    await this.runInternalAgent({
      workspaceId,
      agentName,
      systemPrompt,
      task,
      tools,
      executeTool: async (name, args) => {
        if (allowedSet.has(name)) return handleMemoryTool(name, args, memCtx);
        return JSON.stringify({ ok: false, error: `Tool ${name} not available.` });
      },
    });
  }

  private async runPostFinishMemoryUpdate(
    workspaceId: string,
    messages: ChatMessage[],
    sessionId: string,
  ): Promise<void> {
    const transcriptLines: string[] = [];
    for (const msg of messages) {
      if (msg.role === 'user') {
        const content = typeof msg.content === 'string' ? msg.content : '[multimodal]';
        transcriptLines.push(`User: ${content}`);
      } else if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (tc.name === 'notify' && tc.arguments?.message) {
            transcriptLines.push(`Assistant: ${String(tc.arguments.message)}`);
          }
        }
      }
    }

    if (transcriptLines.length === 0) return;

    const transcript = transcriptLines.join('\n\n');
    const currentMemory = this.memoryManager.getContextSnippet(workspaceId);

    const updateTask = [
      'This is the latest interaction transcript between the user and the assistant:\n',
      '---',
      transcript,
      '---\n',
      currentMemory ? `Current memory contents:\n\`\`\`\n${currentMemory}\n\`\`\`\n` : 'Current memory is empty.\n',
      'Review the transcript and if there is important information worth remembering long-term (user preferences, facts, names, project context, technical decisions, configuration notes, recurring patterns, etc.), store it using `memory_append`.',
      'Do NOT store trivial, temporary, or conversational information.',
      'Do NOT duplicate information that already exists in memory.',
      'Make sure to store stuff that you consider important to improve your communication with the user.',
      'If nothing worth storing, just call task_report with status "success".',
    ].join('\n');

    logger.debug(SCOPE, `Running memory_update_agent for workspace ${workspaceId}, session ${sessionId}`);
    await this.runInternalMemoryAgent(workspaceId, 'memory_update_agent', updateTask, ['memory_read', 'memory_append']);

    const updatedMemoryEntries = this.memoryManager.list(workspaceId);
    if (updatedMemoryEntries.length < 2) return;

    const entryList = updatedMemoryEntries.map(e =>
      `<memory-entry id="mem-${e.id}" timestamp="${e.timestamp}">${e.content}</memory-entry>`
    ).join('\n');

    const cleanupTask = [
      'Review the memory entries below and clean them up:\n',
      '```',
      entryList,
      '```\n',
      'Your tasks:',
      '1. Remove duplicate entries (use `memory_remove` with the entry ID).',
      '2. Remove entries that are no longer relevant or have been superseded.',
      '3. If multiple entries cover the same topic, consolidate them by removing the old ones and using `memory_append` with a merged entry.',
      '4. Old `[transcript:...]` entries older than two weeks can be removed — transcript files are preserved separately.',
      '5. If memory is already clean, just call task_report with status "success".',
    ].join('\n');

    logger.debug(SCOPE, `Running memory_cleanup_agent for workspace ${workspaceId}, session ${sessionId}`);
    await this.runInternalMemoryAgent(workspaceId, 'memory_cleanup_agent', cleanupTask, ['memory_read', 'memory_write', 'memory_remove', 'memory_list', 'memory_append']);

    logger.info(SCOPE, `Post-finish memory update completed for workspace ${workspaceId}`);
  }

  private async runPostFinishKyuUpdate(
    workspaceId: string,
    messages: ChatMessage[],
    sessionId: string,
  ): Promise<void> {
    const sessionDump: string[] = [];
    const startIndex = messages.map(m => m.role).lastIndexOf('system');
    const messagesToDump = messages.slice(startIndex + 1);

    for (const msg of messagesToDump) {
      if (msg.role === 'user') {
        const content = typeof msg.content === 'string' ? msg.content : '[multimodal]';
        sessionDump.push(`## User\n${content}`);
      } else if (msg.role === 'assistant') {
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (text) sessionDump.push(`## Assistant\n${text}`);
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            if (tc.name === 'notify' && tc.arguments?.message) {
              sessionDump.push(`## Assistant (notify)\n${String(tc.arguments.message)}`);
            }
          }
        }
      }
    }

    if (sessionDump.length < 2) return;

    const currentKyu = this.config.loadKyuMd(workspaceId);
    const kyuCtx: KyuToolContext = { configManager: this.config, workspaceId };

    const systemPrompt = `**Role: KYU (Know Your User) Profile Agent**
You are responsible for building and maintaining a deep, structured profile of the user.
Your goal is to extract every meaningful signal about who the user is — their personality, preferences, interests, goals, communication style, technical background, values, and anything that helps the assistant serve them better.

**What to capture:**
- Explicit statements: things the user directly says about themselves
- Implicit signals: inferred from their behavior, questions, tone, and choices
- Preferences: tools, technologies, workflows, communication style
- Context: projects, roles, relationships, routines
- Personality traits: how they think, what motivates them, what frustrates them

**Rules:**
- ALWAYS call kyu_read first to get the current profile
- Merge new information with existing data — NEVER lose previously captured insights
- Refine and consolidate sections when new info updates or clarifies existing entries
- Be specific: "prefers TypeScript over JavaScript" is better than "likes coding"
- Only call kyu_write if you have genuinely new or refined information to add
- If the conversation reveals nothing new about the user, just call task_report
- Write in third person ("The user prefers...", "They are interested in...")

**KYU.md Structure:**
Maintain this markdown structure. Add or remove subsections as needed, but keep the top-level sections:

\`\`\`markdown
# User Profile

## Personal
- Name, location, timezone, language, etc.

## Interests & Passions
- Hobbies, topics they enjoy, what excites them

## Professional Context
- Role, occupation, key projects, technical skills, tools used

## Goals & Objectives
- Short-term and long-term goals, aspirations

## Communication Style
- Preferred language, tone, formality level, response length preferences

## Values & Motivations
- What drives them, what they care about

## Patterns & Habits
- Recurring behaviors, routines, typical requests

## Important People & Context
- Family, colleagues, pets, organizations mentioned

## Likes
- Things they enjoy, prefer, or react positively to

## Dislikes & Sensitivities
- Things that annoy, frustrate, or should be avoided
\`\`\`

**Important:**
Keep the KYU.md file clean and minimal. Only add information that is relevant to the user and their interactions with the assistant.
Do not add information that is not relevant to the user and their interactions with the assistant. Make sure to keep the file minimal and relevant.
If the file is too large, remove old information that is not relevant to the user and their interactions with the assistant.
Remember that KYU is a profile of the user, not the assistant or the conversations between them.

**Completion:**
When done, call task_report with a brief summary of what was updated (or "no updates needed").`;

    const task = [
      currentKyu ? `Current KYU profile exists (${currentKyu.length} chars). Read it first with kyu_read, then merge any new insights.\n` : 'No KYU profile exists yet. If you find user information, create the initial profile.\n',
      '---\n',
      '<transcript>\n',
      sessionDump.join('\n\n'),
      '\n</transcript>\n\n',
      'Analyze the conversation transcript and update the user profile if any new insights are found.\n',
      '\n---',
    ].join('\n');

    logger.debug(SCOPE, `Running kyu_agent for workspace ${workspaceId}, session ${sessionId}`);

    const tools = kyuToolDefinitions;

    await this.runInternalAgent({
      workspaceId,
      agentName: 'kyu_agent',
      systemPrompt,
      task,
      tools,
      executeTool: async (name, args) => {
        if (name === 'kyu_read' || name === 'kyu_write') {
          return handleKyuTool(name, args, kyuCtx);
        }
        return JSON.stringify({ ok: false, error: `Tool ${name} not available.` });
      },
      maxIterations: 5,
    });

    logger.info(SCOPE, `KYU profile update completed for workspace ${workspaceId}`);
  }

  private async runPostFinishSelfLearner(
    workspaceId: string,
    messages: ChatMessage[],
    sessionId: string,
  ): Promise<void> {
    if (this.enabledTools.identity === false) return;

    const sessionDump: string[] = [];
    // Get all messages since the last system message
    const startIndex = messages.map(m => m.role).lastIndexOf('system');
    const messagesToDump = messages.slice(startIndex + 1);
    for (const msg of messagesToDump) {
      if (msg.role === 'user') {
        const content = typeof msg.content === 'string' ? msg.content : '[multimodal]';
        sessionDump.push(`## User\n${content}`);
      } else if (msg.role === 'assistant') {
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (text) sessionDump.push(`## Assistant\n${text}`);
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            const argsStr = JSON.stringify(tc.arguments ?? {}).slice(0, 500);
            sessionDump.push(`### Tool Call: ${tc.name}\nArguments: ${argsStr}`);
          }
        }
      } else if (msg.role === 'tool') {
        const content = typeof msg.content === 'string' ? msg.content : '';
        sessionDump.push(`### Tool Result\n${content.slice(0, 1000)}`);
      }
    }

    if (sessionDump.length < 3) return;

    const allowedSkillTools = new Set(['skill_create', 'skill_update', 'skill_read']);
    const allowedIdentityTools = new Set(['agent_evolve', 'identity_read']);
    const tools = [
      ...skillToolDefinitions.filter(t => allowedSkillTools.has(t.name)),
      ...identityToolDefinitions.filter(t => allowedIdentityTools.has(t.name)),
    ];

    const multiUserMode = !!this.toolContext?.multiUserMode;
    const skillCtx: SkillToolContext = {
      skillRegistry: this.skillRegistry,
      skillsDir: this.toolContext?.skillsDir ?? '',
      customEnv: this.toolContext?.shell?.customEnv,
      configManager: this.config,
    };
    const identityCtx: IdentityToolContext = {
      configManager: this.config,
      workspaceId,
    };

    const parts: string[] = [];

    const systemPrompt = `You are a self-learning agent. After each user session, you analyze what happened and decide whether to create new skills or evolve the agent's identity.

**When to create a skill (skill_create)**:
- The assistant learned a new technique, workflow, or pattern that could be reused
- The assistant solved a complex problem with a specific tool chain or API
- The user taught the assistant something that should become a permanent capability
- A reusable automation or process was discovered

**When to evolve identity (agent_evolve)**:
- The user expressed preferences about how the agent should behave
- A significant personality trait or communication style was established
- New goals or responsibilities were assigned to the agent
- The agent's role or domain expertise expanded

**Important rules**:
- Do NOT create skills for trivial or one-off tasks
- Do NOT evolve identity for minor or temporary preferences (those go in memory, not identity)
- Skills must follow SKILL.md format with proper YAML frontmatter (name, version, description)
- Be conservative: only act when there is clear, reusable value
- If nothing worth learning was found, just call task_report with status "success" and summary "No new skills or evolution needed"

When done, call task_report() with a summary of what was created or evolved.`;

    parts.push(systemPrompt);

    // Get current agent identity
    const globalIdentity = this.config.loadIdentityMd();
    const wsIdentity = this.config.loadWorkspaceIdentityMd(workspaceId);
    const identityMd = wsIdentity || globalIdentity;

    if (identityMd) {
      parts.push('<your-current-identity>\n');
      parts.push(identityMd);
      parts.push('</your-current-identity>\n');
    }

    // Current skills already created
    parts.push(buildSkillContextBlock({
      skillRegistry: this.skillRegistry,
      workspaceId: workspaceId ?? this.toolContext?.workspaceId ?? '',
    }));

    const task = `<transcript>\n${sessionDump.join('\n\n')}\n</transcript>\n\nAnalyze the session above and determine if any new skills should be created or if the agent's identity should evolve.`;

    logger.debug(SCOPE, `Running self_learner_agent for workspace ${workspaceId}, session ${sessionId}`);

    await this.runInternalAgent({
      workspaceId,
      agentName: 'self_learner_agent',
      systemPrompt: parts.join('\n\n'),
      task,
      tools,
      executeTool: async (name, args) => {
        if (allowedSkillTools.has(name)) {
          return handleSkillTool(name, args, skillCtx, multiUserMode, workspaceId);
        }
        if (allowedIdentityTools.has(name)) {
          return handleIdentityTool(name, args, identityCtx);
        }
        return JSON.stringify({ ok: false, error: `Tool ${name} not available.` });
      },
      maxIterations: 5,
    });

    logger.info(SCOPE, `Self-learner agent completed for workspace ${workspaceId}`);
  }

  private relocateAttachments(attachments: import('./types.js').EventAttachment[], workspaceId: string): void {
    const wsDownloads = join(this.config.getWorkspacePath(workspaceId), 'work', 'downloads');
    mkdirSync(wsDownloads, { recursive: true });

    for (const a of attachments) {
      if (!a.localPath || !existsSync(a.localPath)) continue;
      try {
        const name = basename(a.localPath);
        const dest = join(wsDownloads, name);
        copyFileSync(a.localPath, dest);
        try { unlinkSync(a.localPath); } catch { /* staging cleanup best-effort */ }
        a.localPath = dest;
      } catch (err) {
        logger.warn(SCOPE, `Failed to relocate attachment to workspace: ${(err as Error).message}`);
      }
    }
  }

  private async vectorizeAttachment(
    workspaceId: string,
    filePath: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      const parsed = await parseDocument(filePath, metadata.mimeType as string, metadata.fileName as string);
      if (!parsed || parsed.text.length === 0 || parsed.text.length > 1_000_000) return;
      const enrichedMeta = {
        ...metadata,
        parseMethod: parsed.method,
        ...(parsed.pages && { pages: parsed.pages }),
      };
      await this.vectorizeDocument(workspaceId, parsed.text, enrichedMeta);
      logger.info(SCOPE, `Vectorized ${parsed.method} document: ${metadata.fileName || filePath} (${parsed.text.length} chars)`);
    } catch (err) {
      logger.warn(SCOPE, `Attachment vectorization failed: ${(err as Error).message}`);
    }
  }

  private getAllToolDefinitions(): ToolDefinition[] {
    return getToolDefinitionsForEnabled(
      this.enabledTools,
      this.mcpManager ?? undefined,
      { multiUserMode: this.toolContext?.multiUserMode },
    );
  }

  private removeToolMessagesBeforeUserOrAssistant(messages: ChatMessage[]): ChatMessage[] {
    if (messages.length <= 1) return messages;
    let skipEnd = 1;
    while (skipEnd < messages.length && messages[skipEnd].role === 'tool') {
      skipEnd++;
    }
    if (skipEnd === 1) return messages;
    return [messages[0], ...messages.slice(skipEnd)];
  }

  /**
   * Ensures every tool result has a matching tool_call and vice versa.
   * Removes orphaned tool results and adds synthetic results for
   * orphaned tool_calls to prevent LLM API 400 errors.
   */
  private sanitizeToolPairs(messages: ChatMessage[]): ChatMessage[] {
    const declaredCallIds = new Set<string>();
    const answeredCallIds = new Set<string>();

    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          if (tc.id) declaredCallIds.add(tc.id);
        }
      }
      if (msg.role === 'tool' && msg.toolCallId) {
        answeredCallIds.add(msg.toolCallId);
      }
    }

    const orphanResults = new Set<string>();
    for (const id of answeredCallIds) {
      if (!declaredCallIds.has(id)) orphanResults.add(id);
    }

    const missingResults = new Set<string>();
    for (const id of declaredCallIds) {
      if (!answeredCallIds.has(id)) missingResults.add(id);
    }

    if (orphanResults.size === 0 && missingResults.size === 0) return messages;

    logger.warn(SCOPE, `Sanitizing tool pairs: ${orphanResults.size} orphan result(s), ${missingResults.size} missing result(s)`);

    const result: ChatMessage[] = [];
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolCallId && orphanResults.has(msg.toolCallId)) {
        continue;
      }
      result.push(msg);

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          if (tc.id && missingResults.has(tc.id)) {
            result.push({
              role: 'tool',
              content: JSON.stringify({ ok: true, note: 'completed' }),
              toolCallId: tc.id,
            });
          }
        }
      }
    }

    return result;
  }

  private refreshCatalog(): void {
    this.toolCatalog.clear();
    const builtInTools = getToolDefinitionsForEnabled(this.enabledTools, this.mcpManager ?? undefined, { multiUserMode: this.toolContext?.multiUserMode });
    this.toolCatalog.register(builtInTools, 'builtin');
    if (!builtInTools.some(t => t.name === 'find_tools')) {
      this.toolCatalog.register([findToolsDefinition], 'system', 'system');
    }
  }

  private getToolsForSession(sessionKey: string): ToolDefinition[] {
    const all = this.getAllToolDefinitions();
    if (all.length <= this.toolSearchThreshold) return all;

    this.refreshCatalog();
    const coreDefs = this.toolCatalog.getCoreDefinitions();
    const activated = this.sessionActivatedTools.get(sessionKey);
    if (activated && activated.size > 0) {
      const extra = this.toolCatalog.getDefinitions([...activated].filter(n => !coreDefs.some(c => c.name === n)));
      return [...coreDefs, ...extra];
    }
    return coreDefs;
  }

  private activateToolsForSession(sessionKey: string, toolNames: string[]): void {
    let set = this.sessionActivatedTools.get(sessionKey);
    if (!set) {
      set = new Set();
      this.sessionActivatedTools.set(sessionKey, set);
    }
    for (const name of toolNames) set.add(name);
  }

  async handleIncomingEvent(event: IncomingEvent): Promise<OutgoingEvent> {
    let sessionId: string | undefined;
    try {
      const providedSessionId = event.metadata?.sessionId as string | undefined;
      const isNewSession = !providedSessionId;
      sessionId = providedSessionId || uuidv4();
      const sessionStart = Date.now();

      const hasVoiceAttachment = event.attachments?.some(a => a.type === 'voice' || a.mimeType?.startsWith('audio/ogg'));

      const isMultiUser = this.toolContext?.multiUserMode ?? false;
      const existingIdentity = this.identityManager.resolve(event.channel, event.identityId);
      let identity: ReturnType<IdentityManager['resolveOrCreate']>;
      let workspaceId: string;

      if (existingIdentity) {
        identity = existingIdentity;
        workspaceId = (event.metadata?.workspaceId as string) ?? existingIdentity.workspaceId ?? '';
      } else if (event.metadata?.workspaceId) {
        identity = this.identityManager.resolveOrCreate(event.channel, event.identityId, event.metadata.workspaceId as string);
        workspaceId = event.metadata.workspaceId as string;
      } else if (!isMultiUser) {
        const defaultWorkspace = this.workspaceManager.ensureDefault();
        identity = this.identityManager.resolveOrCreate(event.channel, event.identityId, defaultWorkspace.id);
        workspaceId = identity.workspaceId ?? defaultWorkspace.id;
      } else if (isMultiUser && event.channel === 'email' && this.userManager) {
        const rawEmail = event.identityId.replace(/^email:/, '');
        const userByEmail = this.userManager.getByEmail(rawEmail);
        if (userByEmail) {
          const userIdentities = this.identityManager.getByUserId(userByEmail.id);
          const linked = userIdentities.find(i => i.workspaceId);
          const wsId = linked?.workspaceId ?? '';
          if (wsId) {
            identity = this.identityManager.resolveOrCreate(event.channel, event.identityId, wsId);
            if (!identity.userId) {
              this.identityManager.linkToUser(identity.id, userByEmail.id, wsId);
              identity.userId = userByEmail.id;
              identity.workspaceId = wsId;
            }
            workspaceId = wsId;
            logger.info(SCOPE, `Auto-linked email identity ${event.identityId} to workspace ${wsId} for user ${userByEmail.email}`);
          } else {
            logger.error(SCOPE, `User ${userByEmail.email} has no workspace linked`);
            return this.errorResponse(event, 'No workspace found. Please register first.');
          }
        } else {
          logger.error(SCOPE, `No workspace for identity ${event.identityId} in multiuser mode`);
          return this.errorResponse(event, 'No workspace found. Please register first.');
        }
      } else {
        logger.error(SCOPE, `No workspace for identity ${event.identityId} in multiuser mode`);
        return this.errorResponse(event, 'No workspace found. Please register first.');
      }
      if (this.userManager && identity.userId) {
        const user = this.userManager.getById(identity.userId);
        if (user?.status === 'suspended') {
          logger.warn(SCOPE, `Rejected message from suspended user ${identity.userId}`);
          return this.errorResponse(event, 'Your account has been suspended. Please contact the administrator.');
        }
      }

      const auditOpts = { channel: event.channel, identityId: event.identityId, workspaceId };

      if (isNewSession) {
        const sessionData: Record<string, unknown> = {
          channel: event.channel,
          type: event.type,
        };
        if (event.metadata?.chatContext) sessionData.chatContext = event.metadata.chatContext;
        this.auditLog?.emit(sessionId, 'session_start', sessionData, auditOpts);
      } else if (event.metadata?.chatContext && this.auditLog) {
        this.auditLog.backfillChatContext(sessionId, event.metadata.chatContext as Record<string, unknown>);
      }

      const workspace = this.workspaceManager.get(workspaceId);
      if (!workspace) {
        logger.error(SCOPE, `Workspace ${workspaceId} not found for identity ${identity.id}`);
        return this.errorResponse(event, 'Internal error: workspace not found.');
      }

      if (this.userManager && !identity.userId && workspace.ownerUserId) {
        const owner = this.userManager.getById(workspace.ownerUserId);
        if (owner?.status === 'suspended') {
          logger.warn(SCOPE, `Rejected internal event for workspace ${workspaceId} — owner ${workspace.ownerUserId} is suspended`);
          return this.errorResponse(event, 'Workspace owner is suspended.');
        }
      }

      const historyKey = (event.metadata?.historyKey as string) || workspaceId;
      const isHeartbeat = historyKey.startsWith('heartbeat:');

      // Sub-agents run asynchronously and don't have direct user access

      let tools = this.getToolsForSession(historyKey);

      const buildCurrentSystemPrompt = async (): Promise<string> => {
        const memCtx = this.memoryManager.getContextSnippet(workspaceId);
        const globalMd = this.config.loadAgentMd();
        const wsMd = this.config.loadWorkspaceAgentMd(workspaceId);
        const agentMd = [globalMd, wsMd ? "**IMPORTANT:** This is the user specific agent prompt, you should use it to personalize your responses:\n" + wsMd : ''].filter(Boolean).join('\n\n---\n\n');

        const globalIdentity = this.config.loadIdentityMd();
        const wsIdentity = this.config.loadWorkspaceIdentityMd(workspaceId);
        const identityMd = wsIdentity || globalIdentity;

        const subs = this.toolContext?.subAgentManager?.list(workspaceId) ?? [];
        let docCtx = '';
        try {
          const store = this.getVectorStore(workspaceId);
          if (store.count() > 0) {
            docCtx = await this.searchRelevantDocuments(workspaceId, event.content, 5);
          }
        } catch { /* vector search optional */ }

        if (this.skillRegistry && workspaceId) {
          const wsSkillsDir = join(this.config.getWorkspacePath(workspaceId), 'skills');
          this.skillRegistry.loadWorkspaceSkills(workspaceId, wsSkillsDir);
        }

        const kyuMd = this.config.loadKyuMd(workspaceId);

        return this.buildSystemPrompt(agentMd, memCtx, tools, subs, docCtx, workspaceId, identityMd, event.channel, kyuMd);
      };

      const initialSystemContent = await buildCurrentSystemPrompt();
      let systemMessage: ChatMessage = { role: 'system', content: initialSystemContent, timestamp: new Date() };

      this.auditLog?.emit(sessionId, 'system_prompt', {
        length: initialSystemContent.length,
        hasAgentMd: true,
        hasGlobalAgentMd: !!this.config.loadAgentMd(),
        hasUserAgentMd: !!this.config.loadWorkspaceAgentMd(workspaceId),
        memoryEntries: this.memoryManager.getContextSnippet(workspaceId)?.split('\n').filter((l: string) => l.trim()).length || 0,
        toolCount: tools.length,
        content: initialSystemContent,
      }, auditOpts);

      const history = this.removeToolMessagesBeforeUserOrAssistant(this.getHistory(historyKey));

      if (event.attachments && event.attachments.length > 0) {
        this.relocateAttachments(event.attachments, workspaceId);
      }

      const wsSettings = this.config.loadWorkspaceSettings(workspaceId);
      const allProviders = this.config.loadProviders();
      const wsActiveProvider = allProviders.find(p => p.id === wsSettings.defaultProvider)
        ?? allProviders.find(p => p.id === this.config.loadSettings().defaultProvider);
      const wsActiveModel = wsActiveProvider?.models?.find(m => m.id === wsSettings.defaultModel);
      const modelSupportsVision = wsActiveModel?.roles?.includes('vision') ?? false;

      let userContent = event.content;
      let multimodal: MultimodalPart[] | undefined;

      if (event.attachments && event.attachments.length > 0) {
        const parts: MultimodalPart[] = [];
        const textLines: string[] = [];

        const vectorizePromises: Promise<void>[] = [];

        for (const a of event.attachments) {
          const isImage = a.type === 'photo' || a.mimeType?.startsWith('image/');
          const isVoice = a.type === 'voice' || a.mimeType?.startsWith('audio/ogg');

          if (isVoice && a.localPath && this.stt) {
            try {
              const prevOnStatus = this.stt.onStatus;
              this.stt.onStatus = (msg) => { event.sendInterimMessage?.(msg); };
              const transcription = await this.stt.transcribe(a.localPath);
              this.stt.onStatus = prevOnStatus;
              if (transcription && transcription.trim()) {
                textLines.push(`[Voice transcription]: ${transcription}`);
                event.metadata = { ...event.metadata, voiceTranscribed: true };
                userContent = '';
              } else {
                logger.warn(SCOPE, 'Voice transcription returned empty result');
                textLines.push('[Voice message received — transcription was empty. Ask the user to repeat or type their message.]');
                userContent = '';
              }
            } catch (err) {
              logger.warn(SCOPE, `Voice transcription failed: ${(err as Error).message}`);
              textLines.push('[Voice message received — transcription failed. Ask the user to type their message instead.]');
              userContent = '';
            }
          } else if (isVoice && a.localPath && !this.stt) {
            textLines.push('[Voice message received — speech-to-text is not enabled. Tell the user that voice messages cannot be processed and ask them to type their message instead.]');
            userContent = '';
          } else if (isImage && a.localPath && existsSync(a.localPath)) {
            if (modelSupportsVision) {
              try {
                const buf = readFileSync(a.localPath);
                parts.push({
                  type: 'image',
                  imageBase64: buf.toString('base64'),
                  mimeType: a.mimeType || 'image/jpeg',
                });
                textLines.push(`[Image file saved at: ${a.localPath}]`);
                if (a.caption) textLines.push(a.caption);
              } catch {
                textLines.push(`[Image file not readable: ${a.localPath}]`);
              }
            } else {
              textLines.push(`[Image received and saved at: ${a.localPath}]`);
              if (a.caption) textLines.push(a.caption);
              textLines.push('[The current model does not support vision. If you have tools that can analyze images (e.g. a browser screenshot tool, OCR, or any image processing tool), use them to understand the image content. Otherwise, ask the user to describe what is in the image.]');
            }
            vectorizePromises.push(
              this.vectorizeAttachment(workspaceId, a.localPath, {
                fileName: a.fileName, mimeType: a.mimeType, channel: event.channel, caption: a.caption,
              }),
            );
          } else {
            const desc = [`[Attachment: ${a.type}`];
            if (a.fileName) desc.push(`name="${a.fileName}"`);
            if (a.mimeType) desc.push(`mime=${a.mimeType}`);
            if (a.localPath) desc.push(`path="${a.localPath}"`);
            if (a.caption) desc.push(`caption="${a.caption}"`);
            desc.push(']');
            textLines.push(desc.join(' '));

            if (a.localPath && existsSync(a.localPath) && canParse(a.mimeType, a.fileName)) {
              const vp = this.vectorizeAttachment(workspaceId, a.localPath, {
                fileName: a.fileName, mimeType: a.mimeType, channel: event.channel,
              });
              vectorizePromises.push(vp);

              try {
                const parsed = await parseDocument(a.localPath, a.mimeType, a.fileName);
                if (parsed && parsed.text.length > 0) {
                  const preview = parsed.text.length > 8000 ? parsed.text.slice(0, 8000) + '\n\n[... truncated, use knowledge_search for full content ...]' : parsed.text;
                  textLines.push(`\n--- Content of ${a.fileName || 'attachment'} ---\n${preview}\n--- End of content ---`);
                }
              } catch { /* parsing failed, vectorization will still proceed */ }
            }
          }
        }

        if (vectorizePromises.length > 0) {
          await Promise.all(vectorizePromises).catch(() => { });
        }

        if (parts.length > 0) {
          if (userContent || textLines.length > 0) {
            const fullText = [...textLines, userContent].filter(Boolean).join('\n');
            parts.unshift({ type: 'text', text: fullText });
          }
          multimodal = parts;
        } else if (textLines.length > 0) {
          userContent = textLines.join('\n') + '\n\n' + userContent;
        }
      }

      const userMessage: ChatMessage = { role: 'user', content: userContent, multimodal, timestamp: new Date() };

      const auditContent = typeof userContent === 'string' ? userContent : event.content;
      this.auditLog?.emit(sessionId, 'user_msg', {
        content: auditContent,
        type: event.type,
        voiceTranscribed: !!event.metadata?.voiceTranscribed,
        ...(hasVoiceAttachment ? { originalContent: event.content } : {}),
      }, auditOpts);

      const messages: ChatMessage[] = [
        systemMessage,
        ...history,
        userMessage,
      ];
      let sessionStartIdx = 1 + history.length;

      const settings = this.config.loadWorkspaceSettings(workspaceId);

      const providers = this.config.loadProviders();
      const wsProvider = providers.find(p => p.id === settings.defaultProvider);
      const provider = wsProvider
        ? this.providerRegistry.get(settings.defaultProvider) ?? this.providerRegistry.getDefault()
        : this.providerRegistry.getDefault();
      const activeProvider = wsProvider ?? providers.find(p => p.id === this.config.loadSettings().defaultProvider);
      const activeModel = activeProvider?.models?.find(m => m.id === settings.defaultModel);
      const reasoningOpt = activeModel?.reasoningEffort
        ? { reasoning: { effort: activeModel.reasoningEffort } as import('./types.js').ReasoningOptions }
        : {};

      let iterations = 0;
      let lastToolResults: string[] = [];
      let notifyUsed = false;
      const maxIter = settings.maxIterations ?? DEFAULT_MAX_ITERATIONS;
      const maxIterEnforced = settings.maxIterationsEnforced ?? DEFAULT_MAX_ITERATIONS_ENFORCED;

      while (iterations < maxIterEnforced) {
        iterations++;
        logger.debug(SCOPE, `LLM call iteration ${iterations} for workspace ${workspaceId}`);

        if (iterations > 1) {
          try {
            const refreshed = await buildCurrentSystemPrompt();
            systemMessage = { role: 'system', content: refreshed, timestamp: messages[0]?.timestamp ?? new Date() };
            messages[0] = systemMessage;
          } catch (err) {
            logger.warn(SCOPE, `System prompt refresh failed at iteration ${iterations}: ${(err as Error).message}`);
          }
        }

        if (iterations > 1 && event.drainPendingMessages) {
          const pending = event.drainPendingMessages();
          if (pending.length > 0) {
            const combined = pending.join('\n\n');
            logger.info(SCOPE, `Injecting ${pending.length} pending user message(s) at iteration ${iterations}`);
            messages.push({
              role: 'user',
              timestamp: new Date(),
              content: `[New message from user while you were working]\n${combined}\n\n[Address this alongside your current task. If it changes what you were doing, adjust accordingly.]`,
            });
          }
        }

        const estTokens = estimateTokens(messages, tools);
        if (estTokens > settings.maxContextTokens) {
          const compResult = await compactMessages(messages, settings.maxContextTokens, tools, async (msgs) => {
            try {
              const r = await provider.chat({ messages: msgs, model: settings.defaultModel, maxTokens: 2000, workspaceId });
              return r.content ?? '';
            } catch (primaryErr) {
              const fb = this.providerRegistry.getFallback();
              if (fb) {
                logger.warn(SCOPE, `compactMessages primary LLM failed (${(primaryErr as Error).message}), using fallback ${fb.model.id}`);
                const r = await fb.provider.chat({ messages: msgs, model: fb.model.id, maxTokens: 2000, workspaceId });
                return r.content ?? '';
              }
              throw primaryErr;
            }
          });
          if (compResult.removed > 0) {
            messages.splice(0, messages.length, ...compResult.messages);
            sessionStartIdx = 1;
            this.messageHistory.set(historyKey, []);
            this.auditLog?.emit(sessionId, 'context_compaction', {
              beforeTokens: compResult.beforeTokens,
              afterTokens: compResult.afterTokens,
              removedMessages: compResult.removed,
              maxContextTokens: settings.maxContextTokens,
            }, auditOpts);
          }
        }

        let messagesToSend: ChatMessage[];
        if (iterations >= maxIter) {
          const iterNote = `<think>WARNING: Iteration ${iterations}/${maxIterEnforced} — soft limit reached (hard limit: ${maxIterEnforced}). You MUST wrap up and call finish() in the next few iterations. Use notify() to communicate with the user, then call finish(summary=...). REMEMBER: finish() does NOT send anything to the user — only notify() delivers messages.</think>`;
          const iterMsg: ChatMessage = { role: 'assistant', content: iterNote };
          messagesToSend = this.sanitizeToolPairs(
            this.removeToolMessagesBeforeUserOrAssistant([...messages, iterMsg]),
          );
        } else {
          messagesToSend = this.sanitizeToolPairs(
            this.removeToolMessagesBeforeUserOrAssistant([...messages]),
          );
        }

        const llmStart = Date.now();
        this.emitLlmRequest(sessionId, messagesToSend, tools, settings, iterations, auditOpts, undefined, settings.defaultModel);

        let response;
        let usedProvider = provider;
        let usedModel = settings.defaultModel;
        try {
          response = await provider.chat({
            messages: messagesToSend,
            tools: tools.length > 0 ? tools : undefined,
            model: settings.defaultModel,
            maxTokens: settings.maxTokens,
            workspaceId,
            ...reasoningOpt,
          });
        } catch (primaryErr) {
          if (primaryErr instanceof SubscriptionRequiredError) {
            const isInternal = event.channel === 'internal';
            if (isInternal) {
              logger.info(SCOPE, `Internal event blocked by subscription gate for workspace ${workspaceId}, silently skipping`);
              return { channel: event.channel, identityId: event.identityId, type: 'message', content: '', metadata: event.metadata };
            }
            let subMsg = '⚠️ Your subscription is not active. Please subscribe to continue using the AI agent.';
            if (this.subscriptionErrorHandler) {
              try { subMsg = await this.subscriptionErrorHandler(workspaceId); } catch { /* use default */ }
            }
            return {
              channel: event.channel,
              identityId: event.identityId,
              type: 'message',
              content: subMsg,
              metadata: { ...event.metadata, subscriptionRequired: true },
            };
          }
          if (primaryErr instanceof DailyLimitError) {
            if (event.channel === 'internal') {
              logger.info(SCOPE, `Internal event blocked by daily limit for workspace ${workspaceId}, silently skipping`);
              return { channel: event.channel, identityId: event.identityId, type: 'message', content: '', metadata: event.metadata };
            }
            return {
              channel: event.channel,
              identityId: event.identityId,
              type: 'message',
              content: `⚠️ ${primaryErr.message}`,
              metadata: event.metadata,
            };
          }
          if (isContextWindowError(primaryErr)) {
            logger.warn(SCOPE, `Context window exceeded, triggering emergency compaction...`);
            const emergencyTarget = Math.floor(settings.maxContextTokens * 0.6);
            const compResult = await compactMessages(messages, emergencyTarget, tools, async (msgs) => {
              const fb = this.providerRegistry.getFallback();
              const compProvider = fb?.provider ?? provider;
              const compModel = fb?.model.id ?? settings.defaultModel;
              const r = await compProvider.chat({ messages: msgs, model: compModel, maxTokens: 2000, workspaceId });
              return r.content ?? '';
            });
            if (compResult.removed > 0) {
              messages.splice(0, messages.length, ...compResult.messages);
              sessionStartIdx = 1;
              this.messageHistory.set(historyKey, []);
              this.auditLog?.emit(sessionId, 'context_compaction', {
                beforeTokens: compResult.beforeTokens,
                afterTokens: compResult.afterTokens,
                removedMessages: compResult.removed,
                reason: 'context_window_error',
              }, auditOpts);
              logger.info(SCOPE, `Emergency compaction: ${compResult.beforeTokens} → ${compResult.afterTokens} tokens (removed ${compResult.removed} messages)`);
              continue;
            }
            logger.error(SCOPE, 'Emergency compaction could not reduce context further');
          }

          const errorResponse: import('./types.js').ChatResponse = {
            content: (primaryErr as Error).message,
            reasoning: null,
            toolCalls: undefined,
            usage: undefined,
            finishReason: 'error',
          };
          this.emitLlmResponse(sessionId, errorResponse, Date.now() - llmStart, auditOpts);
          const fallback = this.providerRegistry.getFallback();
          if (fallback && (fallback.model.id !== settings.defaultModel || fallback.providerId !== settings.defaultProvider)) {
            logger.warn(SCOPE, `Primary model failed (${(primaryErr as Error).message}), falling back to ${fallback.model.id}`);
            this.emitLlmRequest(sessionId, messagesToSend, tools, settings, iterations, auditOpts, undefined, fallback.model.id);
            try {
              response = await fallback.provider.chat({
                messages: messagesToSend,
                tools: tools.length > 0 ? tools : undefined,
                model: fallback.model.id,
                maxTokens: settings.maxTokens,
                workspaceId,
              });
              usedProvider = fallback.provider;
              usedModel = fallback.model.id;
            } catch (fallbackErr) {
              if (isContextWindowError(fallbackErr)) {
                logger.warn(SCOPE, `Fallback also hit context limit, triggering emergency compaction...`);
                const emergencyTarget = Math.floor(settings.maxContextTokens * 0.5);
                const compResult2 = await compactMessages(messages, emergencyTarget, tools, async (msgs) => {
                  const r = await fallback.provider.chat({ messages: msgs, model: fallback.model.id, maxTokens: 2000, workspaceId });
                  return r.content ?? '';
                });
                if (compResult2.removed > 0) {
                  messages.splice(0, messages.length, ...compResult2.messages);
                  sessionStartIdx = 1;
                  this.messageHistory.set(historyKey, []);
                  this.auditLog?.emit(sessionId, 'context_compaction', {
                    beforeTokens: compResult2.beforeTokens,
                    afterTokens: compResult2.afterTokens,
                    removedMessages: compResult2.removed,
                    reason: 'fallback_context_window_error',
                  }, auditOpts);
                  logger.info(SCOPE, `Emergency compaction (fallback): ${compResult2.beforeTokens} → ${compResult2.afterTokens} tokens (removed ${compResult2.removed} messages)`);
                  continue;
                }
              }
              logger.error(SCOPE, `Fallback model also failed: ${(fallbackErr as Error).message}`);
              throw primaryErr;
            }
          } else {
            throw primaryErr;
          }
        }

        if (response.finishReason === 'error' && !response.content && !response.toolCalls?.length) {
          const fallback = this.providerRegistry.getFallback();
          if (fallback && (fallback.model.id !== settings.defaultModel || fallback.providerId !== settings.defaultProvider)) {
            logger.warn(SCOPE, `Primary model returned error response, falling back to ${fallback.providerId}/${fallback.model.id}`);
            try {
              response = await fallback.provider.chat({
                messages: messagesToSend,
                tools: tools.length > 0 ? tools : undefined,
                model: fallback.model.id,
                maxTokens: settings.maxTokens,
                workspaceId,
              });
              usedProvider = fallback.provider;
              usedModel = fallback.model.id;
            } catch (fallbackErr) {
              logger.error(SCOPE, `Fallback model also failed: ${(fallbackErr as Error).message}`);
            }
          }
          if (response.finishReason === 'error') {
            logger.error(SCOPE, `Provider returned error response with no fallback available`);
            messages.push({
              role: 'user',
              content: '[System: The LLM provider returned an error. The model or provider may be unavailable. Please notify the user about the issue and call finish().]',
            });
            continue;
          }
        }

        const usedProviderId = usedProvider.id ?? settings.defaultProvider;
        this.emitLlmResponse(sessionId, response, Date.now() - llmStart, auditOpts, undefined, { providerId: usedProviderId, model: usedModel });

        if (response.usage && this.toolContext?.dbManager) {
          try {
            let userId = identity.userId || '';
            if (!userId && workspace.ownerUserId) userId = workspace.ownerUserId;
            if (!userId) userId = 'system';
            this.toolContext.dbManager.db.prepare(`
              INSERT INTO usage_logs (user_id, workspace_id, provider_id, model, input_tokens, output_tokens, cost_usd, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 0, ?)
            `).run(
              userId, workspaceId, usedProvider.id ?? settings.defaultProvider, usedModel,
              response.usage.promptTokens ?? 0, response.usage.completionTokens ?? 0,
              new Date().toISOString(),
            );
          } catch (err) {
            logger.warn(SCOPE, `Failed to log usage: ${(err as Error).message}`);
          }
        }

        logger.debug(SCOPE, `LLM raw response [iter=${iterations}, provider=${usedProviderId}, model=${usedModel}]: finish=${response.finishReason}, tokens=${response.usage?.totalTokens ?? 0}, tokensOut=${response.usage?.completionTokens ?? 0}, tools=${response.toolCalls?.length ?? 0}, toolCalls=${response.toolCalls?.map(tc => tc.name).join(', ') ?? 'none'}, content(${response.content?.length ?? 0})=${JSON.stringify((response.content ?? '').slice(0, 500))}${response.reasoning ? `, reasoning(${response.reasoning.length})=${JSON.stringify(response.reasoning.slice(0, 200))}` : ''}`);

        const contentWithReasoning = response.reasoning
          ? `<think>${response.reasoning}</think>${response.content ? '\n' + response.content : ''}`
          : response.content;

        if (response.toolCalls && response.toolCalls.length > 0) {
          const assistantMessage: ChatMessage = {
            role: 'assistant',
            content: contentWithReasoning,
            toolCalls: response.toolCalls,
            timestamp: new Date(),
          };
          messages.push(assistantMessage);

          lastToolResults = [];
          let catalogToolsAdded = false;
          let controlSignal: 'finish' | 'continue' | null = null;
          let finishSummary = '';

          for (const toolCall of response.toolCalls) {
            const toolStart = Date.now();
            event?.sendToolStatus?.(toolCall.name, 'start');
            this.auditLog?.emit(sessionId, 'tool_call', {
              name: toolCall.name,
              arguments: toolCall.arguments,
            }, auditOpts);

            let result: ToolResult;

            if (toolCall.name === 'finish') {
              controlSignal = 'finish';
              finishSummary = String(toolCall.arguments?.summary ?? '');
              if (!finishSummary && !isHeartbeat) {
                controlSignal = 'continue';
                result = { callId: toolCall.id, content: JSON.stringify({ ok: false, error: 'summary is required.' }) };
              } else {
                if (finishSummary) {
                  const now = new Date().toISOString();
                  const sourceLabel = isHeartbeat
                    ? 'heartbeat'
                    : event.channel === 'internal'
                      ? `task(${event.identityId})`
                      : `${event.channel}(${event.identityId})`;
                  this.memoryManager.append(workspaceId, `[${now}] [source:${sourceLabel}] ${finishSummary}`);

                  if (!isHeartbeat) {
                    this.saveTranscript(workspaceId, sessionId, finishSummary, messages).catch(err =>
                      logger.warn(SCOPE, `Failed to save transcript: ${(err as Error).message}`));
                    this.runPostFinishMemoryUpdate(workspaceId, messages, sessionId).catch(err =>
                      logger.warn(SCOPE, `Post-finish memory update failed: ${(err as Error).message}`));
                    this.runPostFinishSelfLearner(workspaceId, messages, sessionId).catch(err =>
                      logger.warn(SCOPE, `Self-learner agent failed: ${(err as Error).message}`));
                    this.runPostFinishKyuUpdate(workspaceId, messages, sessionId).catch(err =>
                      logger.warn(SCOPE, `KYU profile update failed: ${(err as Error).message}`));
                  }
                }
                result = { callId: toolCall.id, content: JSON.stringify({ ok: true }) };
              }
            } else if (toolCall.name === 'find_tools') {
              const searchResult = this.toolCatalog.handleFindTools(toolCall.arguments);
              result = { callId: toolCall.id, content: searchResult };
              try {
                const parsed = JSON.parse(searchResult) as { results?: Array<{ name: string }> };
                if (parsed.results?.length) {
                  const foundNames = parsed.results.map(r => r.name);
                  this.activateToolsForSession(historyKey, foundNames);
                  catalogToolsAdded = true;
                }
              } catch { /* ignore parse error */ }
            } else if (toolCall.name === 'notify') {
              const message = String(toolCall.arguments?.message ?? '');
              const replyExpected = !!toolCall.arguments?.reply_expected;
              const isHeartbeatSession = event.channel === 'internal' && event.identityId.startsWith('system:heartbeat');
              const suppressed = isHeartbeatSession && message && this.isNoiseNotification(message);
              if (message && event.sendInterimMessage && !suppressed) {
                await event.sendInterimMessage(message);
                notifyUsed = true;

                const attachments = toolCall.arguments?.attachments as Array<{ path: string; caption?: string; type?: string }> | undefined;
                if (attachments?.length && event.sendFile) {
                  for (const att of attachments) {
                    if (existsSync(att.path)) {
                      await event.sendFile(att.path, { caption: att.caption, type: (att.type as 'photo' | 'document') || 'document' });
                    } else {
                      logger.warn(SCOPE, `Notify attachment not found: ${att.path}`);
                    }
                  }
                }

                if (historyKey !== workspaceId && message) {
                  const now = new Date().toISOString();
                  const sourceLabel = isHeartbeat
                    ? 'heartbeat'
                    : event.channel === 'internal'
                      ? `task(${event.identityId})`
                      : `${event.channel}(${event.identityId})`;
                  this.memoryManager.append(workspaceId, `[${now}] [source:${sourceLabel}] Sent to user: ${message.slice(0, 500)}`);
                }
              }
              if (suppressed) {
                logger.debug(SCOPE, `Suppressed noisy heartbeat notification: "${message.slice(0, 100)}"`);
              }
              this.auditLog?.emit(sessionId, 'notify', {
                message: message.slice(0, 2000),
                delivered: !!(message && event.sendInterimMessage && !suppressed),
                suppressed: !!suppressed,
                replyExpected,
              }, auditOpts);

              if (replyExpected && event.waitForReply && !suppressed) {
                const REPLY_TIMEOUT_MS = 5 * 60 * 1000;
                logger.info(SCOPE, `Waiting for user reply (timeout: ${REPLY_TIMEOUT_MS / 1000}s)`);
                event.setTyping?.(false);
                const replyEvent = await event.waitForReply(REPLY_TIMEOUT_MS);
                event.setTyping?.(true);
                if (replyEvent) {
                  const processed = await this.processReplyAttachments(replyEvent, workspaceId, event.sendInterimMessage, modelSupportsVision);
                  const userReply = processed.content;
                  logger.info(SCOPE, `User replied while agent was waiting: "${userReply.slice(0, 100)}"${processed.multimodal ? ' (multimodal)' : ''}`);
                  messages.push({ role: 'tool', content: JSON.stringify({ ok: true, delivered: true, user_reply: userReply }), toolCallId: toolCall.id });
                  messages.push({ role: 'user', content: userReply, multimodal: processed.multimodal, timestamp: new Date() });
                  this.auditLog?.emit(sessionId, 'user_msg', {
                    content: userReply,
                    type: event.type,
                    voiceTranscribed: processed.voiceTranscribed,
                    hasAttachments: !!(replyEvent.attachments && replyEvent.attachments.length > 0),
                  }, auditOpts);

                  if (historyKey !== workspaceId) {
                    const now = new Date().toISOString();
                    const sourceLabel = isHeartbeat ? 'heartbeat' : `task(${event.identityId})`;
                    this.memoryManager.append(workspaceId, `[${now}] [source:${sourceLabel}] User replied: ${userReply.slice(0, 500)}`);
                  }
                  notifyUsed = false;
                  continue;
                } else {
                  logger.info(SCOPE, 'User did not reply within timeout, continuing');
                  result = { callId: toolCall.id, content: JSON.stringify({ ok: true, delivered: true, user_reply: null, timed_out: true }) };
                  this.auditLog?.emit(sessionId, 'user_msg', {
                    content: "(no user reply)",
                    timed_out: true,
                    type: event.type,
                  }, auditOpts);
                }
              } else {
                result = { callId: toolCall.id, content: JSON.stringify({ ok: true, delivered: !!(message && event.sendInterimMessage && !suppressed) }) };
              }
            } else if (toolCall.name === 'wait_for_tool') {
              const execId = String(toolCall.arguments?.tool_execution_id ?? '');
              const waitSec = Math.min(Math.max(Number(toolCall.arguments?.seconds) || 30, 1), 300);
              const detached = this.detachedExecutions.get(execId);
              if (!detached || detached.workspaceId !== workspaceId) {
                result = { callId: toolCall.id, content: JSON.stringify({ ok: false, error: `No detached execution found with id "${execId}". It may have already completed or been cleaned up.` }) };
              } else {
                const timeoutP = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), waitSec * 1000));
                const race = await Promise.race([detached.promise, timeoutP]);
                if (race === 'timeout') {
                  const partial = detached.getPartialOutput?.();
                  const elapsed = Math.round((Date.now() - detached.startedAt) / 1000);
                  result = {
                    callId: toolCall.id, content: JSON.stringify({
                      ok: true, still_running: true, tool_name: detached.toolName, tool_execution_id: execId,
                      elapsed_seconds: elapsed,
                      message: `Tool "${detached.toolName}" is still running after ${elapsed}s total. Use wait_for_tool again or kill_tool to terminate it.`,
                      ...(partial ? { partial_stdout: partial.stdout.slice(-2000), partial_stderr: partial.stderr.slice(-2000) } : {}),
                    })
                  };
                } else {
                  this.detachedExecutions.delete(execId);
                  const completed = race as ToolResult;
                  result = { ...completed, callId: toolCall.id };
                }
              }
            } else if (toolCall.name === 'kill_tool') {
              const execId = String(toolCall.arguments?.tool_execution_id ?? '');
              const detached = this.detachedExecutions.get(execId);
              if (!detached || detached.workspaceId !== workspaceId) {
                result = { callId: toolCall.id, content: JSON.stringify({ ok: false, error: `No detached execution found with id "${execId}".` }) };
              } else {
                detached.kill?.();
                this.detachedExecutions.delete(execId);
                const partial = detached.getPartialOutput?.();
                result = {
                  callId: toolCall.id, content: JSON.stringify({
                    ok: true, killed: true, tool_name: detached.toolName,
                    ...(partial ? { final_stdout: partial.stdout.slice(-2000), final_stderr: partial.stderr.slice(-2000) } : {}),
                  })
                };
                logger.info(SCOPE, `Killed detached tool "${detached.toolName}" (id: ${execId})`);
              }
            } else {
              result = await this.executeToolCallWithDetach(toolCall, workspaceId, event);
            }
            lastToolResults.push(result.content);

            if (['mcp_install', 'mcp_reconnect', 'mcp_enable'].includes(toolCall.name)) {
              try {
                const parsed = JSON.parse(result.content) as { ok?: boolean; availableTools?: string[]; tools?: string[] };
                if (parsed.ok) {
                  const newTools = parsed.availableTools ?? parsed.tools ?? [];
                  if (newTools.length > 0) {
                    this.activateToolsForSession(historyKey, newTools);
                    catalogToolsAdded = true;
                    logger.info(SCOPE, `MCP tools auto-activated for session: ${newTools.join(', ')}`);
                  }
                  this.refreshCatalog();
                }
              } catch { /* ignore parse error */ }
            }

            event?.sendToolStatus?.(toolCall.name, 'end');
            this.auditLog?.emit(sessionId, 'tool_result', {
              name: toolCall.name,
              resultPreview: result.content.slice(0, 500),
              isError: result.isError ?? false,
            }, { ...auditOpts, durationMs: Date.now() - toolStart });
            const toolMessage: ChatMessage = {
              role: 'tool',
              content: result.content,
              toolCallId: result.callId,
            };
            messages.push(toolMessage);
          }

          if (catalogToolsAdded) {
            tools = this.getToolsForSession(historyKey);
            logger.info(SCOPE, `Tools refreshed after changes, now ${tools.length} tools available for session`);
          }

          if (controlSignal === 'finish') {
            const cleaned = stripThinkBlocks(contentWithReasoning ?? '');

            this.auditLog?.emit(sessionId, 'assistant_msg', {
              content: cleaned.slice(0, 2000),
              rawContent: (contentWithReasoning ?? '').slice(0, 4000),
              iterations,
              finishRequested: true,
              notifyUsed,
            }, { ...auditOpts, durationMs: Date.now() - sessionStart });

            if (isHeartbeat) {
              this.clearHistory(historyKey);
              logger.info(SCOPE, `Heartbeat finish(): discarded heartbeat history for "${historyKey}"`);
            } else {
              this.saveSessionToHistory(historyKey, messages, sessionStartIdx);
            }

            this.auditLog?.emit(sessionId, 'session_end', {
              reason: 'finish',
              summary: finishSummary || undefined,
              totalDurationMs: Date.now() - sessionStart,
              iterations,
              toolCallsTotal: lastToolResults.length,
              notifyUsed,
            }, auditOpts);

            const isInternalEvent = event.channel === 'internal';
            const finalContent2 = (notifyUsed || isInternalEvent) ? '' : cleaned;
            logger.info(SCOPE, `Session ${sessionId} ended (finish) after ${iterations} iter, ` +
              `notify=${notifyUsed}, channel=${event.channel}, ` +
              `outputLen=${finalContent2.length}`);

            // If not internal event, and notifyUsed is false, iterate again requesting using notify() tool before finish()
            if (!isInternalEvent && !notifyUsed) {
              messages.push({ role: 'user', content: 'You must call notify() to communicate with the user BEFORE calling finish(). Please call notify() now.' });
              continue;
            }

            return {
              channel: event.channel,
              identityId: event.identityId,
              type: 'message',
              content: finalContent2,
              metadata: { ...event.metadata, marker: 'finish', voiceTranscribed: !!event.metadata?.voiceTranscribed },
            };
          }

          continue;
        }

        let finalContent = contentWithReasoning ?? '';

        if (response.finishReason === 'length' && finalContent.trim()) {
          logger.warn(SCOPE, `Response truncated (max_tokens reached). Requesting continuation.`);
          messages.push({ role: 'assistant', content: finalContent });
          messages.push({ role: 'user', content: 'Your previous response was cut off. Please continue exactly from where you stopped.' });

          const contStart = Date.now();
          this.emitLlmRequest(sessionId, messages, [], settings, iterations, auditOpts, 'continuation');

          const contResponse = await provider.chat({
            messages,
            model: settings.defaultModel,
            maxTokens: settings.maxTokens,
            workspaceId,
          });

          this.emitLlmResponse(sessionId, contResponse, Date.now() - contStart, auditOpts, 'continuation', { providerId: settings.defaultProvider, model: settings.defaultModel });

          if (contResponse.content?.trim()) {
            finalContent += contResponse.content;
          }
        }

        let cleaned = stripThinkBlocks(finalContent);
        const hasReasoning = finalContent.length > 0 && !cleaned;

        if (!cleaned && !hasReasoning && lastToolResults.length === 0) {
          logger.debug(SCOPE, 'LLM returned empty usable content, auto-retrying');
          messages.push({ role: 'assistant', content: '' });
          messages.push({ role: 'user', content: 'Continue. Please use tools.' });

          const retryStart = Date.now();
          this.emitLlmRequest(sessionId, messages, tools, settings, iterations, auditOpts, 'empty_retry');

          let retryResponse;
          try {
            retryResponse = await usedProvider.chat({
              messages,
              tools: tools.length > 0 ? tools : undefined,
              model: usedModel,
              maxTokens: settings.maxTokens,
            });
          } catch (retryErr) {
            const errorResponse: import('./types.js').ChatResponse = {
              content: (retryErr as Error).message,
              reasoning: null,
              toolCalls: undefined,
              usage: undefined,
              finishReason: 'error',
            };
            this.emitLlmResponse(sessionId, errorResponse, Date.now() - llmStart, auditOpts);
            const fb = this.providerRegistry.getFallback();
            if (fb && (fb.model.id !== usedModel || fb.providerId !== settings.defaultProvider)) {
              logger.warn(SCOPE, `Empty retry failed (${(retryErr as Error).message}), falling back to ${fb.model.id}`);
              retryResponse = await fb.provider.chat({
                messages,
                tools: tools.length > 0 ? tools : undefined,
                model: fb.model.id,
                maxTokens: settings.maxTokens,
                workspaceId,
              });
            } else {
              throw retryErr;
            }
          }

          this.emitLlmResponse(sessionId, retryResponse, Date.now() - retryStart, auditOpts, 'empty_retry', { providerId: settings.defaultProvider, model: usedModel });

          if (retryResponse.toolCalls && retryResponse.toolCalls.length > 0) {
            if (retryResponse.toolCalls.some(tc => CONTROL_TOOL_NAMES.has(tc.name) || tc.name === 'notify')) {
              response = retryResponse;
              continue;
            }
            messages.push({
              role: 'assistant',
              content: retryResponse.content,
              toolCalls: retryResponse.toolCalls,
            });
            for (const toolCall of retryResponse.toolCalls) {
              const result = await this.executeToolCallWithDetach(toolCall, workspaceId, event);
              lastToolResults.push(result.content);
              messages.push({ role: 'tool', content: result.content, toolCallId: result.callId });
            }
            continue;
          }

          finalContent = retryResponse.content ?? '';
          cleaned = getCleanContent(finalContent);
        }

        const embeddedToolCalls = extractEmbeddedToolCalls(finalContent || cleaned);
        if (embeddedToolCalls.length > 0) {
          logger.info(SCOPE, `Found ${embeddedToolCalls.length} embedded <tool_call> block(s) in LLM response: ${embeddedToolCalls.map(tc => tc.name).join(', ')}`);
          if (embeddedToolCalls.some(tc => CONTROL_TOOL_NAMES.has(tc.name) || tc.name === 'notify')) {
            response = { ...response, toolCalls: embeddedToolCalls, content: contentWithReasoning, finishReason: 'tool_calls' };
            continue;
          }
          messages.push({
            role: 'assistant',
            content: contentWithReasoning,
            toolCalls: embeddedToolCalls,
          });
          for (const toolCall of embeddedToolCalls) {
            this.auditLog?.emit(sessionId, 'tool_call', {
              name: toolCall.name,
              arguments: toolCall.arguments,
              source: 'embedded_xml',
            }, auditOpts);
            const result = await this.executeToolCallWithDetach(toolCall, workspaceId, event);
            lastToolResults.push(result.content);
            messages.push({ role: 'tool', content: result.content, toolCallId: result.callId });
          }
          continue;
        }

        const bashBlocks = extractBashBlocks(cleaned);
        if (bashBlocks.length > 0 && this.enabledTools.shell) {
          logger.info(SCOPE, `Found ${bashBlocks.length} bash block(s) in LLM response, executing via shell_exec`);
          for (const code of bashBlocks) {
            const scriptPath = join(tmpdir(), `korabot-bash-${Date.now()}.sh`);
            writeFileSync(scriptPath, code, 'utf-8');
            try {
              const bashToolCall: ToolCall = {
                id: `call_bash${Date.now().toString(36)}`,
                name: 'shell_exec',
                arguments: { command: `bash ${scriptPath}` },
              };
              this.auditLog?.emit(sessionId, 'tool_exec', {
                tool: 'shell_exec',
                args: { command: `bash ${scriptPath}`, scriptContent: code.slice(0, 500) },
                source: 'bash_block_autoexec',
              }, auditOpts);
              const result = await this.executeToolCall(bashToolCall, workspaceId, event);
              lastToolResults.push(result.content);
              messages.push({
                role: 'assistant',
                content: cleaned,
                toolCalls: [bashToolCall],
              });
              this.auditLog?.emit(sessionId, 'tool_result', {
                name: 'shell_exec',
                resultPreview: result.content.slice(0, 500),
                isError: result.isError ?? false,
              }, { ...auditOpts, durationMs: Date.now() - sessionStart });
              messages.push({ role: 'tool', content: result.content, toolCallId: result.callId });
              /*if (!result.isError) {
                cleaned += `\n\n**Script output:**\n\`\`\`\n${result.content.slice(0, 2000)}\n\`\`\``;
              }*/
            } finally {
              try { unlinkSync(scriptPath); } catch { /* ignore */ }
            }
          }
        }

        if (iterations < maxIter) {
          messages.push({ role: 'assistant', content: finalContent });
          if (lastToolResults.length === 0) {
            messages.push({
              role: 'user',
              content: 'SYSTEM ERROR: no tools have been called in this iteration.\n\nYou must use tools even to communicate with the user. Otherwise, the loop continues automatically — just keep calling tools if you have more work, or call finish() to end.\n\nPlease call tools now.',
            });
          }
          lastToolResults = [];
          continue;
        }

        logger.warn(SCOPE, `Auto-finishing at iteration ${iterations}: ${iterations >= maxIter ? 'soft limit reached' : 'too many text-only responses'}`);
        finalContent += '\n\n[Session ended: auto-finished]';

        this.auditLog?.emit(sessionId, 'assistant_msg', {
          content: cleaned.slice(0, 2000),
          rawContent: finalContent.slice(0, 4000),
          iterations,
          finishRequested: true,
          notifyUsed,
        }, { ...auditOpts, durationMs: Date.now() - sessionStart });

        messages.push({ role: 'assistant', content: finalContent });

        const endReason = 'soft_limit_reached';

        if (isHeartbeat) {
          this.clearHistory(historyKey);
          logger.info(SCOPE, `Heartbeat finish: discarded heartbeat history for "${historyKey}"`);
        } else {
          this.saveSessionToHistory(historyKey, messages, sessionStartIdx);
        }

        this.auditLog?.emit(sessionId, 'session_end', {
          reason: endReason,
          totalDurationMs: Date.now() - sessionStart,
          iterations,
          toolCallsTotal: lastToolResults.length,
          notifyUsed,
        }, auditOpts);

        const isInternalEvent = event.channel === 'internal';
        const finalContent2 = (notifyUsed || isInternalEvent) ? '' : cleaned;
        return {
          channel: event.channel,
          identityId: event.identityId,
          type: 'message',
          content: finalContent2,
          metadata: { ...event.metadata, marker: 'finish', voiceTranscribed: !!event.metadata?.voiceTranscribed },
        };
      }

      logger.warn(SCOPE, `Hit enforced max iterations (${maxIterEnforced}) for workspace ${workspaceId}`);

      this.auditLog?.emit(sessionId, 'session_end', {
        reason: 'max_iterations',
        totalDurationMs: Date.now() - sessionStart,
        iterations,
        toolCallsTotal: lastToolResults.length,
        notifyUsed,
      }, auditOpts);

      if (isHeartbeat) {
        this.clearHistory(historyKey);
        logger.info(SCOPE, `Heartbeat max iterations: discarded heartbeat history for "${historyKey}"`);
      } else {
        this.saveSessionToHistory(historyKey, messages, sessionStartIdx);
      }

      let overflowContent = 'I reached the maximum iteration limit. Here is what I accomplished so far.';
      if (lastToolResults.length > 0) {
        overflowContent += '\n\n' + this.fallbackSummary(lastToolResults);
      }

      const isInternalOverflow = event.channel === 'internal';
      if (!notifyUsed && !isInternalOverflow && event.sendInterimMessage) {
        await event.sendInterimMessage(stripThinkBlocks(overflowContent));
      }

      return {
        channel: event.channel,
        identityId: event.identityId,
        type: 'message',
        content: (notifyUsed || isInternalOverflow) ? '' : stripThinkBlocks(overflowContent),
        metadata: event.metadata,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(SCOPE, `Failed to handle event: ${message}`);
      this.auditLog?.emit(sessionId ?? 'unknown', 'error', {
        error: message,
      }, { channel: event.channel, identityId: event.identityId });

      this.auditLog?.emit(sessionId ?? 'unknown', 'session_end', {
        reason: 'error',
        error: message,
      }, { channel: event.channel, identityId: event.identityId });

      const historyKey = (event.metadata?.historyKey as string) || '';
      if (historyKey.startsWith('heartbeat:')) {
        this.clearHistory(historyKey);
        logger.info(SCOPE, `Heartbeat error: discarded heartbeat history for "${historyKey}"`);
      } else if (historyKey) {
        this.appendToHistory(historyKey, { role: 'user', content: event.content, timestamp: new Date() });
        this.appendToHistory(historyKey, { role: 'assistant', content: `[Error: ${message}]`, timestamp: new Date() });
        logger.debug(SCOPE, `Preserved user message in history despite error for "${historyKey}"`);
      }

      return this.errorResponse(event, `Something broke. ${message}`);
    }
  }

  async executeToolCall(toolCall: ToolCall, workspaceId: string, event?: IncomingEvent): Promise<ToolResult> {
    logger.info(SCOPE, `Executing tool "${toolCall.name}" with args: ${JSON.stringify(toolCall.arguments)}`);

    if (!isToolEnabled(toolCall.name, this.enabledTools)) {
      const category = getToolCategory(toolCall.name);
      logger.warn(SCOPE, `Tool "${toolCall.name}" is disabled (category: ${category}). Rejecting.`);
      return {
        callId: toolCall.id,
        content: JSON.stringify({ ok: false, error: `Tool "${toolCall.name}" is disabled. Enable "${category}" in settings first.` }),
        isError: true,
      };
    }

    const paramError = this.validateToolParams(toolCall.name, toolCall.arguments);
    if (paramError) {
      logger.warn(SCOPE, `Tool "${toolCall.name}" missing required params: ${paramError}`);
      return { callId: toolCall.id, content: JSON.stringify({ ok: false, error: paramError }), isError: true };
    }

    if (this.toolApproval && this.toolApproval.isSensitive(toolCall.name)) {
      if (toolCall.name === 'shell_exec' && toolCall.arguments.command) {
        const check = this.toolApproval.isBlockedCommand(String(toolCall.arguments.command));
        if (check.blocked) {
          logger.warn(SCOPE, `Blocked dangerous command: ${toolCall.arguments.command}`);
          return {
            callId: toolCall.id,
            content: JSON.stringify({ ok: false, error: `BLOCKED: ${check.reason}` }),
            isError: true,
          };
        }
      }

      const channel = event?.channel ?? 'internal';
      const identityId = event?.identityId ?? 'system';

      const decision = await this.toolApproval.requestApproval(
        toolCall.name,
        toolCall.arguments,
        channel,
        identityId,
        workspaceId,
      );

      if (decision === 'deny_once' || decision === 'deny_always') {
        const msg = decision === 'deny_always'
          ? `Tool "${toolCall.name}" is permanently denied. Revoke via /permissions to re-enable.`
          : `Tool "${toolCall.name}" was denied by the user.`;
        return { callId: toolCall.id, content: JSON.stringify({ ok: false, error: msg }), isError: true };
      }
    }

    if (this.toolContext) {
      let wsVectorStore: import('./vector-store.js').VectorStore | undefined;
      try { wsVectorStore = this.getVectorStore(workspaceId); } catch { /* optional */ }

      let sensitiveMailFilter = this.toolContext.sensitiveMailFilter;
      if (this.toolContext.configManager) {
        try {
          const wsSettings = this.toolContext.configManager.loadWorkspaceSettings(workspaceId) as unknown as Record<string, unknown>;
          const security = wsSettings.mail_delegation_security as Record<string, unknown> | undefined;
          if (security?.sensitiveMailFilter !== undefined) {
            sensitiveMailFilter = security.sensitiveMailFilter !== false;
          }
        } catch { /* use default */ }
      }

      const contextForCall: ToolExecutionContext = {
        ...this.toolContext,
        workspaceId,
        vectorStore: wsVectorStore,
        embeddingProvider: this.embeddingProvider,
        sensitiveMailFilter,
      };

      if (contextForCall.multiUserMode) {
        const ws = this.workspaceManager.get(workspaceId);
        if (ws?.ownerUserId && contextForCall.dbManager) {
          const userRow = contextForCall.dbManager.db
            .prepare('SELECT email FROM users WHERE id = ?')
            .get(ws.ownerUserId) as { email: string } | undefined;
          if (userRow?.email) contextForCall.userEmail = userRow.email;
        }
      }

      try {
        const result = await handleToolCall(toolCall.name, toolCall.arguments, contextForCall, this.toolContext?.multiUserMode ?? false);
        logger.debug(SCOPE, `Tool "${toolCall.name}" returned: ${result.slice(0, 200)}`);
        return { callId: toolCall.id, content: result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(SCOPE, `Tool "${toolCall.name}" threw: ${msg}`);
        return { callId: toolCall.id, content: JSON.stringify({ ok: false, error: msg }), isError: true };
      }
    }

    logger.warn(SCOPE, `No handler found for tool "${toolCall.name}"`);
    return {
      callId: toolCall.id,
      content: JSON.stringify({ ok: false, error: `Tool "${toolCall.name}" has no handler configured.` }),
      isError: true,
    };
  }

  private validateToolParams(toolName: string, args: Record<string, unknown>): string | null {
    const allDefs = this.getAllToolDefinitions();
    const def = allDefs.find(d => d.name === toolName);
    if (!def) return null;

    const required = (def.parameters as { required?: string[] })?.required;
    if (!required || required.length === 0) return null;

    const missing = required.filter(p => args[p] === undefined || args[p] === null || args[p] === '');
    if (missing.length === 0) return null;

    return `Missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`;
  }

  private async executeToolCallWithDetach(
    toolCall: ToolCall,
    workspaceId: string,
    event?: IncomingEvent,
  ): Promise<ToolResult> {
    this.cleanupOldDetachedExecutions(workspaceId);

    let execPromise: Promise<ToolResult>;
    let getPartialOutput: (() => { stdout: string; stderr: string }) | undefined;
    let killFn: (() => void) | undefined;

    if (toolCall.name === 'shell_exec' && this.toolContext) {
      const contextForCall: ToolExecutionContext = {
        ...this.toolContext,
        workspaceId,
      };
      const managed = buildManagedShellExecution(toolCall.arguments, contextForCall);
      if ('error' in managed) {
        return { callId: toolCall.id, content: JSON.stringify({ ok: false, error: managed.error }), isError: true };
      }
      execPromise = managed.promise.then(content => ({ callId: toolCall.id, content }));
      getPartialOutput = managed.getPartialOutput;
      killFn = managed.kill;
    } else {
      execPromise = this.executeToolCall(toolCall, workspaceId, event);
    }

    const timeoutP = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), TOOL_DETACH_TIMEOUT_MS));
    const race = await Promise.race([execPromise, timeoutP]);

    if (race === 'timeout') {
      const execId = toolCall.id;
      const argsPreview = JSON.stringify(toolCall.arguments ?? {}).slice(0, 100);
      this.detachedExecutions.set(execId, {
        promise: execPromise,
        startedAt: Date.now(),
        toolName: toolCall.name,
        workspaceId,
        argsPreview,
        getPartialOutput,
        kill: killFn,
      });

      const partial = getPartialOutput?.();
      logger.info(SCOPE, `Tool "${toolCall.name}" detached after ${TOOL_DETACH_TIMEOUT_MS / 1000}s (id: ${execId})`);

      return {
        callId: toolCall.id,
        content: JSON.stringify({
          ok: true,
          detached: true,
          tool_execution_id: execId,
          tool_name: toolCall.name,
          timeout_seconds: TOOL_DETACH_TIMEOUT_MS / 1000,
          message: `Tool "${toolCall.name}" is still running after ${TOOL_DETACH_TIMEOUT_MS / 1000}s. It has been detached and continues in the background. Use wait_for_tool(tool_execution_id="${execId}", seconds=N) to wait for it, or kill_tool(tool_execution_id="${execId}") to terminate it.`,
          ...(partial?.stdout || partial?.stderr ? {
            partial_stdout: partial.stdout.slice(-2000),
            partial_stderr: partial.stderr.slice(-2000),
          } : {}),
        }),
      };
    }

    return race as ToolResult;
  }

  private cleanupOldDetachedExecutions(workspaceId: string): void {
    const now = Date.now();
    for (const [id, exec] of this.detachedExecutions) {
      if (exec.workspaceId === workspaceId && now - exec.startedAt > DETACHED_CLEANUP_TTL_MS) {
        exec.kill?.();
        this.detachedExecutions.delete(id);
        logger.debug(SCOPE, `Cleaned up expired detached execution "${exec.toolName}" (id: ${id})`);
      }
    }
  }

  private getDetachedExecutionsForWorkspace(workspaceId: string): Array<{ id: string; toolName: string; argsPreview: string; elapsedSeconds: number }> {
    const now = Date.now();
    const result: Array<{ id: string; toolName: string; argsPreview: string; elapsedSeconds: number }> = [];
    for (const [id, exec] of this.detachedExecutions) {
      if (exec.workspaceId === workspaceId) {
        result.push({
          id,
          toolName: exec.toolName,
          argsPreview: exec.argsPreview,
          elapsedSeconds: Math.round((now - exec.startedAt) / 1000),
        });
      }
    }
    return result;
  }

  private async processReplyAttachments(
    replyEvent: IncomingEvent,
    workspaceId: string,
    sendInterim?: (text: string) => Promise<void>,
    modelSupportsVision = false,
  ): Promise<{ content: string; multimodal?: MultimodalPart[]; voiceTranscribed: boolean }> {
    if (!replyEvent.attachments || replyEvent.attachments.length === 0) {
      return { content: replyEvent.content ?? '', voiceTranscribed: false };
    }

    this.relocateAttachments(replyEvent.attachments, workspaceId);

    const parts: MultimodalPart[] = [];
    const textLines: string[] = [];
    const vectorizePromises: Promise<void>[] = [];
    let voiceTranscribed = false;

    for (const a of replyEvent.attachments) {
      const isImage = a.type === 'photo' || a.mimeType?.startsWith('image/');
      const isVoice = a.type === 'voice' || a.mimeType?.startsWith('audio/ogg');

      if (isVoice && a.localPath && this.stt) {
        try {
          const prevOnStatus = this.stt.onStatus;
          this.stt.onStatus = (msg) => { sendInterim?.(msg); };
          const transcription = await this.stt.transcribe(a.localPath);
          this.stt.onStatus = prevOnStatus;
          if (transcription && transcription.trim()) {
            textLines.push(`[Voice transcription]: ${transcription}`);
            voiceTranscribed = true;
          } else {
            logger.warn(SCOPE, 'Voice transcription returned empty result');
            textLines.push('[Voice message received — transcription was empty. Ask the user to repeat or type their message.]');
          }
        } catch (err) {
          logger.warn(SCOPE, `Voice transcription failed: ${(err as Error).message}`);
          textLines.push('[Voice message received — transcription failed. Ask the user to type their message instead.]');
        }
      } else if (isVoice && !this.stt) {
        textLines.push('[Voice message received — speech-to-text is not enabled. Tell the user that voice messages cannot be processed and ask them to type their message instead.]');
      } else if (isImage && a.localPath && existsSync(a.localPath)) {
        if (modelSupportsVision) {
          try {
            const buf = readFileSync(a.localPath);
            parts.push({ type: 'image', imageBase64: buf.toString('base64'), mimeType: a.mimeType || 'image/jpeg' });
            textLines.push(`[Image file saved at: ${a.localPath}]`);
            if (a.caption) textLines.push(a.caption);
          } catch {
            textLines.push(`[Image file not readable: ${a.localPath}]`);
          }
        } else {
          textLines.push(`[Image received and saved at: ${a.localPath}]`);
          if (a.caption) textLines.push(a.caption);
          textLines.push('[The current model does not support vision. If you have a tool that can analyze images (e.g. a browser screenshot tool, OCR, or any image processing tool), use it to understand the image content. Otherwise, ask the user to describe what is in the image.]');
        }
        vectorizePromises.push(
          this.vectorizeAttachment(workspaceId, a.localPath, {
            fileName: a.fileName, mimeType: a.mimeType, channel: replyEvent.channel, caption: a.caption,
          }),
        );
      } else {
        const desc = [`[Attachment: ${a.type}`];
        if (a.fileName) desc.push(`name="${a.fileName}"`);
        if (a.mimeType) desc.push(`mime=${a.mimeType}`);
        if (a.localPath) desc.push(`path="${a.localPath}"`);
        if (a.caption) desc.push(`caption="${a.caption}"`);
        desc.push(']');
        textLines.push(desc.join(' '));

        if (a.localPath && existsSync(a.localPath) && canParse(a.mimeType, a.fileName)) {
          vectorizePromises.push(
            this.vectorizeAttachment(workspaceId, a.localPath, {
              fileName: a.fileName, mimeType: a.mimeType, channel: replyEvent.channel,
            }),
          );
          try {
            const parsed = await parseDocument(a.localPath, a.mimeType, a.fileName);
            if (parsed && parsed.text.length > 0) {
              const preview = parsed.text.length > 8000 ? parsed.text.slice(0, 8000) + '\n\n[... truncated, use knowledge_search for full content ...]' : parsed.text;
              textLines.push(`\n--- Content of ${a.fileName || 'attachment'} ---\n${preview}\n--- End of content ---`);
            }
          } catch { /* parsing failed, vectorization will still proceed */ }
        }
      }
    }

    if (vectorizePromises.length > 0) {
      await Promise.all(vectorizePromises).catch(() => { });
    }

    const baseContent = replyEvent.content ?? '';
    const hasVoiceOrEmpty = replyEvent.attachments.some(a => a.type === 'voice' || a.mimeType?.startsWith('audio/ogg'));
    const textContent = hasVoiceOrEmpty ? '' : baseContent;

    if (parts.length > 0) {
      const fullText = [...textLines, textContent].filter(Boolean).join('\n');
      if (fullText) parts.unshift({ type: 'text', text: fullText });
      return { content: fullText, multimodal: parts, voiceTranscribed };
    }

    const finalContent = textLines.length > 0
      ? textLines.join('\n') + (textContent ? '\n\n' + textContent : '')
      : textContent;

    return { content: finalContent, voiceTranscribed };
  }

  getHistory(workspaceId: string): ChatMessage[] {
    return this.messageHistory.get(workspaceId) ?? [];
  }

  getHistoryKeys(): string[] {
    return Array.from(this.messageHistory.keys());
  }

  clearHistory(workspaceId: string): void {
    this.messageHistory.delete(workspaceId);
    this.deleteHistoryFile(workspaceId);
    logger.debug(SCOPE, `Cleared history for workspace ${workspaceId}`);
  }

  injectMessage(historyKey: string, role: 'user' | 'assistant', content: string): void {
    if (!historyKey || !content) return;
    const msg: ChatMessage = { role, content, timestamp: new Date(), injected: true };
    const history = this.messageHistory.get(historyKey) ?? [];
    history.push(msg);
    this.messageHistory.set(historyKey, history);
    this.schedulePersist(historyKey);
    logger.debug(SCOPE, `Injected ${role} message into history "${historyKey}": "${content.slice(0, 80)}"`);
  }


  private appendToHistory(workspaceId: string, message: ChatMessage): void {
    const history = this.messageHistory.get(workspaceId) ?? [];
    history.push(message);

    if (this.maxHistoryMessages > 0 && history.length > this.maxHistoryMessages) {
      const excess = history.length - this.maxHistoryMessages;
      history.splice(0, excess);
    }

    this.messageHistory.set(workspaceId, history);
    this.schedulePersist(workspaceId);
  }

  private saveSessionToHistory(historyKey: string, messages: ChatMessage[], historyStartIndex: number): void {
    const sessionMessages = messages.slice(historyStartIndex)
      .filter(m => {
        if (m.role === 'system') return false;
        if (m.role === 'assistant' && m.content && /^<think>This is iteration /i.test(m.content)) return false;
        return true;
      });
    const history = this.messageHistory.get(historyKey) ?? [];
    history.push(...sessionMessages);
    if (this.maxHistoryMessages > 0 && history.length > this.maxHistoryMessages) {
      const excess = history.length - this.maxHistoryMessages;
      history.splice(0, excess);
    }
    const sanitized = this.sanitizeToolPairs(history);
    this.messageHistory.set(historyKey, sanitized);
    this.schedulePersist(historyKey);
  }

  private historyFilePath(key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9_:-]/g, '_');
    return join(this.historyDir, `${safeKey}.json`);
  }

  private loadPersistedHistory(): void {
    try {
      if (!existsSync(this.historyDir)) return;
      const files = readdirSync(this.historyDir) as string[];
      let purgedHeartbeat = 0;
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = readFileSync(join(this.historyDir, file), 'utf-8');
          const data = JSON.parse(raw) as { key: string; messages: ChatMessage[] };
          if (data.key && Array.isArray(data.messages) && data.messages.length > 0) {
            if (data.key.startsWith('heartbeat:')) {
              unlinkSync(join(this.historyDir, file));
              purgedHeartbeat++;
              continue;
            }
            this.messageHistory.set(data.key, this.sanitizeToolPairs(data.messages));
          }
        } catch { /* skip corrupted files */ }
      }
      if (purgedHeartbeat > 0) {
        logger.info(SCOPE, `Purged ${purgedHeartbeat} stale heartbeat history file(s) on startup`);
      }
      logger.info(SCOPE, `Loaded ${this.messageHistory.size} persisted conversation histories`);
    } catch (err) {
      logger.warn(SCOPE, `Failed to load persisted history: ${(err as Error).message}`);
    }
  }

  shutdown(): void {
    if (this.historySaveTimer) {
      clearTimeout(this.historySaveTimer);
      this.historySaveTimer = null;
    }
    for (const key of this.messageHistory.keys()) {
      this.persistHistoryKey(key);
    }
    for (const [wsId, store] of this.vectorStores) {
      try {
        store.close();
        logger.debug(SCOPE, `Closed vector store for workspace ${wsId}`);
      } catch (err) {
        logger.warn(SCOPE, `Failed to close vector store for ${wsId}: ${(err as Error).message}`);
      }
    }
    this.vectorStores.clear();
  }

  private schedulePersist(key: string): void {
    if (this.historySaveTimer) clearTimeout(this.historySaveTimer);
    this.historySaveTimer = setTimeout(() => {
      this.persistHistoryKey(key);
    }, 2000);
  }

  private persistHistoryKey(key: string): void {
    try {
      const messages = this.messageHistory.get(key);
      if (!messages || messages.length === 0) return;
      const filePath = this.historyFilePath(key);
      const stripped = messages.map(m => {
        const { role, content, toolCalls, toolCallId, injected } = m;
        const entry: Record<string, unknown> = { role, content };
        if (toolCalls) entry.toolCalls = toolCalls;
        if (toolCallId) entry.toolCallId = toolCallId;
        if (injected) entry.injected = true;
        return entry;
      });
      writeFileSync(filePath, JSON.stringify({ key, messages: stripped }), 'utf-8');
    } catch (err) {
      logger.warn(SCOPE, `Failed to persist history for "${key}": ${(err as Error).message}`);
    }
  }

  private deleteHistoryFile(key: string): void {
    try {
      const filePath = this.historyFilePath(key);
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch { /* ignore */ }
  }

  private buildSystemPrompt(agentMd: string, memoryContext: string, tools: ToolDefinition[], subAgents?: import('./sub-agent.js').SubAgentConfig[], documentContext?: string, workspaceId?: string, identityMd?: string, channel?: string, kyuContext?: string): string {
    const parts: string[] = [];

    if (agentMd) {
      parts.push(agentMd);
    } else if (!identityMd) {
      parts.push('You are Kora, a helpful assistant.');
    }

    if (identityMd) {
      parts.push('<identity>\nThis is your identity. It is used to personalize your interactions with the user:\n' + identityMd + '\n</identity>\n');
    }

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const effectiveWsId = workspaceId || this.toolContext?.workspaceId;
    const wsWorkDir = effectiveWsId && this.toolContext?.configManager
      ? join(this.toolContext.configManager.getWorkspacePath(effectiveWsId), 'work')
      : "/tmp";
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    parts.push(`\n\n<environment>\n`);
    parts.push(`- **Current date and time:** ${dateStr}, ${timeStr} (${tz})\n`);
    parts.push(`- **Operating system:** ${process.platform} ${process.arch}\n`);
    parts.push(`- **Node.js version:** ${process.version}\n`);
    parts.push(`- **Working directory:** ${wsWorkDir}\n`);
    parts.push(`</environment>\n`);

    if (tools.length > 0) {
      const allDefs = this.getAllToolDefinitions();
      const useCatalog = allDefs.length > this.toolSearchThreshold;

      parts.push('\n\n<available-tools>\n');
      parts.push('Use tools proactively whenever they can help. Do NOT describe what you plan to do — just do it.\n\n');

      if (useCatalog) {
        parts.push(`You have access to ${allDefs.length} tools total. Only a core subset is loaded now to save context.\n`);
        parts.push('Available tool names: ' + allDefs.map(t => `\`${t.name}\``).join(', ') + '\n');
        parts.push('VERY IMPORTANT: **Use `find_tools` to understand how to use tools by keyword or category.**\n');
        parts.push('Categories: scheduler, browser, search, shell, email, mcp, memory, settings, home_assistant, subagent, skill\n');
        parts.push('\n');
      }

      const categories: Record<string, ToolDefinition[]> = {};
      for (const tool of tools) {
        let cat = 'Other';
        const n = tool.name;
        if (n.startsWith('memory_') || n.startsWith('agent_prompt_')) cat = 'Memory & Config';
        else if (n.startsWith('settings_')) cat = 'Memory & Config';
        else if (n.startsWith('scheduler_')) cat = 'Scheduler';
        else if (n.startsWith('mcp_')) cat = 'MCP Management';
        else if (n.startsWith('browser_')) cat = 'Browser';
        else if (n.includes('search')) cat = 'Web Search';
        else if (n.startsWith('shell_')) cat = 'Shell';
        else if (n.startsWith('file_')) cat = 'File Operations';
        else if (n.startsWith('knowledge_')) cat = 'Knowledge Base';
        else if (n.startsWith('mail_') || n.startsWith('email_')) cat = 'Email';
        else if (n.startsWith('ha_')) cat = 'Home Assistant';
        else if (n.startsWith('subagent_')) cat = 'Sub-Agents';
        else if (n === 'find_tools' || n === 'notify') cat = 'System';
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(tool);
      }

      for (const [cat, catTools] of Object.entries(categories)) {
        parts.push(`### ${cat}\n`);
        for (const tool of catTools) {
          const params = tool.parameters as { properties?: Record<string, { type?: string; description?: string }>, required?: string[] };
          const reqParams = params.required ?? [];
          const paramList = Object.entries(params.properties ?? {}).map(([name, p]) => {
            const req = reqParams.includes(name) ? '' : '?';
            return `${name}${req}: ${p.type || 'any'}`;
          }).join(', ');
          parts.push(`- **${tool.name}**(${paramList}): ${tool.description.slice(0, 120)}\n`);
        }
        parts.push('\n');
      }
      parts.push('</available-tools>\n');

      parts.push('<tool-usage-rules>\n');
      parts.push('- Always use the exact parameter names defined above. Do not invent parameter names.\n');
      parts.push('- For shell commands, use `shell_exec` with `command` as a string, e.g.: shell_exec(command="ls -la")\n');
      parts.push('- For web questions, prefer `web_search` for facts and `browser_navigate` for interactive pages.\n');
      parts.push('- Chain multiple tools when needed: search → navigate → extract.\n');
      parts.push('- Report results in natural language. Never dump raw JSON to the user.\n');
      parts.push('- If a tool fails, try an alternative approach or explain what went wrong.\n');
      if (useCatalog) {
        parts.push('- If you need a tool that is not loaded, call `find_tools(query="...")` to search the catalog.\n');
      }
      parts.push('</tool-usage-rules>\n');

      parts.push(buildSkillContextBlock({
        skillRegistry: this.skillRegistry,
        workspaceId: workspaceId ?? this.toolContext?.workspaceId ?? '',
      }));

      const wsSkillsPath = effectiveWsId && this.toolContext?.configManager
        ? join(this.toolContext.configManager.getWorkspacePath(effectiveWsId), 'skills')
        : null;

      if (wsSkillsPath) {
        parts.push('\n<creating-skills>\n');
        parts.push(`You can create custom skills with \`skill_create(name="...", content="...")\` and add files with \`skill_update(name="...", fileName="...", content="...")\`.\n\n`);
        parts.push('**Skill structure:**\n');
        parts.push('```\n');
        parts.push(`${wsSkillsPath}/<skill-name>/\n`);
        parts.push('  SKILL.md          # Required — skill manifest and instructions\n');
        parts.push('  script.py         # Optional — executable scripts\n');
        parts.push('  asset.jpg         # Optional — additional files\n');
        parts.push('```\n\n');
        parts.push('**SKILL.md format** (YAML frontmatter + Markdown instructions):\n');
        parts.push('```markdown\n');
        parts.push('---\n');
        parts.push('name: my-skill-name\n');
        parts.push('description: What this skill does (shown in skill list)\n');
        parts.push('version: "1.0"\n');
        parts.push('---\n\n');
        parts.push('# Instructions for the agent\n\n');
        parts.push('Step-by-step instructions on how to use this skill...\n');
        parts.push('```\n\n');
        parts.push('Skills you create using skill_create(name="...", content="...") are automatically loaded for the next interaction turn.\n');
        parts.push('</creating-skills>\n');
      }
    }

    parts.push('\n\n<long-term-memory>\n');
    parts.push('Your memory is managed automatically. Important context from your conversations is stored and updated after each session.\n');
    parts.push('You do NOT have memory tools — the system handles memory for you behind the scenes.\n\n');

    if (memoryContext) {
      parts.push(`### What You Remember (${memoryContext.split('\n').filter(l => l.trim()).length} entries)\n\`\`\`\n${memoryContext}\n\`\`\`\n`);
    } else {
      parts.push('### What You Remember\n*Empty — no memories stored yet. They will be created automatically after your conversations.*\n');
    }
    parts.push('</long-term-memory>\n');

    parts.push('\n\n<know-your-user>\n');
    parts.push('You deeply care about understanding the user. Use the profile below to personalize your interactions, anticipate their needs, and make proactive suggestions.\n');
    parts.push('When natural, ask follow-up questions to learn more about the user. Never interrogate — weave curiosity into the conversation flow organically.\n');
    parts.push('If you discover something new about the user (preferences, goals, context, personality), simply take note — the system will update the user profile automatically after the session.\n\n');

    if (kyuContext) {
      parts.push('### User Profile\n');
      parts.push(kyuContext);
      parts.push('\n');
    } else {
      parts.push('### User Profile\n');
      parts.push('*No profile yet — you are meeting this user for the first time.*\n\n');
      parts.push('**First conversation guidelines:**\n');
      parts.push('- Introduce yourself warmly. Explain that you are Kora, their personal AI assistant.\n');
      parts.push('- **First priority:** Ask the user to link their email so they can access the web portal. Suggest they use the `/link email@example.com` command in Telegram. Explain that the web portal gives them access to settings, memory, task management, and more.\n');
      parts.push('- Briefly mention your main capabilities: browsing the web, managing emails, scheduling tasks and reminders, running commands, home automation, and more.\n');
      parts.push('- Ask what they would like to use you for — their goals, interests, or what brought them here.\n');
      parts.push('- Ask about their profession, hobbies, or daily routines so you can personalize future interactions.\n');
      parts.push('- Keep it conversational and friendly — do not list all capabilities at once, introduce them naturally.\n');
      parts.push('- Do NOT interrogate — share a bit about what you can do and let them guide the conversation.\n');
    }
    parts.push('</know-your-user>\n');

    if (documentContext) {
      parts.push('\n\n<relevant-documents>\n');
      parts.push('The following document excerpts were found relevant to the current conversation. Use them to provide informed answers:\n');
      parts.push('```\n' + documentContext + '\n```\n');
    }
    parts.push('</relevant-documents>\n');

    if (effectiveWsId) {
      const detachedExecs = this.getDetachedExecutionsForWorkspace(effectiveWsId);
      if (detachedExecs.length > 0) {
        parts.push('\n\n<background-executions>\n');
        parts.push('The following tool executions are currently running in the background. You can use `wait_for_tool(tool_execution_id="...")` to wait for them or `kill_tool(tool_execution_id="...")` to terminate them.\n\n');
        for (const exec of detachedExecs) {
          parts.push(`- **${exec.toolName}** (id: \`${exec.id}\`, running for ${exec.elapsedSeconds}s) — \`${exec.argsPreview}\`\n`);
        }
        parts.push('\n');
      }
    }
    parts.push('</background-executions>\n');

    parts.push('\n\n<file-and-attachment-handling>\n');
    parts.push('Users may send files, images, documents, or voice messages. When they do, the message will include metadata like:\n');
    parts.push('`[Attachment: photo path="/path/to/file.jpg"]`\n');
    parts.push('You have dedicated file tools: `file_list`, `file_info`, `file_read_text`, `file_write_text`, `file_edit`, `file_delete`.\n');
    parts.push('Use these instead of shell commands for file operations — they are faster and sandbox-aware.\n');
    parts.push('For images: you can read image metadata, process images with CLI tools, or describe what you see if you have vision capabilities.\n');

    if (this.toolContext?.shell?.sandboxProvider && this.toolContext?.shell?.sandboxConfig) {
      const wsSkillsSandboxPath = effectiveWsId && this.toolContext?.configManager
        ? join(this.toolContext.configManager.getWorkspacePath(effectiveWsId), 'skills')
        : null;
      parts.push(buildSandboxContextBlock({
        sandboxName: this.toolContext.shell.sandboxProvider!.name,
        mounts: this.toolContext.shell.sandboxConfig!.mounts,
        networkAccess: this.toolContext.shell.sandboxConfig!.networkAccess,
        memoryLimitMb: this.toolContext.shell.sandboxConfig!.memoryLimitMb,
        wsWorkDir: wsWorkDir || null,
        wsSkillsPath: wsSkillsSandboxPath,
      }));
    }
    parts.push('</file-and-attachment-handling>\n');

    parts.push('\n\n<settings-management>\n');
    parts.push('You can read and modify your own settings using `settings_read` and `settings_update`.\n');
    parts.push('You can also read and modify your own system prompt using `agent_prompt_read` and `agent_prompt_write`.\n');

    if (this.toolContext?.delegationManager) {
      const wsIdForDelegation = workspaceId || this.toolContext.workspaceId;
      const delegations = this.toolContext.delegationManager.listForWorkspace(wsIdForDelegation);
      if (delegations.length > 0) {
        parts.push('\n## Mail Delegation\n');
        parts.push('You have delegated access to the following user email accounts. These are the USER\'s email accounts, NOT your bot channel.\n');
        for (const d of delegations) {
          const perms = [d.permissions.read ? 'READ' : '', d.permissions.send ? 'SEND' : ''].filter(Boolean).join(', ');
          parts.push(`- **${d.email}** (${d.provider}) — Permissions: ${perms}\n`);
        }
        parts.push('Use `mail_delegation_inbox`, `mail_delegation_read`, `mail_delegation_search` to read emails.\n');
        if (delegations.some(d => d.permissions.send)) {
          parts.push('Use `mail_delegation_reply` or `mail_delegation_send` to send emails as the user (only for accounts with SEND permission).\n');
        }
      }
    }
    parts.push('</settings-management>\n');

    const allModels = this.providerRegistry.listModelsWithRoles();
    if (allModels.length > 0) {
      parts.push('\n\n<available-models>\n');
      parts.push('These are the models you can reference when creating sub-agents:\n\n');
      for (const entry of allModels) {
        const roles = entry.model.roles?.length ? ` [${entry.model.roles.join(', ')}]` : '';
        parts.push(`- \`${entry.model.id}\` (provider: ${entry.providerId})${roles}\n`);
      }
      parts.push('\n</available-models>\n');
    }

    if (subAgents && subAgents.length > 0) {
      parts.push('\n\n<available-sub-agents>\n');
      parts.push('You have the following sub-agents available:\n\n');
      for (const sa of subAgents) {
        const modelInfo = sa.model ? ` (model: ${sa.model})` : '';
        parts.push(`- **${sa.name}** (id: \`${sa.id}\`)${modelInfo} — ${sa.description}\n`);
      }
      const baseUrl = process.env.KORA_BASE_URL || '';
      if (baseUrl) {
        const hasWebhook = subAgents.some(sa => sa.webhookToken);
        if (hasWebhook) {
          parts.push('\nSub-agent webhook URLs (external services can POST to these to trigger the agent):\n');
          for (const sa of subAgents) {
            if (sa.webhookToken) {
              parts.push(`- **${sa.name}**: \`${baseUrl}/api/webhook/subagent/${sa.webhookToken}\`\n`);
            }
          }
        }
      }
      parts.push('\n### How to use sub-agents\n');
      parts.push('1. Use `subagent_create` to create new specialized agents with an optional `model` parameter (does NOT execute them).\n');
      parts.push('2. Use `subagent_dispatch` to run tasks on one or more sub-agents **in parallel**.\n');
      parts.push('   - You can dispatch multiple tasks at once and they will all run concurrently.\n');
      parts.push('   - Always `notify` the user that you are delegating work before dispatching.\n');
      parts.push('   - The results from all sub-agents will be returned in the tool response.\n');
      parts.push('3. After receiving results, analyze them and `notify` the user with the combined outcome.\n');
      parts.push('\n You can also use `subagent_remove` to remove an agent by its agent_id if you no longer need it.\n');
      parts.push('</available-sub-agents>\n');
    }

    parts.push('\n\n<execution-strategy>\n');
    parts.push('Before taking action on any non-trivial request, ALWAYS think through a plan first:\n');
    parts.push('1. **Analyze** — Understand what the user is asking and what the expected outcome is.\n');
    parts.push('2. **Plan** — Break the task into concrete steps. Identify which tools you will need and in what order.\n');
    parts.push('3. **Notify** — Share your plan with the user briefly (e.g., "I\'ll do X, then Y, then Z") so they know what to expect.\n');
    parts.push('4. **Execute** — Follow the plan step by step, reporting progress as you go.\n');
    parts.push('5. **Verify** — Check your results before reporting completion.\n\n');
    parts.push('For simple questions or greetings, skip the plan and respond directly. The plan is for tasks that involve multiple steps, tool usage, or research.\n\n');
    parts.push('</execution-strategy>\n');

    parts.push('\n\n<communication-protocol>\n');
    parts.push('**The `notify` tool is the ONLY way to communicate with the user.** You MUST call `notify(message="...", reply_expected=true/false)` to send any information, progress updates, answers, or questions to the user.\n\n');

    if (channel === 'telegram') {
      parts.push('### Telegram Channel\n');
      parts.push('This conversation is happening over **Telegram**. The user can use these commands:\n');
      parts.push('- `/start` — Register or re-show welcome/subscription info\n');
      parts.push('- `/link email@example.com` — Link email and create a web portal account (a code will be sent to their email)\n');
      parts.push('- `/newsession` — Start a fresh conversation session\n');
      parts.push('- `/resetpassword` — Request a password reset code for the web portal\n');
      parts.push('- `/help` — Show available commands\n');
      parts.push('When relevant, you can suggest these commands to the user.\n\n');
    }

    if (channel === 'email') {
      parts.push('### Email Channel Notice\n');
      parts.push('This conversation is happening over **email**. Each `notify` message will be sent as a reply to the user\'s email thread.\n');
      parts.push('- **NEVER use `reply_expected=true`** — email is asynchronous and the user will not reply instantly. If you need more info, ask the question and call `finish()`. The user will reply in a new email.\n');
      parts.push('- Keep responses concise and well-formatted for email reading (plain text).\n');
      parts.push('- Consolidate your response into a **single `notify` call** rather than sending multiple emails.\n\n');
    }
    parts.push('</communication-protocol>\n');

    parts.push('\n\n<rules>\n');
    parts.push('- Call `notify` at least once before calling `finish()`. The user will NOT see any text you write in your response — only `notify` messages are delivered.\n');
    parts.push('- Use `notify` to report progress on multi-step tasks (e.g., "Searching for information...", "Found 3 results, analyzing...").\n');
    parts.push('- Use `notify` to deliver final answers and results.\n');
    parts.push('- Use `notify` to ask clarifying questions. After asking, call `finish()` so the user can reply.\n\n');
    parts.push('### Turn Control\n');
    parts.push('The agent loop continues automatically — you do NOT need to signal continuation. Just keep calling tools as needed.\n');
    parts.push('When the task is completed, call `finish(summary)` to end the session. The `summary` is an internal memory note only — it is NOT sent to the user. Always use `notify()` first to deliver your answer.\n');
    parts.push('If you need user input, use `notify(message, reply_expected=true)` so the user can reply.\n');
    parts.push('</rules>\n');

    parts.push('\n\n**IMPORTANT:**\n Use always the plan strategy described above. Do not deviate from it.\n');
    return parts.join('');
  }

  private emitLlmRequest(
    sessionId: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    settings: { defaultModel: string; defaultProvider?: string },
    iteration: number,
    auditOpts: Record<string, string>,
    reason?: string,
    model?: string,
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
    const toolSummary = tools.length > 0
      ? tools.map(t => ({ name: t.name, description: (t.description ?? '').slice(0, 120) }))
      : undefined;
    this.auditLog?.emit(sessionId, 'llm_request', {
      messageCount: messages.length,
      toolCount: tools.length,
      provider: settings.defaultProvider ?? 'unknown',
      model: model ?? settings.defaultModel,
      iteration,
      reason: reason ?? 'primary',
      messages: messageSummary,
      tools: toolSummary,
    }, auditOpts);
  }

  private emitLlmResponse(
    sessionId: string,
    response: import('./types.js').ChatResponse,
    durationMs: number,
    auditOpts: Record<string, string>,
    reason?: string,
    providerInfo?: { providerId?: string; model?: string },
  ): void {
    const hasTools = !!(response.toolCalls && response.toolCalls.length > 0);
    const rawContent = response.content ?? '';
    const visibleContent = stripThinkBlocks(rawContent);
    this.auditLog?.emit(sessionId, 'llm_response', {
      hasToolCalls: hasTools,
      toolCallCount: response.toolCalls?.length ?? 0,
      contentLength: rawContent.length,
      visibleContentLength: visibleContent.length,
      finishReason: response.finishReason,
      provider: providerInfo?.providerId ?? 'unknown',
      model: providerInfo?.model ?? 'unknown',
      contentPreview: rawContent.length > 0
        ? rawContent.slice(0, 500)
        : (hasTools ? '(tool calls only, no text)' : '(empty)'),
      reasoning: response.reasoning || null,
      toolNames: hasTools ? response.toolCalls!.map(tc => tc.name) : undefined,
      reason: reason ?? 'primary',
      usage: response.usage ?? null,
    }, { ...auditOpts, durationMs });
  }

  private fallbackSummary(toolResults: string[]): string {
    if (toolResults.length === 0) return 'Done.';

    const parts: string[] = ['I executed the requested operations. Here is a summary:'];
    for (const raw of toolResults) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.ok === false && parsed.error) {
          parts.push(`- Error: ${parsed.error}`);
        } else if (parsed.ok === true && parsed.message) {
          parts.push(`- ${parsed.message}`);
        } else if (parsed.stdout) {
          const out = String(parsed.stdout).trim().slice(0, 500);
          parts.push(`- Output: ${out}`);
        } else if (parsed.text) {
          parts.push(`- ${String(parsed.text).trim().slice(0, 500)}`);
        } else if (parsed.ok === true) {
          parts.push('- Completed successfully.');
        }
      } catch {
        const trimmed = raw.trim().slice(0, 500);
        if (trimmed) parts.push(`- ${trimmed}`);
      }
    }
    return parts.join('\n');
  }

  private errorResponse(event: IncomingEvent, content: string): OutgoingEvent {
    return {
      channel: event.channel,
      identityId: event.identityId,
      type: 'message',
      content,
      metadata: event.metadata,
    };
  }
}
