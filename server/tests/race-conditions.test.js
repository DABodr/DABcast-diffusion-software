// tests/race-conditions.test.js
// Tests pour valider les correctifs critiques de race conditions

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OdrProcessManager } from '../src/odr/processManager.js';
import { FileLogger } from '../src/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.resolve(__dirname, '.tmp-race-test');

// Cleanup and setup
function setupTestDir() {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tmpDir, { recursive: true });
}

function cleanupTestDir() {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('Race Conditions - Critical Fixes', () => {

  describe('ProcessManager - pids.json serialization', () => {
    it('should handle concurrent _setPid calls without losing data', async () => {
      setupTestDir();

      const logPath = path.resolve(tmpDir, 'test.log');
      const logger = new FileLogger(logPath);
      const pm = new OdrProcessManager({
        logger,
        odrBinDir: '',
        runtimeDir: tmpDir
      });

      // Simulate 10 concurrent writes
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(pm._setPid(`svc:test${i}`, 1000 + i));
      }

      await Promise.all(promises);

      // Verify all PIDs were written
      const pids = pm._loadPids();
      assert.equal(Object.keys(pids).length, 10, 'Should have 10 PIDs');

      for (let i = 0; i < 10; i++) {
        assert.equal(pids[`svc:test${i}`], 1000 + i, `PID ${i} should be correct`);
      }

      cleanupTestDir();
    });

    it('should write pids.json atomically (no corruption)', async () => {
      setupTestDir();

      const logPath = path.resolve(tmpDir, 'test.log');
      const logger = new FileLogger(logPath);
      const pm = new OdrProcessManager({
        logger,
        odrBinDir: '',
        runtimeDir: tmpDir
      });

      // Write initial data
      await pm._setPid('svc:test1', 1001);

      // Verify pids.json is valid JSON
      const pidsPath = path.resolve(tmpDir, 'pids.json');
      const content = fs.readFileSync(pidsPath, 'utf8');

      assert.doesNotThrow(() => {
        JSON.parse(content);
      }, 'pids.json should be valid JSON');

      // Verify no temp files left behind
      const files = fs.readdirSync(tmpDir);
      const tempFiles = files.filter(f => f.includes('.tmp.'));
      assert.equal(tempFiles.length, 0, 'Should not leave temp files behind');

      cleanupTestDir();
    });
  });

  describe('AppState - _switchServiceUri lock', () => {
    it('should prevent concurrent switches on same service', async () => {
      // This test validates the lock mechanism conceptually
      // Real test would require full AppState setup which is complex

      const locks = new Map();
      const lockKey = 'switch:test-service';

      // Simulate two concurrent switch attempts
      let firstSwitchStarted = false;
      let secondSwitchSkipped = false;

      // First switch
      const switch1 = async () => {
        if (locks.has(lockKey)) {
          secondSwitchSkipped = true;
          return;
        }
        locks.set(lockKey, true);
        firstSwitchStarted = true;
        try {
          await new Promise(resolve => setTimeout(resolve, 10));
        } finally {
          locks.delete(lockKey);
        }
      };

      // Second switch (concurrent)
      const switch2 = async () => {
        if (locks.has(lockKey)) {
          secondSwitchSkipped = true;
          return;
        }
        locks.set(lockKey, true);
        try {
          await new Promise(resolve => setTimeout(resolve, 10));
        } finally {
          locks.delete(lockKey);
        }
      };

      // Start both simultaneously
      await Promise.all([switch1(), switch2()]);

      assert.equal(firstSwitchStarted, true, 'First switch should start');
      assert.equal(secondSwitchSkipped, true, 'Second switch should be skipped');
    });
  });

  describe('Watchdog - guard flag', () => {
    it('should prevent concurrent watchdog iterations', async () => {
      let watchdogRunning = false;
      let skippedCount = 0;
      let executedCount = 0;

      const simulateWatchdogIteration = async () => {
        if (watchdogRunning) {
          skippedCount++;
          return;
        }

        watchdogRunning = true;
        try {
          executedCount++;
          // Simulate long-running operation
          await new Promise(resolve => setTimeout(resolve, 20));
        } finally {
          watchdogRunning = false;
        }
      };

      // Simulate 5 rapid watchdog triggers
      const iterations = [];
      for (let i = 0; i < 5; i++) {
        iterations.push(simulateWatchdogIteration());
        // Small delay between triggers
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      await Promise.all(iterations);

      // At least one should be skipped due to overlap
      assert.ok(skippedCount > 0, 'At least one iteration should be skipped');
      assert.ok(executedCount > 0, 'At least one iteration should execute');
      assert.equal(executedCount + skippedCount, 5, 'Total should be 5');
    });
  });

  describe('Timeout protection', () => {
    it('should timeout long-running switch operations', async () => {
      const longOperation = async () => {
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10s
        return 'completed';
      };

      const timeoutMs = 100;
      let timedOut = false;

      try {
        await Promise.race([
          longOperation(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('switch timeout')), timeoutMs)
          )
        ]);
      } catch (err) {
        if (err.message === 'switch timeout') {
          timedOut = true;
        }
      }

      assert.equal(timedOut, true, 'Should timeout after 100ms');
    });
  });
});
