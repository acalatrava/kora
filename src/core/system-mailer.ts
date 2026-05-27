import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { logger } from './logger.js';

const SCOPE = 'SystemMailer';

export interface SystemMailerConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure?: boolean;
}

/**
 * Lightweight SMTP mailer for transactional system emails
 * (email verification, password reset, notifications).
 * Separate from the agent's email channel.
 */
export class SystemMailer {
  private transporter: Transporter;
  private fromAddress: string;

  constructor(config: SystemMailerConfig) {
    this.fromAddress = config.from;
    if (!config.user || !config.pass) {
      this.transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure ?? config.port === 465,
      });
    } else {
      this.transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure ?? config.port === 465,
        auth: { user: config.user, pass: config.pass },
      });
    }
    logger.info(SCOPE, `Initialized with sender ${config.from} via ${config.host}:${config.port}`);
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      logger.info(SCOPE, 'SMTP connection verified');
      return true;
    } catch (err) {
      logger.error(SCOPE, `SMTP verification failed: ${(err as Error).message}`);
      return false;
    }
  }

  async send(to: string, subject: string, text: string, html?: string): Promise<void> {
    await this.transporter.sendMail({
      from: this.fromAddress,
      to,
      subject,
      text,
      html,
    });
    logger.debug(SCOPE, `Sent transactional email to ${to}: ${subject}`);
  }

  async sendVerificationCode(to: string, code: string, appName = 'Kora'): Promise<void> {
    const subject = `${appName} — Email Verification Code`;
    const text = [
      `Your verification code is: ${code}`,
      '',
      'Enter this code in the registration form to complete your account setup.',
      '',
      'This code expires in 15 minutes.',
      '',
      `— ${appName}`,
    ].join('\n');
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="margin-bottom:16px">${appName} — Email Verification</h2>
        <p>Your verification code is:</p>
        <div style="font-size:32px;font-weight:bold;letter-spacing:6px;text-align:center;padding:16px;background:#f0f0f0;border-radius:8px;margin:16px 0">${code}</div>
        <p style="color:#666;font-size:13px">This code expires in 15 minutes.</p>
      </div>`;
    await this.send(to, subject, text, html);
  }

  async sendPasswordResetCode(to: string, code: string, appName = 'Kora'): Promise<void> {
    const subject = `${appName} — Password Reset Code`;
    const text = [
      `Your password reset code is: ${code}`,
      '',
      'Enter this code on the password reset page to set a new password.',
      '',
      'If you did not request this, you can safely ignore this email.',
      '',
      'This code expires in 15 minutes.',
      '',
      `— ${appName}`,
    ].join('\n');
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="margin-bottom:16px">${appName} — Password Reset</h2>
        <p>Your password reset code is:</p>
        <div style="font-size:32px;font-weight:bold;letter-spacing:6px;text-align:center;padding:16px;background:#f0f0f0;border-radius:8px;margin:16px 0">${code}</div>
        <p style="color:#666;font-size:13px">If you did not request this, ignore this email. Code expires in 15 minutes.</p>
      </div>`;
    await this.send(to, subject, text, html);
  }

  close(): void {
    this.transporter.close();
  }

  static fromEnv(): SystemMailer | null {
    const host = process.env.SYSTEM_SMTP_HOST;
    const user = process.env.SYSTEM_SMTP_USER;
    const pass = process.env.SYSTEM_SMTP_PASS;
    if (!host) return null;
    return new SystemMailer({
      host,
      port: parseInt(process.env.SYSTEM_SMTP_PORT || '587', 10),
      user: user || '',
      pass: pass || '',
      from: process.env.SYSTEM_SMTP_FROM || user || 'kora',
      secure: process.env.SYSTEM_SMTP_SECURE === 'true',
    });
  }

  static fromConfigFile(storagePath: string): SystemMailer | null {
    const filePath = path.join(storagePath, 'config', 'system-smtp.json');
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const j = JSON.parse(raw) as { host?: string; port?: number; user?: string; pass?: string; from?: string; secure?: boolean };
      if (!j.host || !j.user || !j.pass) return null;
      return new SystemMailer({
        host: j.host,
        port: j.port ?? 587,
        user: j.user,
        pass: j.pass,
        from: j.from || j.user,
        secure: j.secure === true,
      });
    } catch (err) {
      logger.warn(SCOPE, `Invalid system-smtp.json: ${(err as Error).message}`);
      return null;
    }
  }

  static resolve(storagePath: string): SystemMailer | null {
    return SystemMailer.fromEnv() ?? SystemMailer.fromConfigFile(storagePath);
  }
}
