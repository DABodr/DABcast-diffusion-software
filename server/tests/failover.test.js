// tests/failover.test.js
// Tests pour la logique de failover watchdog (crash counting + transition-based detection)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Replicate the failover constants from appState.js
const FAILOVER_CRASH_THRESHOLD = 1;
const FAILOVER_STABLE_MS = 30000;

// Minimal rt (serviceRuntime) factory
function makeRt(overrides = {}) {
  return {
    status: 'RUNNING',
    activeUri: 'http://main.stream/audio',
    consecutiveCrashes: 0,
    lastStartMs: Date.now(),
    lastDeathMs: 0,
    encWasAlive: true,
    lastSwitchMs: 0,
    ...overrides
  };
}

// Simulate one watchdog tick's crash-detection + failover decision logic
// Returns { action, targetUri } where action is 'restart'|'switch'|'none'|'stable_reset'
function simulateTick(rt, { encAlive, okMain, okBackup, mainUri, backupUri, now }) {
  const hasDistinctBackup = backupUri && backupUri !== mainUri;

  // --- Crash detection (transition-based) ---
  if (!encAlive && rt.encWasAlive) {
    rt.consecutiveCrashes = (rt.consecutiveCrashes || 0) + 1;
    rt.lastDeathMs = now;
    rt.status = 'ERROR';
  }
  rt.encWasAlive = encAlive;

  // --- Encoder dead ---
  if (!encAlive) {
    const crashes = rt.consecutiveCrashes || 0;
    const activeIsMainUri = (rt.activeUri || mainUri) === mainUri;

    if (crashes >= FAILOVER_CRASH_THRESHOLD && hasDistinctBackup) {
      const targetUri = activeIsMainUri ? backupUri : mainUri;
      const targetOk = activeIsMainUri ? okBackup : okMain;

      if (targetOk) {
        rt.consecutiveCrashes = 0;
        rt.activeUri = targetUri;
        rt.lastStartMs = now;
        rt.encWasAlive = true;
        rt.status = 'RUNNING';
        return { action: 'switch', targetUri };
      } else {
        // Target unreachable, restart on same
        rt.lastStartMs = now;
        rt.encWasAlive = true;
        rt.status = 'RUNNING';
        return { action: 'restart', targetUri: rt.activeUri };
      }
    } else if (crashes >= FAILOVER_CRASH_THRESHOLD && !hasDistinctBackup) {
      rt.lastStartMs = now;
      rt.encWasAlive = true;
      rt.status = 'RUNNING';
      return { action: 'restart', targetUri: rt.activeUri };
    } else {
      // Under threshold, restart on current
      rt.lastStartMs = now;
      rt.encWasAlive = true;
      rt.status = 'RUNNING';
      return { action: 'restart', targetUri: rt.activeUri };
    }
  }

  // --- Encoder alive ---
  if (rt.consecutiveCrashes > 0 && rt.lastStartMs) {
    const upMs = now - rt.lastStartMs;
    if (upMs >= FAILOVER_STABLE_MS) {
      rt.consecutiveCrashes = 0;
      return { action: 'stable_reset', targetUri: null };
    }
  }
  return { action: 'none', targetUri: null };
}

describe('Failover — transition-based crash counting', () => {

  it('crash #1: alive→dead transition increments counter and triggers switch (threshold=1)', () => {
    const rt = makeRt({ encWasAlive: true, activeUri: 'http://main' });
    const result = simulateTick(rt, {
      encAlive: false, okMain: true, okBackup: true,
      mainUri: 'http://main', backupUri: 'http://backup',
      now: Date.now()
    });
    // threshold=1: first crash immediately triggers switch to backup
    assert.equal(result.action, 'switch', 'threshold=1: first crash triggers switch');
    assert.equal(result.targetUri, 'http://backup');
    assert.equal(rt.consecutiveCrashes, 0, 'counter reset after switch');
  });

  it('dead→dead does NOT increment counter (same crash, not a transition)', () => {
    const rt = makeRt({ encWasAlive: false, consecutiveCrashes: 1, status: 'ERROR' });
    const result = simulateTick(rt, {
      encAlive: false, okMain: true, okBackup: true,
      mainUri: 'http://main', backupUri: 'http://backup',
      now: Date.now()
    });
    // Still 1 crash (not incremented because encWasAlive was already false)
    // threshold=1: crashes=1 >= threshold → switch
    assert.equal(result.action, 'switch');
    assert.equal(rt.consecutiveCrashes, 0, 'counter reset after switch');
    assert.equal(rt.encWasAlive, true);
  });

  it('full scenario: 1 crash triggers switch immediately (threshold=1)', () => {
    const mainUri = 'http://main.stream/audio';
    const backupUri = 'http://backup.stream/audio';
    const rt = makeRt({ activeUri: mainUri });

    const now = Date.now();

    // Tick 1: encoder dies (alive→dead) — threshold=1 → immediate switch
    const res1 = simulateTick(rt, { encAlive: false, okMain: true, okBackup: true, mainUri, backupUri, now });

    assert.equal(res1.action, 'switch', 'Should switch to backup after 1 crash');
    assert.equal(res1.targetUri, backupUri, 'Target should be backup URI');
    assert.equal(rt.consecutiveCrashes, 0, 'Counter reset after switch');
    assert.equal(rt.activeUri, backupUri, 'Active URI updated to backup');
  });

  it('encoder alive for >STABLE_MS resets crash counter', () => {
    const rt = makeRt({
      consecutiveCrashes: 2,
      lastStartMs: Date.now() - FAILOVER_STABLE_MS - 1000 // started 31s ago
    });

    const result = simulateTick(rt, {
      encAlive: true, okMain: true, okBackup: true,
      mainUri: 'http://main', backupUri: 'http://backup',
      now: Date.now()
    });

    assert.equal(result.action, 'stable_reset');
    assert.equal(rt.consecutiveCrashes, 0, 'Counter reset after stable period');
  });

  it('encoder alive for <STABLE_MS does NOT reset crash counter', () => {
    const now = Date.now();
    const rt = makeRt({
      consecutiveCrashes: 2,
      lastStartMs: now - 5000 // only 5s ago
    });

    const result = simulateTick(rt, {
      encAlive: true, okMain: true, okBackup: true,
      mainUri: 'http://main', backupUri: 'http://backup',
      now
    });

    assert.equal(result.action, 'none');
    assert.equal(rt.consecutiveCrashes, 2, 'Counter preserved (not stable yet)');
  });

  it('identical main/backup URIs: never switches, just restarts', () => {
    const sameUri = 'http://same.stream/audio';
    const rt = makeRt({ activeUri: sameUri, consecutiveCrashes: 5 });

    const result = simulateTick(rt, {
      encAlive: false, okMain: true, okBackup: true,
      mainUri: sameUri, backupUri: sameUri,
      now: Date.now()
    });

    assert.equal(result.action, 'restart', 'Should restart, not switch');
    assert.equal(rt.activeUri, sameUri, 'Active URI unchanged');
  });

  it('no backup URI: restarts even at threshold', () => {
    const rt = makeRt({ consecutiveCrashes: 5 });

    const result = simulateTick(rt, {
      encAlive: false, okMain: true, okBackup: false,
      mainUri: 'http://main', backupUri: null,
      now: Date.now()
    });

    assert.equal(result.action, 'restart');
  });

  it('backup unreachable at threshold: restart on current URI', () => {
    const mainUri = 'http://main.stream/audio';
    const backupUri = 'http://backup.stream/audio';
    const rt = makeRt({ consecutiveCrashes: 3, activeUri: mainUri, encWasAlive: false });

    const result = simulateTick(rt, {
      encAlive: false, okMain: true, okBackup: false,
      mainUri, backupUri,
      now: Date.now()
    });

    assert.equal(result.action, 'restart', 'Should restart since backup unreachable');
    assert.equal(rt.activeUri, mainUri, 'Stay on current URI');
  });

  it('on backup + threshold: switches BACK to main', () => {
    const mainUri = 'http://main.stream/audio';
    const backupUri = 'http://backup.stream/audio';
    const rt = makeRt({
      activeUri: backupUri,
      consecutiveCrashes: 3,
      encWasAlive: false  // already dead
    });

    // encWasAlive=false → no transition → no increment → stays at 3
    const result = simulateTick(rt, {
      encAlive: false, okMain: true, okBackup: false,
      mainUri, backupUri,
      now: Date.now()
    });

    assert.equal(result.action, 'switch', 'Should switch back to main');
    assert.equal(result.targetUri, mainUri, 'Target should be main');
  });
});
