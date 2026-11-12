// Tests for `dabcast --reset-password`
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { resetPassword, resolveDataDir } from '../src/resetPassword.js';

describe('reset password', () => {
  it('sets the factory password (hashed), forces a change, keeps the other settings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-reset-'));
    const p = path.join(dir, 'settings.json');
    fs.writeFileSync(p, JSON.stringify({ autoStart: true, auth: { username: 'boss', password: '$2b$10$oldhash', mustChangePassword: false } }));
    const msg = resetPassword(dir);
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(s.auth.username, 'boss', 'username kept');
    assert.ok(bcrypt.compareSync('dabcast', s.auth.password));
    assert.equal(s.auth.mustChangePassword, true);
    assert.equal(s.autoStart, true);
    assert.match(msg, /systemctl restart dabcast/);
    resetPassword(dir, 'newuser');
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).auth.username, 'newuser');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('missing settings.json: clear error', () => {
    assert.throws(() => resetPassword(path.join(os.tmpdir(), 'dabcast-nope-' + Date.now())), /settings\.json not found/);
  });

  it('data dir: environment, then /etc/default/dabcast, then /var/lib/dabcast (installed) or the dev path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-def-'));
    const def = path.join(dir, 'dabcast');
    fs.writeFileSync(def, '#DABCAST_DATA_DIR=/commented\nDABCAST_DATA_DIR="/srv/dab"\n');
    assert.equal(resolveDataDir('/dev/data', { env: { DABCAST_DATA_DIR: '/env/dir' }, defaultsFile: def }), '/env/dir');
    assert.equal(resolveDataDir('/dev/data', { env: {}, defaultsFile: def }), '/srv/dab');
    const none = path.join(dir, 'none');
    assert.equal(resolveDataDir('/dev/data', { env: {}, defaultsFile: none }), '/var/lib/dabcast');
    assert.equal(resolveDataDir('/dev/data', { env: {}, defaultsFile: none, installed: false }), '/dev/data');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
