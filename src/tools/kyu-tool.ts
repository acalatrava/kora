import type { ToolDefinition } from '../core/types.js';
import type { ConfigManager } from '../core/config.js';
import { logger } from '../core/logger.js';

const SCOPE = 'kyu-tool';

export interface KyuToolContext {
  configManager: ConfigManager;
  workspaceId: string;
}

export const kyuToolDefinitions: ToolDefinition[] = [
  {
    name: 'kyu_read',
    description: 'Read the current KYU (Know Your User) profile. Returns the full content of KYU.md for this user.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'kyu_write',
    description: 'Write the full KYU (Know Your User) profile. Overwrites the entire KYU.md with the provided content. Always read first, merge new insights with existing data, and write the complete updated profile.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The complete KYU.md content in structured markdown format' },
      },
      required: ['content'],
    },
  },
];

export async function handleKyuTool(
  name: string,
  args: Record<string, unknown>,
  ctx: KyuToolContext,
): Promise<string> {
  switch (name) {
    case 'kyu_read': {
      const content = ctx.configManager.loadKyuMd(ctx.workspaceId);
      if (!content) return JSON.stringify({ ok: true, content: '', message: 'KYU profile is empty. No user profile exists yet.' });
      return JSON.stringify({ ok: true, content });
    }

    case 'kyu_write': {
      const content = args.content as string | undefined;
      if (!content) return JSON.stringify({ ok: false, error: 'content is required' });
      ctx.configManager.saveKyuMd(ctx.workspaceId, content);
      logger.info(SCOPE, `KYU profile updated for workspace ${ctx.workspaceId} (${content.length} chars)`);
      return JSON.stringify({ ok: true, message: 'KYU profile saved successfully.' });
    }

    default:
      return JSON.stringify({ ok: false, error: `Unknown KYU tool: ${name}` });
  }
}
