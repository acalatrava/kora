import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { logger } from '../core/logger.js';
import type { Plugin, PluginConfig, ChannelPlugin, ConnectorPlugin, ChannelCallbacks, ConnectorCallbacks } from './types.js';
import { PluginRegistry } from './registry.js';

const SCOPE = 'plugin-loader';

export async function loadPlugin(packageName: string): Promise<Plugin> {
  try {
    const mod = await import(packageName);
    const plugin: Plugin = mod.default ?? mod;

    if (!plugin.name || !plugin.version || !plugin.type) {
      throw new Error(`Plugin "${packageName}" is missing required fields (name, version, type)`);
    }
    if (!['channel', 'connector'].includes(plugin.type)) {
      throw new Error(`Plugin "${packageName}" has invalid type "${plugin.type}"`);
    }

    return plugin;
  } catch (err) {
    throw new Error(`Failed to load plugin "${packageName}": ${(err as Error).message}`);
  }
}

export function loadPluginConfigs(configPath: string): PluginConfig[] {
  const pluginsFile = path.join(configPath, 'plugins.yml');
  if (!fs.existsSync(pluginsFile)) return [];

  try {
    const content = fs.readFileSync(pluginsFile, 'utf-8');
    const parsed = parseYaml(content) as PluginConfig[] | null;
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logger.warn(SCOPE, `Failed to parse plugins.yml: ${(err as Error).message}`);
    return [];
  }
}

export function savePluginConfigs(configPath: string, configs: PluginConfig[]): void {
  const pluginsFile = path.join(configPath, 'plugins.yml');
  fs.writeFileSync(pluginsFile, stringifyYaml(configs), 'utf-8');
}

export async function initializePlugins(
  configPath: string,
  registry: PluginRegistry,
  channelCallbacks: ChannelCallbacks,
  connectorCallbacks: ConnectorCallbacks,
): Promise<void> {
  const configs = loadPluginConfigs(configPath);

  for (const cfg of configs) {
    if (!cfg.enabled) {
      logger.info(SCOPE, `Plugin "${cfg.name}" is disabled, skipping`);
      continue;
    }

    try {
      const plugin = await loadPlugin(cfg.package);

      if (plugin.type === 'channel') {
        await (plugin as ChannelPlugin).initialize(cfg.config || {}, channelCallbacks);
        await (plugin as ChannelPlugin).start();
      } else if (plugin.type === 'connector') {
        await (plugin as ConnectorPlugin).initialize(cfg.config || {}, connectorCallbacks);
        await (plugin as ConnectorPlugin).index();
      }

      registry.register(plugin, cfg);
      logger.info(SCOPE, `Plugin "${cfg.name}" (${cfg.package}) initialized and started`);
    } catch (err) {
      logger.error(SCOPE, `Failed to initialize plugin "${cfg.name}": ${(err as Error).message}`);
    }
  }
}
