import path from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ToolDefinition } from '../core/types.js';
import type { TaskStore } from '../tasks/store.js';
import type { TaskScheduler } from '../tasks/scheduler.js';
import type { MailSender } from './mail-tool.js';
import type { McpManager } from '../mcp/manager.js';
import { logger } from '../core/logger.js';

import { schedulerToolDefinitions, handleSchedulerTool } from './scheduler-tool.js';
import type { SchedulerToolContext } from './scheduler-tool.js';
import { mailToolDefinitions, getMailToolDefinitions, handleMailTool } from './mail-tool.js';
import type { MailToolContext } from './mail-tool.js';
import { browserToolDefinitions, handleBrowserTool } from './browser-tool.js';
import type { BrowserToolContext } from './browser-tool.js';
import { webSearchToolDefinitions, handleWebSearchTool } from './web-search-tool.js';
import type { WebSearchToolContext } from './web-search-tool.js';
import { homeAssistantToolDefinitions, handleHomeAssistantTool } from './homeassistant-tool.js';
import type { HomeAssistantToolContext } from './homeassistant-tool.js';
import { shellToolDefinitions, handleShellTool, createManagedShellExecution } from './shell-tool.js';
import type { ShellToolContext, ManagedExecution } from './shell-tool.js';
export type { ManagedExecution } from './shell-tool.js';
import { mcpToolDefinitions, handleMcpTool } from './mcp-tool.js';
import type { McpToolContext } from './mcp-tool.js';
import { subAgentToolDefinitions, handleSubAgentTool } from './subagent-tool.js';
import type { SubAgentToolContext } from './subagent-tool.js';
import type { SubAgentManager } from '../core/sub-agent.js';
import { memoryToolDefinitions, handleMemoryTool } from './memory-tool.js';
import type { MemoryToolContext } from './memory-tool.js';
import { settingsToolDefinitions, handleSettingsTool } from './settings-tool.js';
import type { SettingsToolContext } from './settings-tool.js';
import { identityToolDefinitions, handleIdentityTool } from './identity-tool.js';
import type { IdentityToolContext } from './identity-tool.js';
import { skillToolDefinitions, handleSkillTool } from './skill-tool.js';
import type { SkillToolContext } from './skill-tool.js';
import { webFetchToolDefinitions, handleWebFetchTool } from './web-fetch-tool.js';
import { fileToolDefinitions, handleFileTool } from './file-tool.js';
import type { FileToolContext } from './file-tool.js';
import { knowledgeToolDefinitions, handleKnowledgeTool } from './knowledge-tool.js';
import type { KnowledgeToolContext } from './knowledge-tool.js';
import { notifyToolDefinition, finishToolDefinition, waitForToolDefinition, killToolDefinition } from './notify-tool.js';
import { mailDelegationToolDefinitions, handleMailDelegationTool } from './mail-delegation/index.js';
import type { MailDelegationToolContext } from './mail-delegation/index.js';
import type { DelegationManager } from './mail-delegation/index.js';
import type { MemoryManager } from '../core/memory.js';
import type { ConfigManager } from '../core/config.js';
import type { SkillRegistry } from '../skills_runtime/registry.js';
import type { ContentGuard } from '../core/content-guard.js';

const SCOPE = 'tool-registry';

export interface EnabledTools {
  scheduler?: boolean;
  mail?: boolean;
  mail_delegation?: boolean;
  browser?: boolean;
  web_search?: boolean;
  homeassistant_mqtt?: boolean;
  shell?: boolean;
  files?: boolean;
  mcp?: boolean;
  subagents?: boolean;
  settings?: boolean;
  identity?: boolean;
  web_fetch?: boolean;
}

const TOOL_TO_CATEGORY: Record<string, keyof EnabledTools> = {};
for (const name of schedulerToolDefinitions.map(t => t.name)) TOOL_TO_CATEGORY[name] = 'scheduler';
for (const name of getMailToolDefinitions(false).map(t => t.name)) TOOL_TO_CATEGORY[name] = 'mail';
for (const name of browserToolDefinitions.map(t => t.name)) TOOL_TO_CATEGORY[name] = 'browser';
for (const name of webSearchToolDefinitions.map(t => t.name)) TOOL_TO_CATEGORY[name] = 'web_search';
for (const name of homeAssistantToolDefinitions.map(t => t.name)) TOOL_TO_CATEGORY[name] = 'homeassistant_mqtt';
for (const name of shellToolDefinitions.map(t => t.name)) TOOL_TO_CATEGORY[name] = 'shell';
for (const name of fileToolDefinitions.map(t => t.name)) TOOL_TO_CATEGORY[name] = 'files';
for (const name of knowledgeToolDefinitions.map(t => t.name)) TOOL_TO_CATEGORY[name] = 'files';
for (const name of settingsToolDefinitions.map(t => t.name)) TOOL_TO_CATEGORY[name] = 'settings';
for (const name of identityToolDefinitions.map(t => t.name)) TOOL_TO_CATEGORY[name] = 'identity';
for (const name of webFetchToolDefinitions.map(t => t.name)) TOOL_TO_CATEGORY[name] = 'web_fetch';
for (const name of mailDelegationToolDefinitions.map(t => t.name)) TOOL_TO_CATEGORY[name] = 'mail_delegation';

export function getToolCategory(toolName: string): keyof EnabledTools | undefined {
  return TOOL_TO_CATEGORY[toolName];
}

export function isToolEnabled(toolName: string, enabled: EnabledTools): boolean {
  const category = TOOL_TO_CATEGORY[toolName];
  if (!category) return true;
  const val = enabled[category];
  if (val === undefined) return category === 'scheduler' || category === 'browser' || category === 'mcp' || category === 'settings' || category === 'identity' || category === 'files';
  return val === true || val !== false;
}

export interface ToolExecutionContext {
  workspaceId: string;
  taskStore: TaskStore;
  taskScheduler: TaskScheduler;
  emailChannel?: MailSender;
  delegationManager?: DelegationManager;
  contentGuard?: ContentGuard;
  sensitiveMailFilter?: boolean;
  screenshotDir: string;
  webSearch?: { apiKey: string; engine: 'brave' | 'google' };
  homeAssistant?: { haUrl: string; haToken: string };
  shell?: ShellToolContext;
  mcpManager?: McpManager;
  subAgentManager?: SubAgentManager;
  memoryManager?: MemoryManager;
  configManager?: ConfigManager;
  skillRegistry?: SkillRegistry;
  skillsDir?: string;
  dbManager?: import('../core/database.js').DatabaseManager;
  multiUserMode?: boolean;
  userEmail?: string;
  vectorStore?: import('../core/vector-store.js').VectorStore;
  embeddingProvider?: import('../core/vector-store.js').EmbeddingProvider;
}

const SCHEDULER_TOOLS = new Set(schedulerToolDefinitions.map((t) => t.name));
const MAIL_TOOLS = new Set(mailToolDefinitions.map((t) => t.name));
const BROWSER_TOOLS = new Set(browserToolDefinitions.map((t) => t.name));
const WEB_SEARCH_TOOLS = new Set(webSearchToolDefinitions.map((t) => t.name));
const HA_TOOLS = new Set(homeAssistantToolDefinitions.map((t) => t.name));
const SHELL_TOOLS = new Set(shellToolDefinitions.map((t) => t.name));
const FILE_TOOLS = new Set(fileToolDefinitions.map((t) => t.name));
const KNOWLEDGE_TOOLS = new Set(knowledgeToolDefinitions.map((t) => t.name));
const MCP_MGMT_TOOLS = new Set(mcpToolDefinitions.map((t) => t.name));
const SUBAGENT_TOOLS = new Set(subAgentToolDefinitions.map((t) => t.name));
const MEMORY_TOOLS = new Set(memoryToolDefinitions.map((t) => t.name));
const SETTINGS_TOOLS = new Set(settingsToolDefinitions.map((t) => t.name));
const IDENTITY_TOOLS = new Set(identityToolDefinitions.map((t) => t.name));
const SKILL_TOOLS = new Set(skillToolDefinitions.map((t) => t.name));
const WEB_FETCH_TOOLS = new Set(webFetchToolDefinitions.map((t) => t.name));
const MAIL_DELEGATION_TOOLS = new Set(mailDelegationToolDefinitions.map((t) => t.name));

export function getToolDefinitionsForEnabled(
  enabled: EnabledTools,
  mcpManager?: McpManager,
  opts?: { multiUserMode?: boolean },
): ToolDefinition[] {
  const defs: ToolDefinition[] = [];
  if (enabled.scheduler) defs.push(...schedulerToolDefinitions);
  if (enabled.mail) defs.push(...getMailToolDefinitions(opts?.multiUserMode));
  if (enabled.browser) defs.push(...browserToolDefinitions);
  if (enabled.web_search) defs.push(...webSearchToolDefinitions);
  if (enabled.homeassistant_mqtt) defs.push(...homeAssistantToolDefinitions);
  if (enabled.shell) defs.push(...shellToolDefinitions);
  if (enabled.files !== false) defs.push(...fileToolDefinitions);
  if (enabled.files !== false) defs.push(...knowledgeToolDefinitions);
  if (enabled.mcp !== false) {
    defs.push(...mcpToolDefinitions);
    if (mcpManager) {
      defs.push(...mcpManager.getToolDefinitions());
    }
  }
  if (enabled.subagents !== false) {
    defs.push(...subAgentToolDefinitions);
  }
  if (enabled.settings !== false) defs.push(...settingsToolDefinitions);
  if (enabled.identity !== false) defs.push(...identityToolDefinitions);
  defs.push(...skillToolDefinitions);
  if (enabled.web_fetch) defs.push(...webFetchToolDefinitions);
  if (enabled.mail_delegation) defs.push(...mailDelegationToolDefinitions);
  defs.push(notifyToolDefinition, finishToolDefinition, waitForToolDefinition, killToolDefinition);
  return defs;
}

export function getAllToolDefinitions(mcpManager?: McpManager): ToolDefinition[] {
  const defs = [
    notifyToolDefinition, finishToolDefinition, waitForToolDefinition, killToolDefinition,
    ...schedulerToolDefinitions,
    ...mailToolDefinitions,
    ...mailDelegationToolDefinitions,
    ...browserToolDefinitions,
    ...webSearchToolDefinitions,
    ...homeAssistantToolDefinitions,
    ...shellToolDefinitions,
    ...fileToolDefinitions,
    ...knowledgeToolDefinitions,
    ...mcpToolDefinitions,
    ...subAgentToolDefinitions,
    ...settingsToolDefinitions,
    ...identityToolDefinitions,
    ...skillToolDefinitions,
    ...webFetchToolDefinitions,
  ];
  if (mcpManager) {
    defs.push(...mcpManager.getToolDefinitions());
  }
  return defs;
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  multiUserMode: boolean,
): Promise<string> {
  logger.debug(SCOPE, `Handling tool call: ${name}`);

  if (SCHEDULER_TOOLS.has(name)) {
    const ctx: SchedulerToolContext = {
      workspaceId: context.workspaceId,
      taskStore: context.taskStore,
      taskScheduler: context.taskScheduler,
    };
    return handleSchedulerTool(name, args, ctx);
  }

  if (MAIL_TOOLS.has(name) || name === 'mail_list' || name === 'mail_read') {
    if (!context.emailChannel) {
      return JSON.stringify({ ok: false, error: 'Email channel is not configured' });
    }
    let mailDlDir: string | undefined;
    if (context.configManager && context.workspaceId) {
      mailDlDir = path.join(context.configManager.getWorkspacePath(context.workspaceId), 'work', 'downloads', 'mail');
    }
    const ctx: MailToolContext = {
      emailChannel: context.emailChannel,
      multiUserMode: context.multiUserMode,
      userEmail: context.userEmail,
      downloadsDir: mailDlDir,
    };
    return handleMailTool(name, args, ctx);
  }

  if (MAIL_DELEGATION_TOOLS.has(name)) {
    if (!context.delegationManager) {
      return JSON.stringify({ ok: false, error: 'Mail delegation is not configured. Set up delegated accounts in web admin.' });
    }
    let dlDir: string | undefined;
    if (context.configManager && context.workspaceId) {
      dlDir = path.join(context.configManager.getWorkspacePath(context.workspaceId), 'work', 'downloads', 'mail');
    }
    const ctx: MailDelegationToolContext = {
      delegationManager: context.delegationManager,
      workspaceId: context.workspaceId,
      downloadsDir: dlDir,
      contentGuard: context.contentGuard,
      sensitiveMailFilter: context.sensitiveMailFilter,
    };
    return handleMailDelegationTool(name, args, ctx);
  }

  if (BROWSER_TOOLS.has(name)) {
    const ctx: BrowserToolContext = { screenshotDir: context.screenshotDir };
    return handleBrowserTool(name, args, ctx);
  }

  if (WEB_SEARCH_TOOLS.has(name)) {
    if (!context.webSearch) {
      return JSON.stringify({ ok: false, error: 'Web search is not configured. No API key provided.' });
    }
    const ctx: WebSearchToolContext = {
      apiKey: context.webSearch.apiKey,
      engine: context.webSearch.engine,
    };
    return handleWebSearchTool(name, args, ctx);
  }

  if (HA_TOOLS.has(name)) {
    if (!context.homeAssistant) {
      return JSON.stringify({ ok: false, error: 'Home Assistant integration is not configured. Set ha_url and ha_token in tool settings.' });
    }
    const ctx: HomeAssistantToolContext = {
      haUrl: context.homeAssistant.haUrl,
      haToken: context.homeAssistant.haToken,
    };
    return handleHomeAssistantTool(name, args, ctx);
  }

  if (SHELL_TOOLS.has(name)) {
    if (!context.shell) {
      return JSON.stringify({ ok: false, error: 'Shell access is not enabled. Enable it in settings (tools.shell) first.' });
    }
    let shellCtx = context.shell;
    if (shellCtx.sandboxProvider && shellCtx.sandboxConfig && context.workspaceId && context.configManager) {
      const wsWorkDir = path.join(context.configManager.getWorkspacePath(context.workspaceId), 'work');
      const wsSkillsDir = path.join(context.configManager.getWorkspacePath(context.workspaceId), 'skills');
      mkdirSync(wsWorkDir, { recursive: true });
      mkdirSync(wsSkillsDir, { recursive: true });
      shellCtx = {
        ...shellCtx,
        workingDirectory: wsWorkDir,
        sandboxConfig: {
          ...shellCtx.sandboxConfig,
          mounts: [
            { hostPath: wsWorkDir, containerPath: wsWorkDir, mode: 'rw' as const },
            { hostPath: wsSkillsDir, containerPath: wsSkillsDir, mode: 'rw' as const },
            ...shellCtx.sandboxConfig.mounts,
          ],
        },
      };
    }
    return handleShellTool(name, args, shellCtx);
  }

  if (FILE_TOOLS.has(name)) {
    const fileCtx: FileToolContext = {};
    if (context.shell?.sandboxProvider && context.shell?.sandboxConfig && context.workspaceId && context.configManager) {
      const wsWorkDir = path.join(context.configManager.getWorkspacePath(context.workspaceId), 'work');
      const wsSkillsDir = path.join(context.configManager.getWorkspacePath(context.workspaceId), 'skills');
      mkdirSync(wsWorkDir, { recursive: true });
      mkdirSync(wsSkillsDir, { recursive: true });
      fileCtx.sandboxProvider = context.shell.sandboxProvider;
      fileCtx.sandboxConfig = {
        ...context.shell.sandboxConfig,
        mounts: [
          { hostPath: wsWorkDir, containerPath: wsWorkDir, mode: 'rw' as const },
          { hostPath: wsSkillsDir, containerPath: wsSkillsDir, mode: 'rw' as const },
          ...context.shell.sandboxConfig.mounts,
        ],
      };
      fileCtx.allowedPaths = [wsWorkDir, wsSkillsDir, '/tmp'];
    } else if (context.workspaceId && context.configManager) {
      const wsWorkDir = path.join(context.configManager.getWorkspacePath(context.workspaceId), 'work');
      const wsSkillsDir = path.join(context.configManager.getWorkspacePath(context.workspaceId), 'skills');
      fileCtx.allowedPaths = [wsWorkDir, wsSkillsDir, '/tmp'];
    } else {
      fileCtx.allowedPaths = context.shell?.allowedPaths;
    }
    return handleFileTool(name, args, fileCtx);
  }

  if (KNOWLEDGE_TOOLS.has(name)) {
    const ctx: KnowledgeToolContext = {
      vectorStore: context.vectorStore,
      embeddingProvider: context.embeddingProvider,
      workspacePath: context.configManager?.getWorkspacePath(context.workspaceId),
    };
    return handleKnowledgeTool(name, args, ctx);
  }

  if (MCP_MGMT_TOOLS.has(name)) {
    if (!context.mcpManager) {
      return JSON.stringify({ ok: false, error: 'MCP manager is not initialized' });
    }
    const ctx: McpToolContext = {
      mcpManager: context.mcpManager,
      multiUserEnabled: context.multiUserMode,
      isAdmin: false,
    };
    return handleMcpTool(name, args, ctx);
  }

  if (SUBAGENT_TOOLS.has(name)) {
    if (!context.subAgentManager) {
      return JSON.stringify({ ok: false, error: 'Sub-agent system is not initialized' });
    }
    const ctx: SubAgentToolContext = {
      subAgentManager: context.subAgentManager,
      workspaceId: context.workspaceId,
    };
    return handleSubAgentTool(name, args, ctx);
  }

  if (MEMORY_TOOLS.has(name)) {
    if (!context.memoryManager) {
      return JSON.stringify({ ok: false, error: 'Memory manager is not initialized' });
    }
    const ctx: MemoryToolContext = {
      memoryManager: context.memoryManager,
      workspaceId: context.workspaceId,
    };
    return handleMemoryTool(name, args, ctx);
  }

  if (SETTINGS_TOOLS.has(name)) {
    if (!context.configManager) {
      return JSON.stringify({ ok: false, error: 'Config manager is not initialized' });
    }
    const ctx: SettingsToolContext = { configManager: context.configManager, workspaceId: context.workspaceId };
    return handleSettingsTool(name, args, ctx);
  }

  if (IDENTITY_TOOLS.has(name)) {
    if (!context.configManager) {
      return JSON.stringify({ ok: false, error: 'Config manager is not initialized' });
    }
    const ctx: IdentityToolContext = { configManager: context.configManager, workspaceId: context.workspaceId };
    return handleIdentityTool(name, args, ctx);
  }

  if (SKILL_TOOLS.has(name)) {
    if (!context.skillRegistry || !context.skillsDir) {
      return JSON.stringify({ ok: false, error: 'Skill registry is not initialized' });
    }
    const ctx: SkillToolContext = {
      skillRegistry: context.skillRegistry,
      skillsDir: context.skillsDir,
      customEnv: context.shell?.customEnv,
      configManager: context.configManager!
    };
    return handleSkillTool(name, args, ctx, multiUserMode, context.workspaceId);
  }

  if (WEB_FETCH_TOOLS.has(name)) {
    return handleWebFetchTool(name, args);
  }

  if (context.mcpManager) {
    const mcpClient = context.mcpManager.findClientForTool(name);
    if (mcpClient) {
      logger.info(SCOPE, `Routing "${name}" to MCP server "${mcpClient.serverName}"`);
      return context.mcpManager.callTool(name, args);
    }
  }

  logger.warn(SCOPE, `Unknown tool: ${name}`);
  return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
}

export {
  schedulerToolDefinitions,
  handleSchedulerTool,
  mailToolDefinitions,
  handleMailTool,
  browserToolDefinitions,
  handleBrowserTool,
  webSearchToolDefinitions,
  handleWebSearchTool,
  homeAssistantToolDefinitions,
  handleHomeAssistantTool,
  shellToolDefinitions,
  handleShellTool,
  mcpToolDefinitions,
  handleMcpTool,
  subAgentToolDefinitions,
  handleSubAgentTool,
  memoryToolDefinitions,
  handleMemoryTool,
  settingsToolDefinitions,
  handleSettingsTool,
  identityToolDefinitions,
  handleIdentityTool,
};

export type {
  SchedulerToolContext,
  MailToolContext,
  BrowserToolContext,
  WebSearchToolContext,
  HomeAssistantToolContext,
  ShellToolContext,
  McpToolContext,
  SubAgentToolContext,
  MemoryToolContext,
  SettingsToolContext,
  IdentityToolContext,
};

export function buildManagedShellExecution(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): ManagedExecution | { error: string } {
  if (!context.shell) return { error: 'Shell access is not enabled.' };
  const command = args.command as string;
  if (!command || typeof command !== 'string' || !command.trim()) return { error: 'Command must be a non-empty string' };

  let shellCtx = context.shell;
  if (shellCtx.sandboxProvider && shellCtx.sandboxConfig && context.workspaceId && context.configManager) {
    const wsWorkDir = path.join(context.configManager.getWorkspacePath(context.workspaceId), 'work');
    const wsSkillsDir = path.join(context.configManager.getWorkspacePath(context.workspaceId), 'skills');
    mkdirSync(wsWorkDir, { recursive: true });
    mkdirSync(wsSkillsDir, { recursive: true });
    shellCtx = {
      ...shellCtx,
      workingDirectory: wsWorkDir,
      sandboxConfig: {
        ...shellCtx.sandboxConfig,
        mounts: [
          { hostPath: wsWorkDir, containerPath: wsWorkDir, mode: 'rw' as const },
          { hostPath: wsSkillsDir, containerPath: wsSkillsDir, mode: 'rw' as const },
          ...shellCtx.sandboxConfig.mounts,
        ],
      },
    };
  }

  return createManagedShellExecution(command, shellCtx, args);
}
