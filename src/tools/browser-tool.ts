import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join, resolve as pathResolve } from 'node:path';
import type { ToolDefinition } from '../core/types.js';
import { logger } from '../core/logger.js';

const SCOPE = 'browser-tool';
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

const BLOCKED_URL_SCHEMES = ['file:', 'javascript:', 'data:', 'vbscript:', 'ftp:'];
const BLOCKED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'metadata.google.internal', '169.254.169.254'];

function validateUrl(url: string): { valid: boolean; reason?: string } {
  try {
    const parsed = new URL(url);

    if (BLOCKED_URL_SCHEMES.includes(parsed.protocol)) {
      return { valid: false, reason: `Blocked URL scheme: ${parsed.protocol}` };
    }

    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.includes(hostname)) {
      return { valid: false, reason: `Blocked host: ${hostname} (SSRF protection)` };
    }

    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(hostname)) {
      return { valid: false, reason: `Blocked private IP range: ${hostname}` };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: `Invalid URL: ${url}` };
  }
}

export interface BrowserToolContext {
  screenshotDir: string;
}

export const browserToolDefinitions: ToolDefinition[] = [
  {
    name: 'browser_navigate',
    description: 'Navigate the headless browser to a URL. Returns page title, URL, and a simplified DOM structure with interactive elements (links, buttons, inputs, etc.) for further interaction.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        wait_for: { type: 'string', description: 'Optional CSS selector to wait for before returning' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_get_dom',
    description: 'Get a simplified DOM snapshot of the current page showing interactive elements (links, buttons, inputs, forms, selects). Each element has a unique [ref=N] attribute you can use with browser_click or browser_fill.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector to scope the DOM extraction' },
      },
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page or a specific element. Optionally navigate to a URL first.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional URL to navigate to before taking the screenshot' },
        selector: { type: 'string', description: 'Optional CSS selector to capture instead of full page' },
      },
    },
  },
  {
    name: 'browser_extract_text',
    description: 'Extract visible text content from the current page or a URL, optionally scoped to a CSS selector.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional URL to navigate to first (if omitted, uses current page)' },
        selector: { type: 'string', description: 'Optional CSS selector to limit text extraction' },
      },
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element on the current page. Use a CSS selector or [ref=N] from browser_get_dom. Returns updated page info after click.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_fill',
    description: 'Type text into an input/textarea on the current page. Clears existing content first.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input element' },
        value: { type: 'string', description: 'Value to type into the field' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'browser_select',
    description: 'Select an option from a <select> dropdown element.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the select element' },
        value: { type: 'string', description: 'Value of the option to select' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'browser_evaluate',
    description: 'Execute JavaScript in the page context and return the result. Use for complex interactions not covered by other tools.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate in the page' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait for a condition: a CSS selector to appear, navigation to complete, or a fixed delay.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for' },
        timeout_ms: { type: 'number', description: 'Max wait time in ms (default: 10000)' },
      },
    },
  },
];

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

function resetInactivityTimer(): void {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(async () => {
    await closeBrowser();
  }, INACTIVITY_TIMEOUT_MS);
}

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    logger.info(SCOPE, 'Launching headless browser (Playwright/Chromium)');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  resetInactivityTimer();
  return browser;
}

async function getPage(): Promise<Page> {
  const b = await getBrowser();
  if (!context) {
    context = await b.newContext({ viewport: { width: 1280, height: 720 } });
  }
  if (!page || page.isClosed()) {
    page = await context.newPage();
  }
  return page;
}

async function closeBrowser(): Promise<void> {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
  if (browser) {
    logger.info(SCOPE, 'Closing browser due to inactivity');
    try { await browser.close(); } catch { /* already closed */ }
    browser = null;
    context = null;
    page = null;
  }
}

async function extractDom(p: Page, scope?: string): Promise<string> {
  const title = await p.title();
  const url = p.url();
  const selector = scope || 'body';

  const elements = await p.$$eval(
    `${selector} a, ${selector} button, ${selector} input, ${selector} textarea, ` +
    `${selector} select, ${selector} details, ${selector} summary, ` +
    `${selector} [role="button"], ${selector} [role="link"], ${selector} [onclick]`,
    (els) => els.map((el: any, i: number) => {
      const tag = el.tagName.toLowerCase();
      const attrs: Record<string, string> = { ref: String(i + 1) };
      if (tag === 'a' && el.href) attrs.href = el.href;
      if (tag === 'input') {
        attrs.type = el.type || 'text';
        if (el.name) attrs.name = el.name;
        if (el.value && el.type !== 'password') attrs.value = el.value.slice(0, 50);
        if (el.placeholder) attrs.placeholder = el.placeholder;
      }
      if (tag === 'textarea' && el.name) attrs.name = el.name;
      if (tag === 'select' && el.name) attrs.name = el.name;
      if (el.id) attrs.id = el.id;
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().slice(0, 60);
        if (cls) attrs.class = cls;
      }
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      return { tag, attrs, text };
    }),
  ).catch(() => [] as Array<{ tag: string; attrs: Record<string, string>; text: string }>);

  const lines = [`Page: ${title}`, `URL: ${url}`, '---'];

  if (elements.length > 0) {
    for (const el of elements) {
      const attrStr = Object.entries(el.attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
      lines.push(`<${el.tag} ${attrStr}>${el.text}</${el.tag}>`);
    }
  } else {
    lines.push('(No interactive elements found)');
    const textPreview = await p.$eval(selector, (el) =>
      (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 2000),
    ).catch(() => '');
    if (textPreview) {
      lines.push('Text preview:');
      lines.push(textPreview);
    }
  }

  return lines.join('\n');
}

export async function handleBrowserTool(
  name: string,
  args: Record<string, unknown>,
  ctx: BrowserToolContext,
): Promise<string> {
  try {
    switch (name) {
      case 'browser_navigate': {
        const url = args.url as string;
        const waitFor = args.wait_for as string | undefined;
        const urlCheck = validateUrl(url);
        if (!urlCheck.valid) return JSON.stringify({ ok: false, error: urlCheck.reason });
        const p = await getPage();
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (waitFor) {
          await p.waitForSelector(waitFor, { timeout: 10_000 }).catch(() => {});
        }
        const title = await p.title();
        const dom = await extractDom(p);
        return JSON.stringify({ ok: true, title, url: p.url(), dom });
      }

      case 'browser_get_dom': {
        const selector = args.selector as string | undefined;
        const p = await getPage();
        const dom = await extractDom(p, selector);
        return JSON.stringify({ ok: true, dom, currentUrl: p.url() });
      }

      case 'browser_screenshot': {
        const url = args.url as string | undefined;
        const selector = args.selector as string | undefined;
        const p = await getPage();

        if (url) {
          const urlCheck = validateUrl(url);
          if (!urlCheck.valid) return JSON.stringify({ ok: false, error: urlCheck.reason });
          await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        }

        await mkdir(ctx.screenshotDir, { recursive: true });
        const filename = `screenshot-${Date.now()}.png`;
        const filepath = join(ctx.screenshotDir, filename);
        if (!pathResolve(filepath).startsWith(pathResolve(ctx.screenshotDir))) {
          return JSON.stringify({ ok: false, error: 'Invalid screenshot path' });
        }

        if (selector) {
          const el = await p.$(selector);
          if (!el) return JSON.stringify({ ok: false, error: `Selector "${selector}" not found` });
          await el.screenshot({ path: filepath });
        } else {
          await p.screenshot({ path: filepath, fullPage: true });
        }

        logger.info(SCOPE, `Screenshot saved: ${filepath}`);
        return JSON.stringify({ ok: true, filepath, filename });
      }

      case 'browser_extract_text': {
        const url = args.url as string | undefined;
        const selector = args.selector as string | undefined;
        const p = await getPage();

        if (url) {
          const urlCheck = validateUrl(url);
          if (!urlCheck.valid) return JSON.stringify({ ok: false, error: urlCheck.reason });
          await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        }

        let text: string;
        if (selector) {
          const extracted = await p.$eval(selector, (node) => (node as unknown as { innerText: string }).innerText).catch(() => null);
          if (extracted === null) return JSON.stringify({ ok: false, error: `Selector "${selector}" not found` });
          text = extracted;
        } else {
          text = await p.evaluate('document.body.innerText') as string;
        }

        const trimmed = text.slice(0, 10_000);
        return JSON.stringify({ ok: true, text: trimmed, truncated: text.length > 10_000 });
      }

      case 'browser_click': {
        const selector = args.selector as string;
        const p = await getPage();
        await p.click(selector);
        await p.waitForLoadState('networkidle').catch(() => {});
        const title = await p.title();
        return JSON.stringify({ ok: true, message: `Clicked "${selector}"`, currentUrl: p.url(), title });
      }

      case 'browser_fill': {
        const selector = args.selector as string;
        const value = args.value as string;
        const p = await getPage();
        await p.fill(selector, value);
        return JSON.stringify({ ok: true, message: `Filled "${selector}" with value` });
      }

      case 'browser_select': {
        const selector = args.selector as string;
        const value = args.value as string;
        const p = await getPage();
        await p.selectOption(selector, value);
        return JSON.stringify({ ok: true, message: `Selected "${value}" in "${selector}"` });
      }

      case 'browser_evaluate': {
        const expression = args.expression as string;
        const p = await getPage();
        const result = await p.evaluate(expression);
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        return JSON.stringify({ ok: true, result: resultStr?.slice(0, 10_000) });
      }

      case 'browser_wait': {
        const selector = args.selector as string | undefined;
        const timeout = (args.timeout_ms as number) || 10_000;
        const p = await getPage();
        if (selector) {
          await p.waitForSelector(selector, { timeout });
          return JSON.stringify({ ok: true, message: `Element "${selector}" appeared` });
        }
        await new Promise(r => setTimeout(r, Math.min(timeout, 30_000)));
        return JSON.stringify({ ok: true, message: `Waited ${timeout}ms` });
      }

      default:
        return JSON.stringify({ ok: false, error: `Unknown browser tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(SCOPE, `${name} failed: ${msg}`);
    return JSON.stringify({ ok: false, error: msg });
  }
}

export { closeBrowser };
