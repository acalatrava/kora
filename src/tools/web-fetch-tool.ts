import type { ToolDefinition } from '../core/types.js';
import { logger } from '../core/logger.js';

const SCOPE = 'web-fetch-tool';
const MAX_RESPONSE_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export const webFetchToolDefinitions: ToolDefinition[] = [
  {
    name: 'web_fetch',
    description:
      'Make HTTP requests to any URL. Supports all HTTP methods (GET, POST, PUT, DELETE, PATCH, HEAD), ' +
      'custom headers, request body, and query parameters. Use it to call REST APIs, GraphQL endpoints, ' +
      'webhooks, fetch web pages, JSON data, RSS feeds, or any HTTP resource. ' +
      'Returns status code, response headers, and body.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to send the request to (e.g., "https://api.example.com/v1/users")',
        },
        method: {
          type: 'string',
          description: 'HTTP method. Defaults to GET.',
          enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
        },
        headers: {
          type: 'object',
          description: 'HTTP headers as key-value pairs. Example: {"Authorization": "Bearer TOKEN", "Content-Type": "application/json"}',
        },
        body: {
          type: 'string',
          description: 'Request body as a string. For JSON APIs, pass a JSON string and set Content-Type header to application/json.',
        },
        query_params: {
          type: 'object',
          description: 'URL query parameters as key-value pairs. These will be appended to the URL. Example: {"page": "2", "limit": "10"}',
        },
        timeout_ms: {
          type: 'number',
          description: 'Request timeout in milliseconds. Defaults to 30000 (30 seconds).',
        },
      },
      required: ['url'],
    },
  },
];

export async function handleWebFetchTool(
  _name: string,
  args: Record<string, unknown>,
): Promise<string> {
  let url = String(args.url ?? '');
  if (!url) {
    return JSON.stringify({ ok: false, error: 'URL is required' });
  }

  try {
    const parsed = new URL(url);
    if (args.query_params && typeof args.query_params === 'object') {
      for (const [k, v] of Object.entries(args.query_params as Record<string, string>)) {
        parsed.searchParams.set(k, String(v));
      }
    }
    url = parsed.toString();
  } catch {
    return JSON.stringify({ ok: false, error: `Invalid URL: ${url}` });
  }

  const method = String(args.method ?? 'GET').toUpperCase();
  const customHeaders = (args.headers ?? {}) as Record<string, string>;
  const body = args.body != null ? String(args.body) : undefined;
  const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = {
    'User-Agent': 'Kora/1.0',
    ...customHeaders,
  };

  logger.info(SCOPE, `${method} ${url}`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method,
      headers,
      body: ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined,
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeout);

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    const truncated = text.length > MAX_RESPONSE_CHARS;
    const content = truncated ? text.slice(0, MAX_RESPONSE_CHARS) : text;

    logger.info(SCOPE, `${method} ${url} → ${response.status} (${text.length} chars)`);

    return JSON.stringify({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      contentType,
      contentLength: text.length,
      truncated,
      headers: responseHeaders,
      body: content,
    });
  } catch (err) {
    const message = (err as Error).message;
    logger.error(SCOPE, `Fetch failed: ${message}`);
    return JSON.stringify({ ok: false, error: message });
  }
}
