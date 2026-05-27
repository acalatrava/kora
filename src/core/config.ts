import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { logger } from './logger.js';
import type { KoraConfig, Settings, ProviderConfig, ChannelConfig } from './types.js';

function deepMergeSettings(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)
    ) {
      result[key] = deepMergeSettings(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else if (srcVal !== undefined) {
      result[key] = srcVal;
    }
  }
  return result;
}

const DEFAULT_STORAGE_PATH = process.env.KORA_STORAGE_PATH || path.join(
  process.env.HOME || process.env.USERPROFILE || '~',
  '.kora'
);

const DEFAULT_SETTINGS: Settings = {
  storagePath: DEFAULT_STORAGE_PATH,
  defaultProvider: 'openai',
  defaultModel: 'gpt-4o',
  maxTokens: 16384,
  maxContextTokens: 200000,
  maxIterations: 50,
  maxIterationsEnforced: 100,
  multiUser: false,
  logLevel: 'info',
  tools: {
    scheduler: true,
    browser: true,
    shell: false,
    web_search: false,
    mail: false,
    homeassistant_mqtt: false,
    mcp: true,
  },
  heartbeat: {
    enabled: true,
    intervalMinutes: 5,
  },
  web_admin: {
    enabled: true,
    port: 3100,
  },
};

export class ConfigManager {
  readonly basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath || DEFAULT_STORAGE_PATH;
  }

  get configPath(): string {
    return path.join(this.basePath, 'config');
  }

  get skillsPath(): string {
    return path.join(this.basePath, 'skills');
  }

  get toolsPath(): string {
    return path.join(this.basePath, 'tools');
  }

  get workspacesPath(): string {
    return path.join(this.basePath, 'workspaces');
  }

  get logsPath(): string {
    return path.join(this.basePath, 'logs');
  }

  getWorkspacePath(workspaceId: string): string {
    return path.join(this.workspacesPath, workspaceId);
  }

  ensureDirectories(): void {
    const dirs = [
      this.basePath,
      this.configPath,
      this.skillsPath,
      this.toolsPath,
      this.workspacesPath,
      this.logsPath,
    ];
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }
    logger.debug('config', `Ensured directories at ${this.basePath}`);
  }

  ensureWorkspaceDir(workspaceId: string): string {
    const wsPath = this.getWorkspacePath(workspaceId);
    const agentsPath = path.join(wsPath, 'agents');
    fs.mkdirSync(agentsPath, { recursive: true });
    return wsPath;
  }

  loadSettings(): Settings {
    const filePath = path.join(this.configPath, 'settings.yml');
    if (!fs.existsSync(filePath)) return { ...DEFAULT_SETTINGS, storagePath: this.basePath };
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseYaml(raw) as Partial<Settings>;
      return deepMergeSettings(
        { ...DEFAULT_SETTINGS, storagePath: this.basePath } as unknown as Record<string, unknown>,
        parsed as unknown as Record<string, unknown>,
      ) as unknown as Settings;
    } catch (err) {
      logger.warn('config', `Failed to parse settings.yml, using defaults: ${err}`);
      return { ...DEFAULT_SETTINGS, storagePath: this.basePath };
    }
  }

  saveSettings(settings: Partial<Settings>): void {
    const filePath = path.join(this.configPath, 'settings.yml');
    const current = this.loadSettings();
    const merged = deepMergeSettings(
      current as unknown as Record<string, unknown>,
      settings as unknown as Record<string, unknown>,
    ) as unknown as Settings;
    const { storagePath: _, ...toSave } = merged;
    fs.writeFileSync(filePath, stringifyYaml(toSave), 'utf-8');
  }

  loadProviders(): ProviderConfig[] {
    const filePath = path.join(this.configPath, 'providers.yml');
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseYaml(raw);
      return (parsed?.providers as ProviderConfig[]) || [];
    } catch (err) {
      logger.warn('config', `Failed to parse providers.yml: ${err}`);
      return [];
    }
  }

  saveProviders(providers: ProviderConfig[]): void {
    const filePath = path.join(this.configPath, 'providers.yml');
    fs.writeFileSync(filePath, stringifyYaml({ providers }), 'utf-8');
  }

  loadChannels(): ChannelConfig[] {
    const filePath = path.join(this.configPath, 'channels.yml');
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseYaml(raw);
      return (parsed?.channels as ChannelConfig[]) || [];
    } catch (err) {
      logger.warn('config', `Failed to parse channels.yml: ${err}`);
      return [];
    }
  }

  saveChannels(channels: ChannelConfig[]): void {
    const filePath = path.join(this.configPath, 'channels.yml');
    fs.writeFileSync(filePath, stringifyYaml({ channels }), 'utf-8');
  }

  loadAgentMd(): string {
    const filePath = path.join(this.configPath, 'AGENT.md');
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
  }

  saveAgentMd(content: string): void {
    const filePath = path.join(this.configPath, 'AGENT.md');
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  loadFullConfig(): KoraConfig {
    return {
      settings: this.loadSettings(),
      providers: this.loadProviders(),
      channels: this.loadChannels(),
    };
  }

  isConfigured(): boolean {
    return fs.existsSync(path.join(this.configPath, 'settings.yml'));
  }

  private static ADMIN_ONLY_KEYS = new Set([
    'storagePath', 'logLevel', 'shell_sandbox', 'web_admin',
    'multiUser', 'billing', 'mail_delegation',
  ]);

  loadWorkspaceSettings(workspaceId: string): Settings {
    const global = this.loadSettings();
    const wsPath = path.join(this.getWorkspacePath(workspaceId), 'settings.yml');
    if (!fs.existsSync(wsPath)) return global;

    try {
      const raw = fs.readFileSync(wsPath, 'utf-8');
      const wsSettings = parseYaml(raw) as Record<string, unknown> | null;
      if (!wsSettings) return global;

      const filtered: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(wsSettings)) {
        if (!ConfigManager.ADMIN_ONLY_KEYS.has(key)) {
          filtered[key] = val;
        }
      }

      return deepMergeSettings(
        global as unknown as Record<string, unknown>,
        filtered,
      ) as unknown as Settings;
    } catch (err) {
      logger.warn('config', `Failed to parse workspace settings for ${workspaceId}: ${err}`);
      return global;
    }
  }

  saveWorkspaceSettings(workspaceId: string, settings: Record<string, unknown>): void {
    const wsDir = this.getWorkspacePath(workspaceId);
    fs.mkdirSync(wsDir, { recursive: true });
    const wsPath = path.join(wsDir, 'settings.yml');

    const filtered: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(settings)) {
      if (!ConfigManager.ADMIN_ONLY_KEYS.has(key)) {
        filtered[key] = val;
      }
    }

    fs.writeFileSync(wsPath, stringifyYaml(filtered), 'utf-8');
  }

  loadWorkspaceAgentMd(workspaceId: string): string {
    const wsPath = path.join(this.getWorkspacePath(workspaceId), 'AGENT.md');
    if (!fs.existsSync(wsPath)) return '';
    return fs.readFileSync(wsPath, 'utf-8');
  }

  loadIdentityMd(): string {
    const filePath = path.join(this.configPath, 'IDENTITY.md');
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
  }

  saveIdentityMd(content: string): void {
    const filePath = path.join(this.configPath, 'IDENTITY.md');
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  loadWorkspaceIdentityMd(workspaceId: string): string {
    const wsPath = path.join(this.getWorkspacePath(workspaceId), 'IDENTITY.md');
    if (!fs.existsSync(wsPath)) return '';
    return fs.readFileSync(wsPath, 'utf-8');
  }

  saveWorkspaceIdentityMd(workspaceId: string, content: string): void {
    const wsDir = this.getWorkspacePath(workspaceId);
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'IDENTITY.md'), content, 'utf-8');
  }

  loadKyuMd(workspaceId: string): string {
    const wsPath = path.join(this.getWorkspacePath(workspaceId), 'KYU.md');
    if (!fs.existsSync(wsPath)) return '';
    return fs.readFileSync(wsPath, 'utf-8');
  }

  saveKyuMd(workspaceId: string, content: string): void {
    const wsDir = this.getWorkspacePath(workspaceId);
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'KYU.md'), content, 'utf-8');
  }
}

let _instance: ConfigManager | null = null;

export function getConfig(basePath?: string): ConfigManager {
  if (!_instance) {
    _instance = new ConfigManager(basePath);
  }
  return _instance;
}
