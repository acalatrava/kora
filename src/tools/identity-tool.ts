import type { ToolDefinition } from '../core/types.js';
import type { ConfigManager } from '../core/config.js';
import { logger } from '../core/logger.js';

const SCOPE = 'identity-tool';

export interface IdentityToolContext {
  configManager: ConfigManager;
  workspaceId?: string;
}

export const identityToolDefinitions: ToolDefinition[] = [
  {
    name: 'identity_read',
    description: 'Read the current IDENTITY.md that defines who you are — your personality, motivations, and self-improvement goals.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'agent_evolve',
    description: 'Evolve your identity by updating IDENTITY.md. Use this to refine your personality, add learned traits, or update your goals based on experiences. Each evolution is logged with a timestamp.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The updated IDENTITY.md content (markdown format). Include your personality, motivations, goals, and an evolution log section.',
        },
        reason: {
          type: 'string',
          description: 'Brief explanation of why you are evolving (what triggered this change).',
        },
      },
      required: ['content', 'reason'],
    },
  },
];

export async function handleIdentityTool(
  name: string,
  args: Record<string, unknown>,
  context: IdentityToolContext,
): Promise<string> {
  try {
    switch (name) {
      case 'identity_read': {
        const wsId = context.workspaceId;
        const wsIdentity = wsId ? context.configManager.loadWorkspaceIdentityMd(wsId) : '';
        const globalIdentity = context.configManager.loadIdentityMd();
        const content = wsIdentity || globalIdentity;
        return JSON.stringify({ ok: true, content: content || '(no identity defined yet)', source: wsIdentity ? 'workspace' : 'global' });
      }
      case 'agent_evolve': {
        const content = args.content as string;
        const reason = args.reason as string;
        if (!content) return JSON.stringify({ ok: false, error: 'content is required' });

        const timestamp = new Date().toISOString();
        const evolutionEntry = `\n\n---\n_Evolution log — ${timestamp}_\n_Reason: ${reason}_\n`;
        const finalContent = content.includes('## Evolution Log')
          ? content
          : content + '\n\n## Evolution Log\n' + evolutionEntry;

        const wsId = context.workspaceId;
        if (wsId) {
          context.configManager.saveWorkspaceIdentityMd(wsId, finalContent);
        } else {
          context.configManager.saveIdentityMd(finalContent);
        }
        logger.info(SCOPE, `Identity evolved: ${reason}`);
        return JSON.stringify({ ok: true, message: 'Identity updated.', reason });
      }
      default:
        return JSON.stringify({ ok: false, error: `Unknown identity tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(SCOPE, `${name} failed: ${msg}`);
    return JSON.stringify({ ok: false, error: msg });
  }
}
