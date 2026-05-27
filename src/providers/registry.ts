import type { ProviderConfig, ModelConfig, ModelRole } from '../core/types.js';
import { logger } from '../core/logger.js';
import { LLMProvider } from './base.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai-compat.js';

export interface ResolvedModel {
  provider: LLMProvider;
  providerId: string;
  model: ModelConfig;
}

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();
  private providerConfigs = new Map<string, ProviderConfig>();
  private defaultId: string | null = null;

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
    logger.debug('ProviderRegistry', `Registered provider "${provider.id}" (${provider.type})`);

    if (this.providers.size === 1) {
      this.defaultId = provider.id;
    }
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  getDefault(): LLMProvider {
    if (!this.defaultId) {
      throw new Error('No default provider configured');
    }
    const provider = this.providers.get(this.defaultId);
    if (!provider) {
      throw new Error(`Default provider "${this.defaultId}" not found in registry`);
    }
    return provider;
  }

  setDefault(id: string): void {
    if (!this.providers.has(id)) {
      throw new Error(`Cannot set default: provider "${id}" not registered`);
    }
    this.defaultId = id;
  }

  list(): LLMProvider[] {
    return [...this.providers.values()];
  }

  registerConfig(config: ProviderConfig): void {
    this.providerConfigs.set(config.id, config);
  }

  getByRole(role: ModelRole): ResolvedModel | undefined {
    for (const [providerId, cfg] of this.providerConfigs) {
      for (const model of cfg.models) {
        if (model.roles?.includes(role)) {
          const provider = this.providers.get(providerId);
          if (provider) return { provider, providerId, model };
        }
      }
    }
    return undefined;
  }

  getFallback(): ResolvedModel | undefined {
    return this.getByRole('fallback');
  }

  resolveByModelId(modelId: string): ResolvedModel | undefined {
    for (const [providerId, cfg] of this.providerConfigs) {
      for (const model of cfg.models) {
        if (model.id === modelId) {
          const provider = this.providers.get(providerId);
          if (provider) return { provider, providerId, model };
        }
      }
    }
    return undefined;
  }

  listModelsWithRoles(): Array<{ providerId: string; providerType: string; model: ModelConfig }> {
    const result: Array<{ providerId: string; providerType: string; model: ModelConfig }> = [];
    for (const [, cfg] of this.providerConfigs) {
      for (const model of cfg.models) {
        result.push({ providerId: cfg.id, providerType: cfg.type, model });
      }
    }
    return result;
  }

  reloadProviders(configs: ProviderConfig[]): void {
    const oldDefault = this.defaultId;
    this.providers.clear();
    this.providerConfigs.clear();
    this.defaultId = null;
    for (const cfg of configs) {
      try {
        const modelIds = cfg.models.map(m => m.id);
        const provider = createProvider(cfg, modelIds);
        this.register(provider);
        this.registerConfig(cfg);
      } catch (err) {
        logger.error('ProviderRegistry', `Failed to reload provider "${cfg.id}": ${(err as Error).message}`);
      }
    }
    if (oldDefault && this.providers.has(oldDefault)) {
      this.defaultId = oldDefault;
    }
    logger.info('ProviderRegistry', `Reloaded ${this.providers.size} provider(s)`);
  }

  static fromConfig(providers: ProviderConfig[]): ProviderRegistry {
    const registry = new ProviderRegistry();

    for (const cfg of providers) {
      try {
        const modelIds = cfg.models.map((m) => m.id);
        const provider = createProvider(cfg, modelIds);
        registry.register(provider);
        registry.registerConfig(cfg);
      } catch (err) {
        logger.error('ProviderRegistry', `Failed to create provider "${cfg.id}": ${(err as Error).message}`);
      }
    }

    return registry;
  }
}

function createProvider(cfg: ProviderConfig, models: string[]): LLMProvider {
  switch (cfg.type) {
    case 'openai':
      if (!cfg.apiKey) throw new Error('OpenAI provider requires an apiKey');
      return new OpenAIProvider(cfg.id, { apiKey: cfg.apiKey, models });

    case 'anthropic':
      if (!cfg.apiKey) throw new Error('Anthropic provider requires an apiKey');
      return new AnthropicProvider(cfg.id, { apiKey: cfg.apiKey, models });

    case 'openai_compat': {
      if (!cfg.baseUrl) throw new Error('OpenAI-compatible provider requires a baseUrl');
      const profile = cfg.models[0]?.toolCallProfile ?? 'standard';
      return new OpenAICompatProvider(cfg.id, {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        models,
        toolCallProfile: profile,
      });
    }

    default:
      throw new Error(`Unknown provider type: ${cfg.type}`);
  }
}
