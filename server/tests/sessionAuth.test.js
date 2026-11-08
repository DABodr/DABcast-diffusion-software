import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LoginAttemptLimiter,
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  createSessionToken,
  getOrCreateSessionSecret,
  makeSessionCookie,
  parseCookies,
  verifySessionToken
} from '../src/auth/sessionAuth.js';

const credentials = {
  username: 'admin',
  passwordHash: '$2b$10$example',
  secret: 'test-secret-that-is-long-enough-for-hmac-signing'
};

describe('signed authentication sessions', () => {
  it('creates and verifies a valid token', () => {
    const token = createSessionToken({ ...credentials, now: 1_000, maxAgeMs: 10_000 });
    assert.deepEqual(
      verifySessionToken(token, { ...credentials, now: 5_000 }),
      { username: 'admin', expiresAt: 11_000 }
    );
  });

  it('rejects tampered, expired, and password-invalidated tokens', () => {
    const token = createSessionToken({ ...credentials, now: 1_000, maxAgeMs: 10_000 });
    assert.equal(verifySessionToken(`${token}x`, { ...credentials, now: 2_000 }), null);
    assert.equal(verifySessionToken(token, { ...credentials, now: 11_001 }), null);
    assert.equal(verifySessionToken(token, { ...credentials, passwordHash: 'changed', now: 2_000 }), null);
  });

  it('serializes secure cookies and clears them', () => {
    const cookie = makeSessionCookie('abc', { maxAgeMs: 60_000, secure: true });
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE_NAME}=abc`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Max-Age=60/);
    assert.match(cookie, /Secure/);
    assert.match(clearSessionCookie(), /Max-Age=0/);
  });

  it('parses encoded cookie values', () => {
    assert.deepEqual(parseCookies('a=one; dabcast_session=x%2Ey'), {
      a: 'one',
      dabcast_session: 'x.y'
    });
  });
});

describe('session secret persistence', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-session-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('creates a private secret once and reuses it', () => {
    const secretPath = path.join(dir, '.auth-secret');
    const first = getOrCreateSessionSecret(secretPath);
    const second = getOrCreateSessionSecret(secretPath);
    assert.equal(first, second);
    assert.ok(first.length >= 43);
    assert.equal(fs.statSync(secretPath).mode & 0o777, 0o600);
  });
});

describe('login attempt limiter', () => {
  it('blocks after repeated failures and resets after the window', () => {
    const limiter = new LoginAttemptLimiter({ maxAttempts: 3, windowMs: 10_000 });
    limiter.recordFailure('client', 1_000);
    limiter.recordFailure('client', 2_000);
    assert.equal(limiter.check('client', 2_000).allowed, true);
    limiter.recordFailure('client', 3_000);
    assert.equal(limiter.check('client', 3_000).allowed, false);
    assert.equal(limiter.check('client', 11_001).allowed, true);
  });

  it('clears failures after a successful login', () => {
    const limiter = new LoginAttemptLimiter({ maxAttempts: 1 });
    limiter.recordFailure('client', 1_000);
    assert.equal(limiter.check('client', 1_000).allowed, false);
    limiter.recordSuccess('client');
    assert.equal(limiter.check('client', 1_000).allowed, true);
  });
});
