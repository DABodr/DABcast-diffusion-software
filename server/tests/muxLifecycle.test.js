// Multiplex start / stop (appState.startMux / stopMux) with a simulated process manager:
// ON AIR is never declared with odr-dabmux gone, a Stop during the start cancels it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppState } from '../src/appState.js';
import { DEFAULT_SETTINGS } from '../src/defaults.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// fake ODR processes: dabmuxExit = { afterMs, code } makes odr-dabmux exit by itself
function fakePm({ dabmuxExit = null, stopDelayMs = 0 } = {}) {
  const procs = new Map();
  const exit = (key, code) => { const p = procs.get(key); if (!p) return; procs.delete(key); p.opts?.onExit?.(code); };
  return {
    procs,
    binaryExists: () => true,
    isRunning: (key) => procs.has(key),
    spawn(key, bin, args, opts = {}) {
      procs.set(key, { bin, args, opts });
      if (key === 'mux:odr-dabmux' && dabmuxExit) setTimeout(() => exit(key, dabmuxExit.code), dabmuxExit.afterMs);
    },
    async stop(key) { if (!procs.has(key)) throw new Error('not running'); if (stopDelayMs) await sleep(stopDelayMs); exit(key, null); },
    async stopAll(prefix) { for (const k of [...procs.keys()]) if (k.startsWith(prefix)) exit(k, null); },
    exit,
  };
}
function makeState(pm, { encoders = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-mux-'));
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  const preset = JSON.parse(fs.readFileSync(new URL('./fixtures/preset-7-services.json', import.meta.url)));
  preset.services.forEach((s, i) => { s.enabled = i < encoders; });   // encoders = 0: only odr-dabmux is started
  fs.writeFileSync(path.join(dir, 'presets', 'demo.json'), JSON.stringify(preset));
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.dabmux.txMode = 'EASYDAB';
  return new AppState({ settings, dataDir: dir, logger: { line() {} }, processManager: pm });
}

describe('multiplex start / stop', () => {
  it('odr-dabmux exiting during the 500 ms of the start: start fails, never ON AIR', async () => {
    const pm = fakePm({ dabmuxExit: { afterMs: 100, code: 1 } });
    const st = makeState(pm);
    await assert.rejects(st.startMux(), /odr-dabmux stopped at start-up/);
    assert.equal(st.muxRunning, false);
    assert.equal(st.muxStatus, 'fail');
  });

  it('Stop pressed during the start: the start is cancelled, off (not failed), nothing left running', async () => {
    const pm = fakePm();
    const st = makeState(pm);
    const start = st.startMux();
    await sleep(100);
    await st.stopMux();
    await assert.rejects(start, /cancelled/);
    assert.equal(st.muxRunning, false);
    assert.equal(st.muxStatus, 'off');
    assert.equal(pm.procs.size, 0);
  });

  it('odr-dabmux exiting with code 0 while ON AIR is a failure too', async () => {
    const pm = fakePm();
    const st = makeState(pm);
    await st.startMux();
    assert.equal(st.muxRunning, true);
    pm.exit('mux:odr-dabmux', 0);
    await sleep(50);
    assert.equal(st.muxRunning, false);
    assert.equal(st.muxStatus, 'fail');
    await st.stopMux();
  });

  it('two quick gain changes ON AIR: the encoder ends with the last one (second restart queued, not skipped)', async () => {
    const pm = fakePm({ stopDelayMs: 300 });
    const st = makeState(pm, { encoders: 1 });
    await st.startMux();
    const id = st.preset.services[0].id;
    const gainOf = () => { const a = pm.procs.get(`svc:${id}:audioenc`)?.args || []; return a[a.indexOf('-g') + 1]; };
    st.setService(id, { audio: { gainDb: 3 } });
    await sleep(50);
    st.setService(id, { audio: { gainDb: 6 } });   // while the first restart is still stopping the encoder
    await sleep(1500);
    assert.equal(st.preset.services[0].audio.gainDb, 6);
    assert.equal(gainOf(), '6', 'encoder restarted with the last gain');
    await st.stopMux();
  });

  it('a normal start then stop still works', async () => {
    const pm = fakePm();
    const st = makeState(pm);
    await st.startMux();
    assert.equal(st.muxRunning, true);
    assert.equal(st.muxStatus, 'on');
    await st.stopMux();
    assert.equal(st.muxRunning, false);
    assert.equal(pm.procs.size, 0);
  });
});
