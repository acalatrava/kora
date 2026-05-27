import type { ToolDefinition } from '../core/types.js';
import type { ConfigManager } from '../core/config.js';
import { logger } from '../core/logger.js';

const SCOPE = 'settings-tool';

export interface SettingsToolContext {
  configManager: ConfigManager;
  workspaceId?: string;
}

export const settingsToolDefinitions: ToolDefinition[] = [
  {
    name: 'settings_read',
    description: 'Read the current Kora settings. Returns the full configuration including tools, heartbeat, web admin, and general settings.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'settings_update',
    description: 'Update one or more Kora settings. Provide a JSON object with the keys to update. Supports nested keys like tools.shell, heartbeat.enabled, etc.',
    parameters: {
      type: 'object',
      properties: {
        updates: {
          type: 'object',
          description: 'Key-value pairs to update. Examples: {"defaultModel": "gpt-4o"}, {"tools": {"shell": true}}, {"heartbeat": {"intervalMinutes": 10}}',
        },
      },
      required: ['updates'],
    },
  },
  {
    name: 'agent_prompt_read',
    description: 'Read the current AGENT.md system prompt that defines your behavior and personality.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'agent_prompt_write',
    description: 'Update the AGENT.md system prompt. Use this to modify your own behavior instructions, personality, or guidelines.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The new AGENT.md content (markdown format)' },
      },
      required: ['content'],
    },
  },
];

export async function handleSettingsTool(
  name: string,
  args: Record<string, unknown>,
  context: SettingsToolContext,
): Promise<string> {
  try {
    switch (name) {
      case 'settings_read': {
        const settings = context.configManager.loadSettings();
        const { storagePath: _, ...safe } = settings;
        return JSON.stringify({ ok: true, settings: safe });
      }
      case 'settings_update': {
        const updates = args.updates as Record<string, unknown>;
        if (!updates || typeof updates !== 'object') {
          return JSON.stringify({ ok: false, error: 'updates must be an object' });
        }

        const RESTRICTED_KEYS = ['storagePath', 'logLevel', 'unlimitedMode', 'unlimited_mode'];
        for (const key of RESTRICTED_KEYS) {
          if (key in updates) {
            return JSON.stringify({ ok: false, error: `Cannot modify restricted setting "${key}" via agent. This setting can only be changed by the user via Telegram.` });
          }
        }

        if (updates.tools && typeof updates.tools === 'object') {
          const toolUpdates = updates.tools as Record<string, unknown>;
          const SECURITY_TOOLS = ['shell'];
          for (const t of SECURITY_TOOLS) {
            if (t in toolUpdates && toolUpdates[t] === true) {
              return JSON.stringify({ ok: false, error: `Cannot enable "${t}" tool via agent for security reasons. Enable it manually via Telegram /settings or config file.` });
            }
          }
        }

        const current = context.configManager.loadSettings();
        const merged = deepMerge(current as unknown as Record<string, unknown>, updates) as Partial<import('../core/types.js').Settings>;
        context.configManager.saveSettings(merged);
        logger.info(SCOPE, `Settings updated: ${Object.keys(updates).join(', ')}`);
        return JSON.stringify({ ok: true, message: 'Settings updated. Some changes may require a restart.' });
      }
      case 'agent_prompt_read': {
        const content = context.configManager.loadAgentMd();
        return JSON.stringify({ ok: true, content: content || '(empty)' });
      }
      case 'agent_prompt_write': {
        const content = args.content as string;
        context.configManager.saveAgentMd(content);
        logger.info(SCOPE, 'AGENT.md updated by agent');
        return JSON.stringify({ ok: true, message: 'Agent prompt updated.' });
      }
      default:
        return JSON.stringify({ ok: false, error: `Unknown settings tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(SCOPE, `${name} failed: ${msg}`);
    return JSON.stringify({ ok: false, error: msg });
  }
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, val] of Object.entries(source)) {
    if (val && typeof val === 'object' && !Array.isArray(val) && typeof result[key] === 'object' && result[key] !== null) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result;
}
