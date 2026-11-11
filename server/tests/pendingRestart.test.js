// Tests for rt.pendingRestart: ON AIR edits saved but not applied until next restart (UI hint only)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppState } from '../src/appState.js';
import { DEFAULT_SETTINGS } from '../src/defaults.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demoPreset = path.resolve(__dirname, '../../data/presets/demo.json');

describe('setService — pendingRestart hint', () => {
  let dir, state, svcId, running;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-pending-'));
    fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
    fs.copyFileSync(demoPreset, path.join(dir, 'presets', 'demo.json'));
    running = false;
    state = new AppState({
      settings: structuredClone(DEFAULT_SETTINGS),
      dataDir: dir,
      logger: { line() {} },
      processManager: { isRunning: () => running },
    });
    svcId = state.preset.services[0].id;
    state._switchServiceUri = async () => {}; // never spawn anything in tests
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is not set when the mux is stopped', () => {
    state.muxRunning = false;
    state.setService(svcId, { audio: { gainDb: 3 } });
    assert.equal(state.serviceRuntime.get(svcId).pendingRestart, undefined);
  });

  it('lists gain changed ON AIR, and clears it when reverted', () => {
    state._initRuntime();
    state.muxRunning = true;
    const orig = state.preset.services[0].audio.gainDb;
    state.setService(svcId, { audio: { gainDb: orig + 2 } });
    assert.deepEqual(state.serviceRuntime.get(svcId).pendingRestart, ['gainDb']);
    state.setService(svcId, { audio: { gainDb: orig } });
    assert.deepEqual(state.serviceRuntime.get(svcId).pendingRestart, []);
  });

  it('encoder restart (URI change) applies encoder-level fields', () => {
    state._initRuntime();
    state.muxRunning = true;
    running = true;
    const svc = state.preset.services[0];
    state.setService(svcId, { audio: { gainDb: svc.audio.gainDb + 1 }, input: { uri: 'http://example.invalid/new' } });
    assert.deepEqual(state.serviceRuntime.get(svcId).pendingRestart, []);
    running = false;
  });

  it('is cleared by _initRuntime (mux Start)', () => {
    state.muxRunning = true;
    state.setService(svcId, { input: { encoderBufferMs: 555 } });
    assert.deepEqual(state.serviceRuntime.get(svcId).pendingRestart, ['encoderBufferMs']);
    state._initRuntime();
    assert.equal(state.serviceRuntime.get(svcId).pendingRestart, undefined);
  });
});
