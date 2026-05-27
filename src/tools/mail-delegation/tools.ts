import type { ToolDefinition } from '../../core/types.js';
import type { DelegationManager } from './manager.js';
import type { ContentGuard } from '../../core/content-guard.js';
import { logger } from '../../core/logger.js';

const SCOPE = 'mail-delegation-tool';

export interface MailDelegationToolContext {
  delegationManager: DelegationManager;
  workspaceId: string;
  downloadsDir?: string;
  contentGuard?: ContentGuard;
  sensitiveMailFilter?: boolean;
}

export const mailDelegationToolDefinitions: ToolDefinition[] = [
  {
    name: 'mail_delegation_inbox',
    description: 'List recent emails from a delegated user email account. This reads the USER\'s inbox, not the bot\'s channel.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Email address of the delegated account (optional if only one configured)' },
        limit: { type: 'number', description: 'Max emails to return (default 10)' },
        unread_only: { type: 'boolean', description: 'Only show unread emails (default true)' },
      },
    },
  },
  {
    name: 'mail_delegation_read',
    description: 'Read the full content of a specific email from a delegated user account. Attachments are automatically downloaded and their local file paths returned.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Email address of the delegated account' },
        message_id: { type: 'string', description: 'The message ID to read' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'mail_delegation_search',
    description: 'Search emails in a delegated user account. Supports queries like "from:user@example.com subject:meeting after:2024-01-01".',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Email address of the delegated account' },
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'mail_delegation_reply',
    description: 'Reply to an email in a delegated account, sending as the user. Requires send permission.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Email address of the delegated account' },
        message_id: { type: 'string', description: 'Message ID to reply to' },
        body: { type: 'string', description: 'Reply body text' },
      },
      required: ['message_id', 'body'],
    },
  },
  {
    name: 'mail_delegation_send',
    description: 'Send a new email from a delegated account as the user. Requires send permission.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Email address of the delegated account' },
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body text' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
];

export async function handleMailDelegationTool(
  name: string,
  args: Record<string, unknown>,
  context: MailDelegationToolContext,
): Promise<string> {
  try {
    const emailHint = args.account as string | undefined;
    const { config, account } = context.delegationManager.resolveAccount(context.workspaceId, emailHint);

    switch (name) {
      case 'mail_delegation_inbox': {
        if (!config.permissions.read) {
          return JSON.stringify({ ok: false, error: 'Read permission not granted for this account' });
        }
        const limit = (args.limit as number) || 10;
        const unreadOnly = args.unread_only !== false;
        let emails = await account.getInbox(limit, unreadOnly);
        if (context.sensitiveMailFilter !== false && context.contentGuard) {
          const filtered = [];
          for (const e of emails) {
            const scan = await context.contentGuard.scanEmail(e.subject, '', e.snippet);
            if (!scan.blocked) filtered.push(e);
            else logger.debug(SCOPE, `Filtered sensitive email "${e.subject}" from inbox: ${scan.reasons[0]}`);
          }
          emails = filtered;
        }
        logger.info(SCOPE, `Listed ${emails.length} emails from ${config.email} for workspace ${context.workspaceId}`);
        return JSON.stringify({ ok: true, account: config.email, count: emails.length, emails });
      }

      case 'mail_delegation_read': {
        if (!config.permissions.read) {
          return JSON.stringify({ ok: false, error: 'Read permission not granted for this account' });
        }
        const messageId = args.message_id as string;
        const email = await account.readMessage(messageId, context.downloadsDir);
        if (context.sensitiveMailFilter !== false && context.contentGuard) {
          const scan = await context.contentGuard.scanEmail(email.subject, email.body, email.snippet);
          if (scan.blocked) {
            logger.info(SCOPE, `Blocked sensitive email "${email.subject}" (id=${messageId}): ${scan.reasons.join(', ')}`);
            return JSON.stringify({
              ok: true, account: config.email, sensitive: true, reasons: scan.reasons,
              email: { ...email, body: '[REDACTED - sensitive content detected]', htmlBody: undefined },
            });
          }
        }
        logger.info(SCOPE, `Read message ${messageId} from ${config.email}`);
        return JSON.stringify({ ok: true, account: config.email, email });
      }

      case 'mail_delegation_search': {
        if (!config.permissions.read) {
          return JSON.stringify({ ok: false, error: 'Read permission not granted for this account' });
        }
        const query = args.query as string;
        const limit = (args.limit as number) || 10;
        let emails = await account.search(query, limit);
        if (context.sensitiveMailFilter !== false && context.contentGuard) {
          const filtered = [];
          for (const e of emails) {
            const scan = await context.contentGuard.scanEmail(e.subject, '', e.snippet);
            if (!scan.blocked) filtered.push(e);
            else logger.debug(SCOPE, `Filtered sensitive email "${e.subject}" from search: ${scan.reasons[0]}`);
          }
          emails = filtered;
        }
        logger.info(SCOPE, `Search "${query}" returned ${emails.length} results from ${config.email}`);
        return JSON.stringify({ ok: true, account: config.email, query, count: emails.length, emails });
      }

      case 'mail_delegation_reply': {
        if (!config.permissions.send) {
          return JSON.stringify({ ok: false, error: `Send permission not granted for ${config.email}. Only read access is configured.` });
        }
        const messageId = args.message_id as string;
        const body = args.body as string;
        await account.replyToMessage(messageId, body);
        return JSON.stringify({ ok: true, message: `Reply sent as ${config.email}` });
      }

      case 'mail_delegation_send': {
        if (!config.permissions.send) {
          return JSON.stringify({ ok: false, error: `Send permission not granted for ${config.email}. Only read access is configured.` });
        }
        const to = args.to as string;
        const subject = args.subject as string;
        const body = args.body as string;
        await account.sendEmail(to, subject, body);
        return JSON.stringify({ ok: true, message: `Email sent as ${config.email} to ${to}` });
      }

      default:
        return JSON.stringify({ ok: false, error: `Unknown delegation tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(SCOPE, `${name} failed: ${msg}`);
    return JSON.stringify({ ok: false, error: msg });
  }
}
