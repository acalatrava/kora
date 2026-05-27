import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import type { IncomingEvent, EventAttachment, GmailChannelConfig } from '../../core/types.js';
import type { MailSendOptions } from '../../tools/mail-tool.js';
import { logger } from '../../core/logger.js';

const SCOPE = 'GmailChannel';
const DEFAULT_POLL_INTERVAL = 30;

function normalizeSubject(subject: string): string {
  return subject.replace(/^(re|fwd?|fw)\s*:\s*/gi, '').trim().toLowerCase();
}

function buildHistoryKey(from: string, subject: string): string {
  const normalized = normalizeSubject(subject);
  return `email:${from.toLowerCase()}:${normalized || 'no-subject'}`;
}
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

export function buildIdentityId(email: string): string {
  return `email:${email}`;
}

/**
 * Generate an OAuth2 authorization URL for the user to visit.
 * After authorizing, Google redirects with an auth code.
 */
export function getAuthUrl(clientId: string, clientSecret: string, redirectUri = 'urn:ietf:wg:oauth:2.0:oob'): string {
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPES,
  });
}

/**
 * Exchange an authorization code for tokens (including refresh_token).
 */
export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri = 'urn:ietf:wg:oauth:2.0:oob',
): Promise<{ refreshToken: string; accessToken: string; email: string }> {
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) throw new Error('No refresh token received. Make sure you use prompt=consent and access_type=offline.');
  oauth2.setCredentials(tokens);

  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const email = profile.data.emailAddress ?? '';

  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token ?? '',
    email,
  };
}

export class GmailChannel {
  private oauth2: OAuth2Client;
  private gmail: gmail_v1.Gmail;
  private config: GmailChannelConfig;
  private onMessage: (event: IncomingEvent) => Promise<void>;
  private onTokenRefresh?: (refreshToken: string) => void;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastHistoryId: string | null = null;
  private running = false;
  private processing = false;
  private authFailed = false;
  private consecutiveAuthFailures = 0;
  private userEmail = '';
  private allowedSenders: Set<string> | null = null;
  private downloadsDir: string;

  constructor(
    config: GmailChannelConfig,
    options: {
      onMessage: (event: IncomingEvent) => Promise<void>;
      downloadsDir?: string;
      onTokenRefresh?: (refreshToken: string) => void;
    },
  ) {
    this.config = config;
    this.onMessage = options.onMessage;
    this.onTokenRefresh = options.onTokenRefresh;
    this.downloadsDir = options.downloadsDir || '/tmp/korabot-downloads';

    this.oauth2 = new google.auth.OAuth2(config.clientId, config.clientSecret);
    this.oauth2.setCredentials({ refresh_token: config.refreshToken });
    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2 });

    this.oauth2.on('tokens', (tokens) => {
      if (tokens.refresh_token) {
        logger.info(SCOPE, 'Received new refresh token from Google, persisting...');
        this.config = { ...this.config, refreshToken: tokens.refresh_token };
        this.onTokenRefresh?.(tokens.refresh_token);
      }
      logger.debug(SCOPE, `Access token refreshed (expires: ${tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : 'unknown'})`);
    });

    if (config.allowedSenders && config.allowedSenders.length > 0) {
      this.allowedSenders = new Set(config.allowedSenders.map(s => s.toLowerCase()));
    }
  }

  async updateCredentials(refreshToken: string): Promise<void> {
    logger.info(SCOPE, 'Updating OAuth credentials with new refresh token...');
    this.config = { ...this.config, refreshToken };
    this.oauth2.setCredentials({ refresh_token: refreshToken });
    this.authFailed = false;
    this.consecutiveAuthFailures = 0;

    try {
      const profile = await this.gmail.users.getProfile({ userId: 'me' });
      this.userEmail = profile.data.emailAddress ?? this.config.email ?? '';
      logger.info(SCOPE, `Credentials updated successfully for ${this.userEmail}`);

      if (!this.running) {
        await this.start();
      }
    } catch (err) {
      logger.error(SCOPE, `Failed to validate new credentials: ${(err as Error).message}`);
      throw err;
    }
  }

  async start(): Promise<void> {
    this.running = true;
    this.authFailed = false;
    this.consecutiveAuthFailures = 0;

    logger.info(SCOPE, 'Connecting to Gmail API...');
    try {
      const profile = await this.gmail.users.getProfile({ userId: 'me' });
      this.userEmail = profile.data.emailAddress ?? this.config.email ?? '';
      this.lastHistoryId = profile.data.historyId ?? null;
    } catch (err) {
      const msg = (err as Error).message || String(err);
      logger.error(SCOPE, `Failed to connect to Gmail API: ${msg}`);
      if (this.isAuthError(msg)) {
        this.authFailed = true;
        logger.error(SCOPE, [
          'The refresh token is invalid or expired.',
          'Common causes:',
          '  1. Google Cloud Console app is in "Testing" mode (tokens expire after 7 days)',
          '     → Go to Google Cloud Console > APIs & Services > OAuth consent screen > Publish the app',
          '  2. The user revoked access to the app',
          '  3. The refresh token was obtained with different credentials',
          'Fix: Re-authorize via the web admin panel (Channels > Gmail > click "Authorize").',
        ].join('\n'));
      }
      this.running = false;
      return;
    }

    const intervalSec = this.config.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL;
    logger.info(SCOPE, `Gmail channel started for ${this.userEmail} (historyId: ${this.lastHistoryId}, polling every ${intervalSec}s)`);
    if (this.allowedSenders) {
      logger.info(SCOPE, `Allowed senders: ${[...this.allowedSenders].join(', ')}`);
    } else {
      logger.warn(SCOPE, 'No allowedSenders configured — ALL incoming emails will be processed. Configure allowedSenders for security.');
    }

    this.pollTimer = setInterval(() => this.poll().catch(e => {
      logger.error(SCOPE, `Unhandled poll error: ${(e as Error).message}`);
    }), intervalSec * 1000);
  }

  get isAuthBroken(): boolean {
    return this.authFailed;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info(SCOPE, 'Gmail channel stopped');
  }

  async send(to: string, subject: string, body: string, options?: MailSendOptions): Promise<void> {
    const raw = this.buildRawEmail(to, subject, body, options);
    const requestBody: Record<string, unknown> = { raw };
    if (options?.threadId) requestBody.threadId = options.threadId;

    const MAX_SEND_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_SEND_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          logger.info(SCOPE, `Refreshing access token before send retry ${attempt + 1}/${MAX_SEND_RETRIES}...`);
          try {
            await this.oauth2.getAccessToken();
          } catch (refreshErr) {
            logger.warn(SCOPE, `Token refresh failed: ${(refreshErr as Error).message}`);
          }
        }
        await this.gmail.users.messages.send({ userId: 'me', requestBody });
        logger.debug(SCOPE, `Email sent to ${to}: ${subject}${options?.threadId ? ` (thread: ${options.threadId})` : ''}`);
        return;
      } catch (err) {
        const msg = (err as Error).message || String(err);
        if (attempt < MAX_SEND_RETRIES - 1 && this.isAuthError(msg)) {
          const delay = (attempt + 1) * 2000;
          logger.warn(SCOPE, `Send attempt ${attempt + 1} failed with auth error: ${msg}. Retrying in ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  get email(): string {
    return this.userEmail;
  }

  async listMessages(page = 1, pageSize = 10): Promise<{ messages: Array<{ id: string; from: string; subject: string; date: string; snippet: string }>; total: number; page: number; pageSize: number }> {
    const listRes = await this.gmail.users.messages.list({
      userId: 'me',
      maxResults: pageSize,
      labelIds: ['INBOX'],
      ...(page > 1 ? {} : {}),
    });
    const total = listRes.data.resultSizeEstimate ?? 0;
    const msgs = listRes.data.messages ?? [];
    const results: Array<{ id: string; from: string; subject: string; date: string; snippet: string }> = [];
    for (const msg of msgs) {
      if (!msg.id) continue;
      const detail = await this.gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
      const headers = detail.data.payload?.headers ?? [];
      results.push({
        id: msg.id,
        from: headers.find(h => h.name === 'From')?.value ?? 'unknown',
        subject: headers.find(h => h.name === 'Subject')?.value ?? '(no subject)',
        date: headers.find(h => h.name === 'Date')?.value ?? '',
        snippet: detail.data.snippet ?? '',
      });
    }
    return { messages: results, total, page, pageSize };
  }

  async readMessage(id: string, downloadsDir?: string): Promise<{ id: string; from: string; to: string; subject: string; date: string; snippet: string; body: string; cc?: string; attachments?: Array<{ filename: string; mimeType: string; size: number; localPath?: string }> } | null> {
    try {
      const detail = await this.gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const headers = detail.data.payload?.headers ?? [];
      const getHeader = (name: string) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

      let body = '';
      const payload = detail.data.payload;
      if (payload?.body?.data) {
        body = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
      } else if (payload?.parts) {
        const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
        if (textPart?.body?.data) {
          body = Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
        }
      }

      const attachments: Array<{ filename: string; mimeType: string; size: number; localPath?: string }> = [];
      const saveDir = downloadsDir ?? join(this.downloadsDir, 'email');
      await this.collectReadAttachments(id, payload, attachments, saveDir);

      return {
        id,
        from: getHeader('From'),
        to: getHeader('To'),
        subject: getHeader('Subject'),
        date: getHeader('Date'),
        snippet: detail.data.snippet ?? '',
        body,
        cc: getHeader('Cc') || undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      };
    } catch {
      return null;
    }
  }

  private async collectReadAttachments(
    messageId: string,
    payload: gmail_v1.Schema$MessagePart | undefined,
    out: Array<{ filename: string; mimeType: string; size: number; localPath?: string }>,
    downloadsDir: string,
  ): Promise<void> {
    if (!payload) return;
    for (const part of payload.parts ?? []) {
      if (part.filename && part.body?.attachmentId) {
        const entry: { filename: string; mimeType: string; size: number; localPath?: string } = {
          filename: part.filename,
          mimeType: part.mimeType ?? 'application/octet-stream',
          size: part.body.size ?? 0,
        };
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
        out.push(entry);
      }
      if (part.parts) {
        await this.collectReadAttachments(messageId, part, out, downloadsDir);
      }
    }
  }

  private isAuthError(msg: string): boolean {
    return msg.includes('invalid_grant') || msg.includes('Token has been expired or revoked') || msg.includes('unauthorized');
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.lastHistoryId || this.authFailed) {
      return;
    }
    if (this.processing) {
      logger.debug(SCOPE, 'Poll skipped — still processing a previous message');
      return;
    }

    try {
      logger.debug(SCOPE, `Polling Gmail history since ${this.lastHistoryId}...`);

      const response = await this.gmail.users.history.list({
        userId: 'me',
        startHistoryId: this.lastHistoryId,
        historyTypes: ['messageAdded'],
        labelId: 'INBOX',
      });

      this.consecutiveAuthFailures = 0;

      const newHistoryId = response.data.historyId;
      const histories = response.data.history ?? [];

      if (histories.length === 0) {
        logger.debug(SCOPE, `No new history events (historyId: ${this.lastHistoryId} → ${newHistoryId})`);
        if (newHistoryId) this.lastHistoryId = newHistoryId;
        return;
      }

      const messageIds = new Set<string>();
      for (const h of histories) {
        for (const added of h.messagesAdded ?? []) {
          const msg = added.message;
          if (msg?.id && msg.labelIds?.includes('INBOX') && msg.labelIds.includes('UNREAD')) {
            messageIds.add(msg.id);
          }
        }
      }

      logger.info(SCOPE, `Found ${histories.length} history events, ${messageIds.size} new unread message(s)`);

      this.processing = true;
      try {
        for (const msgId of messageIds) {
          await this.processMessage(msgId);
        }
      } finally {
        this.processing = false;
      }

      if (newHistoryId) this.lastHistoryId = newHistoryId;
    } catch (err: unknown) {
      const error = err as { code?: number; message?: string };
      const errMsg = error.message ?? String(err);

      if (this.isAuthError(errMsg)) {
        this.consecutiveAuthFailures++;
        if (this.consecutiveAuthFailures >= 3) {
          this.authFailed = true;
          logger.error(SCOPE, 'Gmail authentication failed 3 times in a row. Stopping polling. Re-authorize via web admin (Channels > Gmail > Authorize).');
          if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
          return;
        }
        logger.warn(SCOPE, `Auth error (attempt ${this.consecutiveAuthFailures}/3): ${errMsg}`);
        return;
      }

      if (error.code === 404) {
        logger.warn(SCOPE, 'History ID expired, performing full sync');
        try {
          const profile = await this.gmail.users.getProfile({ userId: 'me' });
          this.lastHistoryId = profile.data.historyId ?? null;
        } catch (resyncErr) {
          const resyncMsg = (resyncErr as Error).message;
          if (this.isAuthError(resyncMsg)) {
            this.consecutiveAuthFailures++;
            logger.error(SCOPE, `Auth error during resync: ${resyncMsg}`);
          } else {
            logger.error(SCOPE, `Full sync failed: ${resyncMsg}`);
          }
        }
      } else {
        logger.error(SCOPE, `Poll error: ${errMsg}`);
      }
    }
  }

  private async processMessage(messageId: string): Promise<void> {
    try {
      logger.info(SCOPE, `Processing message ${messageId}...`);

      const msg = await this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });

      const headers = msg.data.payload?.headers ?? [];
      const getHeader = (name: string) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

      const from = getHeader('From');
      const to = getHeader('To');
      const subject = getHeader('Subject');
      const date = getHeader('Date');
      const emailMessageId = getHeader('Message-ID') || getHeader('Message-Id');

      const fromAddress = this.extractEmail(from);

      if (fromAddress.toLowerCase() === this.userEmail.toLowerCase()) {
        logger.debug(SCOPE, `Skipping own message from ${fromAddress}: "${subject}"`);
        return;
      }

      if (this.allowedSenders && !this.allowedSenders.has(fromAddress.toLowerCase())) {
        logger.warn(SCOPE, `Rejected email from unauthorized sender ${fromAddress}: "${subject}"`);
        return;
      }

      const body = this.extractBody(msg.data.payload);
      const attachments = await this.extractAttachments(messageId, msg.data.payload);
      const historyKey = buildHistoryKey(fromAddress, subject);
      const content = `[Email received]\nFrom: ${fromAddress}\nSubject: ${subject}\nDate: ${date}\n\n${body}`;

      logger.info(SCOPE, `New email from ${fromAddress}: "${subject}" (${body.length} chars body, ${attachments.length} attachments)`);

      const event: IncomingEvent = {
        channel: 'email',
        identityId: buildIdentityId(fromAddress),
        type: 'email',
        content,
        attachments: attachments.length > 0 ? attachments : undefined,
        metadata: {
          from: fromAddress,
          to: this.extractEmail(to),
          subject,
          date,
          messageId: msg.data.id,
          emailMessageId,
          threadId: msg.data.threadId,
          historyKey,
          provider: 'gmail',
        },
        raw: msg.data,
      };

      await this.onMessage(event);

      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
      logger.info(SCOPE, `Message ${messageId} processed and marked as read`);
    } catch (err) {
      logger.error(SCOPE, `Failed to process message ${messageId}: ${(err as Error).message}`);
    }
  }

  private extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
    if (!payload) return '';

    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    }

    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64url').toString('utf-8');
        }
      }
      for (const part of payload.parts) {
        const nested = this.extractBody(part);
        if (nested) return nested;
      }
    }

    return '';
  }

  private extractEmail(headerValue: string): string {
    const match = headerValue.match(/<([^>]+)>/);
    return match ? match[1] : headerValue.trim();
  }

  private async extractAttachments(messageId: string, payload: gmail_v1.Schema$MessagePart | undefined): Promise<EventAttachment[]> {
    const attachments: EventAttachment[] = [];
    if (!payload) return attachments;

    const parts = payload.parts ?? [];
    for (const part of parts) {
      if (part.filename && part.body?.attachmentId) {
        try {
          const attData = await this.gmail.users.messages.attachments.get({
            userId: 'me',
            messageId,
            id: part.body.attachmentId,
          });

          if (attData.data.data) {
            const buffer = Buffer.from(attData.data.data, 'base64url');
            const attDir = join(this.downloadsDir, 'email');
            try { mkdirSync(attDir, { recursive: true }); } catch { /* exists */ }

            const fileName = part.filename || `${Date.now()}.bin`;
            const filePath = join(attDir, `${Date.now()}-${fileName}`);
            writeFileSync(filePath, buffer);

            const isImage = part.mimeType?.startsWith('image/') ?? false;
            attachments.push({
              type: isImage ? 'photo' : 'document',
              fileId: part.body.attachmentId,
              fileName: part.filename || undefined,
              mimeType: part.mimeType ?? undefined,
              localPath: filePath,
            });
            logger.info(SCOPE, `Saved attachment: ${filePath} (${buffer.length} bytes)`);
          }
        } catch (err) {
          logger.warn(SCOPE, `Failed to download attachment "${part.filename}": ${(err as Error).message}`);
        }
      }

      if (part.parts) {
        const nested = await this.extractAttachments(messageId, part);
        attachments.push(...nested);
      }
    }

    return attachments;
  }

  private mimeEncodeHeader(value: string): string {
    if (/^[\x20-\x7E]*$/.test(value)) return value;
    return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
  }

  private buildTextPart(text: string, contentType = 'text/plain'): string {
    const encoded = Buffer.from(text, 'utf-8').toString('base64');
    return [
      `Content-Type: ${contentType}; charset=utf-8`,
      'Content-Transfer-Encoding: base64',
      '',
      encoded,
    ].join('\r\n');
  }

  private buildRawEmail(to: string, subject: string, body: string, options?: MailSendOptions): string {
    const headerLines = [
      `From: ${this.userEmail}`,
      `To: ${to}`,
      `Subject: ${this.mimeEncodeHeader(subject)}`,
      'MIME-Version: 1.0',
    ];

    if (options?.inReplyTo) {
      headerLines.push(`In-Reply-To: ${options.inReplyTo}`);
      headerLines.push(`References: ${options.references || options.inReplyTo}`);
    }

    const hasAttachments = options?.attachments && options.attachments.length > 0;
    const hasHtml = !!options?.html;

    if (!hasAttachments && !hasHtml) {
      headerLines.push('Content-Type: text/plain; charset=utf-8');
      headerLines.push('Content-Transfer-Encoding: base64');
      const encoded = Buffer.from(body, 'utf-8').toString('base64');
      const raw = [...headerLines, '', encoded].join('\r\n');
      return Buffer.from(raw).toString('base64url');
    }

    const mixedBoundary = `mixed_${Date.now()}`;
    const altBoundary = `alt_${Date.now()}`;

    const parts: string[] = [...headerLines];

    if (hasAttachments) {
      parts.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`, '', `--${mixedBoundary}`);

      if (hasHtml) {
        parts.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`, '', `--${altBoundary}`);
        parts.push(this.buildTextPart(body), `--${altBoundary}`);
        parts.push(this.buildTextPart(options!.html!, 'text/html'), `--${altBoundary}--`);
      } else {
        parts.push(this.buildTextPart(body));
      }

      for (const att of options!.attachments!) {
        const fileData = readFileSync(att.path);
        const b64 = fileData.toString('base64');
        const mime = att.mimeType || 'application/octet-stream';
        parts.push(
          `--${mixedBoundary}`,
          `Content-Type: ${mime}; name="${this.mimeEncodeHeader(att.filename)}"`,
          `Content-Disposition: attachment; filename="${this.mimeEncodeHeader(att.filename)}"`,
          'Content-Transfer-Encoding: base64',
          '',
          b64,
        );
      }
      parts.push(`--${mixedBoundary}--`);
    } else {
      parts.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`, '');
      parts.push(`--${altBoundary}`, this.buildTextPart(body));
      parts.push(`--${altBoundary}`, this.buildTextPart(options!.html!, 'text/html'));
      parts.push(`--${altBoundary}--`);
    }

    return Buffer.from(parts.join('\r\n')).toString('base64url');
  }
}
