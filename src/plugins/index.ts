export { PluginRegistry } from './registry.js';
export { loadPlugin, loadPluginConfigs, savePluginConfigs, initializePlugins } from './loader.js';
export type {
  Plugin,
  PluginManifest,
  ChannelPlugin,
  ConnectorPlugin,
  ChannelCallbacks,
  ConnectorCallbacks,
  PluginConfig,
  PluginSetupQuestion,
} from './types.js';
