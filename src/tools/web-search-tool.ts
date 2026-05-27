import type { ToolDefinition } from '../core/types.js';
import { logger } from '../core/logger.js';

const SCOPE = 'web-search-tool';

export interface WebSearchToolContext {
  apiKey: string;
  engine: 'brave' | 'google';
}

export const webSearchToolDefinitions: ToolDefinition[] = [
  {
    name: 'web_search',
    description: 'Search the web and return a list of results with title, URL, and description.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Number of results to return (default 5, max 20)' },
      },
      required: ['query'],
    },
  },
];

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResult[] };
}

async function searchBrave(
  query: string,
  count: number,
  apiKey: string,
): Promise<BraveSearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(count, 20)),
  });

  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave Search API returned ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as BraveSearchResponse;
  const results = data.web?.results ?? [];

  return results.map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    description: r.description ?? '',
  }));
}

export async function handleWebSearchTool(
  name: string,
  args: Record<string, unknown>,
  context: WebSearchToolContext,
): Promise<string> {
  try {
    switch (name) {
      case 'web_search': {
        const query = args.query as string;
        const count = (args.count as number | undefined) ?? 5;

        if (!context.apiKey) {
          return JSON.stringify({ ok: false, error: 'Web search API key not configured' });
        }

        logger.info(SCOPE, `Searching: "${query}" (count=${count}, engine=${context.engine})`);

        let results: BraveSearchResult[];
        if (context.engine === 'brave') {
          results = await searchBrave(query, count, context.apiKey);
        } else {
          return JSON.stringify({ ok: false, error: `Search engine "${context.engine}" not yet implemented` });
        }

        return JSON.stringify({ ok: true, results });
      }

      default:
        return JSON.stringify({ ok: false, error: `Unknown web search tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(SCOPE, `${name} failed: ${msg}`);
    return JSON.stringify({ ok: false, error: msg });
  }
}
