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

describe('addService — ON AIR', () => {
  let dir, state;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-add-'));
    fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
    fs.copyFileSync(demoPreset, path.join(dir, 'presets', 'demo.json'));
    state = new AppState({
      settings: structuredClone(DEFAULT_SETTINGS),
      dataDir: dir,
      logger: { line() {} },
      processManager: { isRunning: () => false },
    });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('adds the service OFF while ON AIR', () => {
    state.muxRunning = true;
    const svc = state.addService({ identity: { pi: 'FAB1', ps8: 'NEWONE' } });
    assert.equal(svc.enabled, false);
    assert.equal(state.serviceRuntime.get(svc.id).status, 'STOPPED');
  });

  it('adds the service ON when the mux is stopped', () => {
    state.muxRunning = false;
    const svc = state.addService({ identity: { pi: 'FAB2', ps8: 'NEWTWO' } });
    assert.equal(svc.enabled, true);
  });
});

describe('deleteService — ON AIR', () => {
  let dir, state, running;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-del-'));
    fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
    fs.copyFileSync(demoPreset, path.join(dir, 'presets', 'demo.json'));
    running = false;
    state = new AppState({
      settings: structuredClone(DEFAULT_SETTINGS),
      dataDir: dir,
      logger: { line() {} },
      processManager: { isRunning: () => running },
    });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('refuses to delete an ON service while ON AIR', () => {
    state.muxRunning = true;
    const id = state.preset.services[0].id;
    assert.throws(() => state.deleteService(id), /turn it OFF first/);
    assert.ok(state.preset.services.some((s) => s.id === id));
  });

  it('deletes an OFF service while ON AIR', () => {
    state.muxRunning = true;
    const svc = state.addService({ identity: { pi: 'FAD1', ps8: 'DELME' } });
    assert.equal(svc.enabled, false);
    state.deleteService(svc.id);
    assert.ok(!state.preset.services.some((s) => s.id === svc.id));
  });

  it('refuses an OFF service whose encoder is still running', () => {
    state.muxRunning = true;
    const svc = state.addService({ identity: { pi: 'FAD2', ps8: 'DELME2' } });
    running = true;
    assert.throws(() => state.deleteService(svc.id), /turn it OFF first/);
    running = false;
  });

  it('deletes any service when the mux is stopped', () => {
    state.muxRunning = false;
    const id = state.preset.services[0].id;
    state.deleteService(id);
    assert.ok(!state.preset.services.some((s) => s.id === id));
  });
});

describe('upsertService (import) — ON AIR', () => {
  let dir, state;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-imp-'));
    fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
    fs.copyFileSync(demoPreset, path.join(dir, 'presets', 'demo.json'));
    state = new AppState({
      settings: structuredClone(DEFAULT_SETTINGS),
      dataDir: dir,
      logger: { line() {} },
      processManager: { isRunning: () => false },
    });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('imports a new service OFF while ON AIR, even if the file says enabled', () => {
    state.muxRunning = true;
    const src = structuredClone(state.preset.services[0]);
    src.id = 'FAE1'; src.identity.pi = 'FAE1'; src.identity.serviceIdHex = '0xFAE1'; src.enabled = true;
    const svc = state.upsertService(src);
    assert.equal(svc.enabled, false);
  });

  it('refuses to replace an ON service while ON AIR', () => {
    state.muxRunning = true;
    const src = structuredClone(state.preset.services[0]);
    assert.notEqual(src.enabled, false);
    assert.throws(() => state.upsertService(src), /turn it OFF first/);
  });

  it('keeps the enabled flag from the file when the mux is stopped', () => {
    state.muxRunning = false;
    const src = structuredClone(state.preset.services[0]);
    src.id = 'FAE2'; src.identity.pi = 'FAE2'; src.identity.serviceIdHex = '0xFAE2'; src.enabled = true;
    assert.equal(state.upsertService(src).enabled, true);
  });
});
