import crypto from 'node:crypto';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { logger } from './logger.js';

const SCOPE = 'two-factor';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface PendingChallenge {
  challenge: string;
  createdAt: number;
}

const pendingChallenges = new Map<string, PendingChallenge>();

function storeChallenge(key: string, challenge: string): void {
  pendingChallenges.set(key, { challenge, createdAt: Date.now() });
}

function consumeChallenge(key: string): string | null {
  const entry = pendingChallenges.get(key);
  if (!entry) return null;
  pendingChallenges.delete(key);
  if (Date.now() - entry.createdAt > CHALLENGE_TTL_MS) return null;
  return entry.challenge;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pendingChallenges) {
    if (now - entry.createdAt > CHALLENGE_TTL_MS) pendingChallenges.delete(key);
  }
}, 60_000).unref();

// ── TOTP ──

export interface TotpSetupResult {
  secret: string;
  uri: string;
  qrCodeDataUrl: string;
}

export function generateTotpSecret(issuer: string, accountName: string): TotpSetupResult {
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({
    issuer,
    label: accountName,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });
  const uri = totp.toString();
  return { secret: secret.base32, uri, qrCodeDataUrl: '' };
}

export async function generateTotpQrCode(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 2, width: 256 });
}

export function verifyTotpCode(base32Secret: string, code: string): boolean {
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(base32Secret),
  });
  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

// ── WebAuthn ──

export interface StoredPasskey {
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  deviceName?: string;
}

export async function generatePasskeyRegistrationOptions(
  userId: string,
  userName: string,
  rpId: string,
  rpName: string,
  existingPasskeys: StoredPasskey[] = [],
): Promise<{ options: Record<string, unknown>; challengeKey: string }> {
  const opts = await generateRegistrationOptions({
    rpName,
    rpID: rpId,
    userName,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    excludeCredentials: existingPasskeys.map(pk => ({
      id: pk.credentialId,
      transports: pk.transports,
    })),
  });
  const challengeKey = `reg:${userId}:${crypto.randomBytes(8).toString('hex')}`;
  storeChallenge(challengeKey, opts.challenge);
  return { options: opts as unknown as Record<string, unknown>, challengeKey };
}

export async function verifyPasskeyRegistration(
  credential: RegistrationResponseJSON,
  challengeKey: string,
  rpId: string,
  origin: string,
): Promise<StoredPasskey | null> {
  const expectedChallenge = consumeChallenge(challengeKey);
  if (!expectedChallenge) {
    logger.warn(SCOPE, 'Registration challenge expired or not found');
    return null;
  }
  try {
    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) return null;
    const { credential: cred, credentialDeviceType: _dt, credentialBackedUp: _bu } = verification.registrationInfo;
    return {
      credentialId: cred.id,
      publicKey: Buffer.from(cred.publicKey) as unknown as Buffer,
      counter: cred.counter,
      transports: credential.response.transports as AuthenticatorTransportFuture[] | undefined,
    };
  } catch (err) {
    logger.error(SCOPE, `WebAuthn registration verification failed: ${(err as Error).message}`);
    return null;
  }
}

export async function generatePasskeyAuthenticationOptions(
  rpId: string,
  allowCredentials: StoredPasskey[],
): Promise<{ options: Record<string, unknown>; challengeKey: string }> {
  const opts = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: allowCredentials.map(pk => ({
      id: pk.credentialId,
      transports: pk.transports,
    })),
    userVerification: 'preferred',
  });
  const challengeKey = `auth:${crypto.randomBytes(12).toString('hex')}`;
  storeChallenge(challengeKey, opts.challenge);
  return { options: opts as unknown as Record<string, unknown>, challengeKey };
}

export async function verifyPasskeyAuthentication(
  credential: AuthenticationResponseJSON,
  challengeKey: string,
  rpId: string,
  origin: string,
  storedPasskey: StoredPasskey,
): Promise<{ verified: boolean; newCounter: number }> {
  const expectedChallenge = consumeChallenge(challengeKey);
  if (!expectedChallenge) {
    logger.warn(SCOPE, 'Authentication challenge expired or not found');
    return { verified: false, newCounter: storedPasskey.counter };
  }
  try {
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: false,
      credential: {
        id: storedPasskey.credentialId,
        publicKey: new Uint8Array(storedPasskey.publicKey),
        counter: storedPasskey.counter,
        transports: storedPasskey.transports,
      },
    });
    return {
      verified: verification.verified,
      newCounter: verification.authenticationInfo?.newCounter ?? storedPasskey.counter,
    };
  } catch (err) {
    logger.error(SCOPE, `WebAuthn authentication verification failed: ${(err as Error).message}`);
    return { verified: false, newCounter: storedPasskey.counter };
  }
}

// ── Temp tokens for 2FA flow ──

interface PendingTwoFactorSession {
  userId: string;
  scope: 'admin' | 'user' | 'client';
  createdAt: number;
}

const pendingTwoFactorSessions = new Map<string, PendingTwoFactorSession>();

export function createTwoFactorTempToken(userId: string, scope: 'admin' | 'user' | 'client'): string {
  const token = crypto.randomBytes(32).toString('hex');
  pendingTwoFactorSessions.set(token, { userId, scope, createdAt: Date.now() });
  return token;
}

export function consumeTwoFactorTempToken(token: string, scope: 'admin' | 'user' | 'client'): string | null {
  const session = pendingTwoFactorSessions.get(token);
  if (!session) return null;
  pendingTwoFactorSessions.delete(token);
  if (session.scope !== scope) return null;
  if (Date.now() - session.createdAt > CHALLENGE_TTL_MS) return null;
  return session.userId;
}

export function removeTwoFactorTempToken(token: string): void {
  pendingTwoFactorSessions.delete(token);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, session] of pendingTwoFactorSessions) {
    if (now - session.createdAt > CHALLENGE_TTL_MS) pendingTwoFactorSessions.delete(key);
  }
}, 60_000).unref();
