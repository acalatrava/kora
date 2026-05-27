import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import chalk from 'chalk';
import { getConfig } from '../core/config.js';
import { logger } from '../core/logger.js';
import { DatabaseManager } from '../core/database.js';
import { IdentityManager } from '../core/identity.js';
import { WorkspaceManager } from '../core/workspace.js';
import { MemoryManager } from '../core/memory.js';
import { Dispatcher, buildSandboxContextBlock, buildSkillContextBlock } from '../core/dispatcher.js';
import { Router } from '../core/router.js';
import { Heartbeat } from '../core/heartbeat.js';
import { AuditLog } from '../core/audit.js';
import { SubAgentManager } from '../core/sub-agent.js';
import { ToolApprovalManager } from '../core/tool-approval.js';
import type { ApprovalRequest } from '../core/tool-approval.js';
import { ProviderRegistry } from '../providers/registry.js';
import { SkillRegistry } from '../skills_runtime/registry.js';
import { PermissionManager } from '../skills_runtime/permissions.js';
import { TaskStore } from '../tasks/store.js';
import { TaskScheduler } from '../tasks/scheduler.js';
import { McpManager } from '../mcp/manager.js';
import { WebAdminServer } from '../web_admin/server.js';
import { ClientApi } from '../api/client-api.js';
import { TelegramChannel } from '../channels/telegram/index.js';
import { EmailChannel } from '../channels/email/index.js';
import { GmailChannel } from '../channels/gmail/index.js';
import { getToolDefinitionsForEnabled } from '../tools/index.js';
import type { ToolExecutionContext, EnabledTools } from '../tools/index.js';
import { DelegationManager } from '../tools/mail-delegation/index.js';
import { MailIndexer } from '../tools/mail-delegation/indexer.js';
import { UserManager } from '../core/user.js';
import { StripeManager } from '../billing/stripe.js';
import type { StripeConfig } from '../billing/stripe.js';
import { LLMProvider } from '../providers/base.js';
import { UsageTracker } from '../billing/usage.js';
import { SystemMailer } from '../core/system-mailer.js';
import type { TelegramChannelConfig, EmailChannelConfig, GmailChannelConfig, MqttChannelConfig, OutgoingEvent } from '../core/types.js';
import { SpeechToText, TextToSpeech } from '../tools/speech-tool.js';
import { detectSandboxProvider, probeSandboxAvailability } from '../tools/sandbox.js';
import type { SandboxProvider, SandboxStatus } from '../tools/sandbox.js';
import { OpenAIEmbeddingProvider, OpenAICompatEmbeddingProvider, SimpleEmbeddingProvider, LocalEmbeddingProvider } from '../core/vector-store.js';
import type { EmbeddingProvider } from '../core/vector-store.js';
import { AdminAuth } from '../core/admin-auth.js';
import { MqttChannel } from '../channels/mqtt/index.js';
import { closeBrowser } from '../tools/browser-tool.js';

const SCOPE = 'start';

const sessionMap = new Map<string, string>();
const heartbeatSessionIds = new Map<string, string>();
const lastChannelActivityByWorkspace = new Map<string, number>();
const mainSessionKeys = new Map<string, string>();
const HEARTBEAT_IDLE_THRESHOLD_MS = 10 * 60 * 1000;
let sessionFilePath = '';

const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const pendingLinks = new Map<string, { code: string; chatId: number; expiresAt: number }>();

interface EmailThreadInfo {
  subject: string;
  messageId?: string;
  emailMessageId?: string;
  threadId?: string;
}
const emailThreadStore = new Map<string, EmailThreadInfo>();

function emailSessionId(historyKey: string): string {
  const h = createHash('sha256').update(historyKey).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function loadSessionMap(storagePath: string): void {
  sessionFilePath = path.join(storagePath, 'sessions.json');
  try {
    if (fs.existsSync(sessionFilePath)) {
      const raw = fs.readFileSync(sessionFilePath, 'utf-8');
      const data = JSON.parse(raw) as { sessions?: Record<string, string>; heartbeat?: Record<string, string>; mainSessions?: Record<string, string> };
      if (data.sessions) {
        for (const [k, v] of Object.entries(data.sessions)) sessionMap.set(k, v);
      }
      if (data.heartbeat) {
        for (const [k, v] of Object.entries(data.heartbeat)) heartbeatSessionIds.set(k, v);
      }
      if (data.mainSessions) {
        for (const [k, v] of Object.entries(data.mainSessions)) mainSessionKeys.set(k, v);
      }
      logger.info(SCOPE, `Loaded ${sessionMap.size} sessions, ${heartbeatSessionIds.size} heartbeat, ${mainSessionKeys.size} main sessions`);
    }
  } catch (err) {
    logger.warn(SCOPE, `Failed to load sessions: ${(err as Error).message}`);
  }
}

function saveSessionMap(): void {
  if (!sessionFilePath) return;
  try {
    const sessions: Record<string, string> = {};
    for (const [k, v] of sessionMap) sessions[k] = v;
    const heartbeat: Record<string, string> = {};
    for (const [k, v] of heartbeatSessionIds) heartbeat[k] = v;
    const mainSessions: Record<string, string> = {};
    for (const [k, v] of mainSessionKeys) mainSessions[k] = v;
    fs.writeFileSync(sessionFilePath, JSON.stringify({ sessions, heartbeat, mainSessions }), 'utf-8');
  } catch (err) {
    logger.warn(SCOPE, `Failed to persist sessions: ${(err as Error).message}`);
  }
}

function getOrCreateSession(key: string): { sessionId: string; isNew: boolean } {
  const existing = sessionMap.get(key);
  if (existing) return { sessionId: existing, isNew: false };
  const id = crypto.randomUUID();
  sessionMap.set(key, id);
  saveSessionMap();
  return { sessionId: id, isNew: true };
}

function resetSession(key: string): string {
  const id = crypto.randomUUID();
  sessionMap.set(key, id);
  saveSessionMap();
  return id;
}

export async function runStart(): Promise<void> {
  const config = getConfig();
  const startTime = Date.now();

  if (!config.isConfigured()) {
    console.log(chalk.yellow('Kora is not configured. Run `kora setup` first.'));
    process.exit(1);
  }

  const settings = config.loadSettings();
  logger.setLevel(settings.logLevel);
  loadSessionMap(settings.storagePath);

  console.log(chalk.cyan.bold('\n  Starting Kora...\n'));

  const dataDir = path.join(settings.storagePath, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'korabot.db');
  const database = new DatabaseManager(dbPath);
  database.initialize();
  logger.info(SCOPE, 'Database initialized');

  const auditLog = new AuditLog(database.db);
  logger.info(SCOPE, 'Audit log initialized');

  const toolApproval = new ToolApprovalManager(database.db);
  logger.info(SCOPE, 'Tool approval manager initialized');

  const providerConfigs = config.loadProviders();
  const providerRegistry = ProviderRegistry.fromConfig(providerConfigs);
  if (settings.defaultProvider) {
    try {
      providerRegistry.setDefault(settings.defaultProvider);
    } catch {
      logger.warn(SCOPE, `Default provider "${settings.defaultProvider}" not available, using first registered`);
    }
  }
  logger.info(SCOPE, `${providerConfigs.length} provider(s) loaded`);

  const skillRegistry = new SkillRegistry();
  try {
    skillRegistry.loadFromDirectory(config.skillsPath);
  } catch {
    logger.info(SCOPE, 'No skills found or skills directory empty');
  }

  const identityManager = new IdentityManager(database);
  const workspaceManager = new WorkspaceManager(database, config);
  const memoryManager = new MemoryManager(config);
  const permissionManager = new PermissionManager(database);

  if (!settings.multiUser) {
    workspaceManager.ensureDefault();
    logger.info(SCOPE, 'Default workspace ensured');
  }

  const userManager = new UserManager(database);

  let stripeManager: StripeManager | undefined;
  const billingEnabled = !!settings.billing?.enabled;
  const stripeSecretKey = settings.billing?.stripe?.secretKey || process.env.STRIPE_SECRET_KEY;
  const stripeWebhookSecret = settings.billing?.stripe?.webhookSecret || process.env.STRIPE_WEBHOOK_SECRET;
  if (stripeSecretKey && stripeWebhookSecret) {
    const stripeConfig: StripeConfig = {
      secretKey: stripeSecretKey,
      webhookSecret: stripeWebhookSecret,
      priceId: settings.billing?.stripe?.priceId || process.env.STRIPE_PRICE_ID || '',
      portalConfigId: settings.billing?.stripe?.portalConfigId || process.env.STRIPE_PORTAL_CONFIG_ID,
      baseUrl: process.env.KORA_BASE_URL || `http://localhost:${settings.web_admin?.port || 3100}`,
    };
    stripeManager = new StripeManager(stripeConfig, userManager, workspaceManager, identityManager);
    const isTestMode = settings.billing?.stripe?.testMode || stripeSecretKey.startsWith('sk_test_');
    logger.info(SCOPE, `Stripe billing initialized${isTestMode ? ' (TEST MODE)' : ''}`);
  }

  if (billingEnabled) {
    LLMProvider.setSubscriptionChecker((wsId: string) => {
      const ws = workspaceManager.get(wsId);
      if (!ws?.ownerUserId) return true;
      const owner = userManager.getById(ws.ownerUserId);
      if (!owner) return true;
      if (owner.subscriptionStatus === 'active') return true;
      const wsIdentities = identityManager.getByWorkspace(wsId);
      for (const ident of wsIdentities) {
        if (ident.userId && ident.userId !== ws.ownerUserId) {
          const linkedUser = userManager.getById(ident.userId);
          if (linkedUser?.subscriptionStatus === 'active') return true;
        }
      }
      return false;
    });
    logger.info(SCOPE, 'Subscription gate enabled -- LLM calls require active subscription');
  }

  const usageTracker = new UsageTracker(database.db, settings.billing);
  LLMProvider.setDailyLimitChecker((wsId: string, model?: string) => {
    const ws = workspaceManager.get(wsId);
    if (!ws?.ownerUserId) return { allowed: true };
    return usageTracker.canMakeCall(ws.ownerUserId, model);
  });

  const systemMailer = SystemMailer.resolve(settings.storagePath);
  if (systemMailer) {
    logger.info(SCOPE, 'System mailer initialized (env vars or config/system-smtp.json)');
  } else if (settings.multiUser) {
    logger.warn(SCOPE, 'Multi-user mode active but no system SMTP configured. Set SYSTEM_SMTP_* or config/system-smtp.json for email verification and password reset.');
  }

  const mcpManager = new McpManager(config.toolsPath);

  const dispatcher = new Dispatcher({
    providerRegistry,
    skillRegistry,
    identityManager,
    workspaceManager,
    memoryManager,
    config,
    permissionManager,
  });
  dispatcher.setAuditLog(auditLog);
  dispatcher.setToolApproval(toolApproval);
  if (settings.multiUser) dispatcher.setUserManager(userManager);

  if (billingEnabled && stripeManager) {
    const sm = stripeManager;
    dispatcher.setSubscriptionErrorHandler(async (wsId) => {
      const ident = identityManager.listByWorkspace(wsId).find(i => i.channel === 'telegram');
      const chatId = ident?.channelUserId?.replace(/^telegram:/, '');
      if (chatId && sm) {
        try {
          const url = await sm.createTelegramCheckoutSession(chatId);
          return `⚠️ Your subscription is not active.\n\n<a href="${url}">👉 Subscribe here</a> to continue using the AI agent.`;
        } catch { /* fall through to default */ }
      }
      return '⚠️ Your subscription is not active. Please subscribe to continue using the AI agent. Use /start to get a subscription link.';
    });
  }

  const embeddingConfig = settings.embedding;
  let embeddingProvider: EmbeddingProvider | null = null;

  if (embeddingConfig?.provider === 'openai' || embeddingConfig?.provider === 'auto' || !embeddingConfig) {
    const key = embeddingConfig?.apiKey || providerConfigs.find(p => p.type === 'openai' && p.apiKey)?.apiKey;
    if (key) {
      const model = embeddingConfig?.model || 'text-embedding-3-small';
      embeddingProvider = new OpenAIEmbeddingProvider(key, model);
      logger.info(SCOPE, `Using OpenAI embedding provider (model: ${model})`);
    }
  }

  if (!embeddingProvider && embeddingConfig?.provider === 'openai_compat' && embeddingConfig.baseUrl) {
    const model = embeddingConfig.model || 'nomic-embed-text';
    embeddingProvider = new OpenAICompatEmbeddingProvider(
      embeddingConfig.baseUrl, model, embeddingConfig.apiKey,
    );
    logger.info(SCOPE, `Using OpenAI-compatible embedding provider (${embeddingConfig.baseUrl}, model: ${model})`);
  }

  if (!embeddingProvider && embeddingConfig?.provider === 'local') {
    const model = 'Xenova/all-MiniLM-L6-v2';
    embeddingProvider = new LocalEmbeddingProvider(model);
    logger.info(SCOPE, `Using local ML embedding provider (${model})`);
  }

  if (!embeddingProvider) {
    const openaiKey = providerConfigs.find(p => p.type === 'openai' && p.apiKey)?.apiKey;
    if (openaiKey) {
      embeddingProvider = new OpenAIEmbeddingProvider(openaiKey);
      logger.info(SCOPE, 'Using OpenAI embedding provider (auto-detected from providers)');
    } else {
      embeddingProvider = new LocalEmbeddingProvider();
      logger.info(SCOPE, 'Using local ML embedding provider (all-MiniLM-L6-v2)');
    }
  }

  dispatcher.setEmbeddingProvider(embeddingProvider);

  const taskStore = new TaskStore(database.db);
  taskStore.initialize();
  const scheduler = new TaskScheduler(taskStore);

  const toolSettings = settings.tools || {};
  const enabledTools: EnabledTools = {
    scheduler: toolSettings.scheduler !== false,
    mail: toolSettings.mail === true,
    mail_delegation: toolSettings.mail_delegation === true,
    browser: toolSettings.browser !== false,
    web_search: toolSettings.web_search === true,
    homeassistant_mqtt: toolSettings.homeassistant_mqtt === true,
    shell: toolSettings.shell === true,
    mcp: toolSettings.mcp !== false,
    subagents: true,
    settings: toolSettings.settings !== false,
    identity: toolSettings.identity !== false,
    web_fetch: toolSettings.web_fetch === true,
  };

  const channelConfigs = config.loadChannels();

  const delegationGlobalConfig: Record<string, unknown> = { ...(settings.mail_delegation || {}) };
  if (!delegationGlobalConfig.google_client_id || !delegationGlobalConfig.google_client_secret) {
    const gmailCh = channelConfigs.find(c => c.type === 'gmail');
    if (gmailCh) {
      const cfg = gmailCh.config as unknown as Record<string, unknown>;
      if (cfg.clientId) delegationGlobalConfig.google_client_id = cfg.clientId;
      if (cfg.clientSecret) delegationGlobalConfig.google_client_secret = cfg.clientSecret;
    }
  }
  const delegationManager = new DelegationManager(database.db, delegationGlobalConfig);
  if (delegationManager.listAll().length > 0) {
    enabledTools.mail_delegation = true;
  }

  const { ContentGuard } = await import('../core/content-guard.js');
  const contentGuard = new ContentGuard(embeddingProvider);
  contentGuard.initialize().catch(err => {
    logger.error(SCOPE, `ContentGuard initialization failed: ${(err as Error).message}`);
  });

  const mailIndexer = new MailIndexer(database.db, delegationManager, config, embeddingProvider, contentGuard);

  if (enabledTools.mail_delegation) {
    const allDelegations = delegationManager.listAll();
    const workspaceIds = [...new Set(allDelegations.map(d => d.workspaceId))];
    for (const wsId of workspaceIds) {
      const wsSettings = config.loadWorkspaceSettings(wsId) as unknown as Record<string, unknown>;
      const security = wsSettings.mail_delegation_security as Record<string, unknown> | undefined;
      if (security?.sensitiveMailFilter !== undefined) {
        mailIndexer.setSensitiveMailFilter(security.sensitiveMailFilter !== false);
      }
      mailIndexer.startIndexing(wsId).catch(err => {
        logger.error(SCOPE, `Mail indexer start failed for workspace ${wsId}: ${(err as Error).message}`);
      });
    }
    logger.info(SCOPE, `Mail indexer started for ${workspaceIds.length} workspace(s)`);
  }
  let emailChannelInstance: EmailChannel | undefined;
  let gmailChannelInstance: GmailChannel | undefined;

  for (const channelCfg of channelConfigs) {
    if (!channelCfg.enabled) continue;
    if (channelCfg.type === 'email') {
      const emailConfig = channelCfg.config as EmailChannelConfig;
      emailChannelInstance = new EmailChannel(emailConfig, {
        onMessage: () => Promise.resolve(),
      });
      enabledTools.mail = true;
    }
    if (channelCfg.type === 'gmail') {
      enabledTools.mail = true;
    }
  }

  const screenshotDir = path.join(settings.storagePath, 'screenshots');

  const allToolDefs = getToolDefinitionsForEnabled(enabledTools, mcpManager);
  const subAgentManager = new SubAgentManager(config, providerRegistry, allToolDefs);
  subAgentManager.initDb(database.db);
  subAgentManager.setToolExecutor(async (toolCall, workspaceId) => {
    return dispatcher.executeToolCall(toolCall, workspaceId);
  });
  subAgentManager.setAuditLog(auditLog);
  subAgentManager.setBaseContextBuilder((wsId: string) => {
    const parts: string[] = [];

    parts.push('You are a sub-agent — an isolated worker executing a specific task on behalf of the main agent.');
    parts.push('You do NOT have access to user memories or conversation history. Focus solely on the task assigned to you.');
    parts.push('You have access to all workspace tools and skills. Use them as needed to complete your task.');
    parts.push('When done, call `task_report()` with your results. Do NOT use `notify` or `finish`.\n');
    parts.push('## Execution Strategy\n');
    parts.push('Before taking action, plan your approach:');
    parts.push('1. Analyze the task and identify what needs to be done.');
    parts.push('2. Break it into concrete steps and identify which tools you will need.');
    parts.push('3. Execute step by step, verifying results as you go.');
    parts.push('4. Report results via `task_report()` when complete.\n');

    // Do not use global agent prompt
    /*
    const globalMd = config.loadAgentMd() || '';
    const wsMd = config.loadWorkspaceAgentMd(wsId) || '';
    if (globalMd) parts.push(globalMd);
    if (wsMd) parts.push(wsMd);
    */

    parts.push(buildSkillContextBlock({
      skillRegistry: skillRegistry,
      workspaceId: wsId,
    }));

    const shellCtx = dispatcher.getToolContext()?.shell;
    if (shellCtx?.sandboxProvider && shellCtx?.sandboxConfig) {
      const wsWorkDir = path.join(config.getWorkspacePath(wsId), 'work');
      const wsSkillsSandboxPath = path.join(config.getWorkspacePath(wsId), 'skills');
      parts.push(buildSandboxContextBlock({
        sandboxName: shellCtx.sandboxProvider.name,
        mounts: shellCtx.sandboxConfig.mounts,
        networkAccess: shellCtx.sandboxConfig.networkAccess,
        memoryLimitMb: shellCtx.sandboxConfig.memoryLimitMb,
        wsWorkDir,
        wsSkillsPath: wsSkillsSandboxPath,
      }));
    }

    return parts.join('\n');
  });

  let sandboxProvider: SandboxProvider | null = null;
  let sandboxStatus: SandboxStatus | null = null;
  const sandboxCfg = settings.shell_sandbox;
  if (enabledTools.shell && sandboxCfg?.containerEnabled) {
    sandboxProvider = await detectSandboxProvider({
      backend: sandboxCfg.backend ?? 'auto',
      dockerKeepAliveSec: sandboxCfg.dockerKeepAlive ?? 0,
    });
    if (sandboxProvider) {
      logger.info(SCOPE, `Shell sandbox active: ${sandboxProvider.name}`);
    } else {
      logger.warn(SCOPE, 'Shell sandbox enabled in config but no backend available — commands will run unsandboxed');
    }
  }
  if (enabledTools.shell) {
    sandboxStatus = await probeSandboxAvailability();
  }

  const toolContext: ToolExecutionContext = {
    workspaceId: '',
    taskStore,
    taskScheduler: scheduler,
    emailChannel: emailChannelInstance,
    delegationManager,
    contentGuard,
    sensitiveMailFilter: true,
    screenshotDir,
    webSearch: toolSettings.web_search_api_key
      ? { apiKey: toolSettings.web_search_api_key as string, engine: (toolSettings.web_search_engine || 'brave') as 'brave' | 'google' }
      : undefined,
    homeAssistant: (toolSettings.ha_url && toolSettings.ha_token)
      ? { haUrl: toolSettings.ha_url as string, haToken: toolSettings.ha_token as string }
      : undefined,
    shell: enabledTools.shell
      ? {
        workingDirectory: settings.storagePath,
        allowedPaths: sandboxCfg?.allowedPaths?.length
          ? [...new Set([...sandboxCfg.allowedPaths, settings.storagePath, '/tmp'])]
          : undefined,
        customEnv: sandboxCfg?.customEnv,
        sandboxProvider: sandboxProvider ?? undefined,
        sandboxConfig: sandboxProvider ? {
          mounts: sandboxCfg?.mounts ?? [],
          networkAccess: sandboxCfg?.networkAccess ?? false,
          memoryLimitMb: sandboxCfg?.memoryLimitMb ?? 512,
          image: sandboxCfg?.dockerImage,
          storagePath: settings.storagePath,
        } : undefined,
      }
      : undefined,
    mcpManager,
    subAgentManager,
    memoryManager,
    configManager: config,
    skillRegistry,
    skillsDir: config.skillsPath,
    dbManager: database,
    multiUserMode: settings.multiUser,
  };

  dispatcher.setToolContext(toolContext);
  dispatcher.setEnabledTools(enabledTools);
  dispatcher.setMcpManager(mcpManager);

  let sttInstance: SpeechToText | undefined;
  let ttsInstance: TextToSpeech | undefined;

  if (toolSettings.stt) {
    sttInstance = new SpeechToText({
      modelName: toolSettings.stt_model || 'base',
      storagePath: settings.storagePath,
    });
    dispatcher.setSpeechToText(sttInstance);
    logger.info(SCOPE, `STT enabled (model: ${toolSettings.stt_model || 'base'})`);
  }

  if (toolSettings.tts) {
    ttsInstance = new TextToSpeech({
      voiceKey: toolSettings.tts_voice || 'es_ES-davefx-medium',
      storagePath: settings.storagePath,
    });
    logger.info(SCOPE, `TTS enabled (voice: ${toolSettings.tts_voice || 'es_ES-davefx-medium'})`);
  }

  const enabledToolNames = Object.entries(enabledTools)
    .filter(([, v]) => v)
    .map(([k]) => k);
  logger.info(SCOPE, `Tools enabled: ${enabledToolNames.join(', ') || 'none'}`);

  if (enabledTools.mcp !== false) {
    try {
      await mcpManager.connectAll();
      const mcpToolCount = mcpManager.getToolDefinitions().length;
      if (mcpManager.getConnectedCount() > 0) {
        logger.info(SCOPE, `MCP: ${mcpManager.getConnectedCount()} server(s) connected, ${mcpToolCount} tool(s) available`);
      }
    } catch (err) {
      logger.warn(SCOPE, `MCP connect error: ${(err as Error).message}`);
    }
  }

  const router = new Router(dispatcher);

  const activeChannels: Array<{ name: string; stop: () => Promise<void> }> = [];
  let telegramInstance: TelegramChannel | undefined;
  const knownTelegramChatIds = new Set<string>();
  const workspaceTelegramIds = new Map<string, Set<string>>();
  const privateTelegramChatIds = new Set<string>();

  const registerChatForWorkspace = (chatId: string, wsId: string, isGroup = false) => {
    knownTelegramChatIds.add(chatId);
    let set = workspaceTelegramIds.get(wsId);
    if (!set) { set = new Set(); workspaceTelegramIds.set(wsId, set); }
    set.add(chatId);
    if (!isGroup) {
      privateTelegramChatIds.add(chatId);
    }
  };

  const getChatIdsForWorkspace = (wsId: string): string[] => {
    const wsSet = workspaceTelegramIds.get(wsId);
    if (wsSet && wsSet.size > 0) return [...wsSet];
    if (settings.multiUser) return [];
    return [...knownTelegramChatIds];
  };

  const getPrivateChatIdsForWorkspace = (wsId: string): string[] => {
    const all = getChatIdsForWorkspace(wsId);
    return all.filter(id => privateTelegramChatIds.has(id));
  };

  const sendTaskResultToTelegram = async (taskName: string, content: string, taskWorkspaceId?: string) => {
    if (!telegramInstance || !content) return;
    if (!taskWorkspaceId && !settings.multiUser) {
      taskWorkspaceId = workspaceManager.ensureDefault().id;
    }
    if (!taskWorkspaceId) return;
    const chatIds = getPrivateChatIdsForWorkspace(taskWorkspaceId);
    const formattedContent = `📅 Task "${taskName}"\n\n${content}`;
    for (const chatId of chatIds) {
      await telegramInstance.send(chatId, `<b>📅 Task "${taskName}"</b>\n\n${content}`);
    }
    const mainKey = mainSessionKeys.get(taskWorkspaceId);
    if (mainKey) {
      dispatcher.injectMessage(mainKey, 'assistant', formattedContent);
    }
  };

  scheduler.start(async (task) => {
    logger.info(SCOPE, `Executing scheduled task "${task.name}"`);
    if (!task.prompt) {
      logger.warn(SCOPE, `Task "${task.name}" has no prompt, skipping`);
      return;
    }

    if (settings.multiUser && task.workspaceId) {
      const ws = workspaceManager.get(task.workspaceId);
      if (ws?.ownerUserId) {
        const owner = userManager.getById(ws.ownerUserId);
        if (owner?.status === 'suspended') {
          logger.info(SCOPE, `Skipping task "${task.name}" — owner ${ws.ownerUserId} is suspended`);
          return;
        }
      }
    }

    const taskSessionKey = `task:${task.id}`;
    const { sessionId } = getOrCreateSession(taskSessionKey);

    const event: import('../core/types.js').IncomingEvent = {
      channel: 'internal',
      identityId: `scheduler:${task.id}`,
      type: 'message' as const,
      content: task.prompt,
      metadata: { taskId: task.id, taskName: task.name, sessionId, historyKey: taskSessionKey, workspaceId: task.workspaceId },
      sendInterimMessage: async (text: string) => {
        await sendTaskResultToTelegram(task.name, text, task.workspaceId);
      },
      waitForReply: async (timeoutMs: number) => {
        const wsId = task.workspaceId;
        if (!wsId) return null;
        const chatIds = getPrivateChatIdsForWorkspace(wsId);
        if (chatIds.length === 0) return null;
        const targets = chatIds.map(cid => ({
          channel: 'telegram',
          identityId: `telegram:${cid}`,
        }));
        return router.waitForReplyFromAny(targets, timeoutMs);
      },
      setTyping: () => { },
    };

    try {
      const response = await dispatcher.handleIncomingEvent(event);
      logger.info(SCOPE, `Task "${task.name}" result (marker=${response.metadata?.marker ?? 'none'}): ${response.content.slice(0, 200)}`);
      if (response.content) {
        await sendTaskResultToTelegram(task.name, response.content, task.workspaceId);
      }
    } catch (err) {
      logger.error(SCOPE, `Task "${task.name}" execution failed: ${(err as Error).message}`);
    } finally {
      dispatcher.clearHistory(taskSessionKey);
    }
  });
  logger.info(SCOPE, `Scheduler started with ${scheduler.activeJobCount} active job(s)`);

  const heartbeatSettings = settings.heartbeat || { enabled: true, intervalMinutes: 5 };
  const heartbeat = new Heartbeat(config, {
    enabled: heartbeatSettings.enabled,
    intervalMs: (heartbeatSettings.intervalMinutes || 5) * 60 * 1000,
  });

  const getStatusFn = (): Record<string, unknown> => ({
    provider: settings.defaultProvider,
    model: settings.defaultModel,
    channels: activeChannels.length,
    toolCount: enabledToolNames.length,
    mcpCount: mcpManager.getConnectedCount(),
    schedulerJobs: scheduler.activeJobCount,
    heartbeat: heartbeat.getStatus().enabled ? 'active' : 'disabled',
    uptime: formatUptime(Date.now() - startTime),
    subAgents: subAgentManager.list().length,
    unlimitedMode: toolApproval.unlimitedMode,
  });

  const getEnabledToolsFn = (): string[] => {
    const tools = [...enabledToolNames];
    const mcpTools = mcpManager.getAllMcpToolNames();
    tools.push(...mcpTools);
    return tools;
  };

  const getHistoryFn = (workspaceId: string): Array<Record<string, unknown>> => {
    const history = dispatcher.getHistory(workspaceId || 'default');
    return history.map((msg, i) => ({
      id: i,
      role: msg.role,
      content: msg.content,
    }));
  };

  for (const channelCfg of channelConfigs) {
    if (!channelCfg.enabled) continue;

    if (channelCfg.type === 'telegram') {
      const tgConfig = channelCfg.config as TelegramChannelConfig;
      const telegram = new TelegramChannel(tgConfig.token, {
        allowedChatIds: tgConfig.allowedChatIds,
        onMessage: (event) => {
          const chatId = event.metadata?.chatId;
          if (chatId) {
            const identity = identityManager.resolve('telegram', event.identityId);
            if (!identity && settings.multiUser) {
              return Promise.reject(new Error('Not registered. Send /start first.'));
            }
            const wsId = identity?.workspaceId
              ?? (settings.multiUser ? undefined : workspaceManager.ensureDefault().id);
            if (wsId) {
              registerChatForWorkspace(String(chatId), wsId, !!event.metadata?.isGroup);
              lastChannelActivityByWorkspace.set(wsId, Date.now());
              event.metadata = { ...event.metadata, workspaceId: wsId };
            }
          }
          const replyTo = event.metadata?.replyTo as { chatId: number; threadId?: number } | undefined;
          if (replyTo && telegram) {
            event.sendFile = async (filePath: string, options?: { caption?: string; type?: 'photo' | 'document' }) => {
              await telegram.sendFile(replyTo.chatId, filePath, { ...options, threadId: replyTo.threadId });
            };
            event.setTyping = (active: boolean) => {
              if (active) telegram.sendTypingAction(replyTo.chatId, replyTo.threadId).catch(() => { });
            };
          }
          const tgChatId = event.metadata?.chatId;
          const tgThreadId = event.metadata?.threadId as number | undefined;
          const isGroup = !!event.metadata?.isGroup;
          const chatTitle = event.metadata?.chatTitle as string | undefined;
          const chatContextKey = tgThreadId
            ? `tg-chat:${tgChatId}:thread:${tgThreadId}`
            : `tg-chat:${tgChatId}`;
          const { sessionId } = getOrCreateSession(chatContextKey);
          event.metadata = {
            ...event.metadata,
            sessionId,
            historyKey: chatContextKey,
            routingKey: chatContextKey,
            chatContext: { type: isGroup ? 'group' : 'private', chatId: tgChatId, threadId: tgThreadId, chatTitle },
          };
          const wsId = event.metadata?.workspaceId as string | undefined;
          if (wsId && !isGroup) {
            mainSessionKeys.set(wsId, chatContextKey);
            saveSessionMap();
          }
          return router.handleEvent(event);
        },
        getStatus: getStatusFn,
        getTaskList: (wsId?: string) => {
          const tasks = wsId ? taskStore.list(wsId) : taskStore.listAll();
          return tasks.map(t => ({ ...t }) as Record<string, unknown>);
        },
        resolveWorkspaceForChat: (chatId: number) => {
          const identityId = `telegram:${chatId}`;
          const identity = identityManager.resolve('telegram', identityId);
          if (identity?.workspaceId) return identity.workspaceId;
          if (!settings.multiUser) return workspaceManager.ensureDefault().id;
          return undefined as unknown as string;
        },
        getSubAgents: (wsId?: string) => {
          return subAgentManager.list(wsId).map(sa => ({
            id: sa.id,
            name: sa.name,
            description: sa.description || sa.systemPrompt?.slice(0, 120),
            model: sa.model,
            status: sa.status,
            lastRun: sa.lastRunAt,
          }));
        },
        getSkills: (wsId?: string) => {
          if (wsId) {
            const wsSkillsDir = path.join(config.getWorkspacePath(wsId), 'skills');
            skillRegistry.loadWorkspaceSkills(wsId, wsSkillsDir);
          }
          return skillRegistry.list(wsId).map(s => ({
            name: String(s.name ?? ''),
            description: s.description ? String(s.description) : undefined,
            version: s.version != null ? String(s.version) : undefined,
          }));
        },
        getEnabledTools: getEnabledToolsFn,
        getMcpServers: () => mcpManager.listServers().map(s => ({ name: s.name, enabled: s.enabled, source: s.source })),
        getHeartbeatStatus: () => {
          const s = heartbeat.getStatus();
          return { ...s, lastRunAt: s.lastRunAt?.toISOString() ?? null };
        },
        getSettings: () => {
          const s = config.loadSettings();
          const { storagePath: _, ...rest } = s;
          return rest as unknown as Record<string, unknown>;
        },
        clearHistory: (chatContextKey) => {
          dispatcher.clearHistory(chatContextKey);
        },
        resetSession: (chatContextKey) => {
          dispatcher.clearHistory(chatContextKey);
          resetSession(chatContextKey);
        },
        onApproval: (approvalId, decision) => {
          return toolApproval.resolveApproval(approvalId, decision as import('../core/tool-approval.js').ApprovalDecision);
        },
        getPermissions: (chatId?: number) => {
          let wsId: string | undefined;
          if (chatId) {
            const ident = identityManager.resolve('telegram', `telegram:${chatId}`);
            wsId = ident?.workspaceId ?? undefined;
          }
          if (!wsId) wsId = settings.multiUser ? '' : workspaceManager.ensureDefault().id;
          return wsId ? toolApproval.listApprovals(wsId) : [];
        },
        revokePermission: (toolName, chatId?: number) => {
          let wsId: string | undefined;
          if (chatId) {
            const ident = identityManager.resolve('telegram', `telegram:${chatId}`);
            wsId = ident?.workspaceId ?? undefined;
          }
          if (!wsId) wsId = settings.multiUser ? '' : workspaceManager.ensureDefault().id;
          if (wsId) toolApproval.revokeApproval(toolName, wsId);
        },
        isUnlimitedMode: () => toolApproval.unlimitedMode,
        setUnlimitedMode: (enabled) => toolApproval.setUnlimitedMode(enabled),
        getWebAdminUrl: () => {
          const waSettings = config.loadSettings().web_admin || { enabled: false, port: 3100 };
          return waSettings.enabled ? `http://localhost:${waSettings.port}/admin` : null;
        },
        setWebAdminCredentials: async (username, password) => {
          await adminAuth.setCredentials(username, password);
        },
        clearAdmin2FA: () => {
          adminAuth.clear2FA();
        },
        updateSetting: (key, value) => {
          const current = config.loadSettings();
          const parts = key.split('.');
          let target: Record<string, unknown> = current as unknown as Record<string, unknown>;
          for (let i = 0; i < parts.length - 1; i++) {
            if (typeof target[parts[i]] !== 'object' || target[parts[i]] === null) {
              target[parts[i]] = {};
            }
            target = target[parts[i]] as Record<string, unknown>;
          }
          const lastKey = parts[parts.length - 1];
          if (value === 'true') target[lastKey] = true;
          else if (value === 'false') target[lastKey] = false;
          else if (!isNaN(Number(value))) target[lastKey] = Number(value);
          else target[lastKey] = value;
          config.saveSettings(current);
        },
        onCallback: async (action, entity, param) => {
          if (action !== 'task') return null;
          const task = taskStore.get(param);
          if (!task) return `Task not found: ${param}`;
          switch (entity) {
            case 'pause':
              taskStore.setEnabled(task.id, false);
              scheduler.unschedule(task.id);
              return `⏸ Task "<b>${task.name}</b>" paused.`;
            case 'resume':
              taskStore.setEnabled(task.id, true);
              scheduler.schedule(task, scheduler.getDefaultHandler()!);
              return `▶ Task "<b>${task.name}</b>" resumed.`;
            case 'run': {
              const handler = scheduler.getDefaultHandler();
              if (!handler) return 'No task handler configured.';
              scheduler.runNow(task.id, handler).catch(err =>
                logger.error(SCOPE, `Run now failed: ${(err as Error).message}`));
              return `🚀 Task "<b>${task.name}</b>" triggered. Results will follow.`;
            }
            case 'delete':
              scheduler.unschedule(task.id);
              taskStore.delete(task.id);
              return `🗑 Task "<b>${task.name}</b>" deleted.`;
            case 'detail': {
              const logs = taskStore.getTaskLogs(task.id, 5);
              const lines = [
                `<b>📋 ${task.name}</b>`,
                '',
                `ID: <code>${task.id}</code>`,
                `Status: ${task.enabled ? '▶ Active' : '⏸ Paused'}`,
                `Cron: <code>${task.cronExpression}</code>`,
                `Prompt: ${task.prompt || '(none)'}`,
                `Last run: <code>${task.lastRun ? new Date(task.lastRun).toLocaleString() : 'never'}</code>`,
                `Created: <code>${task.createdAt ? new Date(task.createdAt).toLocaleString() : 'unknown'}</code>`,
              ];
              if (logs.length > 0) {
                lines.push('', '<b>Recent Executions:</b>');
                for (const l of logs) {
                  const log = l as unknown as { status: string; startedAt: Date; output?: string; error?: string };
                  const icon = log.status === 'success' ? '✅' : '❌';
                  const logDate = log.startedAt instanceof Date ? log.startedAt : new Date(String(log.startedAt));
                  lines.push(`${icon} ${isNaN(logDate.getTime()) ? 'unknown' : logDate.toLocaleString()} — ${log.status}`);
                  if (log.error) lines.push(`  Error: ${(log.error).slice(0, 100)}`);
                }
              }
              return lines.join('\n');
            }
            default:
              return null;
          }
        },
        onLinkRequest: async (chatId: number, email: string): Promise<string> => {
          if (!emailChannelInstance && !gmailChannelInstance) {
            return '❌ No email channel is configured. Cannot send verification code.';
          }

          const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
          let code = '';
          for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));

          const key = `${chatId}:${email}`;
          pendingLinks.set(key, { code, chatId, expiresAt: Date.now() + LINK_CODE_TTL_MS });

          try {
            const sender = emailChannelInstance || gmailChannelInstance!;
            await sender.send(email, 'Kora — Identity Verification Code', [
              `Your verification code is: ${code}`,
              '',
              'Enter this code in Telegram with:',
              `/link ${email} ${code}`,
              '',
              'This code expires in 10 minutes.',
            ].join('\n'));
            logger.info(SCOPE, `Sent identity link verification code to ${email} for chat ${chatId}`);
            return `✅ Verification code sent to <code>${email}</code>.\n\nCheck your inbox and then run:\n<code>/link ${email} CODE</code>`;
          } catch (err) {
            logger.error(SCOPE, `Failed to send link verification to ${email}: ${(err as Error).message}`);
            return `❌ Failed to send verification email to ${email}: ${(err as Error).message}`;
          }
        },
        onLinkVerify: async (chatId: number, email: string, code: string): Promise<string> => {
          const key = `${chatId}:${email}`;
          const pending = pendingLinks.get(key);

          if (!pending) {
            return '❌ No pending link request found. Start with:\n<code>/link your@email.com</code>';
          }
          if (Date.now() > pending.expiresAt) {
            pendingLinks.delete(key);
            return '❌ Verification code has expired. Request a new one with:\n<code>/link your@email.com</code>';
          }
          if (pending.code !== code) {
            return '❌ Invalid code. Please check your email and try again.';
          }

          pendingLinks.delete(key);

          const tgIdentityId = `telegram:${chatId}`;
          const tgIdentity = identityManager.resolve('telegram', tgIdentityId);
          const tgWorkspaceId = tgIdentity?.workspaceId ?? (settings.multiUser ? '' : workspaceManager.ensureDefault().id);
          if (!tgWorkspaceId) {
            return '❌ No workspace found for this Telegram chat. Send /start first.';
          }

          const emailIdentityId = `email:${email}`;
          const emailIdentity = identityManager.resolveOrCreate('email', emailIdentityId, tgWorkspaceId);

          identityManager.generatePairingCode(emailIdentity.id);
          const row = identityManager.resolve('email', emailIdentityId);
          if (row?.pairingCode) {
            identityManager.linkWithCode(row.pairingCode, tgWorkspaceId);
          }

          logger.info(SCOPE, `Linked email identity ${emailIdentityId} to workspace ${tgWorkspaceId} (via Telegram chat ${chatId})`);
          return `✅ <b>Identity linked!</b>\n\n<code>${email}</code> is now linked to this Telegram account.\n\nEmails from this address will share the same workspace and memory.`;
        },
        onLinkGenerate: async (chatId: number, email: string): Promise<string> => {
          if (!systemMailer) {
            return '❌ Email sending is not configured. Contact the administrator.';
          }

          const code = userManager.generateRegistrationCode(String(chatId), undefined, email);
          const portalUrl = process.env.KORA_BASE_URL
            || `http://localhost:${settings.web_admin?.port || 3100}`;

          try {
            await systemMailer.send(email, 'Kora — Portal Registration Code', [
              `Your registration code is: ${code}`,
              '',
              `Use this code on the web portal to create your account: ${portalUrl}`,
              '',
              'Enter your email, this code, and choose a password.',
              '',
              'This code expires in 10 minutes.',
              '',
              '— Kora',
            ].join('\n'));
            logger.info(SCOPE, `Sent portal registration code to ${email} for chat ${chatId}`);
          } catch (err) {
            logger.error(SCOPE, `Failed to send registration code to ${email}: ${(err as Error).message}`);
            return `❌ Failed to send email to <code>${email}</code>. Please check the address and try again.`;
          }

          return (
            '<b>🔗 Web Portal Registration</b>\n\n' +
            `A registration code has been sent to <code>${email}</code>.\n\n` +
            `Go to the portal and register with your email and the code:\n` +
            `<a href="${portalUrl}">${portalUrl}</a>\n\n` +
            'The code expires in 10 minutes.'
          );
        },
        isRegisteredUser: (chatId: number): boolean => {
          if (!settings.multiUser) return true;
          if (userManager.getUserByTelegramChatId(String(chatId))) return true;
          const ident = identityManager.resolve('telegram', `telegram:${chatId}`);
          return !!ident?.workspaceId;
        },
        isAdmin: (chatId: number): boolean => {
          if (!settings.multiUser) return true;
          const user = userManager.getUserByTelegramChatId(String(chatId));
          return user?.role === 'admin';
        },
        multiUserEnabled: settings.multiUser,
        onRegistration: async (chatId: number, username?: string): Promise<string> => {
          const tgIdentityId = `telegram:${chatId}`;
          let existingIdent = identityManager.resolve('telegram', tgIdentityId);
          if (!existingIdent) {
            const wsName = username || `tg-${chatId}`;
            const workspace = workspaceManager.create(wsName, false);
            existingIdent = identityManager.create('telegram', tgIdentityId, workspace.id);
            registerChatForWorkspace(String(chatId), workspace.id);
            logger.info(SCOPE, `Created workspace "${wsName}" (${workspace.id}) for Telegram user ${chatId}`);
          } else if (existingIdent.workspaceId) {
            registerChatForWorkspace(String(chatId), existingIdent.workspaceId);
          }
          telegramInstance?.addAllowedChatId(chatId);

          if (billingEnabled && stripeManager) {
            const ws = existingIdent?.workspaceId ? workspaceManager.get(existingIdent.workspaceId) : undefined;
            const ownerUser = ws?.ownerUserId ? userManager.getById(ws.ownerUserId) : undefined;
            const hasActiveSub = ownerUser?.subscriptionStatus === 'active';

            if (!hasActiveSub) {
              try {
                const checkoutUrl = await stripeManager.createTelegramCheckoutSession(String(chatId));
                return (
                  '<b>Welcome to Kora! 🤖</b>\n\n' +
                  'Your workspace has been created.\n\n' +
                  'To start using the AI agent, you need an active subscription.\n\n' +
                  `<a href="${checkoutUrl}">👉 Subscribe here</a>\n\n` +
                  'After subscribing, you can start chatting right away!'
                );
              } catch (err) {
                logger.error(SCOPE, `Failed to create Stripe checkout for chat ${chatId}: ${(err as Error).message}`);
                return '<b>Welcome to Kora!</b>\n\n⚠️ Subscription setup failed. Please try again later or contact support.';
              }
            }

            return (
              '<b>Welcome back to Kora! 🤖</b>\n\n' +
              'Your subscription is active. Send me a message to get started!\n\n' +
              'Use /link to connect your web portal account.'
            );
          }

          return (
            '<b>Welcome to Kora! 🤖</b>\n\n' +
            'Your workspace has been created and you\'re ready to go!\n\n' +
            'Just send me a message to get started.\n\n' +
            'Use /link to create a web portal account for additional features.'
          );
        },
        onPasswordReset: async (chatId: number): Promise<string> => {
          const user = userManager.getUserByTelegramChatId(String(chatId));
          if (!user || !user.email) {
            return '❌ No account linked to this Telegram chat. Register first via /start.';
          }
          const code = userManager.generatePasswordResetCode(user.id, user.email, String(chatId));
          const portalUrl = process.env.KORA_BASE_URL
            || `http://localhost:${settings.web_admin?.port || 3100}`;
          return (
            `<b>🔑 Password Reset</b>\n\n` +
            `Your reset code: <b>${code}</b>\n\n` +
            `Go to the portal and click "Forgot password?" → "I already have a code":\n` +
            `<code>${portalUrl}</code>\n\n` +
            `This code expires in 15 minutes.`
          );
        },
      });

      router.registerChannel(
        'telegram',
        async (identityId: string, event: OutgoingEvent) => {
          const replyTo = event.metadata?.replyTo as { chatId: number; threadId?: number } | undefined;
          const replyCtx = telegram.getReplyContext(identityId);
          const chatId = replyTo?.chatId ?? replyCtx?.chatId ?? identityId.replace('telegram:', '');
          const threadId = replyTo?.threadId ?? replyCtx?.threadId;
          const useTts = ttsInstance && event.metadata?.voiceTranscribed && event.content?.length > 0 && event.content.length < 2000;

          if (useTts) {
            try {
              await telegram.sendRecordVoiceAction(chatId);
              ttsInstance!.onStatus = (msg) => {
                telegram.send(chatId, msg, threadId).catch(() => { });
              };
              const oggPath = await ttsInstance!.synthesize(event.content);
              ttsInstance!.onStatus = null;
              await telegram.sendVoice(chatId, oggPath);
              return;
            } catch (err) {
              logger.warn(SCOPE, `TTS voice reply failed: ${(err as Error).message}`);
              ttsInstance!.onStatus = null;
            }
          }

          if (threadId) {
            await telegram.send(chatId, event.content, threadId);
          } else {
            await telegram.send(chatId, event.content, { buttons: event.buttons });
          }
        },
        async (identityId: string) => {
          const replyCtx = telegram.getReplyContext(identityId);
          const chatId = replyCtx?.chatId ?? identityId.replace('telegram:', '');
          await telegram.sendTypingAction(chatId, replyCtx?.threadId);
        },
      );

      telegram.setDownloadsDir(path.join(settings.storagePath, '.staging-downloads'));

      await telegram.start();
      activeChannels.push({ name: 'telegram', stop: () => telegram.stop() });
      telegramInstance = telegram;

      if (stripeManager) {
        stripeManager.setTelegramNotify(async (chatId, text) => {
          await telegram.send(chatId, text);
        });
      }

      const telegramIdentities = identityManager.listByChannel('telegram');
      for (const ident of telegramIdentities) {
        if (ident.channelUserId && ident.workspaceId) {
          const chatId = ident.channelUserId.replace(/^telegram:/, '');
          registerChatForWorkspace(chatId, ident.workspaceId);
          telegram.addAllowedChatId(Number(chatId));
        }
      }
      if (!settings.multiUser) {
        const defaultWs = workspaceManager.ensureDefault();
        for (const id of (tgConfig.allowedChatIds ?? []).map(String)) {
          registerChatForWorkspace(id, defaultWs.id);
        }
      }

      logger.info(SCOPE, `Known Telegram chat IDs for notifications: [${[...knownTelegramChatIds].join(', ')}]`);

      toolApproval.setNotifier(async (request: ApprovalRequest) => {
        const targetChatIds = new Set<string>();

        if (request.identityId.startsWith('telegram:')) {
          targetChatIds.add(request.identityId.replace('telegram:', ''));
        }

        for (const id of knownTelegramChatIds) {
          targetChatIds.add(id);
        }

        if (targetChatIds.size === 0) {
          logger.warn(SCOPE, 'No Telegram chat IDs available for approval notification — tool will be denied');
          return;
        }

        logger.info(SCOPE, `Sending approval notification for "${request.toolName}" to ${targetChatIds.size} chat(s): [${[...targetChatIds].join(', ')}]`);

        const argsSummary = Object.entries(request.args)
          .map(([k, v]) => `  ${k}: ${String(v).slice(0, 100)}`)
          .join('\n');

        const isTask = request.channel === 'internal' && request.identityId.startsWith('scheduler:');
        const isHeartbeat = request.identityId === 'system:heartbeat';
        const source = isTask ? '📅 Scheduled Task' : isHeartbeat ? '💓 Heartbeat' : '💬 Chat';
        const timeoutLabel = request.channel === 'internal' ? '5 minutes' : '2 minutes';

        const text = [
          `<b>🔐 Permission Request</b>`,
          '',
          `Source: <b>${source}</b>`,
          `Tool: <code>${request.toolName}</code>`,
          `Arguments:`,
          `<pre>${argsSummary}</pre>`,
          '',
          `The agent wants to execute this tool. Respond within ${timeoutLabel} or it will be denied.`,
        ].join('\n');

        for (const chatId of targetChatIds) {
          await telegram.send(chatId, text, {
            buttons: [
              [
                { text: 'Allow Once', callbackData: `approve:once:${request.id}` },
                { text: 'Always Allow', callbackData: `approve:always:${request.id}` },
              ],
              [
                { text: 'Deny', callbackData: `approve:deny:${request.id}` },
                { text: 'Always Deny', callbackData: `approve:deny_always:${request.id}` },
              ],
            ],
          });
        }
      });

      logger.info(SCOPE, 'Telegram channel started');
    }

    if (channelCfg.type === 'email') {
      const emailConfig = channelCfg.config as EmailChannelConfig;
      const downloadsDir = path.join(settings.storagePath, '.staging-downloads');
      const email = emailChannelInstance ?? new EmailChannel(emailConfig, {
        onMessage: (event) => {
          const hk = event.metadata?.historyKey as string | undefined;
          const emailSubject = (event.metadata?.subject as string) || '';
          const emailMsgId = event.metadata?.messageId as string | undefined;
          const emailFrom = (event.metadata?.from as string) || event.identityId.replace('email:', '');

          if (hk) {
            emailThreadStore.set(hk, {
              subject: emailSubject,
              messageId: emailMsgId,
            });
            event.metadata = { ...event.metadata, sessionId: emailSessionId(hk) };
          }

          const replySubject = emailSubject
            ? `Re: ${emailSubject.replace(/^re:\s*/i, '')}`
            : 'Kora';

          event.sendInterimMessage = async (text: string) => {
            if (!text) return;
            await email.send(emailFrom, replySubject, text, {
              inReplyTo: emailMsgId,
              references: emailMsgId,
            });
          };

          return router.handleEvent(event);
        },
        downloadsDir,
      });

      if (!emailChannelInstance) {
        emailChannelInstance = email;
        toolContext.emailChannel = email;
      }

      router.registerChannel('email', async (identityId: string, event: OutgoingEvent) => {
        const address = identityId.replace('email:', '');
        const hk = event.metadata?.historyKey as string | undefined;
        const thread = hk ? emailThreadStore.get(hk) : undefined;
        const replySubject = thread ? `Re: ${thread.subject.replace(/^re:\s*/i, '')}` : 'Kora';
        await email.send(address, replySubject, event.content, {
          inReplyTo: thread?.messageId,
          references: thread?.messageId,
        });
      });

      await email.start();
      activeChannels.push({ name: 'email', stop: () => email.stop() });
      logger.info(SCOPE, 'Email channel started');
    }

    if (channelCfg.type === 'gmail') {
      const gmailConfig = channelCfg.config as GmailChannelConfig;
      const downloadsDir = path.join(settings.storagePath, '.staging-downloads');
      const gmail = new GmailChannel(gmailConfig, {
        onMessage: (event) => {
          const hk = event.metadata?.historyKey as string | undefined;
          const emailSubject = (event.metadata?.subject as string) || '';
          const emailMsgId = event.metadata?.emailMessageId as string | undefined;
          const emailThreadId = event.metadata?.threadId as string | undefined;
          const emailFrom = (event.metadata?.from as string) || event.identityId.replace('email:', '');

          if (hk) {
            emailThreadStore.set(hk, {
              subject: emailSubject,
              messageId: event.metadata?.messageId as string | undefined,
              emailMessageId: emailMsgId,
              threadId: emailThreadId,
            });
            event.metadata = { ...event.metadata, sessionId: emailSessionId(hk) };
          }

          const replySubject = emailSubject
            ? `Re: ${emailSubject.replace(/^re:\s*/i, '')}`
            : 'Kora';

          event.sendInterimMessage = async (text: string) => {
            if (!text) return;
            await gmail.send(emailFrom, replySubject, text, {
              inReplyTo: emailMsgId,
              references: emailMsgId,
              threadId: emailThreadId,
            });
          };

          return router.handleEvent(event);
        },
        downloadsDir,
        onTokenRefresh: (newRefreshToken) => {
          try {
            const allChannels = config.loadChannels();
            const idx = allChannels.findIndex(c => c.type === 'gmail');
            if (idx >= 0) {
              (allChannels[idx].config as GmailChannelConfig).refreshToken = newRefreshToken;
              config.saveChannels(allChannels);
              logger.info(SCOPE, 'Gmail refresh token updated in channels.yml');
            }
          } catch (err) {
            logger.error(SCOPE, `Failed to persist new Gmail refresh token: ${(err as Error).message}`);
          }
        },
      });

      gmailChannelInstance = gmail;
      if (!toolContext.emailChannel) toolContext.emailChannel = gmail;

      router.registerChannel('email', async (identityId: string, event: OutgoingEvent) => {
        const address = identityId.replace('email:', '');
        const hk = event.metadata?.historyKey as string | undefined;
        const thread = hk ? emailThreadStore.get(hk) : undefined;
        const replySubject = thread ? `Re: ${thread.subject.replace(/^re:\s*/i, '')}` : 'Kora';
        await gmail.send(address, replySubject, event.content, {
          inReplyTo: thread?.emailMessageId,
          references: thread?.emailMessageId,
          threadId: thread?.threadId,
        });
      });

      try {
        await gmail.start();
        activeChannels.push({ name: 'gmail', stop: () => gmail.stop() });
        logger.info(SCOPE, `Gmail channel started for ${gmail.email}`);
      } catch (err) {
        logger.error(SCOPE, `Gmail channel failed to start: ${(err as Error).message}`);
      }
    }

    if (channelCfg.type === 'mqtt') {
      const mqttConfig = channelCfg.config as MqttChannelConfig;
      const mqttChannel = new MqttChannel(mqttConfig, {
        onMessage: (event) => {
          if (!settings.multiUser) {
            const ws = workspaceManager.ensureDefault();
            event.metadata = { ...event.metadata, workspaceId: ws.id };
          }
          const chatKey = `mqtt:${event.identityId}`;
          const { sessionId } = getOrCreateSession(chatKey);
          event.metadata = { ...event.metadata, sessionId };
          return router.handleEvent(event);
        },
      });

      const responseTopic = mqttChannel.getResponseTopic();
      router.registerChannel('mqtt', async (identityId: string, event: OutgoingEvent) => {
        await mqttChannel.publish(responseTopic, JSON.stringify({
          identityId,
          content: event.content,
          metadata: event.metadata,
        }));
      });

      await mqttChannel.start();
      activeChannels.push({ name: 'mqtt', stop: () => mqttChannel.stop() });
      logger.info(SCOPE, 'MQTT channel started');
    }
  }

  heartbeat.setActivityChecker(() => false);

  const HEARTBEAT_CONCURRENCY = settings.heartbeat?.concurrency ?? 5;

  heartbeat.setHandler(async (prompt) => {
    let workspaces = workspaceManager.list();
    if (workspaces.length === 0 && !settings.multiUser) {
      workspaces = [workspaceManager.ensureDefault()];
    }
    const now = Date.now();

    const eligible = workspaces.filter(ws => {
      if (settings.multiUser && ws.isDefault) return false;
      if (settings.multiUser && ws.ownerUserId) {
        const owner = userManager.getById(ws.ownerUserId);
        if (owner?.status === 'suspended') {
          logger.debug(SCOPE, `Heartbeat [${ws.name}]: owner suspended, skipping`);
          return false;
        }
      }
      const wsSettings = config.loadWorkspaceSettings(ws.id);
      if (wsSettings.heartbeat?.enabled === false) {
        logger.debug(SCOPE, `Heartbeat [${ws.name}]: disabled by user, skipping`);
        return false;
      }
      if (billingEnabled) {
        const subCheck = LLMProvider.checkSubscription?.(ws.id);
        if (subCheck === false) {
          logger.debug(SCOPE, `Heartbeat [${ws.name}]: no active subscription, skipping`);
          return false;
        }
      }
      const lastActivity = lastChannelActivityByWorkspace.get(ws.id) ?? 0;
      if (lastActivity > 0 && (now - lastActivity) < HEARTBEAT_IDLE_THRESHOLD_MS) {
        logger.debug(SCOPE, `Heartbeat [${ws.name}]: workspace active recently, skipping`);
        return false;
      }
      return true;
    });

    if (eligible.length === 0) return 'No workspaces eligible for heartbeat';

    const runForWorkspace = async (ws: typeof eligible[0]) => {
      let sessionId = heartbeatSessionIds.get(ws.id);
      if (!sessionId) {
        sessionId = crypto.randomUUID();
        heartbeatSessionIds.set(ws.id, sessionId);
        saveSessionMap();
      }

      let heartbeatPrompt = prompt;
      if (enabledTools.mail_delegation) {
        try {
          const since = new Date(Date.now() - (settings.heartbeat?.intervalMinutes ?? 5) * 60 * 1000);
          const newEmails = await mailIndexer.getNewEmailsSince(ws.id, since);
          if (newEmails.length > 0) {
            heartbeatPrompt += '\n\n[NEW EMAILS since last heartbeat]\n' +
              newEmails.join('\n') +
              '\n[END NEW EMAILS]\n' +
              'Review these new emails. If any require attention or action, handle them or notify the user. ' +
              'Otherwise, proceed with your normal heartbeat tasks.';

            for (const cfg of delegationManager.listForWorkspace(ws.id)) {
              if (!cfg.permissions.read) continue;
              try {
                const account = delegationManager.getAccount(cfg);
                const emails = await account.getInbox(20, false);
                for (const email of emails) {
                  if (new Date(email.date) > since) {
                    const detail = await account.readMessage(email.id);
                    await mailIndexer.indexSingleEmail(ws.id, cfg.id, detail, cfg.email);
                  }
                }
              } catch (err) {
                logger.warn(SCOPE, `Heartbeat new-mail indexing for ${cfg.email}: ${(err as Error).message}`);
              }
            }
          }
        } catch (err) {
          logger.warn(SCOPE, `Heartbeat mail context for ${ws.id}: ${(err as Error).message}`);
        }
      }

      const internalEvent = {
        channel: 'internal',
        identityId: `system:heartbeat:${ws.id}`,
        type: 'message' as const,
        content: heartbeatPrompt,
        metadata: { sessionId, historyKey: `heartbeat:${ws.id}`, workspaceId: ws.id },
        sendInterimMessage: async (text: string) => {
          if (!telegramInstance || !text) return;
          const chatIds = getPrivateChatIdsForWorkspace(ws.id);
          for (const chatId of chatIds) {
            await telegramInstance.send(chatId, text);
          }
          const mainKey = mainSessionKeys.get(ws.id);
          if (mainKey) {
            dispatcher.injectMessage(mainKey, 'assistant', text);
          }
        },
        waitForReply: async (timeoutMs: number) => {
          const chatIds = getPrivateChatIdsForWorkspace(ws.id);
          if (chatIds.length === 0) return null;
          const targets = chatIds.map(cid => ({
            channel: 'telegram',
            identityId: `telegram:${cid}`,
          }));
          return router.waitForReplyFromAny(targets, timeoutMs);
        },
        setTyping: () => { },
      };

      const response = await dispatcher.handleIncomingEvent(internalEvent);
      const marker = response.metadata?.marker as string | undefined;
      logger.info(SCOPE, `Heartbeat [${ws.name}] completed (marker=${marker ?? 'none'}): ${response.content.slice(0, 200)}`);

      if (response.content && telegramInstance) {
        const chatIds = getPrivateChatIdsForWorkspace(ws.id);
        for (const chatId of chatIds) {
          await telegramInstance.send(chatId, response.content);
        }
        const mainKey = mainSessionKeys.get(ws.id);
        if (mainKey) {
          dispatcher.injectMessage(mainKey, 'assistant', response.content);
        }
      }
    };

    const concurrency = Math.min(HEARTBEAT_CONCURRENCY, eligible.length);
    let idx = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (idx < eligible.length) {
        const ws = eligible[idx++];
        try {
          await runForWorkspace(ws);
        } catch (err) {
          logger.error(SCOPE, `Heartbeat [${ws.name}] failed: ${(err as Error).message}`);
        }
      }
    });
    await Promise.all(workers);

    return `Heartbeat completed for ${eligible.length} workspace(s)`;
  });

  heartbeat.start();
  const hbStatus = heartbeat.getStatus();
  logger.info(SCOPE, `Heartbeat: ${hbStatus.enabled ? `active (every ${heartbeatSettings.intervalMinutes}min)` : 'disabled'}`);

  let webAdmin: WebAdminServer | undefined;
  const webAdminSettings = settings.web_admin || { enabled: true, port: 3100 };
  const adminAuth = new AdminAuth(database);
  adminAuth.initialize();

  if (webAdminSettings.enabled) {
    if (adminAuth.hasCredentials()) {
      logger.info(SCOPE, `Admin credentials configured (user: ${adminAuth.getUsername()})`);
    } else {
      logger.warn(SCOPE, 'No admin credentials set. Run `kora reset-admin` to configure username/password.');
    }
    webAdmin = new WebAdminServer({
      auditLog,
      config,
      mcpManager,
      getStatus: getStatusFn,
      getHistory: getHistoryFn,
      getHistoryKeys: () => dispatcher.getHistoryKeys(),
      clearHistory: (key: string) => dispatcher.clearHistory(key),
      clearAllHistory: () => {
        for (const key of dispatcher.getHistoryKeys()) {
          dispatcher.clearHistory(key);
        }
      },
      getEnabledTools: getEnabledToolsFn,
      adminAuth,
      listTasks: () => taskStore.listAll(),
      getTask: (id) => taskStore.get(id),
      createTask: (t) => {
        const cronExpr = (t as Record<string, unknown>).cronExpression as string;
        if (cronExpr) {
          const validation = TaskScheduler.validateMinInterval(cronExpr);
          if (!validation.valid) {
            throw new Error(validation.intervalMinutes !== undefined
              ? `Minimum interval is 30 minutes. This cron runs every ${Math.round(validation.intervalMinutes)} minutes.`
              : 'Invalid cron expression.');
          }
        }
        const id = crypto.randomUUID();
        const wsId = (t as Record<string, unknown>).workspaceId
          ? String((t as Record<string, unknown>).workspaceId)
          : workspaceManager.ensureDefault().id;
        return taskStore.create({
          id, ...t, workspaceId: wsId, agentId: 'default', enabled: true,
        });
      },
      updateTask: (id, updates) => {
        taskStore.update(id, updates);
        if (updates.enabled === true) scheduler.schedule(taskStore.get(id)!, scheduler.getDefaultHandler()!);
        else if (updates.enabled === false) scheduler.unschedule(id);
        else if (updates.cronExpression) scheduler.reschedule(id, updates.cronExpression);
      },
      deleteTask: (id) => {
        scheduler.unschedule(id);
        taskStore.delete(id);
      },
      runTaskNow: async (id) => {
        const handler = scheduler.getDefaultHandler();
        if (!handler) throw new Error('No task handler configured');
        await scheduler.runNow(id, handler);
      },
      getTaskLogs: (taskId, limit) => taskStore.getTaskLogs(taskId, limit) as unknown as Array<Record<string, unknown>>,
      shutdown: async () => {
        heartbeat.stop();
        scheduler.stop();
        await mcpManager.disconnectAll();
        for (const ch of activeChannels) await ch.stop();
      },
      reload: async () => {
        logger.info(SCOPE, 'Hot-reloading settings...');
        const freshSettings = config.loadSettings();
        logger.setLevel(freshSettings.logLevel);

        const freshProviders = config.loadProviders();
        providerRegistry.reloadProviders(freshProviders);
        if (freshSettings.defaultProvider) {
          try { providerRegistry.setDefault(freshSettings.defaultProvider); } catch { /* keep existing */ }
        }

        const freshToolSettings = freshSettings.tools || {};
        enabledTools.scheduler = freshToolSettings.scheduler !== false;
        enabledTools.mail = freshToolSettings.mail === true || enabledTools.mail;
        enabledTools.browser = freshToolSettings.browser !== false;
        enabledTools.web_search = freshToolSettings.web_search === true;
        enabledTools.homeassistant_mqtt = freshToolSettings.homeassistant_mqtt === true;
        enabledTools.shell = freshToolSettings.shell === true;
        enabledTools.settings = freshToolSettings.settings !== false;
        enabledTools.identity = freshToolSettings.identity !== false;
        enabledTools.web_fetch = freshToolSettings.web_fetch === true;
        dispatcher.setEnabledTools(enabledTools);

        const ctx = dispatcher.getToolContext();
        if (ctx) {
          ctx.homeAssistant = (freshToolSettings.ha_url && freshToolSettings.ha_token)
            ? { haUrl: freshToolSettings.ha_url as string, haToken: freshToolSettings.ha_token as string }
            : undefined;
        }

        try {
          skillRegistry.loadFromDirectory(config.skillsPath);
        } catch { /* no skills */ }

        const hbSettings = freshSettings.heartbeat || { enabled: true, intervalMinutes: 5 };
        heartbeat.updateConfig({
          enabled: hbSettings.enabled,
          intervalMs: (hbSettings.intervalMinutes || 5) * 60 * 1000,
        });

        const freshChannels = config.loadChannels();
        const gmailCfg = freshChannels.find(c => c.type === 'gmail');
        if (gmailCfg && gmailChannelInstance) {
          const gmailConf = gmailCfg.config as import('../core/types.js').GmailChannelConfig;
          if (gmailConf.refreshToken) {
            try {
              await gmailChannelInstance.updateCredentials(gmailConf.refreshToken);
              logger.info(SCOPE, 'Gmail channel credentials refreshed');
            } catch (err) {
              logger.error(SCOPE, `Failed to refresh Gmail credentials: ${(err as Error).message}`);
            }
          }
        }

        logger.info(SCOPE, 'Hot-reload complete');
      },
      getUnlimitedMode: () => toolApproval.unlimitedMode,
      setUnlimitedMode: (enabled) => toolApproval.setUnlimitedMode(enabled),
      getPermissions: (wsId?: string) => {
        const effectiveWsId = wsId || workspaceManager.ensureDefault().id;
        return toolApproval.listApprovals(effectiveWsId).map(a => ({
          tool: a.toolName, decision: a.decision, workspace: effectiveWsId,
        }));
      },
      revokePermission: (tool, wsId?: string) => {
        const effectiveWsId = wsId || workspaceManager.ensureDefault().id;
        toolApproval.revokeApproval(tool, effectiveWsId);
        return true;
      },
      listSubAgents: (workspaceId?: string) => subAgentManager.list(workspaceId).map(sa => ({ ...sa })),
      createSubAgent: async (task, workspaceId) => {
        const wsId = workspaceId || (settings.multiUser ? '' : workspaceManager.ensureDefault().id);
        if (!wsId) throw new Error('No workspace specified.');
        const sa = subAgentManager.create({
          name: `web-${Date.now()}`,
          description: task.slice(0, 100),
          systemPrompt: 'You are a helpful sub-agent.',
          workspaceId: wsId,
        });
        const result = await subAgentManager.runTask(sa.config.id, task, wsId);
        return { id: sa.config.id, result };
      },
      createSubAgentConfig: (data) => {
        const wsId = data.workspaceId ? String(data.workspaceId) : workspaceManager.ensureDefault().id;
        const sa = subAgentManager.create({
          name: String(data.name || `agent-${Date.now()}`),
          description: String(data.description || ''),
          systemPrompt: String(data.systemPrompt || 'You are a helpful sub-agent.'),
          model: data.model ? String(data.model) : undefined,
          maxIterations: data.maxIterations ? Number(data.maxIterations) : undefined,
          workspaceId: wsId,
        });
        return { ...sa.config };
      },
      updateSubAgent: (id, data) => {
        const existing = subAgentManager.list().find(a => a.id === id);
        if (!existing) return false;
        if (data.workspaceId && existing.workspaceId && existing.workspaceId !== String(data.workspaceId)) {
          return false;
        }
        return subAgentManager.update(id, {
          name: data.name !== undefined ? String(data.name) : undefined,
          description: data.description !== undefined ? String(data.description) : undefined,
          systemPrompt: data.systemPrompt !== undefined ? String(data.systemPrompt) : undefined,
          model: data.model !== undefined ? String(data.model) : undefined,
          maxIterations: data.maxIterations !== undefined ? Number(data.maxIterations) : undefined,
        });
      },
      removeSubAgent: (id: string, workspaceId?: string) => {
        const wsId = workspaceId || (settings.multiUser ? '' : workspaceManager.ensureDefault().id);
        return wsId ? subAgentManager.remove(id, wsId) : false;
      },
      runSubAgent: async (id, task, workspaceId) => {
        const wsId = workspaceId || (settings.multiUser ? '' : workspaceManager.ensureDefault().id);
        if (!wsId) return 'No workspace specified.';
        return subAgentManager.runTask(id, task, wsId);
      },
      memoryManager,
      skillRegistry,
      getDefaultWorkspaceId: () => {
        if (settings.multiUser) return undefined as unknown as string;
        return workspaceManager.ensureDefault().id;
      },
      listWorkspaces: () => {
        const allIdentities = identityManager.listAll();
        return workspaceManager.list().map(ws => {
          const wsIdentities = allIdentities.filter(i => i.workspaceId === ws.id);
          const tgIdent = wsIdentities.find(i => i.channel === 'telegram');
          const emailIdent = wsIdentities.find(i => i.channel === 'email');
          const displayName = emailIdent?.channelUserId?.replace('email:', '')
            || tgIdent?.channelUserId?.replace('telegram:', '')
            || ws.name;
          return { id: ws.id, name: ws.name, isDefault: ws.isDefault, displayName };
        });
      },
      delegationManager,
      contentGuard,
      mailIndexer,
      userManager,
      workspaceManager,
      identityManager,
      dbManager: database,
      multiUserEnabled: settings.multiUser,
      telegramChannel: telegramInstance ? { addAllowedChatId: (id: number) => telegramInstance!.addAllowedChatId(id) } : undefined,
      stripeManager,
      billingEnabled,
      systemMailer: systemMailer ?? undefined,
      portalBaseUrl: process.env.KORA_BASE_URL
        || `http://localhost:${webAdminSettings.port}`,
      sandboxStatus: sandboxStatus ?? undefined,
      subAgentManager,
      baseUrl: process.env.KORA_BASE_URL || `http://localhost:${webAdminSettings.port}`,
    });
    if (settings.multiUser) {
      const clientApi = new ClientApi({
        config,
        db: database,
        userManager,
        workspaceManager,
        identityManager,
        dispatcher,
        router,
        getMainSessionKey: (wsId) => mainSessionKeys.get(wsId),
      });
      webAdmin.setClientApi(clientApi);
      router.registerChannel('api', async (_identityId, _event) => {
        /* API responses are collected inline via sendInterimMessage */
      });
      logger.info(SCOPE, 'Client API enabled (multi-user mode)');
    }
    await webAdmin.start(webAdminSettings.port);
    logger.info(SCOPE, `Web admin started on port ${webAdminSettings.port}`);
  }

  const mcpToolCount = mcpManager.getToolDefinitions().length;

  console.log(chalk.green.bold('  Kora is running\n'));
  console.log(`  ${chalk.gray('Providers:')}    ${providerConfigs.map(p => p.id).join(', ') || 'none'}`);
  console.log(`  ${chalk.gray('Channels:')}     ${activeChannels.map(c => c.name).join(', ') || 'none'}`);
  console.log(`  ${chalk.gray('Tools:')}        ${enabledToolNames.join(', ') || 'none'}`);
  console.log(`  ${chalk.gray('MCP Servers:')}  ${mcpManager.getConnectedCount()} connected (${mcpToolCount} tools)`);
  if (enabledTools.shell) {
    const sbLabel = sandboxProvider ? `${sandboxProvider.name}` : 'off';
    console.log(`  ${chalk.gray('Shell Sandbox:')} ${sandboxProvider ? chalk.green(sbLabel) : chalk.yellow(sbLabel)}`);
  }
  console.log(`  ${chalk.gray('Tasks:')}        ${scheduler.activeJobCount} active job(s)`);
  console.log(`  ${chalk.gray('Skills:')}       ${skillRegistry.list().length} loaded`);
  console.log(`  ${chalk.gray('Heartbeat:')}    ${hbStatus.enabled ? `every ${heartbeatSettings.intervalMinutes}min` : 'disabled'}`);
  if (webAdminSettings.enabled) {
    if (adminAuth.hasCredentials()) {
      console.log(`  ${chalk.gray('Web Admin:')}    http://localhost:${webAdminSettings.port}/admin (credentials configured)`);
    } else {
      console.log(`  ${chalk.gray('Web Admin:')}    http://localhost:${webAdminSettings.port}/admin`);
      console.log(`  ${chalk.yellow('  ⚠ No admin credentials set. Run `kora reset-admin` to set a username and password.')}`);
    }
  }
  console.log(`\n  ${chalk.gray('Press Ctrl+C to stop.')}\n`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    const forceExitTimer = setTimeout(() => {
      console.error('  Shutdown timed out, forcing SIGKILL.');
      process.kill(process.pid, 'SIGKILL');
    }, 8_000);
    forceExitTimer.unref();

    console.log(chalk.yellow(`\n  Received ${signal}, shutting down...`));

    try {
      heartbeat.stop();
      scheduler.stop();
      mailIndexer.stopAll();

      await closeBrowser().catch(() => { });

      if (webAdmin) {
        await webAdmin.stop();
      }

      await mcpManager.disconnectAll();

      for (const channel of activeChannels) {
        try {
          await channel.stop();
          logger.info(SCOPE, `${channel.name} channel stopped`);
        } catch (err) {
          logger.error(SCOPE, `Error stopping ${channel.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (sandboxProvider?.destroy) {
        await sandboxProvider.destroy().catch(err => {
          logger.error(SCOPE, `Sandbox pool cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }

      dispatcher.shutdown();
      mailIndexer.closeVectorStores();

      database.close();
      logger.info(SCOPE, 'Database closed');

      console.log(chalk.green('  Kora stopped gracefully.\n'));
    } finally {
      process.exitCode = 0;
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
