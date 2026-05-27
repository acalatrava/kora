import type { Plugin, ChannelPlugin, ConnectorPlugin, PluginConfig } from './types.js';
import { logger } from '../core/logger.js';

const SCOPE = 'plugin-registry';

export class PluginRegistry {
  private plugins = new Map<string, Plugin>();
  private configs = new Map<string, PluginConfig>();

  register(plugin: Plugin, config: PluginConfig): void {
    this.plugins.set(plugin.name, plugin);
    this.configs.set(plugin.name, config);
    logger.info(SCOPE, `Registered plugin "${plugin.name}" (${plugin.type} v${plugin.version})`);
  }

  get(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  getChannel(name: string): ChannelPlugin | undefined {
    const p = this.plugins.get(name);
    return p?.type === 'channel' ? p as ChannelPlugin : undefined;
  }

  getConnector(name: string): ConnectorPlugin | undefined {
    const p = this.plugins.get(name);
    return p?.type === 'connector' ? p as ConnectorPlugin : undefined;
  }

  list(type?: 'channel' | 'connector'): Plugin[] {
    const all = Array.from(this.plugins.values());
    return type ? all.filter(p => p.type === type) : all;
  }

  listConfigs(): PluginConfig[] {
    return Array.from(this.configs.values());
  }

  async stopAll(): Promise<void> {
    for (const [name, plugin] of this.plugins) {
      try {
        if (plugin.type === 'channel') {
          await (plugin as ChannelPlugin).stop();
        } else if ((plugin as ConnectorPlugin).stop) {
          await (plugin as ConnectorPlugin).stop!();
        }
        logger.info(SCOPE, `Stopped plugin "${name}"`);
      } catch (err) {
        logger.error(SCOPE, `Error stopping plugin "${name}": ${(err as Error).message}`);
      }
    }
  }

  remove(name: string): boolean {
    this.configs.delete(name);
    return this.plugins.delete(name);
  }
}
