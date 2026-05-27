import { Telegraf, Markup } from 'telegraf';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../../core/logger.js';
import { cronToHuman } from '../../core/helpers.js';
import type { IncomingEvent, InlineButton, EventAttachment } from '../../core/types.js';

const SCOPE = 'TelegramChannel';
const MAX_MSG = 4096;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function markdownTableToText(table: string): string {
  const rows = table.trim().split('\n').filter(r => r.trim());
  if (rows.length < 2) return table;

  const parseRow = (row: string) =>
    row.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length);

  const isSeparator = (row: string) => /^\|?\s*[-:]+[-| :]*$/.test(row);

  const dataRows = rows.filter(r => !isSeparator(r));
  if (dataRows.length === 0) return table;

  const parsed = dataRows.map(parseRow);
  const colWidths = parsed[0].map((_, ci) =>
    Math.max(...parsed.map(r => (r[ci] ?? '').length))
  );

  const lines: string[] = [];
  for (let ri = 0; ri < parsed.length; ri++) {
    const cells = parsed[ri].map((c, ci) => c.padEnd(colWidths[ci]));
    lines.push(cells.join(' │ '));
    if (ri === 0) {
      lines.push(colWidths.map(w => '─'.repeat(w)).join('─┼─'));
    }
  }
  return lines.join('\n');
}

function markdownToTelegramHtml(md: string): string {
  let text = md;

  // Markdown tables → preformatted text (before code block processing)
  text = text.replace(/((?:^\|.+\|$\n?){2,})/gm, (_match, tableBlock: string) => {
    const converted = markdownTableToText(tableBlock);
    return `<pre>${escapeHtml(converted)}</pre>`;
  });

  // Fenced code blocks: ```lang\n...\n``` → <pre><code class="language-lang">...</code></pre>
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = escapeHtml(code.trimEnd());
    return lang
      ? `<pre><code class="language-${lang}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`;
  });

  // Inline code: `...` → <code>...</code> (but not inside <pre>)
  const parts: string[] = [];
  const preBlocks = text.split(/(<pre[\s\S]*?<\/pre>)/);
  for (const part of preBlocks) {
    if (part.startsWith('<pre')) {
      parts.push(part);
    } else {
      let processed = part;
      processed = processed.replace(/`([^`\n]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`);

      // Bold: **text** or __text__
      processed = processed.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      processed = processed.replace(/__(.+?)__/g, '<b>$1</b>');

      // Italic: *text* or _text_ (not inside words with underscores)
      processed = processed.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<i>$1</i>');
      processed = processed.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<i>$1</i>');

      // Strikethrough: ~~text~~
      processed = processed.replace(/~~(.+?)~~/g, '<s>$1</s>');

      // Links: [text](url)
      processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

      // Headings: # text → bold (Telegram has no heading tag)
      processed = processed.replace(/^#{1,6}\s+(.+)$/gm, '\n<b>$1</b>');

      // Blockquotes: > text → Telegram blockquote (not supported in all clients, use italic prefix)
      processed = processed.replace(/^>\s+(.+)$/gm, '▎ <i>$1</i>');

      // Horizontal rules
      processed = processed.replace(/^[-*_]{3,}$/gm, '———');

      // Unordered list items: - or * at start of line → bullet
      processed = processed.replace(/^[\s]*[-*]\s+/gm, '• ');

      // Ordered list items: 1. text (keep as-is but ensure consistent formatting)
      processed = processed.replace(/^(\s*)(\d+)\.\s+/gm, '$1$2. ');

      parts.push(processed);
    }
  }

  return parts.join('').trim();
}

export function buildIdentityId(chatId: number, threadId?: number): string {
  if (threadId) return `telegram:${chatId}:${threadId}`;
  return `telegram:${chatId}`;
}

interface TelegramChannelOptions {
  allowedChatIds?: number[];
  onMessage: (event: IncomingEvent) => Promise<void>;
  getStatus?: () => Record<string, unknown>;
  getTaskList?: (workspaceId?: string) => Array<Record<string, unknown>>;
  getEnabledTools?: () => string[];
  getMcpServers?: () => Array<Record<string, unknown>>;
  getHeartbeatStatus?: () => Record<string, unknown>;
  getSettings?: () => Record<string, unknown>;
  clearHistory?: (identityId: string) => void;
  resetSession?: (identityId: string) => void;
  updateSetting?: (key: string, value: string) => void;
  onApproval?: (approvalId: string, decision: string) => boolean;
  getPermissions?: (chatId?: number) => Array<{ toolName: string; decision: string; createdAt: string }>;
  revokePermission?: (toolName: string, chatId?: number) => void;
  isUnlimitedMode?: () => boolean;
  setUnlimitedMode?: (enabled: boolean) => void;
  getWebAdminUrl?: () => string | null;
  setWebAdminCredentials?: (username: string, password: string) => void | Promise<void>;
  clearAdmin2FA?: () => void;
  onCallback?: (action: string, entity: string, param: string, chatId: number) => Promise<string | null>;
  resolveWorkspaceForChat?: (chatId: number) => string | undefined;
  getSubAgents?: (workspaceId?: string) => Array<Record<string, unknown>>;
  getSkills?: (workspaceId?: string) => Array<{ name: string; description?: string; version?: string }>;
  onLinkRequest?: (chatId: number, email: string) => Promise<string>;
  onLinkVerify?: (chatId: number, email: string, code: string) => Promise<string>;
  onLinkGenerate?: (chatId: number, email: string) => Promise<string>;
  onRegistration?: (chatId: number, username?: string) => Promise<string>;
  onPasswordReset?: (chatId: number) => Promise<string>;
  isRegisteredUser?: (chatId: number) => boolean;
  isAdmin?: (chatId: number) => boolean;
  multiUserEnabled?: boolean;
}

export class TelegramChannel {
  private bot: Telegraf;
  private allowedChatIds: Set<number> | null;
  private onMessage: (event: IncomingEvent) => Promise<void>;
  private opts: TelegramChannelOptions;
  private botUsername: string | null = null;
  private replyContextMap = new Map<string, { chatId: number; threadId?: number }>();

  constructor(token: string, options: TelegramChannelOptions) {
    this.bot = new Telegraf(token, { handlerTimeout: 300_000 });
    this.allowedChatIds = options.allowedChatIds
      ? new Set(options.allowedChatIds)
      : null;
    this.onMessage = options.onMessage;
    this.opts = options;
  }

  getReplyContext(identityId: string): { chatId: number; threadId?: number } | undefined {
    return this.replyContextMap.get(identityId);
  }

  private isGroupChat(chatType: string): boolean {
    return chatType === 'group' || chatType === 'supergroup';
  }

  private isBotMentioned(text: string, entities?: Array<{ type: string; offset: number; length: number; user?: { username?: string } }>): boolean {
    if (!this.botUsername || !text) return false;
    if (text.toLowerCase().includes(`@${this.botUsername.toLowerCase()}`)) return true;
    if (entities) {
      for (const entity of entities) {
        if (entity.type === 'mention') {
          const mention = text.substring(entity.offset, entity.offset + entity.length);
          if (mention.toLowerCase() === `@${this.botUsername.toLowerCase()}`) return true;
        }
      }
    }
    return false;
  }

  private isReplyToBot(message: { reply_to_message?: { from?: { is_bot?: boolean; username?: string } } }): boolean {
    if (!message.reply_to_message?.from) return false;
    if (message.reply_to_message.from.is_bot && this.botUsername) {
      return message.reply_to_message.from.username?.toLowerCase() === this.botUsername.toLowerCase();
    }
    return false;
  }

  private extractReplyContext(message: { reply_to_message?: { text?: string; caption?: string; from?: { first_name?: string; username?: string; is_bot?: boolean } } }): string {
    const reply = message.reply_to_message;
    if (!reply) return '';
    const quotedText = reply.text || reply.caption || '';
    if (!quotedText) return '';
    const author = reply.from?.is_bot
      ? 'Assistant'
      : (reply.from?.first_name || reply.from?.username || 'User');
    return `[Replying to ${author}: "${quotedText.length > 500 ? quotedText.slice(0, 500) + '…' : quotedText}"]\n\n`;
  }

  private shouldRespondInGroup(chatType: string, message: { text?: string; caption?: string; entities?: any[]; reply_to_message?: any }): boolean {
    if (!this.isGroupChat(chatType)) return true;
    if (this.isReplyToBot(message)) return true;
    const text = message.text || message.caption || '';
    return this.isBotMentioned(text, message.entities);
  }

  private stripBotMention(text: string): string {
    if (!this.botUsername) return text;
    return text.replace(new RegExp(`@${this.botUsername}`, 'gi'), '').trim();
  }

  isAllowed(chatId: number): boolean {
    if (!this.allowedChatIds) return true;
    return this.allowedChatIds.has(chatId);
  }

  addAllowedChatId(chatId: number): void {
    if (!this.allowedChatIds) this.allowedChatIds = new Set();
    this.allowedChatIds.add(chatId);
    logger.info(SCOPE, `Added allowed chat ID: ${chatId}`);
  }

  async start(): Promise<void> {
    try {
      const botInfo = await this.bot.telegram.getMe();
      this.botUsername = botInfo.username || null;
      logger.info(SCOPE, `Bot username: @${this.botUsername}`);
    } catch (err) {
      logger.warn(SCOPE, `Could not fetch bot username: ${(err as Error).message}`);
    }

    await this.registerCommands();
    this.setupHandlers();

    logger.info(SCOPE, 'Starting Telegram bot...');
    this.bot.launch().catch(err => {
      logger.error(SCOPE, `Bot polling error: ${(err as Error).message}`);
    });
    logger.info(SCOPE, 'Telegram bot is running');
  }

  private async registerCommands(): Promise<void> {
    try {
      await this.bot.telegram.setMyCommands([
        { command: 'start', description: 'Start the bot' },
        { command: 'status', description: 'Show system status' },
        { command: 'tasks', description: 'List scheduled tasks' },
        { command: 'tools', description: 'List available tools' },
        { command: 'mcp', description: 'Manage MCP servers' },
        { command: 'settings', description: 'Show settings' },
        { command: 'heartbeat', description: 'Heartbeat status' },
        { command: 'agents', description: 'List sub-agents' },
        { command: 'skills', description: 'List loaded skills' },
        { command: 'permissions', description: 'Manage tool permissions' },
        { command: 'unlimited', description: 'Toggle unlimited mode (danger)' },
        { command: 'webadmin', description: 'Web admin access & credentials' },
        { command: 'link', description: 'Link email identity: /link email [code]' },
        { command: 'resetpassword', description: 'Get a password reset code for the portal' },
        { command: 'newsession', description: 'Start a new conversation session' },
        { command: 'clear', description: 'Clear conversation history' },
        { command: 'help', description: 'Show available commands' },
      ]);
    } catch (err) {
      logger.warn(SCOPE, `Failed to set commands: ${(err as Error).message}`);
    }
  }

  private setupHandlers(): void {
    this.bot.command('start', async (ctx) => {
      try {
        if (this.isGroupChat(ctx.chat.type)) return;
        const userId = ctx.message.from?.id ?? ctx.chat.id;
        const threadId = (ctx.message as any).message_thread_id as number | undefined;
        if (this.opts.multiUserEnabled && this.opts.onRegistration) {
          const username = ctx.message.from?.username;
          const result = await this.opts.onRegistration(userId, username);
          await this.safeSend(ctx.chat.id, result, { threadId });
          return;
        }
        if (!this.isAllowed(userId)) return;
        await ctx.replyWithHTML(
          '<b>Kora</b>\n\n' +
          'I\'m your local AI agent. I can browse the web, run commands, manage tasks, and more.\n\n' +
          'Just send me a message or use the <b>/</b> menu for commands.',
          {
            ...(threadId ? { message_thread_id: threadId } : {}),
            ...Markup.inlineKeyboard([
              [Markup.button.callback('Status', 'cmd:status:_'), Markup.button.callback('Help', 'cmd:help:_')],
              [Markup.button.callback('Tools', 'cmd:tools:_'), Markup.button.callback('Tasks', 'cmd:tasks:_')],
            ]),
          },
        );
      } catch (err) { this.logErr('start', err); }
    });

    this.bot.command('status', async (ctx) => {
      try {
        const userId = ctx.message.from?.id ?? ctx.chat.id;
        const effectiveId = this.isGroupChat(ctx.chat.type) ? userId : ctx.chat.id;
        const threadId = (ctx.message as any).message_thread_id as number | undefined;
        if (!this.isAllowed(effectiveId)) return;
        if (this.opts.multiUserEnabled && !(this.opts.isAdmin?.(effectiveId))) {
          await this.sendLimitedStatus(ctx.chat.id, threadId);
        } else {
          await this.sendStatus(ctx.chat.id, threadId);
        }
      } catch (err) { this.logErr('status', err); }
    });

    this.bot.command('tasks', async (ctx) => {
      try {
        const userId = ctx.message.from?.id ?? ctx.chat.id;
        const effectiveId = this.isGroupChat(ctx.chat.type) ? userId : ctx.chat.id;
        const threadId = (ctx.message as any).message_thread_id as number | undefined;
        if (!this.isAllowed(effectiveId)) return;
        await this.sendTasks(ctx.chat.id, threadId);
      } catch (err) { this.logErr('tasks', err); }
    });

    this.bot.command('tools', async (ctx) => {
      try {
        const userId = ctx.message.from?.id ?? ctx.chat.id;
        const effectiveId = this.isGroupChat(ctx.chat.type) ? userId : ctx.chat.id;
        const threadId = (ctx.message as any).message_thread_id as number | undefined;
        if (!this.isAllowed(effectiveId)) return;
        await this.sendTools(ctx.chat.id, threadId);
      } catch (err) { this.logErr('tools', err); }
    });

    this.bot.command('mcp', async (ctx) => {
      try {
        const userId = ctx.message.from?.id ?? ctx.chat.id;
        const effectiveId = this.isGroupChat(ctx.chat.type) ? userId : ctx.chat.id;
        const threadId = (ctx.message as any).message_thread_id as number | undefined;
        if (!this.isAllowed(effectiveId)) return;
        await this.sendMcp(ctx.chat.id, threadId);
      } catch (err) { this.logErr('mcp', err); }
    });

    this.bot.command('settings', async (ctx) => {
      try {
        const userId = ctx.message.from?.id ?? ctx.chat.id;
        const effectiveId = this.isGroupChat(ctx.chat.type) ? userId : ctx.chat.id;
        const threadId = (ctx.message as any).message_thread_id as number | undefined;
        if (!this.isAllowed(effectiveId)) return;
        if (this.opts.multiUserEnabled && !(this.opts.isAdmin?.(effectiveId))) {
          await this.safeSend(ctx.chat.id, '🔒 This command is only available to administrators.', { threadId });
          return;
        }
        await this.sendSettings(ctx.chat.id, threadId);
      } catch (err) { this.logErr('settings', err); }
    });

    this.bot.command('heartbeat', async (ctx) => {
      try {
        const userId = ctx.message.from?.id ?? ctx.chat.id;
        const effectiveId = this.isGroupChat(ctx.chat.type) ? userId : ctx.chat.id;
        const threadId = (ctx.message as any).message_thread_id as number | undefined;
        if (!this.isAllowed(effectiveId)) return;
        if (this.opts.multiUserEnabled && !(this.opts.isAdmin?.(effectiveId))) {
          await this.safeSend(ctx.chat.id, '🔒 This command is only available to administrators.', { threadId });
          return;
        }
        await this.sendHeartbeat(ctx.chat.id, threadId);
      } catch (err) { this.logErr('heartbeat', err); }
    });

    this.bot.command('permissions', async (ctx) => {
      try {
        const userId = ctx.message.from?.id ?? ctx.chat.id;
        const effectiveId = this.isGroupChat(ctx.chat.type) ? userId : ctx.chat.id;
        const threadId = (ctx.message as any).message_thread_id as number | undefined;
        if (!this.isAllowed(effectiveId)) return;
        if (this.opts.multiUserEnabled && !(this.opts.isAdmin?.(effectiveId))) {
          await this.safeSend(ctx.chat.id, '🔒 This command is only available to administrators.', { threadId });
          return;
        }
        await this.sendPermissions(ctx.chat.id, threadId);
      } catch (err) { this.logErr('permissions', err); }
    });

    this.bot.command('agents', async (ctx) => {
      try {
        const userId = ctx.message.from?.id ?? ctx.chat.id;
        const effectiveId = this.isGroupChat(ctx.chat.type) ? userId : ctx.chat.id;
        const threadId = (ctx.message as any).message_thread_id as number | undefined;
        if (!this.isAllowed(effectiveId)) return;
        await this.sendSubAgents(ctx.chat.id, threadId);
      } catch (err) { this.logErr('agents', err); }
    });

    this.bot.command('skills', async (ctx) => {
      const chatId = ctx.chat.id;
      const threadId = (ctx.message as any).message_thread_id as number | undefined;
      try {
        const userId = ctx.message.from?.id ?? chatId;
        const effectiveId = this.isGroupChat(ctx.chat.type) ? userId : chatId;
        if (!this.isAllowed(effectiveId)) return;
        const wsId = this.opts.resolveWorkspaceForChat?.(effectiveId);
        logger.debug(SCOPE, `/skills command from ${effectiveId}, wsId=${wsId}`);
        const skills = this.opts.getSkills?.(wsId) ?? [];
        logger.debug(SCOPE, `/skills found ${skills.length} skill(s)`);
        if (skills.length === 0) {
          await this.safeSend(chatId, '📦 No skills loaded.', { threadId });
          return;
        }
        const lines = skills.map(s => {
          const name = String(s.name || 'unnamed');
          let line = `• <b>${escapeHtml(name)}</b>`;
          if (s.version) line += ` <i>v${escapeHtml(String(s.version))}</i>`;
          if (s.description) line += `\n  ${escapeHtml(String(s.description))}`;
          return line;
        });
        await this.safeSend(chatId, `<b>📦 Skills (${skills.length})</b>\n\n${lines.join('\n\n')}`, { threadId });
      } catch (err) {
        this.logErr('skills', err);
        await this.safeSend(chatId, `❌ Error listing skills: ${(err as Error).message}`, { threadId }).catch(() => { });
      }
    });

    this.bot.command('unlimited', async (ctx) => {
      try {
        const userId = ctx.message.from?.id ?? ctx.chat.id;
        const effectiveId = this.isGroupChat(ctx.chat.type) ? userId : ctx.chat.id;
        const threadId = (ctx.message as any).message_thread_id as number | undefined;
        if (!this.isAllowed(effectiveId)) return;
        if (this.opts.multiUserEnabled && !(this.opts.isAdmin?.(effectiveId))) {
          await this.safeSend(ctx.chat.id, '🔒 This command is only available to administrators.', { threadId });
          return;
        }
        const isOn = this.opts.isUnlimitedMode?.() ?? false;
        if (isOn) {
          await this.safeSend(ctx.chat.id,
            '<b>Unlimited Mode is ON</b>\n\n' +
            'All tool approvals are currently bypassed. The agent can execute any tool without asking.',
            {
              threadId, buttons: [[
                { text: 'Disable Unlimited Mode', callbackData: 'unlimited:off:_' },
              ]]
            },
          );
        } else {
          await this.safeSend(ctx.chat.id,
            '<b>⚠️ UNLIMITED MODE ⚠️</b>\n\n' +
            '<b>WARNING:</b> Enabling unlimited mode will allow the agent to execute <b>ALL tools</b> ' +
            '(shell commands, MCP installs, settings changes, etc.) <b>without asking for permission</b>.\n\n' +
            'This is a <b>serious security risk</b>. Only enable this if:\n' +
            '• You fully trust the LLM provider\n' +
            '• You are on a sandboxed/disposable machine\n' +
            '• You understand the agent could run arbitrary commands\n\n' +
            'The agent <b>cannot</b> enable this mode itself.',
            {
              threadId, buttons: [[
                { text: '⚠️ I understand, enable it', callbackData: 'unlimited:confirm:_' },
                { text: 'Cancel', callbackData: 'unlimited:cancel:_' },
              ]]
            },
          );
        }
      } catch (err) { this.logErr('unlimited', err); }
    });

    this.bot.command('webadmin', async (ctx) => {
      try {
        const userId = ctx.message.from?.id ?? ctx.chat.id;
        const effectiveId = this.isGroupChat(ctx.chat.type) ? userId : ctx.chat.id;
        const threadId = (ctx.message as any).message_thread_id as number | undefined;
        if (!this.isAllowed(effectiveId)) return;
        if (this.opts.multiUserEnabled && !(this.opts.isAdmin?.(effectiveId))) {
          await this.safeSend(ctx.chat.id, '🔒 This command is only available to administrators.', { threadId });
          return;
        }
        const url = this.opts.getWebAdminUrl?.();
        if (!url) {
          await this.safeSend(ctx.chat.id, 'Web admin is not enabled.', { threadId });
          return;
        }
        const text = ctx.message.text.trim();
        const parts = text.replace('/webadmin', '').trim().split(/\s+/);
        if (parts.length === 2 && parts[0] && parts[1]) {
          await this.opts.setWebAdminCredentials?.(parts[0], parts[1]);
          this.opts.clearAdmin2FA?.();
          await this.safeSend(ctx.chat.id,
            `✅ Web admin credentials set. 2FA has been reset.\n\n` +
            `Username: <code>${parts[0]}</code>\n` +
            `URL: <code>${url}</code>\n\n` +
            'You can now log in with these credentials.',
            { threadId },
          );
          try {
            await ctx.deleteMessage();
          } catch { /* may not have delete permission */ }
        } else {
          await this.safeSend(ctx.chat.id,
            '<b>Web Admin</b>\n\n' +
            `URL: <code>${url}</code>\n\n` +
            'To set login credentials:\n' +
            '<code>/webadmin username password</code>\n\n' +
            '(the message will be auto-deleted for security)',
            {
              threadId, buttons: [[
                { text: 'Open Web Admin', callbackData: 'cmd:status:_' },
              ]]
            },
          );
        }
      } catch (err) { this.logErr('webadmin', err); }
    });

    this.bot.command('newsession', async (ctx) => {
      try {
        const userId = ctx.message.from?.id ?? ctx.chat.id;
        const effectiveId = this.isGroupChat(ctx.chat.type) ? userId : ctx.chat.id;
        const threadId = (ctx.message as any).message_thread_id as number | undefined;
        if (!this.isAllowed(effectiveId)) return;
        const chatContextKey = threadId
          ? `tg-chat:${ctx.chat.id}:thread:${threadId}`
          : `tg-chat:${ctx.chat.id}`;
        this.opts.resetSession?.(chatContextKey);
        await this.safeSend(ctx.chat.id, 'New session started. Conversation history cleared.', { threadId });
      } catch (err) { this.logErr('newsession', err); }
    });

    this.bot.command('clear', async (ctx) => {
      try {
        const userId = ctx.message.from?.id ?? ctx.chat.id;
        const effectiveId = this.isGroupChat(ctx.chat.type) ? userId : ctx.chat.id;
        const threadId = (ctx.message as any).message_thread_id as number | undefined;
        if (!this.isAllowed(effectiveId)) return;
        await this.bot.telegram.sendMessage(ctx.chat.id,
          '<b>Clear conversation history?</b>\nThis cannot be undone.',
          {
            parse_mode: 'HTML',
            ...(threadId ? { message_thread_id: threadId } : {}),
            ...Markup.inlineKeyboard([
              [Markup.button.callback('Yes, clear it', 'clear:confirm:_'),
              Markup.button.callback('Cancel', 'clear:cancel:_')],
            ])
          },
        );
      } catch (err) { this.logErr('clear', err); }
    });

    this.bot.command('link', async (ctx) => {
      try {
        const userId = ctx.message.from?.id ?? ctx.chat.id;
        const effectiveId = this.isGroupChat(ctx.chat.type) ? userId : ctx.chat.id;
        const threadId = (ctx.message as any).message_thread_id as number | undefined;

        const text = ctx.message.text.trim();
        const email = text.replace('/link', '').trim().split(/\s+/)[0]?.toLowerCase();

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          await this.safeSend(ctx.chat.id,
            '<b>🔗 Link Web Portal Account</b>\n\n' +
            'Link your email to create a web portal account.\n\n' +
            '<b>Usage:</b> <code>/link your@email.com</code>\n\n' +
            'A registration code will be sent to your email. ' +
            'Use it on the web portal to complete your account setup.',
            { threadId },
          );
          return;
        }

        if (!this.opts.onLinkGenerate) {
          await this.safeSend(ctx.chat.id, '❌ Portal linking is not available.', { threadId });
          return;
        }

        const result = await this.opts.onLinkGenerate(effectiveId, email);
        await this.safeSend(ctx.chat.id, result, { threadId });
      } catch (err) { this.logErr('link', err); }
    });

    this.bot.command('resetpassword', async (ctx) => {
      try {
        const userId = ctx.message.from?.id ?? ctx.chat.id;
        const effectiveId = this.isGroupChat(ctx.chat.type) ? userId : ctx.chat.id;
        const threadId = (ctx.message as any).message_thread_id as number | undefined;
        if (!this.isAllowed(effectiveId)) {
          if (this.opts.onPasswordReset) {
            const result = await this.opts.onPasswordReset(effectiveId);
            await this.safeSend(ctx.chat.id, result, { threadId });
          }
          return;
        }
        if (this.opts.onPasswordReset) {
          const result = await this.opts.onPasswordReset(effectiveId);
          await this.safeSend(ctx.chat.id, result, { threadId });
        } else {
          await this.safeSend(ctx.chat.id, '❌ Password reset is not available.', { threadId });
        }
      } catch (err) { this.logErr('resetpassword', err); }
    });

    this.bot.command('help', async (ctx) => {
      try {
        const userId = ctx.message.from?.id ?? ctx.chat.id;
        const effectiveId = this.isGroupChat(ctx.chat.type) ? userId : ctx.chat.id;
        const threadId = (ctx.message as any).message_thread_id as number | undefined;
        if (!this.isAllowed(effectiveId)) return;
        await this.sendHelp(ctx.chat.id, threadId);
      } catch (err) { this.logErr('help', err); }
    });

    this.bot.on('callback_query', async (ctx) => {
      try {
        const chatId = ctx.chat?.id;
        const fromId = ctx.callbackQuery.from?.id;
        const chatType = ctx.chat?.type;
        const effectiveId = (chatType && this.isGroupChat(chatType) && fromId) ? fromId : chatId;
        if (!chatId || !effectiveId || !this.isAllowed(effectiveId)) return;

        const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
        if (!data) return;

        const cbMsg = ctx.callbackQuery.message;
        const threadId = (cbMsg as any)?.message_thread_id as number | undefined;

        await ctx.answerCbQuery();

        const parts = data.split(':');
        const action = parts[0] ?? '';
        const entity = parts[1] ?? '';
        const param = parts.slice(2).join(':');

        if (action === 'cmd') {
          switch (entity) {
            case 'status': await this.sendStatus(chatId, threadId); return;
            case 'help': await this.sendHelp(chatId, threadId); return;
            case 'tools': await this.sendTools(chatId, threadId); return;
            case 'tasks': await this.sendTasks(chatId, threadId); return;
            case 'agents': await this.sendSubAgents(chatId, threadId); return;
            case 'mcp': await this.sendMcp(chatId, threadId); return;
            case 'settings': await this.sendSettings(chatId, threadId); return;
            case 'heartbeat': await this.sendHeartbeat(chatId, threadId); return;
            case 'permissions': await this.sendPermissions(chatId, threadId); return;
          }
        }

        if (action === 'clear' && entity === 'confirm') {
          const clearKey = threadId
            ? `tg-chat:${chatId}:thread:${threadId}`
            : `tg-chat:${chatId}`;
          this.opts.clearHistory?.(clearKey);
          await this.safeSend(chatId, 'History cleared.', { threadId });
          return;
        }
        if (action === 'clear' && entity === 'cancel') {
          await this.safeSend(chatId, 'Cancelled.', { threadId });
          return;
        }

        if (action === 'unlimited') {
          if (entity === 'confirm') {
            this.opts.setUnlimitedMode?.(true);
            await this.safeSend(chatId,
              '⚠️ <b>Unlimited mode ENABLED</b>\n\n' +
              'All tool approvals are now bypassed. The agent can execute any tool without asking.\n' +
              'Use /unlimited to disable.',
              { threadId },
            );
          } else if (entity === 'off') {
            this.opts.setUnlimitedMode?.(false);
            await this.safeSend(chatId, '✅ <b>Unlimited mode DISABLED</b>\n\nTool approvals are active again.', { threadId });
          } else if (entity === 'cancel') {
            await this.safeSend(chatId, 'Cancelled. Unlimited mode stays off.', { threadId });
          }
          return;
        }

        if (action === 'perm' && entity === 'revoke') {
          this.opts.revokePermission?.(param, chatId);
          await this.safeSend(chatId, `Permission revoked for <code>${param}</code>. It will ask again next time.`, { threadId });
          await this.sendPermissions(chatId, threadId);
          return;
        }

        if (action === 'approve') {
          const approvalId = param;
          const decisionMap: Record<string, string> = {
            once: 'allow_once',
            always: 'allow_always',
            deny: 'deny_once',
            deny_always: 'deny_always',
          };
          const decision = decisionMap[entity];
          if (decision && this.opts.onApproval) {
            const resolved = this.opts.onApproval(approvalId, decision);
            if (resolved) {
              const emoji = decision.startsWith('allow') ? '✅' : '🚫';
              await this.safeSend(chatId, `${emoji} ${decision.replace('_', ' ')}`, { threadId });
            } else {
              await this.safeSend(chatId, 'Approval request expired or already resolved.', { threadId });
            }
          }
          return;
        }

        if (action === 'set') {
          try {
            this.opts.updateSetting?.(entity, param);
            await this.safeSend(chatId, `Setting <code>${entity}</code> updated to <code>${param}</code>.`, { threadId });
            await this.sendSettings(chatId, threadId);
          } catch (err) {
            await this.safeSend(chatId, `Failed to update setting: ${(err as Error).message}`, { threadId });
          }
          return;
        }

        if (this.opts.onCallback) {
          const result = await this.opts.onCallback(action, entity, param, chatId);
          if (result) await this.safeSend(chatId, result, { threadId });
          return;
        }

        const event: IncomingEvent = {
          channel: 'telegram',
          identityId: buildIdentityId(chatId),
          type: 'callback',
          content: data,
          metadata: { chatId, callbackData: data },
          raw: ctx.callbackQuery,
        };
        this.onMessage(event).catch((e) => this.logErr('callback-msg', e));
      } catch (err) { this.logErr('callback', err); }
    });

    this.bot.on('text', (ctx) => {
      const entities = ctx.message.entities ?? [];
      if (entities.some(e => e.type === 'bot_command' && e.offset === 0)) return;

      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatTitle = (ctx.chat as any).title as string | undefined;
      const threadId = (ctx.message as any).message_thread_id as number | undefined;
      const userId = ctx.message.from?.id ?? chatId;
      const isGroup = this.isGroupChat(chatType);
      const effectiveId = isGroup ? userId : chatId;

      if (!this.isAllowed(effectiveId)) {
        if (this.opts.multiUserEnabled && !isGroup) {
          this.safeSend(chatId, 'You are not registered yet. Send /start to begin registration.').catch(() => { });
        }
        return;
      }

      if (!this.shouldRespondInGroup(chatType, ctx.message as any)) return;

      const rawText = isGroup ? this.stripBotMention(ctx.message.text) : ctx.message.text;
      const replyCtx = this.extractReplyContext(ctx.message as any);
      const text = replyCtx + rawText;
      const identityId = buildIdentityId(effectiveId);

      if (isGroup) {
        this.replyContextMap.set(identityId, { chatId, threadId });
      } else {
        this.replyContextMap.set(identityId, { chatId });
      }

      const event: IncomingEvent = {
        channel: 'telegram',
        identityId,
        type: 'message',
        content: text,
        metadata: {
          chatId, userId, messageId: ctx.message.message_id, from: ctx.message.from,
          chatType, threadId, isGroup, chatTitle,
          replyTo: { chatId, threadId },
        },
        raw: ctx.message,
      };

      this.onMessage(event).catch((err) => {
        logger.error(SCOPE, `Text handler error: ${(err as Error).message}`);
        this.safeSend(chatId, 'Something went wrong. Try again.', threadId).catch(() => { });
      });
    });

    this.bot.on('photo', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatTitle = (ctx.chat as any).title as string | undefined;
      const threadId = (ctx.message as any).message_thread_id as number | undefined;
      const userId = ctx.message.from?.id ?? chatId;
      const isGroup = this.isGroupChat(chatType);
      const effectiveId = isGroup ? userId : chatId;
      if (!this.isAllowed(effectiveId)) return;
      if (!this.shouldRespondInGroup(chatType, ctx.message as any)) return;
      const identityId = buildIdentityId(effectiveId);
      if (isGroup) {
        this.replyContextMap.set(identityId, { chatId, threadId });
      } else {
        this.replyContextMap.set(identityId, { chatId });
      }
      const photos = ctx.message.photo;
      const best = photos[photos.length - 1];
      const photoReplyCtx = this.extractReplyContext(ctx.message as any);
      this.downloadFile(best.file_id, 'photo').then((localPath) => {
        const attachment: EventAttachment = {
          type: 'photo', fileId: best.file_id,
          localPath, mimeType: 'image/jpeg',
          caption: ctx.message.caption,
        };
        const event: IncomingEvent = {
          channel: 'telegram', identityId,
          type: 'message',
          content: photoReplyCtx + (ctx.message.caption || '[Photo received]'),
          attachments: [attachment],
          metadata: { chatId, userId, messageId: ctx.message.message_id, from: ctx.message.from, chatType, threadId, isGroup, chatTitle, replyTo: { chatId, threadId } },
          raw: ctx.message,
        };
        return this.onMessage(event);
      }).catch((err) => this.logErr('photo', err));
    });

    this.bot.on('document', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatTitle = (ctx.chat as any).title as string | undefined;
      const threadId = (ctx.message as any).message_thread_id as number | undefined;
      const userId = ctx.message.from?.id ?? chatId;
      const isGroup = this.isGroupChat(chatType);
      const effectiveId = isGroup ? userId : chatId;
      if (!this.isAllowed(effectiveId)) return;
      if (!this.shouldRespondInGroup(chatType, ctx.message as any)) return;
      const identityId = buildIdentityId(effectiveId);
      if (isGroup) {
        this.replyContextMap.set(identityId, { chatId, threadId });
      } else {
        this.replyContextMap.set(identityId, { chatId });
      }
      const doc = ctx.message.document;
      const docReplyCtx = this.extractReplyContext(ctx.message as any);
      this.downloadFile(doc.file_id, 'document', doc.file_name).then((localPath) => {
        const attachment: EventAttachment = {
          type: 'document', fileId: doc.file_id,
          fileName: doc.file_name, mimeType: doc.mime_type,
          localPath, caption: ctx.message.caption,
        };
        const event: IncomingEvent = {
          channel: 'telegram', identityId,
          type: 'message',
          content: docReplyCtx + (ctx.message.caption || `[Document: ${doc.file_name || 'file'}]`),
          attachments: [attachment],
          metadata: { chatId, userId, messageId: ctx.message.message_id, from: ctx.message.from, chatType, threadId, isGroup, chatTitle, replyTo: { chatId, threadId } },
          raw: ctx.message,
        };
        return this.onMessage(event);
      }).catch((err) => this.logErr('document', err));
    });

    this.bot.on('voice', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatTitle = (ctx.chat as any).title as string | undefined;
      const threadId = (ctx.message as any).message_thread_id as number | undefined;
      const userId = ctx.message.from?.id ?? chatId;
      const isGroup = this.isGroupChat(chatType);
      const effectiveId = isGroup ? userId : chatId;
      if (!this.isAllowed(effectiveId)) return;
      if (!this.shouldRespondInGroup(chatType, ctx.message as any)) return;
      const identityId = buildIdentityId(effectiveId);
      if (isGroup) {
        this.replyContextMap.set(identityId, { chatId, threadId });
      } else {
        this.replyContextMap.set(identityId, { chatId });
      }
      const voice = ctx.message.voice;
      const voiceReplyCtx = this.extractReplyContext(ctx.message as any);
      this.downloadFile(voice.file_id, 'voice').then((localPath) => {
        const attachment: EventAttachment = {
          type: 'voice', fileId: voice.file_id,
          mimeType: voice.mime_type, localPath,
        };
        const event: IncomingEvent = {
          channel: 'telegram', identityId,
          type: 'message', content: voiceReplyCtx + '[Voice message received]',
          attachments: [attachment],
          metadata: { chatId, userId, messageId: ctx.message.message_id, from: ctx.message.from, chatType, threadId, isGroup, chatTitle, replyTo: { chatId, threadId } },
          raw: ctx.message,
        };
        return this.onMessage(event);
      }).catch((err) => this.logErr('voice', err));
    });

    this.bot.on('video', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatTitle = (ctx.chat as any).title as string | undefined;
      const threadId = (ctx.message as any).message_thread_id as number | undefined;
      const userId = ctx.message.from?.id ?? chatId;
      const isGroup = this.isGroupChat(chatType);
      const effectiveId = isGroup ? userId : chatId;
      if (!this.isAllowed(effectiveId)) return;
      if (!this.shouldRespondInGroup(chatType, ctx.message as any)) return;
      const identityId = buildIdentityId(effectiveId);
      if (isGroup) {
        this.replyContextMap.set(identityId, { chatId, threadId });
      } else {
        this.replyContextMap.set(identityId, { chatId });
      }
      const video = ctx.message.video;
      const videoReplyCtx = this.extractReplyContext(ctx.message as any);
      this.downloadFile(video.file_id, 'video', video.file_name).then((localPath) => {
        const attachment: EventAttachment = {
          type: 'video', fileId: video.file_id,
          fileName: video.file_name, mimeType: video.mime_type, localPath,
          caption: ctx.message.caption,
        };
        const event: IncomingEvent = {
          channel: 'telegram', identityId,
          type: 'message',
          content: videoReplyCtx + (ctx.message.caption || '[Video received]'),
          attachments: [attachment],
          metadata: { chatId, userId, messageId: ctx.message.message_id, from: ctx.message.from, chatType, threadId, isGroup, chatTitle, replyTo: { chatId, threadId } },
          raw: ctx.message,
        };
        return this.onMessage(event);
      }).catch((err) => this.logErr('video', err));
    });
  }

  async stop(): Promise<void> {
    logger.info(SCOPE, 'Stopping Telegram bot...');
    this.bot.stop('stop');
  }

  private downloadsDir = '';

  setDownloadsDir(dir: string): void {
    this.downloadsDir = dir;
  }

  private async downloadFile(fileId: string, subDir: string, originalName?: string): Promise<string> {
    const baseDir = this.downloadsDir || '/tmp/korabot-downloads';
    const dir = join(baseDir, subDir);
    await mkdir(dir, { recursive: true });

    const fileLink = await this.bot.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.href);
    const buffer = Buffer.from(await response.arrayBuffer());

    const ext = originalName
      ? originalName.split('.').pop() || 'bin'
      : subDir === 'photo' ? 'jpg' : subDir === 'voice' ? 'ogg' : subDir === 'video' ? 'mp4' : 'bin';
    const fileName = originalName || `${Date.now()}.${ext}`;
    const filePath = join(dir, fileName);
    await writeFile(filePath, buffer);

    logger.info(SCOPE, `Downloaded ${subDir}: ${filePath} (${buffer.length} bytes)`);
    return filePath;
  }

  async sendFile(
    chatId: string | number,
    filePath: string,
    options?: { caption?: string; type?: 'document' | 'photo'; threadId?: number },
  ): Promise<void> {
    try {
      const { createReadStream } = await import('node:fs');
      const { basename } = await import('node:path');
      const stream = createReadStream(filePath);
      const filename = basename(filePath);
      const sendType = options?.type || 'document';

      if (sendType === 'photo') {
        await this.bot.telegram.sendPhoto(chatId, { source: stream, filename }, {
          caption: options?.caption,
          ...(options?.threadId ? { message_thread_id: options.threadId } : {}),
        });
      } else {
        await this.bot.telegram.sendDocument(chatId, { source: stream, filename }, {
          caption: options?.caption,
          ...(options?.threadId ? { message_thread_id: options.threadId } : {}),
        });
      }
    } catch (err) {
      logger.error(SCOPE, `Failed to send file to ${chatId}: ${(err as Error).message}`);
    }
  }

  async send(
    chatId: string | number,
    text: string,
    threadIdOrOptions?: number | { buttons?: InlineButton[][]; html?: boolean; threadId?: number },
  ): Promise<void> {
    if (!text || text.trim().length === 0) return;

    let options: { buttons?: InlineButton[][]; html?: boolean; threadId?: number } | undefined;
    let threadId: number | undefined;

    if (typeof threadIdOrOptions === 'number') {
      threadId = threadIdOrOptions;
    } else {
      options = threadIdOrOptions;
      threadId = options?.threadId;
    }

    const alreadyHtml = options?.html === true;
    const htmlText = alreadyHtml ? text : markdownToTelegramHtml(text);
    const chunks = this.chunkMessage(htmlText);
    try {
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const buttons = isLast && options?.buttons?.length
          ? Markup.inlineKeyboard(
            options.buttons.map(row =>
              row.map(btn => Markup.button.callback(btn.text, btn.callbackData)),
            ),
          )
          : {};

        const extra = { ...buttons, ...(threadId ? { message_thread_id: threadId } : {}) };
        const sent = await this.trySend(chatId, chunks[i], extra);
        if (!sent) {
          logger.warn(SCOPE, `Failed to send chunk ${i + 1}/${chunks.length} to ${chatId}`);
        }
      }
    } catch (err) {
      logger.error(SCOPE, `Send failed to ${chatId}: ${(err as Error).message}`);
    }
  }

  private async trySend(
    chatId: string | number,
    text: string,
    extra: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await this.bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });
      return true;
    } catch {
      // HTML parse failed, try plain text
    }

    try {
      const plain = text
        .replace(/<pre[^>]*>[\s\S]*?<\/pre>/g, m => m.replace(/<[^>]+>/g, ''))
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
      await this.bot.telegram.sendMessage(chatId, plain, extra);
      return true;
    } catch (err) {
      logger.error(SCOPE, `All send attempts failed: ${(err as Error).message}`);
      return false;
    }
  }

  async sendVoice(chatId: string | number, oggPath: string, caption?: string): Promise<void> {
    try {
      const { createReadStream } = await import('node:fs');
      await this.bot.telegram.sendVoice(
        chatId,
        { source: createReadStream(oggPath) },
        caption ? { caption } : undefined,
      );
    } catch (err) {
      logger.error(SCOPE, `Failed to send voice to ${chatId}: ${(err as Error).message}`);
    }
  }

  async sendRecordVoiceAction(chatId: string | number): Promise<void> {
    try {
      await this.bot.telegram.sendChatAction(chatId, 'record_voice');
    } catch { /* ignore */ }
  }

  async sendTypingAction(chatId: string | number, threadId?: number): Promise<void> {
    try {
      const extra = threadId ? { message_thread_id: threadId } : undefined;
      await this.bot.telegram.sendChatAction(chatId, 'typing', extra);
    } catch { /* ignore */ }
  }

  private async sendStatus(chatId: number, threadId?: number): Promise<void> {
    const s = this.opts.getStatus?.() ?? {};
    const lines = [
      '⬡ <b>Kora Status</b>',
      '',
      `🧠  Model: <code>${s.provider ?? '?'}/${s.model ?? '?'}</code>`,
      `🔧  Tools: <code>${s.toolCount ?? 0}</code> active`,
      `🔌  MCP: <code>${s.mcpCount ?? 0}</code> server(s)`,
      `📅  Tasks: <code>${s.schedulerJobs ?? 0}</code> scheduled`,
      `💓  Heartbeat: <code>${s.heartbeat ?? 'unknown'}</code>`,
      `🛡  Unlimited: <code>${s.unlimitedMode ? 'ON ⚠️' : 'OFF'}</code>`,
      `⏱  Uptime: <code>${s.uptime ?? 'unknown'}</code>`,
    ];
    await this.safeSend(chatId, lines.join('\n'), {
      threadId,
      buttons: [[{ text: '↻ Refresh', callbackData: 'cmd:status:_' }]],
    });
  }

  private async sendLimitedStatus(chatId: number, threadId?: number): Promise<void> {
    const s = this.opts.getStatus?.() ?? {};
    const lines = [
      '⬡ <b>Kora Status</b>',
      '',
      `🧠  Model: <code>${s.model ?? '?'}</code>`,
      `🔧  Tools: <code>${s.toolCount ?? 0}</code> active`,
      `⏱  Uptime: <code>${s.uptime ?? 'unknown'}</code>`,
    ];
    await this.safeSend(chatId, lines.join('\n'), { threadId });
  }

  private async sendTasks(chatId: number, threadId?: number): Promise<void> {
    const wsId = this.opts.resolveWorkspaceForChat?.(chatId);
    const tasks = this.opts.getTaskList?.(wsId) ?? [];
    if (tasks.length === 0) {
      await this.safeSend(chatId, '<b>Scheduled Tasks</b>\n\nNo tasks configured.\n\nAsk me to create one, e.g.:\n<code>"Schedule a daily report at 9am"</code>', { threadId });
      return;
    }

    await this.safeSend(chatId, `<b>Scheduled Tasks</b> — ${tasks.length} task(s)`, { threadId });

    for (const t of tasks) {
      const status = t.enabled ? '🟢 Active' : '⏸ Paused';
      const cronStr = String(t.cronExpression || '');
      const lines = [
        `<b>${t.name}</b>  ${status}`,
        `⏰ ${cronToHuman(cronStr)} <code>(${cronStr})</code>`,
      ];
      if (t.prompt) lines.push(`Prompt: ${String(t.prompt).slice(0, 100)}${String(t.prompt).length > 100 ? '…' : ''}`);
      if (t.lastRun) {
        const d = t.lastRun instanceof Date ? t.lastRun : new Date(String(t.lastRun));
        lines.push(`Last run: ${isNaN(d.getTime()) ? String(t.lastRun) : d.toLocaleString()}`);
      }

      const buttons: InlineButton[][] = [
        [
          { text: t.enabled ? '⏸ Pause' : '▶ Resume', callbackData: `task:${t.enabled ? 'pause' : 'resume'}:${t.id}` },
          { text: '🚀 Run Now', callbackData: `task:run:${t.id}` },
        ],
        [
          { text: '📋 Detail', callbackData: `task:detail:${t.id}` },
          { text: '🗑 Delete', callbackData: `task:delete:${t.id}` },
        ],
      ];

      await this.safeSend(chatId, lines.join('\n'), { threadId, buttons });
    }

    await this.safeSend(chatId, '—', { threadId, buttons: [[{ text: '↻ Refresh All', callbackData: 'cmd:tasks:_' }]] });
  }

  private async sendSubAgents(chatId: number, threadId?: number): Promise<void> {
    const wsId = this.opts.resolveWorkspaceForChat?.(chatId);
    const agents = this.opts.getSubAgents?.(wsId) ?? [];
    if (agents.length === 0) {
      await this.safeSend(chatId, '<b>🤖 Sub-Agents</b>\n\nNo sub-agents configured.\n\nAsk me to create one, e.g.:\n<code>"Create a sub-agent for code review"</code>', { threadId });
      return;
    }

    const lines = [`<b>🤖 Sub-Agents</b> — ${agents.length} agent(s)`, ''];
    for (const a of agents) {
      const status = a.status === 'running' ? '🟢' : a.status === 'error' ? '🔴' : '⚪';
      lines.push(`${status} <b>${a.name || a.id}</b>`);
      if (a.description) lines.push(`   ${String(a.description).slice(0, 120)}`);
      if (a.model) lines.push(`   Model: <code>${a.model}</code>`);
      if (a.lastRun) {
        const d = a.lastRun instanceof Date ? a.lastRun : new Date(String(a.lastRun));
        lines.push(`   Last run: ${isNaN(d.getTime()) ? String(a.lastRun) : d.toLocaleString()}`);
      }
      lines.push('');
    }
    lines.push('<i>Ask me to create, run, or manage sub-agents.</i>');
    await this.safeSend(chatId, lines.join('\n'), { threadId, buttons: [[{ text: '↻ Refresh', callbackData: 'cmd:agents:_' }]] });
  }

  private async sendTools(chatId: number, threadId?: number): Promise<void> {
    const tools = this.opts.getEnabledTools?.() ?? [];
    const lines = ['🔧 <b>Available Tools</b>', ''];
    if (tools.length === 0) {
      lines.push('No tools enabled.');
      lines.push('');
      lines.push('Ask me to enable tools, e.g.:');
      lines.push('<i>"Enable web search and browser tools"</i>');
    } else {
      const groups: Record<string, string[]> = {};
      for (const t of tools) {
        const prefix = t.includes('_') ? t.split('_')[0] : 'other';
        (groups[prefix] ??= []).push(t);
      }
      for (const [group, items] of Object.entries(groups)) {
        lines.push(`<b>${group}</b>`);
        for (const t of items) lines.push(`  • <code>${t}</code>`);
      }
      lines.push('');
      lines.push(`<i>${tools.length} tools active. Ask me to enable/disable tools.</i>`);
    }
    await this.safeSend(chatId, lines.join('\n'), { threadId });
  }

  private async sendMcp(chatId: number, threadId?: number): Promise<void> {
    const servers = this.opts.getMcpServers?.() ?? [];
    const lines = ['🔌 <b>MCP Servers</b>', ''];
    if (servers.length === 0) {
      lines.push('No MCP servers installed.');
      lines.push('');
      lines.push('Ask me to install one, e.g.:');
      lines.push('<i>"Install the filesystem MCP server"</i>');
      lines.push('<i>"Connect to my Home Assistant MCP"</i>');
    } else {
      for (const s of servers) {
        const icon = s.enabled ? '🟢' : '⚪';
        lines.push(`${icon} <b>${s.name}</b>`);
        if (s.transport) lines.push(`   Transport: <code>${s.transport}</code>`);
        if (s.source) lines.push(`   Source: <code>${String(s.source).slice(0, 60)}</code>`);
      }
      lines.push('');
      lines.push('<i>Ask me to install, remove, or manage MCP servers.</i>');
    }
    await this.safeSend(chatId, lines.join('\n'), { threadId });
  }

  private async sendSettings(chatId: number, threadId?: number): Promise<void> {
    const s = this.opts.getSettings?.() ?? {} as Record<string, unknown>;

    const provider = String(s.defaultProvider ?? 'not set');
    const model = String(s.defaultModel ?? 'not set');
    const maxTokens = String(s.maxTokens ?? '?');
    const logLevel = String(s.logLevel ?? 'info');
    const tools = s.tools as Record<string, unknown> | undefined;
    const hb = s.heartbeat as Record<string, unknown> | undefined;

    const enabledTools: string[] = [];
    const disabledTools: string[] = [];
    if (tools) {
      for (const [k, v] of Object.entries(tools)) {
        if (typeof v === 'boolean') (v ? enabledTools : disabledTools).push(k);
      }
    }

    const lines = [
      '⚙️ <b>Settings</b>',
      '',
      `🧠  Provider: <code>${provider}</code>`,
      `    Model: <code>${model}</code>`,
      `    Max tokens: <code>${maxTokens}</code>`,
      '',
      `🔧  Tools ON: ${enabledTools.length > 0 ? enabledTools.map(t => `<code>${t}</code>`).join(', ') : '<i>none</i>'}`,
      `    Tools OFF: ${disabledTools.length > 0 ? disabledTools.map(t => `<code>${t}</code>`).join(', ') : '<i>none</i>'}`,
      '',
      `💓  Heartbeat: <code>${hb?.enabled ? `every ${hb.intervalMinutes ?? '?'} min` : 'disabled'}</code>`,
      `📊  Log level: <code>${logLevel}</code>`,
      '',
      '━━━━━━━━━━━━━━━━━━━',
      '<i>To change settings, just tell me:</i>',
      '  • <i>"Change model to claude-3.5-sonnet"</i>',
      '  • <i>"Enable web search tool"</i>',
      '  • <i>"Set heartbeat interval to 10 minutes"</i>',
      '  • <i>"Set max tokens to 32768"</i>',
    ];

    await this.safeSend(chatId, lines.join('\n'), {
      threadId,
      buttons: [[{ text: '↻ Refresh', callbackData: 'cmd:settings:_' }]],
    });
  }

  private async sendHeartbeat(chatId: number, threadId?: number): Promise<void> {
    const h = this.opts.getHeartbeatStatus?.() ?? {} as Record<string, unknown>;
    const enabled = h.enabled ?? false;
    const intervalMin = h.intervalMs ? Math.round(Number(h.intervalMs) / 60000) : '?';
    const lines = [
      `💓 <b>Heartbeat</b>  ${enabled ? '🟢 Active' : '⚪ Disabled'}`,
      '',
      `Interval: <code>${intervalMin} min</code>`,
      `Runs: <code>${h.runCount ?? 0}</code>`,
      `Skipped: <code>${h.skippedCount ?? 0}</code> (chat was active)`,
      `Last run: <code>${h.lastRunAt ?? 'never'}</code>`,
      `Running now: <code>${h.running ? 'yes' : 'no'}</code>`,
      '',
      '<i>To change: "Set heartbeat to 15 minutes" or "Disable heartbeat"</i>',
    ];
    await this.safeSend(chatId, lines.join('\n'), { threadId });
  }

  private async sendPermissions(chatId: number, threadId?: number): Promise<void> {
    const perms = this.opts.getPermissions?.(chatId) ?? [];
    const isUnlimited = this.opts.isUnlimitedMode?.() ?? false;
    const lines = ['🛡 <b>Tool Permissions</b>', ''];

    if (isUnlimited) {
      lines.push('⚠️ <b>UNLIMITED MODE ON</b> — all approvals bypassed');
      lines.push('');
    }

    if (perms.length === 0) {
      lines.push('No stored permissions.');
      lines.push('Tools will ask for your approval on first use.');
    } else {
      for (const p of perms) {
        const icon = p.decision.startsWith('allow') ? '✅' : '🚫';
        lines.push(`${icon} <code>${p.toolName}</code>  <i>${p.decision.replace('_', ' ')}</i>`);
      }
    }

    lines.push('');
    lines.push('<i>To revoke: "Revoke permission for shell_exec"</i>');

    if (perms.length > 0) {
      const buttons: InlineButton[][] = perms.map(p => ([{
        text: `❌ Revoke ${p.toolName}`,
        callbackData: `perm:revoke:${p.toolName}`,
      }]));
      buttons.push([{ text: '↻ Refresh', callbackData: 'cmd:permissions:_' }]);
      await this.safeSend(chatId, lines.join('\n'), { threadId, buttons });
      return;
    }

    await this.safeSend(chatId, lines.join('\n'), { threadId });
  }

  private async sendHelp(chatId: number, threadId?: number): Promise<void> {
    const lines = [
      '⬡ <b>Kora</b>',
      '',
      '<b>Quick Commands</b>',
      '/status — System overview',
      '/settings — View configuration',
      '/tasks — Scheduled tasks',
      '/permissions — Tool permissions',
      '/unlimited — Toggle unlimited mode',
      '',
      '<b>Info</b>',
      '/tools — Active tools',
      '/skills — Loaded skills',
      '/mcp — MCP servers',
      '/agents — Sub-agents',
      '/heartbeat — Heartbeat status',
      '/webadmin — Web admin link',
      '',
      '<b>Identity</b>',
      '/link — Link email to this Telegram',
      '',
      '<b>Session</b>',
      '/newsession — Fresh conversation',
      '/clear — Clear history',
      '',
      '━━━━━━━━━━━━━━━━━━━',
      'Just talk to me naturally. I can:',
      '  • Change settings and configuration',
      '  • Create and manage scheduled tasks',
      '  • Install and manage MCP servers',
      '  • Execute commands and browse the web',
      '  • Send emails, manage files, and more',
    ];
    await this.safeSend(chatId, lines.join('\n'), { threadId });
  }

  private async safeSend(
    chatId: number | string,
    text: string,
    threadIdOrButtonsOrOpts?: number | InlineButton[][] | { threadId?: number; buttons?: InlineButton[][] },
  ): Promise<void> {
    let threadId: number | undefined;
    let buttons: InlineButton[][] | undefined;

    if (typeof threadIdOrButtonsOrOpts === 'number') {
      threadId = threadIdOrButtonsOrOpts;
    } else if (Array.isArray(threadIdOrButtonsOrOpts)) {
      buttons = threadIdOrButtonsOrOpts;
    } else if (threadIdOrButtonsOrOpts) {
      threadId = threadIdOrButtonsOrOpts.threadId;
      buttons = threadIdOrButtonsOrOpts.buttons;
    }

    if (threadId || buttons) {
      await this.send(chatId, text, { threadId, buttons });
    } else {
      await this.send(chatId, text);
    }
  }

  private chunkMessage(text: string): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_MSG) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', MAX_MSG);
      if (splitAt <= 0) splitAt = MAX_MSG;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }

  private logErr(handler: string, err: unknown): void {
    logger.error(SCOPE, `/${handler} error: ${(err as Error).message}`);
  }
}
