import Imap from 'imap';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { google, gmail_v1 } from 'googleapis';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../core/logger.js';
import type {
  DelegatedEmail,
  DelegatedEmailDetail,
  DelegationCredentials,
  DelegationPermissions,
} from './types.js';

const SCOPE = 'MailDelegation';

export abstract class DelegatedMailAccount {
  abstract readonly provider: 'gmail' | 'imap';
  abstract readonly email: string;
  readonly permissions: DelegationPermissions;

  constructor(permissions: DelegationPermissions) {
    this.permissions = permissions;
  }

  abstract getInbox(limit?: number, unreadOnly?: boolean): Promise<DelegatedEmail[]>;
  abstract readMessage(messageId: string, downloadsDir?: string): Promise<DelegatedEmailDetail>;
  abstract search(query: string, limit?: number): Promise<DelegatedEmail[]>;
  abstract sendEmail(to: string, subject: string, body: string, options?: { html?: string; inReplyTo?: string }): Promise<void>;
  abstract replyToMessage(messageId: string, body: string, options?: { html?: string }): Promise<void>;
  abstract listMessageIds(afterDate: Date): AsyncGenerator<string[], void, unknown>;
}

// ─── Gmail Implementation ─────────────────────────────────────────────────────

export class GmailDelegatedAccount extends DelegatedMailAccount {
  readonly provider = 'gmail' as const;
  readonly email: string;
  private gmail: gmail_v1.Gmail;

  constructor(
    emailAddress: string,
    credentials: DelegationCredentials,
    globalClientId: string,
    globalClientSecret: string,
    permissions: DelegationPermissions,
  ) {
    super(permissions);
    this.email = emailAddress;

    const oauth2 = new google.auth.OAuth2(globalClientId, globalClientSecret);
    oauth2.setCredentials({ refresh_token: credentials.refreshToken });
    this.gmail = google.gmail({ version: 'v1', auth: oauth2 });
  }

  async getInbox(limit = 10, unreadOnly = true): Promise<DelegatedEmail[]> {
    const q = unreadOnly ? 'is:unread in:inbox' : 'in:inbox';
    const res = await this.gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: limit,
    });

    const messages = res.data.messages ?? [];
    const results: DelegatedEmail[] = [];

    for (const stub of messages) {
      if (!stub.id) continue;
      const msg = await this.gmail.users.messages.get({
        userId: 'me',
        id: stub.id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });

      const headers = msg.data.payload?.headers ?? [];
      const getH = (n: string) => headers.find(h => h.name?.toLowerCase() === n.toLowerCase())?.value ?? '';

      results.push({
        id: stub.id,
        from: getH('From'),
        to: getH('To'),
        subject: getH('Subject'),
        date: getH('Date'),
        snippet: msg.data.snippet ?? '',
        unread: msg.data.labelIds?.includes('UNREAD') ?? false,
        hasAttachments: (msg.data.payload?.parts?.some(p => !!p.filename) ?? false),
      });
    }

    return results;
  }

  async readMessage(messageId: string, downloadsDir?: string): Promise<DelegatedEmailDetail> {
    const msg = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const headers = msg.data.payload?.headers ?? [];
    const getH = (n: string) => headers.find(h => h.name?.toLowerCase() === n.toLowerCase())?.value ?? '';

    const body = this.extractText(msg.data.payload, 'text/plain');
    const htmlBody = this.extractText(msg.data.payload, 'text/html');

    const attachments: DelegatedEmailDetail['attachments'] = [];
    await this.collectAttachments(messageId, msg.data.payload, attachments, downloadsDir);

    return {
      id: messageId,
      from: getH('From'),
      to: getH('To'),
      subject: getH('Subject'),
      date: getH('Date'),
      snippet: msg.data.snippet ?? '',
      unread: msg.data.labelIds?.includes('UNREAD') ?? false,
      hasAttachments: attachments.length > 0,
      body: body || htmlBody || '',
      htmlBody: htmlBody || undefined,
      attachments,
    };
  }

  async search(query: string, limit = 10): Promise<DelegatedEmail[]> {
    const res = await this.gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: limit,
    });

    const messages = res.data.messages ?? [];
    const results: DelegatedEmail[] = [];

    for (const stub of messages) {
      if (!stub.id) continue;
      const msg = await this.gmail.users.messages.get({
        userId: 'me',
        id: stub.id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });

      const headers = msg.data.payload?.headers ?? [];
      const getH = (n: string) => headers.find(h => h.name?.toLowerCase() === n.toLowerCase())?.value ?? '';

      results.push({
        id: stub.id,
        from: getH('From'),
        to: getH('To'),
        subject: getH('Subject'),
        date: getH('Date'),
        snippet: msg.data.snippet ?? '',
        unread: msg.data.labelIds?.includes('UNREAD') ?? false,
        hasAttachments: false,
      });
    }

    return results;
  }

  async sendEmail(to: string, subject: string, body: string, options?: { html?: string; inReplyTo?: string }): Promise<void> {
    if (!this.permissions.send) throw new Error('Send permission not granted for this delegated account');

    const headerLines = [
      `From: ${this.email}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
    ];
    if (options?.inReplyTo) headerLines.push(`In-Reply-To: ${options.inReplyTo}`);

    const raw = Buffer.from([...headerLines, '', body].join('\r\n')).toString('base64url');
    await this.gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    logger.info(SCOPE, `[Gmail delegation] Sent email as ${this.email} to ${to}: "${subject}"`);
  }

  async replyToMessage(messageId: string, body: string, options?: { html?: string }): Promise<void> {
    if (!this.permissions.send) throw new Error('Send permission not granted for this delegated account');

    const original = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Message-ID'],
    });

    const headers = original.data.payload?.headers ?? [];
    const getH = (n: string) => headers.find(h => h.name?.toLowerCase() === n.toLowerCase())?.value ?? '';

    const replyTo = getH('From');
    const subject = getH('Subject').startsWith('Re:') ? getH('Subject') : `Re: ${getH('Subject')}`;
    const originalMsgId = getH('Message-ID');
    const threadId = original.data.threadId ?? undefined;

    const headerLines = [
      `From: ${this.email}`,
      `To: ${replyTo}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
    ];
    if (originalMsgId) {
      headerLines.push(`In-Reply-To: ${originalMsgId}`);
      headerLines.push(`References: ${originalMsgId}`);
    }

    const raw = Buffer.from([...headerLines, '', body].join('\r\n')).toString('base64url');
    const requestBody: Record<string, unknown> = { raw };
    if (threadId) requestBody.threadId = threadId;

    await this.gmail.users.messages.send({ userId: 'me', requestBody });
    logger.info(SCOPE, `[Gmail delegation] Replied as ${this.email} to ${replyTo}: "${subject}"`);
  }

  private extractText(payload: gmail_v1.Schema$MessagePart | undefined, mimeType: string): string {
    if (!payload) return '';
    if (payload.mimeType === mimeType && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    }
    for (const part of payload.parts ?? []) {
      const found = this.extractText(part, mimeType);
      if (found) return found;
    }
    return '';
  }

  async *listMessageIds(afterDate: Date): AsyncGenerator<string[], void, unknown> {
    const yyyy = afterDate.getFullYear();
    const mm = String(afterDate.getMonth() + 1).padStart(2, '0');
    const dd = String(afterDate.getDate()).padStart(2, '0');
    const q = `after:${yyyy}/${mm}/${dd}`;
    let pageToken: string | undefined;
    do {
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        q,
        maxResults: 100,
        pageToken,
      });
      const ids = (res.data.messages ?? []).map(m => m.id!).filter(Boolean);
      if (ids.length > 0) yield ids;
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  private async collectAttachments(
    messageId: string,
    payload: gmail_v1.Schema$MessagePart | undefined,
    out: DelegatedEmailDetail['attachments'],
    downloadsDir?: string,
  ): Promise<void> {
    if (!payload) return;
    for (const part of payload.parts ?? []) {
      if (part.filename && part.body?.size) {
        const entry: DelegatedEmailDetail['attachments'][0] = {
          filename: part.filename,
          mimeType: part.mimeType ?? 'application/octet-stream',
          size: part.body.size,
        };
        if (downloadsDir && part.body.attachmentId) {
          try {
            const attData = await this.gmail.users.messages.attachments.get({
              userId: 'me', messageId, id: part.body.attachmentId,
            });
            if (attData.data.data) {
              mkdirSync(downloadsDir, { recursive: true });
              const safeFilename = `${Date.now()}-${part.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
              const filePath = join(downloadsDir, safeFilename);
              writeFileSync(filePath, Buffer.from(attData.data.data, 'base64url'));
              entry.localPath = filePath;
              logger.info(SCOPE, `Downloaded attachment "${part.filename}" to ${filePath}`);
            }
          } catch (err) {
            logger.warn(SCOPE, `Failed to download attachment "${part.filename}": ${(err as Error).message}`);
          }
        }
        out.push(entry);
      }
      await this.collectAttachments(messageId, part, out, downloadsDir);
    }
  }
}

// ─── IMAP/SMTP Implementation ─────────────────────────────────────────────────

export class ImapDelegatedAccount extends DelegatedMailAccount {
  readonly provider = 'imap' as const;
  readonly email: string;
  private credentials: DelegationCredentials;

  constructor(
    emailAddress: string,
    credentials: DelegationCredentials,
    permissions: DelegationPermissions,
  ) {
    super(permissions);
    this.email = emailAddress;
    this.credentials = credentials;
  }

  async getInbox(limit = 10, unreadOnly = true): Promise<DelegatedEmail[]> {
    return this.withImap(async (imap) => {
      await this.openBox(imap, 'INBOX');
      const criteria = unreadOnly ? ['UNSEEN'] : ['ALL'];
      const uids = await this.imapSearch(imap, criteria);
      const selected = uids.slice(-limit).reverse();
      if (selected.length === 0) return [];
      return this.fetchSummaries(imap, selected);
    });
  }

  async readMessage(messageId: string, downloadsDir?: string): Promise<DelegatedEmailDetail> {
    return this.withImap(async (imap) => {
      await this.openBox(imap, 'INBOX');
      const uid = parseInt(messageId, 10);
      if (isNaN(uid)) throw new Error(`Invalid message ID: ${messageId}`);

      return new Promise((resolve, reject) => {
        const f = imap.fetch([uid], { bodies: '', struct: true });
        let resolved = false;

        f.on('message', (msg) => {
          msg.on('body', (stream) => {
            simpleParser(stream, (err, parsed) => {
              if (err) { reject(err); return; }
              resolved = true;

              const attachments: DelegatedEmailDetail['attachments'] = [];
              for (const a of parsed.attachments ?? []) {
                const entry: DelegatedEmailDetail['attachments'][0] = {
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
                    logger.info(SCOPE, `Downloaded attachment "${a.filename}" to ${filePath}`);
                  } catch (writeErr) {
                    logger.warn(SCOPE, `Failed to save attachment "${a.filename}": ${(writeErr as Error).message}`);
                  }
                }
                attachments.push(entry);
              }

              resolve({
                id: messageId,
                from: parsed.from?.value?.[0]?.address ?? '',
                to: (parsed.to && !Array.isArray(parsed.to)) ? (parsed.to.value?.[0]?.address ?? '') : '',
                subject: parsed.subject ?? '',
                date: parsed.date?.toISOString() ?? '',
                snippet: (parsed.text ?? '').slice(0, 200),
                unread: true,
                hasAttachments: attachments.length > 0,
                body: parsed.text ?? '',
                htmlBody: parsed.html || undefined,
                attachments,
              });
            });
          });
        });

        f.once('error', (err) => { if (!resolved) reject(err); });
        f.once('end', () => {
          if (!resolved) reject(new Error(`Message ${messageId} not found`));
        });
      });
    });
  }

  async *listMessageIds(afterDate: Date): AsyncGenerator<string[], void, unknown> {
    const uids = await this.withImap(async (imap) => {
      await this.openBox(imap, 'INBOX');
      return this.imapSearch(imap, [['SINCE', afterDate]]);
    });
    const reversed = uids.slice().reverse();
    const BATCH = 50;
    for (let i = 0; i < reversed.length; i += BATCH) {
      yield reversed.slice(i, i + BATCH).map(String);
    }
  }

  async search(query: string, limit = 10): Promise<DelegatedEmail[]> {
    return this.withImap(async (imap) => {
      await this.openBox(imap, 'INBOX');
      const criteria = this.parseSearchQuery(query);
      const uids = await this.imapSearch(imap, criteria);
      const selected = uids.slice(-limit).reverse();
      if (selected.length === 0) return [];
      return this.fetchSummaries(imap, selected);
    });
  }

  async sendEmail(to: string, subject: string, body: string, options?: { html?: string; inReplyTo?: string }): Promise<void> {
    if (!this.permissions.send) throw new Error('Send permission not granted for this delegated account');
    if (!this.credentials.smtp) throw new Error('SMTP credentials not configured for this account');

    const transporter = nodemailer.createTransport({
      host: this.credentials.smtp.host,
      port: this.credentials.smtp.port,
      secure: this.credentials.smtp.secure,
      auth: { user: this.credentials.smtp.user, pass: this.credentials.smtp.password },
    });

    const mailOpts: Record<string, unknown> = {
      from: this.email,
      to,
      subject,
      text: body,
      html: options?.html,
    };
    if (options?.inReplyTo) {
      mailOpts.inReplyTo = options.inReplyTo;
      mailOpts.references = options.inReplyTo;
    }

    await transporter.sendMail(mailOpts);
    transporter.close();
    logger.info(SCOPE, `[IMAP delegation] Sent email as ${this.email} to ${to}: "${subject}"`);
  }

  async replyToMessage(messageId: string, body: string, options?: { html?: string }): Promise<void> {
    const original = await this.readMessage(messageId);
    const subject = original.subject.startsWith('Re:') ? original.subject : `Re: ${original.subject}`;
    await this.sendEmail(original.from, subject, body, { html: options?.html });
  }

  // ─── IMAP Helpers ─────────────────────────────────────────────────────────────

  private async withImap<T>(fn: (imap: Imap) => Promise<T>): Promise<T> {
    if (!this.credentials.imap) throw new Error('IMAP credentials not configured for this account');

    const imap = new Imap({
      user: this.credentials.imap.user,
      password: this.credentials.imap.password,
      host: this.credentials.imap.host,
      port: this.credentials.imap.port,
      tls: this.credentials.imap.tls,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 10000,
      authTimeout: 10000,
    });

    return new Promise<T>((resolve, reject) => {
      imap.once('ready', async () => {
        try {
          const result = await fn(imap);
          imap.end();
          resolve(result);
        } catch (err) {
          imap.end();
          reject(err);
        }
      });
      imap.once('error', reject);
      imap.connect();
    });
  }

  private openBox(imap: Imap, box: string): Promise<void> {
    return new Promise((resolve, reject) => {
      imap.openBox(box, true, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private imapSearch(imap: Imap, criteria: unknown[]): Promise<number[]> {
    return new Promise((resolve, reject) => {
      imap.search(criteria, (err, results) => {
        if (err) reject(err);
        else resolve(results ?? []);
      });
    });
  }

  private async fetchSummaries(imap: Imap, uids: number[]): Promise<DelegatedEmail[]> {
    return new Promise((resolve, reject) => {
      const results: DelegatedEmail[] = [];
      const f = imap.fetch(uids, { bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)', struct: true });

      f.on('message', (msg, seqno) => {
        let uid = seqno;
        msg.on('attributes', (attrs) => { uid = attrs.uid; });
        msg.on('body', (stream) => {
          simpleParser(stream, (err, parsed) => {
            if (err) return;
            results.push({
              id: String(uid),
              from: parsed.from?.value?.[0]?.address ?? '',
              to: (parsed.to && !Array.isArray(parsed.to)) ? (parsed.to.value?.[0]?.address ?? '') : '',
              subject: parsed.subject ?? '',
              date: parsed.date?.toISOString() ?? '',
              snippet: '',
              unread: true,
              hasAttachments: false,
            });
          });
        });
      });

      f.once('error', reject);
      f.once('end', () => resolve(results));
    });
  }

  private parseSearchQuery(query: string): unknown[] {
    const parts = query.match(/(\w+:[^\s]+)|("[^"]+")|\S+/g) ?? [query];
    const criteria: unknown[] = [];

    for (const part of parts) {
      const colonIdx = part.indexOf(':');
      if (colonIdx > 0) {
        const key = part.slice(0, colonIdx).toLowerCase();
        const value = part.slice(colonIdx + 1).replace(/^"|"$/g, '');
        switch (key) {
          case 'from': criteria.push(['FROM', value]); break;
          case 'to': criteria.push(['TO', value]); break;
          case 'subject': criteria.push(['SUBJECT', value]); break;
          case 'since': case 'after': criteria.push(['SINCE', value]); break;
          case 'before': criteria.push(['BEFORE', value]); break;
          default: criteria.push(['TEXT', part]); break;
        }
      } else {
        criteria.push(['TEXT', part.replace(/^"|"$/g, '')]);
      }
    }

    return criteria.length > 0 ? criteria : [['ALL']];
  }
}
