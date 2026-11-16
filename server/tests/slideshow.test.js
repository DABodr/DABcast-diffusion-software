// Tests for the per-service "Slideshow" setting (pad.sls.enabled):
// disabled = no image on air (empty mot/<PI>/air, odr-padenc sends DLS / DL+ only)
// and no userapp "slideshow" in the .mux (receivers are not told to expect slides).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppState } from '../src/appState.js';
import { DEFAULT_SETTINGS } from '../src/defaults.js';
import { buildMuxConfig } from '../src/odr/muxBuilder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demoPreset = path.resolve(__dirname, 'fixtures/preset-7-services.json');

describe('Slideshow disabled (pad.sls.enabled === false)', () => {
  let dir, state, svc, slideDir, airDir;
  const air = () => fs.readdirSync(airDir).sort();

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-sls-'));
    fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
    fs.copyFileSync(demoPreset, path.join(dir, 'presets', 'demo.json'));
    state = new AppState({
      settings: structuredClone(DEFAULT_SETTINGS),
      dataDir: dir,
      logger: { line() {} },
      processManager: { isRunning: () => false },
    });
    state._initRuntime();
    svc = state.preset.services[0];
    const mot = state._resolveMotDir(svc);
    slideDir = path.resolve(mot, svc.pad?.slideDir || 'slide');
    airDir = path.resolve(mot, 'air');
    fs.mkdirSync(slideDir, { recursive: true });
    fs.writeFileSync(path.join(slideDir, 'logo.jpg'), Buffer.alloc(5000, 7));
    fs.writeFileSync(path.join(slideDir, 'cover.jpg'), Buffer.alloc(9000, 7));
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('old presets (no field) keep the slideshow on', () => {
    assert.notEqual(svc.pad?.sls?.enabled, false);
    state._syncAirSlides(svc);
    assert.deepEqual(air(), ['cover.jpg']);
  });

  it('disabled: air dir emptied, slide/ untouched, airSlides empty', () => {
    svc.pad.sls.enabled = false;
    assert.equal(state._syncAirSlides(svc), airDir);
    assert.deepEqual(air(), []);
    assert.deepEqual(state.serviceRuntime.get(svc.id).airSlides, []);
    assert.deepEqual(fs.readdirSync(slideDir).sort(), ['cover.jpg', 'logo.jpg'], 'slide/ stays the source of truth');
  });

  it('enabled again: the slides come back on air', () => {
    svc.pad.sls.enabled = true;
    state._syncAirSlides(svc);
    assert.deepEqual(air(), ['cover.jpg']);
  });

  it('setService saves it when the mux is stopped', () => {
    state.muxRunning = false;
    const out = state.setService(svc.id, { pad: { sls: { enabled: false } } });
    assert.equal(out.pad.sls.enabled, false);
    assert.equal(out.pad.fifoName, svc.pad.fifoName, 'other pad fields kept');
    state.setService(svc.id, { pad: { sls: { enabled: true } } });
  });

  it('setService ignores it ON AIR (the .mux must be regenerated: Stop → save → Start)', () => {
    state.muxRunning = true;
    try {
      const out = state.setService(svc.id, { pad: { sls: { enabled: false } } });
      assert.notEqual(out.pad.sls.enabled, false);
    } finally {
      state.muxRunning = false;
    }
  });

  it('addService honours it for a new service', () => {
    const created = state.addService({ identity: { pi: 'ABCD', ps8: 'NOSLS' }, dab: { bitrateKbps: 88 }, pad: { sls: { enabled: false } } });
    assert.equal(created.pad.sls.enabled, false);
    const other = state.addService({ identity: { pi: 'ABCE', ps8: 'WITHSLS' }, dab: { bitrateKbps: 88 } });
    assert.equal(other.pad.sls.enabled, true, 'default stays on');
  });

  it('the .mux announces the slideshow only when enabled', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const on = buildMuxConfig({ settings, preset: { services: [{ ...structuredClone(svc), pad: { ...svc.pad, sls: { enabled: true } } }] } });
    const off = buildMuxConfig({ settings, preset: { services: [{ ...structuredClone(svc), pad: { ...svc.pad, sls: { enabled: false } } }] } });
    assert.ok(on.includes('userapp "slideshow"'));
    assert.ok(!off.includes('userapp "slideshow"'));
    assert.ok(!off.includes('figtype 0x2'), 'figtype 0x2 alone would still announce it');
  });
});
