import Imap from 'imap';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { IncomingEvent, EventAttachment, EmailChannelConfig } from '../../core/types.js';
import type { MailSendOptions } from '../../tools/mail-tool.js';
import { logger } from '../../core/logger.js';

const SCOPE = 'EmailChannel';
const RECONNECT_DELAY_MS = 5000;

export function buildIdentityId(email: string): string {
  return `email:${email}`;
}

function normalizeSubject(subject: string): string {
  return subject.replace(/^(re|fwd?|fw)\s*:\s*/gi, '').trim().toLowerCase();
}

function buildHistoryKey(from: string, subject: string): string {
  const normalized = normalizeSubject(subject);
  return `email:${from.toLowerCase()}:${normalized || 'no-subject'}`;
}

export class EmailChannel {
  private imap: Imap;
  private transporter: Transporter;
  private config: EmailChannelConfig;
  private onMessage: (event: IncomingEvent) => Promise<void>;
  private shouldReconnect = true;
  private allowedSenders: Set<string> | null = null;
  private downloadsDir: string;

  constructor(
    config: EmailChannelConfig,
    options: { onMessage: (event: IncomingEvent) => Promise<void>; downloadsDir?: string },
  ) {
    this.config = config;
    this.onMessage = options.onMessage;
    this.downloadsDir = options.downloadsDir || '/tmp/korabot-downloads';

    if (config.allowedSenders && config.allowedSenders.length > 0) {
      this.allowedSenders = new Set(config.allowedSenders.map(s => s.toLowerCase()));
    }

    this.imap = new Imap({
      user: config.imap.user,
      password: config.imap.password,
      host: config.imap.host,
      port: config.imap.port,
      tls: config.imap.tls,
      tlsOptions: { rejectUnauthorized: false },
    });

    this.transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.password,
      },
    });
  }

  async start(): Promise<void> {
    if (this.allowedSenders) {
      logger.info(SCOPE, `Allowed senders: ${[...this.allowedSenders].join(', ')}`);
    } else {
      logger.warn(SCOPE, 'No allowedSenders configured — ALL incoming emails will be processed. Configure allowedSenders for security.');
    }
    await this.startListening();
  }

  async stop(): Promise<void> {
    this.shouldReconnect = false;
    try {
      this.imap.end();
    } catch {
      logger.warn(SCOPE, 'Error closing IMAP connection');
    }
    this.transporter.close();
    logger.info(SCOPE, 'Email channel stopped');
  }

  listMessages(page = 1, pageSize = 10): Promise<{ messages: Array<{ id: string; from: string; subject: string; date: string; snippet: string }>; total: number; page: number; pageSize: number }> {
    return new Promise((resolve, reject) => {
      try {
        this.imap.search(['ALL'], (err, results) => {
          if (err) { reject(err); return; }
          if (!results || results.length === 0) {
            resolve({ messages: [], total: 0, page, pageSize });
            return;
          }

          const total = results.length;
          const sorted = results.slice().reverse();
          const start = (page - 1) * pageSize;
          const slice = sorted.slice(start, start + pageSize);

          if (slice.length === 0) {
            resolve({ messages: [], total, page, pageSize });
            return;
          }

          const emails: Array<{ id: string; from: string; subject: string; date: string; snippet: string }> = [];
          const fetch = this.imap.fetch(slice, { bodies: '', markSeen: false });

          fetch.on('message', (msg, seqno) => {
            msg.on('body', (stream) => {
              simpleParser(stream, (parseErr, parsed) => {
                if (parseErr) return;
                emails.push({
                  id: String(seqno),
                  from: parsed.from?.value?.[0]?.address ?? 'unknown',
                  subject: parsed.subject ?? '(no subject)',
                  date: parsed.date?.toISOString() ?? '',
                  snippet: (parsed.text ?? '').slice(0, 200),
                });
              });
            });
          });

          fetch.once('end', () => resolve({ messages: emails, total, page, pageSize }));
          fetch.once('error', reject);
        });
      } catch (e) { reject(e); }
    });
  }

  readMessage(id: string, downloadsDir?: string): Promise<{ id: string; from: string; to: string; subject: string; date: string; snippet: string; body: string; cc?: string; attachments?: Array<{ filename: string; mimeType: string; size: number; localPath?: string }> } | null> {
    return new Promise((resolve, reject) => {
      try {
        const seqno = parseInt(id, 10);
        if (isNaN(seqno)) { resolve(null); return; }

        const fetch = this.imap.fetch([seqno], { bodies: '', markSeen: false });
        let found = false;

        fetch.on('message', (msg) => {
          found = true;
          msg.on('body', (stream) => {
            simpleParser(stream, (parseErr, parsed) => {
              if (parseErr) { resolve(null); return; }

              const attachments: Array<{ filename: string; mimeType: string; size: number; localPath?: string }> = [];
              for (const a of parsed.attachments ?? []) {
                const entry: { filename: string; mimeType: string; size: number; localPath?: string } = {
                  filename: a.filename ?? 'unknown',
                  mimeType: a.contentType ?? 'application/octet-stream',
                  size: a.size ?? 0,
                };
                if (downloadsDir && a.content) {
                  try {
                    mkdirSync(downloadsDir, { recursive: true });
                    const safeFilename = `${Date.now()}-${(a.filename ?? 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
                    const filePath = join(downloadsDir, safeFilename);
                    writeFileSync(filePath, a.content);
                    entry.localPath = filePath;
                  } catch { /* ignore write errors */ }
                }
                attachments.push(entry);
              }

              resolve({
                id,
                from: parsed.from?.value?.[0]?.address ?? 'unknown',
                to: parsed.to && !Array.isArray(parsed.to) ? (parsed.to.value?.[0]?.address ?? '') : '',
                subject: parsed.subject ?? '(no subject)',
                date: parsed.date?.toISOString() ?? '',
                snippet: (parsed.text ?? '').slice(0, 200),
                body: parsed.text ?? '',
                cc: parsed.cc && !Array.isArray(parsed.cc) ? (parsed.cc.value?.map(v => v.address).join(', ') ?? undefined) : undefined,
                attachments: attachments.length > 0 ? attachments : undefined,
              });
            });
          });
        });

        fetch.once('end', () => { if (!found) resolve(null); });
        fetch.once('error', reject);
      } catch (e) { reject(e); }
    });
  }

  async send(
    to: string,
    subject: string,
    body: string,
    options?: MailSendOptions,
  ): Promise<void> {
    const mailOpts: Record<string, unknown> = {
      from: this.config.smtp.user,
      to,
      subject,
      text: body,
      html: options?.html,
    };
    if (options?.inReplyTo) {
      mailOpts.inReplyTo = options.inReplyTo;
      mailOpts.references = options.references || options.inReplyTo;
    }
    await this.transporter.sendMail(mailOpts);
    logger.debug(SCOPE, `Email sent to ${to}: ${subject}`);
  }

  async startListening(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let resolved = false;

      this.imap.once('ready', () => {
        logger.info(SCOPE, 'IMAP connection established');
        this.openInbox()
          .then(() => {
            if (!resolved) {
              resolved = true;
              resolve();
            }
          })
          .catch((err) => {
            if (!resolved) {
              resolved = true;
              reject(err);
            }
          });
      });

      this.imap.once('error', (err: Error) => {
        logger.error(SCOPE, 'IMAP error', err.message);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
        this.scheduleReconnect();
      });

      this.imap.once('end', () => {
        logger.info(SCOPE, 'IMAP connection ended');
        this.scheduleReconnect();
      });

      this.imap.connect();
    });
  }

  private async openInbox(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.imap.openBox('INBOX', false, (err) => {
        if (err) {
          logger.error(SCOPE, 'Failed to open INBOX', err.message);
          reject(err);
          return;
        }

        logger.info(SCOPE, 'INBOX opened, listening for new emails');

        this.imap.on('mail', () => {
          this.fetchNewMessages();
        });

        resolve();
      });
    });
  }

  private fetchNewMessages(): void {
    this.imap.search(['UNSEEN'], (err, results) => {
      if (err) {
        logger.error(SCOPE, 'Search error', err.message);
        return;
      }

      if (!results || results.length === 0) {
        return;
      }

      const fetch = this.imap.fetch(results, { bodies: '', markSeen: true });

      fetch.on('message', (msg) => {
        msg.on('body', (stream) => {
          simpleParser(stream, async (parseErr, parsed) => {
            if (parseErr) {
              logger.error(SCOPE, 'Parse error', parseErr.message);
              return;
            }

            const fromAddress =
              parsed.from?.value?.[0]?.address ?? 'unknown';

            if (this.allowedSenders && !this.allowedSenders.has(fromAddress.toLowerCase())) {
              logger.warn(SCOPE, `Rejected email from unauthorized sender ${fromAddress}: "${parsed.subject ?? '(no subject)'}"`);
              return;
            }

            const toAddress =
              parsed.to && !Array.isArray(parsed.to)
                ? parsed.to.value?.[0]?.address ?? ''
                : '';

            const subject = parsed.subject ?? '';
            const historyKey = buildHistoryKey(fromAddress, subject);

            const attachments: EventAttachment[] = [];
            if (parsed.attachments && parsed.attachments.length > 0) {
              const attDir = join(this.downloadsDir, 'email');
              try { mkdirSync(attDir, { recursive: true }); } catch { /* exists */ }

              for (const att of parsed.attachments) {
                try {
                  const fileName = att.filename || `${Date.now()}.bin`;
                  const filePath = join(attDir, `${Date.now()}-${fileName}`);
                  writeFileSync(filePath, att.content);
                  const isImage = att.contentType?.startsWith('image/') ?? false;
                  attachments.push({
                    type: isImage ? 'photo' : 'document',
                    fileId: att.checksum || fileName,
                    fileName: att.filename || undefined,
                    mimeType: att.contentType,
                    localPath: filePath,
                  });
                  logger.info(SCOPE, `Saved attachment: ${filePath} (${att.size} bytes)`);
                } catch (attErr) {
                  logger.warn(SCOPE, `Failed to save attachment: ${(attErr as Error).message}`);
                }
              }
            }

            const content = `[Email received]\nFrom: ${fromAddress}\nSubject: ${subject}\nDate: ${parsed.date?.toISOString() ?? 'unknown'}\n\n${parsed.text || ''}`;

            const event: IncomingEvent = {
              channel: 'email',
              identityId: buildIdentityId(fromAddress),
              type: 'email',
              content,
              attachments: attachments.length > 0 ? attachments : undefined,
              metadata: {
                from: fromAddress,
                to: toAddress,
                subject,
                date: parsed.date?.toISOString() ?? null,
                messageId: parsed.messageId ?? null,
                historyKey,
              },
              raw: parsed,
            };

            try {
              await this.onMessage(event);
            } catch (handlerErr) {
              logger.error(
                SCOPE,
                'Handler error processing email',
                (handlerErr as Error).message,
              );
            }
          });
        });
      });

      fetch.once('error', (fetchErr) => {
        logger.error(SCOPE, 'Fetch error', fetchErr.message);
      });
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    logger.info(
      SCOPE,
      `Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`,
    );

    setTimeout(() => {
      if (!this.shouldReconnect) return;

      this.imap = new Imap({
        user: this.config.imap.user,
        password: this.config.imap.password,
        host: this.config.imap.host,
        port: this.config.imap.port,
        tls: this.config.imap.tls,
        tlsOptions: { rejectUnauthorized: false },
      });

      this.startListening().catch((err) => {
        logger.error(SCOPE, 'Reconnection failed', (err as Error).message);
      });
    }, RECONNECT_DELAY_MS).unref();
  }
}
