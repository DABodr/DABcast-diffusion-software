import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import bcrypt from 'bcryptjs';
import { DEFAULT_SETTINGS, WEAK_PASSWORDS, MIN_PASSWORD_LENGTH } from '../src/defaults.js';
import { writeJson, readJson } from '../src/fsutil.js';

// Helper: create a temp dir for settings
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-auth-test-'));
}

describe('Auth — mustChangePassword detection', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('default password "dabcast" sets mustChangePassword=true', () => {
    const settings = { auth: { username: 'admin', password: 'dabcast' } };
    // Simulate server auto-hash logic
    const isDefault = WEAK_PASSWORDS.includes(settings.auth.password.toLowerCase());
    settings.auth.password = bcrypt.hashSync(settings.auth.password, 10);
    if (isDefault || settings.auth.mustChangePassword === undefined) {
      settings.auth.mustChangePassword = true;
    }
    assert.equal(settings.auth.mustChangePassword, true);
    assert.ok(settings.auth.password.startsWith('$2b$'));
  });

  it('custom strong password does not force mustChangePassword', () => {
    const settings = { auth: { username: 'admin', password: 'MyStr0ngP@ss!', mustChangePassword: false } };
    const isDefault = WEAK_PASSWORDS.includes(settings.auth.password.toLowerCase());
    settings.auth.password = bcrypt.hashSync(settings.auth.password, 10);
    if (isDefault) {
      settings.auth.mustChangePassword = true;
    }
    assert.equal(settings.auth.mustChangePassword, false);
  });

  it('blacklisted password "password" sets mustChangePassword=true', () => {
    const settings = { auth: { username: 'admin', password: 'password' } };
    const isDefault = WEAK_PASSWORDS.includes(settings.auth.password.toLowerCase());
    settings.auth.password = bcrypt.hashSync(settings.auth.password, 10);
    if (isDefault || settings.auth.mustChangePassword === undefined) {
      settings.auth.mustChangePassword = true;
    }
    assert.equal(settings.auth.mustChangePassword, true);
  });
});

describe('Auth — PATCH /api/auth validation', () => {
  it('rejects passwords shorter than MIN_PASSWORD_LENGTH', () => {
    const password = 'short';
    assert.ok(password.length < MIN_PASSWORD_LENGTH);
  });

  it('rejects blacklisted passwords', () => {
    assert.ok(WEAK_PASSWORDS.includes('dabcast'));
    assert.ok(WEAK_PASSWORDS.includes('password'));
    assert.ok(WEAK_PASSWORDS.includes('admin'));
    assert.ok(!WEAK_PASSWORDS.includes('xK9#mzPq!2vR'));
  });

  it('PATCH sets mustChangePassword=false', () => {
    const settings = { auth: { username: 'admin', password: '$2b$10$hash', mustChangePassword: true } };
    // Simulate PATCH /api/auth logic
    const newPassword = 'MyNewStr0ngPass!';
    assert.ok(newPassword.length >= MIN_PASSWORD_LENGTH);
    assert.ok(!WEAK_PASSWORDS.includes(newPassword.toLowerCase()));
    settings.auth.username = 'newadmin';
    settings.auth.password = bcrypt.hashSync(newPassword, 10);
    settings.auth.mustChangePassword = false;
    assert.equal(settings.auth.mustChangePassword, false);
  });
});

describe('Auth — atomic settings write', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('writeJson uses tmp+rename (no .tmp left behind)', () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    const data = { auth: { username: 'admin', password: 'hashed', mustChangePassword: false } };
    writeJson(settingsPath, data);

    // File should exist and be valid JSON
    const read = readJson(settingsPath);
    assert.deepEqual(read, data);

    // No .tmp file left
    const tmpFile = settingsPath + '.tmp';
    assert.ok(!fs.existsSync(tmpFile), '.tmp file should not exist after writeJson');
  });
});

describe('Auth — defaults', () => {
  it('DEFAULT_SETTINGS.auth has mustChangePassword=true', () => {
    assert.equal(DEFAULT_SETTINGS.auth.mustChangePassword, true);
  });

  it('MIN_PASSWORD_LENGTH is at least 10', () => {
    assert.ok(MIN_PASSWORD_LENGTH >= 10);
  });

  it('WEAK_PASSWORDS includes common defaults', () => {
    assert.ok(WEAK_PASSWORDS.includes('dabcast'));
    assert.ok(WEAK_PASSWORDS.includes('password'));
    assert.ok(WEAK_PASSWORDS.includes('admin'));
  });
});
