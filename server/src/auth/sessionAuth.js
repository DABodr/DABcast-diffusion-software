import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SESSION_COOKIE_NAME = 'dabcast_session';
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const REMEMBERED_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function passwordVersion(passwordHash) {
  return crypto.createHash('sha256').update(String(passwordHash)).digest('base64url').slice(0, 22);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function getOrCreateSessionSecret(secretPath) {
  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (existing.length >= 43) {
      fs.chmodSync(secretPath, 0o600);
      return existing;
    }
  } catch { /* create below */ }

  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  const secret = crypto.randomBytes(48).toString('base64url');
  const tmpPath = `${secretPath}.tmp`;
  fs.writeFileSync(tmpPath, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, secretPath);
  fs.chmodSync(secretPath, 0o600);
  return secret;
}

export function createSessionToken({
  username,
  passwordHash,
  secret,
  now = Date.now(),
  maxAgeMs = SESSION_MAX_AGE_MS
}) {
  const payload = Buffer.from(JSON.stringify({
    u: String(username),
    iat: now,
    exp: now + maxAgeMs,
    v: passwordVersion(passwordHash)
  })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token, {
  username,
  passwordHash,
  secret,
  now = Date.now()
}) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const [payload, signature] = parts;
  if (!safeEqual(signature, sign(payload, secret))) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded.u !== 'string' || !Number.isFinite(decoded.exp)) return null;
    if (decoded.exp <= now || decoded.iat > now + 60_000) return null;
    if (decoded.u !== String(username)) return null;
    if (!safeEqual(decoded.v, passwordVersion(passwordHash))) return null;
    return { username: decoded.u, expiresAt: decoded.exp };
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = value; }
  }
  return cookies;
}

export function makeSessionCookie(token, { maxAgeMs, secure = false } = {}) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict'
  ];
  if (Number.isFinite(maxAgeMs)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie({ secure = false } = {}) {
  return makeSessionCookie('', { maxAgeMs: 0, secure });
}

export class LoginAttemptLimiter {
  constructor({ maxAttempts = 5, windowMs = 15 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.entries = new Map();
  }

  check(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      if (entry) this.entries.delete(key);
      return { allowed: true, retryAfterSec: 0 };
    }
    if (entry.attempts < this.maxAttempts) return { allowed: true, retryAfterSec: 0 };
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }

  recordFailure(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      this.entries.set(key, { attempts: 1, resetAt: now + this.windowMs });
      return;
    }
    entry.attempts += 1;
  }

  recordSuccess(key) {
    this.entries.delete(key);
  }
}
