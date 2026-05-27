import type { ToolDefinition } from '../core/types.js';
import { logger } from '../core/logger.js';
import { existsSync } from 'node:fs';
import { basename, extname } from 'node:path';

const SCOPE = 'mail-tool';

export interface MailAttachment {
  filename: string;
  path: string;
  mimeType?: string;
}

export interface MailSendOptions {
  html?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  attachments?: MailAttachment[];
}

export interface MailMessage {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface MailMessageAttachment {
  filename: string;
  mimeType: string;
  size: number;
  localPath?: string;
}

export interface MailMessageFull extends MailMessage {
  body: string;
  to?: string;
  cc?: string;
  attachments?: MailMessageAttachment[];
}

export interface MailSender {
  send(to: string, subject: string, body: string, options?: MailSendOptions): Promise<void>;
  listMessages?(page: number, pageSize: number): Promise<{ messages: MailMessage[]; total: number; page: number; pageSize: number }>;
  readMessage?(id: string, downloadsDir?: string): Promise<MailMessageFull | null>;
}

export interface MailToolContext {
  emailChannel: MailSender;
  multiUserMode?: boolean;
  userEmail?: string;
  downloadsDir?: string;
}

export function getMailToolDefinitions(multiUserMode?: boolean): ToolDefinition[] {
  const defs: ToolDefinition[] = [
    {
      name: 'mail_send',
      description: multiUserMode
        ? 'Send an email to the current user. In multi-user mode, the recipient is fixed to the user\'s registered email.'
        : 'Send an email to a recipient.',
      parameters: {
        type: 'object',
        properties: {
          ...(multiUserMode ? {} : { to: { type: 'string', description: 'Recipient email address' } }),
          subject: { type: 'string', description: 'Email subject line' },
          text: { type: 'string', description: 'Plain text email body' },
          html: { type: 'string', description: 'HTML email body' },
          attachments: {
            type: 'array',
            description: 'Optional file attachments. Each item needs a file path.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Absolute path to the file to attach' },
                filename: { type: 'string', description: 'Display name for the attachment (defaults to file basename)' },
              },
              required: ['path'],
            },
          },
        },
        required: multiUserMode ? ['subject', 'text'] : ['to', 'subject', 'text'],
      },
    },
  ];

  if (!multiUserMode) {
    defs.push({
      name: 'mail_list',
      description: 'List emails from the bot\'s inbox with pagination.',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'number', description: 'Page number, starting from 1 (default: 1)' },
          pageSize: { type: 'number', description: 'Number of emails per page (default: 10, max: 50)' },
        },
      },
    });
    defs.push({
      name: 'mail_read',
      description: 'Read the full content of a specific email by its ID (obtained from mail_list). Attachments are automatically downloaded and their local file paths returned.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The email message ID' },
        },
        required: ['id'],
      },
    });
  }

  return defs;
}

export const mailToolDefinitions: ToolDefinition[] = getMailToolDefinitions(false);

export async function handleMailTool(
  name: string,
  args: Record<string, unknown>,
  context: MailToolContext,
): Promise<string> {
  try {
    switch (name) {
      case 'mail_send': {
        let to: string;
        if (context.multiUserMode) {
          if (!context.userEmail) {
            return JSON.stringify({ ok: false, error: 'No user email associated with this session.' });
          }
          to = context.userEmail;
        } else {
          to = args.to as string;
          if (!to) return JSON.stringify({ ok: false, error: 'Recipient "to" is required.' });
        }
        const subject = args.subject as string;
        const body = args.text as string;
        const html = args.html as string | undefined;
        const rawAttachments = args.attachments as Array<{ path: string; filename?: string }> | undefined;

        const opts: MailSendOptions = {};
        if (html) opts.html = html;

        if (rawAttachments?.length) {
          const attachments: MailAttachment[] = [];
          for (const a of rawAttachments) {
            if (!a.path || !existsSync(a.path)) {
              return JSON.stringify({ ok: false, error: `Attachment not found: ${a.path}` });
            }
            const ext = extname(a.path).toLowerCase();
            const mimeMap: Record<string, string> = {
              '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
              '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
              '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html',
              '.json': 'application/json', '.xml': 'application/xml',
              '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav',
            };
            attachments.push({
              filename: a.filename || basename(a.path),
              path: a.path,
              mimeType: mimeMap[ext] || 'application/octet-stream',
            });
          }
          opts.attachments = attachments;
        }

        await context.emailChannel.send(to, subject, body, Object.keys(opts).length > 0 ? opts : undefined);
        const attachNote = opts.attachments?.length ? ` with ${opts.attachments.length} attachment(s)` : '';
        logger.info(SCOPE, `Sent email to ${to}: "${subject}"${attachNote}`);
        return JSON.stringify({ ok: true, message: `Email sent to ${to}${attachNote}` });
      }

      case 'mail_list': {
        if (context.multiUserMode) {
          return JSON.stringify({ ok: false, error: 'Inbox listing is not available in multi-user mode.' });
        }
        if (!context.emailChannel.listMessages) {
          return JSON.stringify({ ok: false, error: 'Inbox listing is not supported by this email channel.' });
        }
        const page = Math.max(Number(args.page) || 1, 1);
        const pageSize = Math.min(Math.max(Number(args.pageSize) || 10, 1), 50);
        logger.info(SCOPE, `Listing inbox page=${page} pageSize=${pageSize}`);
        const result = await context.emailChannel.listMessages(page, pageSize);
        return JSON.stringify({ ok: true, ...result });
      }

      case 'mail_read': {
        if (context.multiUserMode) {
          return JSON.stringify({ ok: false, error: 'Email reading is not available in multi-user mode.' });
        }
        if (!context.emailChannel.readMessage) {
          return JSON.stringify({ ok: false, error: 'Email reading is not supported by this email channel.' });
        }
        const id = String(args.id ?? '');
        if (!id) return JSON.stringify({ ok: false, error: 'Message ID is required.' });
        logger.info(SCOPE, `Reading email id=${id}`);
        const msg = await context.emailChannel.readMessage(id, context.downloadsDir);
        if (!msg) return JSON.stringify({ ok: false, error: 'Message not found.' });
        return JSON.stringify({ ok: true, message: msg });
      }

      default:
        return JSON.stringify({ ok: false, error: `Unknown mail tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(SCOPE, `${name} failed: ${msg}`);
    return JSON.stringify({ ok: false, error: msg });
  }
}
