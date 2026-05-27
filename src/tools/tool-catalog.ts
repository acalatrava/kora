import type { ToolDefinition } from '../core/types.js';
import { logger } from '../core/logger.js';
import { notifyToolDefinition, finishToolDefinition } from './notify-tool.js';

const SCOPE = 'tool-catalog';

export interface CatalogEntry {
  name: string;
  description: string;
  category: string;
  source: string;
  definition: ToolDefinition;
}

const CORE_TOOL_NAMES = new Set([
  'memory_append',
  'settings_read', 'subagent_dispatch',
  'identity_read', 'agent_evolve',
  'find_tools', 'notify', 'finish',
  'wait_for_tool', 'kill_tool',
  'file_list', 'file_info', 'file_write_text', 'file_read_text',
  'knowledge_search',
  'mcp_install', 'mcp_list',
  'skill_list', 'skill_read',
  'mail_delegation_inbox', 'mail_delegation_read', 'mail_delegation_search',
  'mail_delegation_reply', 'mail_delegation_send',
]);

function categorizeBuiltinTool(name: string): string {
  if (name.startsWith('memory_') || name.startsWith('agent_prompt_')) return 'memory';
  if (name.startsWith('identity_') || name === 'agent_evolve') return 'identity';
  if (name.startsWith('settings_')) return 'settings';
  if (name.startsWith('scheduler_')) return 'scheduler';
  if (name.startsWith('mcp_')) return 'mcp';
  if (name.startsWith('browser_')) return 'browser';
  if (name.startsWith('web_search') || name === 'web_search') return 'search';
  if (name.startsWith('shell_') || name === 'shell_exec') return 'shell';
  if (name.startsWith('file_')) return 'shell';
  if (name.startsWith('knowledge_')) return 'knowledge';
  if (name.startsWith('mail_') || name.startsWith('email_')) return 'email';
  if (name.startsWith('ha_')) return 'home_assistant';
  if (name.startsWith('sub_agent') || name === 'create_sub_agent') return 'subagent';
  if (name === 'find_tools') return 'system';
  if (name === 'mail') return 'email';
  return 'other';
}

export const findToolsDefinition: ToolDefinition = {
  name: 'find_tools',
  description:
    'There are more tools available. Use this tool to search the tool catalog to discover available tools by keyword or category. ' +
    'Use this when you need a capability that your currently loaded tools do not provide. ' +
    'Returns matching tool names and descriptions. After discovering tools, you can call them directly.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search keyword (e.g., "file", "browser", "schedule", "email")',
      },
      category: {
        type: 'string',
        enum: ['scheduler', 'browser', 'search', 'shell', 'email', 'mcp', 'memory', 'settings', 'home_assistant', 'subagent', 'skill', 'other'],
        description: 'Filter by category',
      },
    },
    required: ['query'],
  },
};

export class ToolCatalog {
  private entries: CatalogEntry[] = [];

  register(tools: ToolDefinition[], source: string, category?: string): void {
    for (const tool of tools) {
      const existing = this.entries.findIndex(e => e.name === tool.name);
      const entry: CatalogEntry = {
        name: tool.name,
        description: tool.description,
        category: category ?? categorizeBuiltinTool(tool.name),
        source,
        definition: tool,
      };
      if (existing >= 0) {
        this.entries[existing] = entry;
      } else {
        this.entries.push(entry);
      }
    }
  }

  clear(): void {
    this.entries = [];
  }

  getAll(): CatalogEntry[] {
    return [...this.entries];
  }

  totalCount(): number {
    return this.entries.length;
  }

  isCoreTool(name: string): boolean {
    return CORE_TOOL_NAMES.has(name);
  }

  getCoreDefinitions(): ToolDefinition[] {
    const defs = this.entries
      .filter(e => CORE_TOOL_NAMES.has(e.name))
      .map(e => e.definition);
    if (!defs.some(d => d.name === 'find_tools')) {
      defs.push(findToolsDefinition);
    }
    if (!defs.some(d => d.name === 'notify')) {
      defs.push(notifyToolDefinition);
    }
    if (!defs.some(d => d.name === 'finish')) {
      defs.push(finishToolDefinition);
    }
    return defs;
  }

  getDefinitions(names: string[]): ToolDefinition[] {
    const nameSet = new Set(names);
    return this.entries
      .filter(e => nameSet.has(e.name))
      .map(e => e.definition);
  }

  getDefinition(name: string): ToolDefinition | undefined {
    return this.entries.find(e => e.name === name)?.definition;
  }

  search(query: string, category?: string): Array<{ name: string; description: string; category: string }> {
    const q = query.toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);

    let results = this.entries;

    if (category) {
      results = results.filter(e => e.category === category);
    }

    const scored = results.map(entry => {
      const nameL = entry.name.toLowerCase();
      const descL = entry.description.toLowerCase();
      let score = 0;

      for (const word of words) {
        if (nameL === word) score += 10;
        else if (nameL.includes(word)) score += 5;
        if (descL.includes(word)) score += 2;
      }

      return { entry, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(s => ({
        name: s.entry.name,
        description: s.entry.description.slice(0, 150),
        category: s.entry.category,
      }));
  }

  handleFindTools(args: Record<string, unknown>): string {
    const query = (args.query as string) || '';
    const category = args.category as string | undefined;

    if (!query && !category) {
      const categories = [...new Set(this.entries.map(e => e.category))];
      return JSON.stringify({
        ok: true,
        totalTools: this.entries.length,
        categories,
        hint: 'Provide a query or category to search for specific tools.',
      });
    }

    const results = this.search(query, category);
    logger.debug(SCOPE, `find_tools("${query}", ${category ?? 'all'}) → ${results.length} results`);

    return JSON.stringify({
      ok: true,
      query,
      category: category ?? 'all',
      results,
      count: results.length,
      hint: results.length > 0
        ? 'You can now call any of these tools directly by name.'
        : 'No matching tools found. Try a different query or category.',
    });
  }
}
