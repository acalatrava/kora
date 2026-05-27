import type { ToolDefinition } from '../core/types.js';
import type { MemoryManager } from '../core/memory.js';
import { logger } from '../core/logger.js';

const SCOPE = 'memory-tool';

export interface MemoryToolContext {
  memoryManager: MemoryManager;
  workspaceId: string;
}

export const memoryToolDefinitions: ToolDefinition[] = [
  {
    name: 'memory_read',
    description: 'Read the current long-term memory entries. Returns all entries with their IDs. Memory is also injected into every prompt automatically, so only use this when you need to verify the latest state.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'memory_write',
    description: 'Replace the entire long-term memory with new content. Use this to reorganize or rewrite memory when it becomes outdated or messy. Content should use the entry format: "## [mem-ID] TIMESTAMP\\nContent".',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The new full content of MEMORY.md (markdown format)' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_append',
    description: 'Add a new entry to long-term memory. Each entry gets a unique ID and timestamp. Use this often to remember facts, preferences, decisions, project context, and anything useful for future interactions.',
    parameters: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'The memory entry content to save' },
      },
      required: ['entry'],
    },
  },
  {
    name: 'memory_remove',
    description: 'Remove a specific memory entry by its ID. Use this to clean up outdated, incorrect, or no longer relevant information.',
    parameters: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'The entry ID to remove (e.g., "a1b2c3d4" from [mem-a1b2c3d4])' },
      },
      required: ['entry_id'],
    },
  },
  {
    name: 'memory_list',
    description: 'List all memory entries with their IDs, timestamps, and content previews. Useful for deciding which entries to update or remove.',
    parameters: { type: 'object', properties: {} },
  },
];

export async function handleMemoryTool(
  name: string,
  args: Record<string, unknown>,
  context: MemoryToolContext,
): Promise<string> {
  try {
    switch (name) {
      case 'memory_read': {
        const content = context.memoryManager.load(context.workspaceId);
        return JSON.stringify({ ok: true, content: content || '(empty — no memories stored yet)' });
      }
      case 'memory_write': {
        const contentCandidate = (
          (typeof args.content === 'string' && args.content) ||
          (typeof args.text === 'string' && args.text) ||
          (typeof args.memory === 'string' && args.memory) ||
          (typeof (args as any).data === 'string' && (args as any).data) ||
          undefined
        );
        if (typeof contentCandidate !== 'string' || !contentCandidate.trim()) {
          const keys = args ? Object.keys(args) : [];
          logger.warn(SCOPE, `memory_write invalid args for workspace ${context.workspaceId}. Keys=${keys.join(', ')}`);
          return JSON.stringify({ ok: false, error: 'memory_write requires a non-empty string field: content (or alias: text/memory/data).' });
        }
        context.memoryManager.save(context.workspaceId, contentCandidate);
        logger.info(SCOPE, `Memory rewritten for workspace ${context.workspaceId}`);
        return JSON.stringify({ ok: true, message: 'Memory updated successfully.' });
      }
      case 'memory_append': {
        const entryCandidate = (
          (typeof args.entry === 'string' && args.entry) ||
          (typeof (args as any).text === 'string' && (args as any).text) ||
          (typeof (args as any).memory === 'string' && (args as any).memory) ||
          undefined
        );
        if (typeof entryCandidate !== 'string' || !entryCandidate.trim()) {
          const keys = args ? Object.keys(args) : [];
          logger.warn(SCOPE, `memory_append invalid args for workspace ${context.workspaceId}. Keys=${keys.join(', ')}`);
          return JSON.stringify({ ok: false, error: 'memory_append requires a non-empty string field: entry (or alias: text/memory).' });
        }
        const newEntry = context.memoryManager.append(context.workspaceId, entryCandidate);
        logger.info(SCOPE, `Memory entry appended: mem-${newEntry.id}`);
        return JSON.stringify({ ok: true, message: `Memory entry saved with ID: mem-${newEntry.id}`, id: newEntry.id });
      }
      case 'memory_remove': {
        const entryIdRaw = (
          (typeof args.entry_id === 'string' && args.entry_id) ||
          (typeof (args as any).entryId === 'string' && (args as any).entryId) ||
          (typeof (args as any).id === 'string' && (args as any).id) ||
          (typeof (args as any).entry === 'string' && (args as any).entry) ||
          undefined
        );
        if (typeof entryIdRaw !== 'string' || !entryIdRaw.trim()) {
          const keys = args ? Object.keys(args) : [];
          logger.warn(SCOPE, `memory_remove invalid args for workspace ${context.workspaceId}. Keys=${keys.join(', ')}`);
          return JSON.stringify({ ok: false, error: 'memory_remove requires a string field entry_id (or aliases: entryId/id/entry).' });
        }

        // Accept both "a1b2" and "[mem-a1b2]" and "mem-a1b2".
        // We intentionally only keep the mem-* hex/alnum tail.
        const idMatch = entryIdRaw.match(/(?:\[)?\s*(?:mem-)?([a-z0-9]+)\s*(?:\])?/i);
        const entryId = (idMatch?.[1] || '').toLowerCase();
        if (!entryId) {
          return JSON.stringify({ ok: false, error: `memory_remove could not parse entry id from: ${entryIdRaw}` });
        }
        const removed = context.memoryManager.remove(context.workspaceId, entryId);
        if (removed) {
          logger.info(SCOPE, `Memory entry removed: mem-${entryId}`);
          return JSON.stringify({ ok: true, message: `Entry mem-${entryId} removed.` });
        }
        return JSON.stringify({ ok: false, error: `Entry mem-${entryId} not found.` });
      }
      case 'memory_list': {
        const entries = context.memoryManager.list(context.workspaceId);
        if (entries.length === 0) {
          return JSON.stringify({ ok: true, entries: [], message: 'No memory entries stored yet.' });
        }
        const list = entries.map(e => ({
          id: `mem-${e.id}`,
          timestamp: e.timestamp,
          preview: e.content.slice(0, 120) + (e.content.length > 120 ? '…' : ''),
        }));
        return JSON.stringify({ ok: true, count: entries.length, entries: list });
      }
      default:
        return JSON.stringify({ ok: false, error: `Unknown memory tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(SCOPE, `${name} failed: ${msg}`);
    return JSON.stringify({ ok: false, error: msg });
  }
}
