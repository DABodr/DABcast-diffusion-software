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

  it('gain change ON AIR restarts only the encoder, on its active stream', () => {
    state._initRuntime();
    state.muxRunning = true;
    running = true;
    const calls = [];
    const prev = state._switchServiceUri;
    state._switchServiceUri = async (svc, uri) => { calls.push(uri); };
    state.serviceRuntime.get(svcId).activeUri = 'http://example.invalid/backup';
    const svc = state.preset.services[0];
    state.setService(svcId, { audio: { gainDb: svc.audio.gainDb + 1 } });
    assert.deepEqual(calls, ['http://example.invalid/backup']);
    assert.deepEqual(state.serviceRuntime.get(svcId).pendingRestart, []);
    state.setService(svcId, { identity: { pty: 5 } });   // no gain change → no encoder restart
    assert.equal(calls.length, 1);
    state._switchServiceUri = prev;
    running = false;
    state._initRuntime();   // clear the pty hint for the next test
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

describe('service input port', () => {
  let dir, state;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-port-'));
    fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
    fs.copyFileSync(demoPreset, path.join(dir, 'presets', 'demo.json'));
    state = new AppState({
      settings: structuredClone(DEFAULT_SETTINGS),
      dataDir: dir,
      logger: { line() {} },
      processManager: { isRunning: () => false },
    });
    state.muxRunning = false;
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('changes the port of a service when the mux is stopped', () => {
    const id = state.preset.services[0].id;
    const svc = state.setService(id, { network: { ediOutputTcp: { port: 9777 } } });
    assert.equal(svc.network.ediOutputTcp.port, 9777);
  });

  it('refuses a port already used by another service', () => {
    const [a, b] = state.preset.services;
    assert.throws(() => state.setService(b.id, { network: { ediOutputTcp: { port: a.network.ediOutputTcp.port } } }), /already used/);
  });

  it('refuses an out-of-range port', () => {
    const id = state.preset.services[0].id;
    assert.throws(() => state.setService(id, { network: { ediOutputTcp: { port: 80 } } }), /Invalid input port/);
  });

  it('addService uses a given port and refuses duplicates', () => {
    const svc = state.addService({ identity: { pi: 'FAF1', ps8: 'PORTA' }, input: { mode: 'EDI' }, network: { ediOutputTcp: { port: 9888 } } });
    assert.equal(svc.network.ediOutputTcp.port, 9888);
    assert.throws(() => state.addService({ identity: { pi: 'FAF2', ps8: 'PORTB' }, network: { ediOutputTcp: { port: 9888 } } }), /already used/);
  });
});

describe('duplicate input ports', () => {
  const mk = (presetMutator) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-dup-'));
    fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
    const p = JSON.parse(fs.readFileSync(demoPreset, 'utf8'));
    if (presetMutator) presetMutator(p);
    fs.writeFileSync(path.join(dir, 'presets', 'demo.json'), JSON.stringify(p));
    const state = new AppState({
      settings: structuredClone(DEFAULT_SETTINGS), dataDir: dir,
      logger: { line() {} }, processManager: { isRunning: () => false },
    });
    return { dir, state };
  };
  const ports = (st) => st.preset.services.map((s) => s.network.ediOutputTcp.port);

  it('an imported service whose port is taken gets a free port', () => {
    const { dir, state } = mk();
    const src = structuredClone(state.preset.services[0]);
    src.id = 'FA01'; src.identity.pi = 'FA01'; src.identity.serviceIdHex = '0xFA01';
    const svc = state.upsertService(src);
    assert.notEqual(svc.network.ediOutputTcp.port, state.preset.services[0].network.ediOutputTcp.port);
    assert.equal(new Set(ports(state)).size, state.preset.services.length);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an imported service keeps its port when it is free', () => {
    const { dir, state } = mk();
    const src = structuredClone(state.preset.services[0]);
    src.id = 'FA02'; src.identity.pi = 'FA02'; src.identity.serviceIdHex = '0xFA02'; src.network.ediOutputTcp.port = 9444;
    assert.equal(state.upsertService(src).network.ediOutputTcp.port, 9444);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('repairs duplicates in a saved preset at load, keeping the first in mux order', () => {
    let firstId, firstPort;
    const { dir, state } = mk((p) => {
      p.services.forEach((s, i) => { s.ui = { order: i + 1 }; });
      firstId = p.services[0].id; firstPort = p.services[0].network.ediOutputTcp.port;
      p.services[1].network.ediOutputTcp.port = firstPort;
    });
    assert.equal(new Set(ports(state)).size, state.preset.services.length);
    assert.equal(state.preset.services.find((s) => s.id === firstId).network.ediOutputTcp.port, firstPort);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'presets', 'demo.json'), 'utf8'));
    assert.equal(new Set(saved.services.map((s) => s.network.ediOutputTcp.port)).size, saved.services.length);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a preset without duplicates untouched', () => {
    const { dir, state } = mk();
    const before = JSON.parse(fs.readFileSync(demoPreset, 'utf8')).services.map((s) => s.network.ediOutputTcp.port);
    assert.deepEqual(ports(state), before);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
