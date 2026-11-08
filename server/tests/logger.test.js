import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileLogger } from '../src/logger.js';

function makeTmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
  return path.join(dir, 'test.log');
}

function readLog(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

describe('FileLogger', () => {
  let logPath;

  beforeEach(() => { logPath = makeTmpLog(); });
  afterEach(() => {
    try { fs.rmSync(path.dirname(logPath), { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('default level is INFO', () => {
    const logger = new FileLogger(logPath);
    logger.line('test', 'hello');
    const content = readLog(logPath);
    assert.match(content, /\[INFO\] \[test\] hello/);
  });

  it('explicit level appears in output', () => {
    const logger = new FileLogger(logPath);
    logger.line('mux', 'crash', 'ERROR');
    logger.line('wd', 'skip', 'WARN');
    logger.line('proc', 'vu meter', 'DEBUG');
    const content = readLog(logPath);
    assert.match(content, /\[ERROR\] \[mux\] crash/);
    assert.match(content, /\[WARN\] \[wd\] skip/);
    assert.match(content, /\[DEBUG\] \[proc\] vu meter/);
  });

  it('backward compat: 2-arg call defaults to INFO', () => {
    const logger = new FileLogger(logPath);
    logger.line('scope', 'msg');
    const lines = readLog(logPath).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[INFO\] \[scope\] msg/);
  });

  it('anti-spam dedup suppresses repeated DEBUG within window', () => {
    const logger = new FileLogger(logPath);
    for (let i = 0; i < 10; i++) {
      logger.line('enc', '[stderr] In: [######|######] P', 'DEBUG');
    }
    const lines = readLog(logPath).trim().split('\n');
    // Only the first should be written (rest suppressed within 5s window)
    assert.equal(lines.length, 1);
  });

  it('INFO is never deduplicated', () => {
    const logger = new FileLogger(logPath);
    for (let i = 0; i < 5; i++) {
      logger.line('mux', '--- START SEQUENCE ---');
    }
    const lines = readLog(logPath).trim().split('\n');
    assert.equal(lines.length, 5);
  });

  it('format includes ISO timestamp', () => {
    const logger = new FileLogger(logPath);
    logger.line('test', 'ts check');
    const content = readLog(logPath);
    // ISO 8601: 2024-01-01T00:00:00.000Z
    assert.match(content, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('forwards emitted lines to the optional notifier', () => {
    const notifications = [];
    const notifier = { notify: entry => notifications.push(entry) };
    const logger = new FileLogger(logPath, { notifier });
    logger.line('mux', 'encoder crashed', 'ERROR');

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, 'ERROR');
    assert.equal(notifications[0].scope, 'mux');
    assert.equal(notifications[0].message, 'encoder crashed');
  });

  it('does not let notifier failures break file logging', () => {
    const notifier = { notify: () => { throw new Error('offline'); } };
    const logger = new FileLogger(logPath, { notifier });
    assert.doesNotThrow(() => logger.line('mux', 'still logged', 'ERROR'));
    assert.match(readLog(logPath), /still logged/);
  });
});
