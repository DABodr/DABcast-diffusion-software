import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OdrProcessManager } from '../src/odr/processManager.js';

// Minimal logger for tests
const nullLogger = { line() {} };

function makePm(runtimeDir) {
  return new OdrProcessManager({
    logger: nullLogger,
    odrBinDir: '',
    runtimeDir
  });
}

describe('OdrProcessManager._isOdrProcess', () => {
  it('returns false for non-existent PID', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
    const pm = makePm(tmp);
    // PID 999999999 should not exist
    assert.equal(pm._isOdrProcess(999999999), false);
    fs.rmSync(tmp, { recursive: true });
  });

  it('returns false for current process (node, not odr)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
    const pm = makePm(tmp);
    // Current process is node, not odr-*
    assert.equal(pm._isOdrProcess(process.pid), false);
    fs.rmSync(tmp, { recursive: true });
  });
});

describe('OdrProcessManager.cleanupOrphans', () => {
  it('does not kill processes with non-ODR cmdline', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
    const pm = makePm(tmp);

    // Write current process PID as stale (it's node, not odr)
    const pidsPath = path.join(tmp, 'pids.json');
    fs.writeFileSync(pidsPath, JSON.stringify({ 'test:node': process.pid }));

    // cleanupOrphans should NOT kill current process
    pm.cleanupOrphans();

    // We're still alive (the test is running)
    assert.ok(true, 'current process survived cleanupOrphans');

    // Pids file should be cleared
    const after = JSON.parse(fs.readFileSync(pidsPath, 'utf8'));
    assert.deepEqual(after, {});

    fs.rmSync(tmp, { recursive: true });
  });

  it('clears stale pids of dead processes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
    const pm = makePm(tmp);

    // Write a definitely-dead PID
    const pidsPath = path.join(tmp, 'pids.json');
    fs.writeFileSync(pidsPath, JSON.stringify({ 'test:dead': 999999999 }));

    pm.cleanupOrphans();

    const after = JSON.parse(fs.readFileSync(pidsPath, 'utf8'));
    assert.deepEqual(after, {});

    fs.rmSync(tmp, { recursive: true });
  });
});

describe('OdrProcessManager.stop (idempotent)', () => {
  it('stop on unknown key does not throw', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
    const pm = makePm(tmp);
    // Should not throw
    await pm.stop('nonexistent:key');
    assert.ok(true);
    fs.rmSync(tmp, { recursive: true });
  });
});

describe('OdrProcessManager.isRunning', () => {
  it('returns false for unknown key', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
    const pm = makePm(tmp);
    assert.equal(pm.isRunning('foo'), false);
    fs.rmSync(tmp, { recursive: true });
  });
});
