// Tests for the metadata loop: mode NONE vs 'Show default DLS', refresh periods, edits applied
// immediately, ZMQ/EDI direct inputs skipped. No network: JSON services have no URL here.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppState, parseTimeMs, parseDurationMs, trackEndMs, TRACK_END_GRACE_MS, classifyItemType, findNearTitle } from '../src/appState.js';
import { DEFAULT_SETTINGS } from '../src/defaults.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demoPreset = path.resolve(__dirname, '../../data/presets/demo.json');

describe('metadata loop', () => {
  let dir, state;
  const svc = (i) => state.preset.services[i];
  const rt = (s) => state.serviceRuntime.get(s.id);
  const dlsFile = (s) => fs.readFileSync(state._getDlsRuntimePath(s), 'utf8');

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-meta-'));
    fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
    fs.copyFileSync(demoPreset, path.join(dir, 'presets', 'demo.json'));
    state = new AppState({
      settings: structuredClone(DEFAULT_SETTINGS),
      dataDir: dir,
      logger: { line() {} },
      processManager: { isRunning: () => false },
    });
    state._initRuntime();
    state.muxRunning = true;
    // only the services used below take part, all other ones are switched off
    state.preset.services.forEach((s, i) => { s.enabled = i < 3; });
    Object.assign(svc(0).metadata, { mode: 'NONE', defaultDls: 'Manual text', defaultDlsAllowed: true, intervalSec: 300 });
    Object.assign(svc(1).metadata, { mode: 'STREAM', defaultDls: 'Stream fallback', defaultDlsAllowed: true, intervalSec: 300 });
    Object.assign(svc(2).metadata, { mode: 'JSON', url: null, defaultDls: 'Json fallback', defaultDlsAllowed: true, intervalSec: 300 });
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('mode NONE sends the manual text', async () => {
    await state._updateMetadata();
    assert.equal(rt(svc(0)).currentDls, 'Manual text');
  });

  it("mode NONE respects 'Show default DLS = No' (no text coming back on the next tick)", async () => {
    svc(0).metadata.defaultDlsAllowed = false;
    rt(svc(0)).lastMetaUpdateMs = 0;
    await state._updateMetadata();
    assert.equal(rt(svc(0)).currentDls, '');
    assert.equal(dlsFile(svc(0)), '');
    svc(0).metadata.defaultDlsAllowed = true;
  });

  it("STREAM / NONE refresh every 5 s whatever the hidden 'Refresh (sec)'; JSON keeps it", async () => {
    const past = Date.now() - 6000;
    for (const i of [0, 1, 2]) rt(svc(i)).lastMetaUpdateMs = past;
    await state._updateMetadata();
    assert.notEqual(rt(svc(0)).lastMetaUpdateMs, past, 'NONE refreshed after 6 s');
    assert.notEqual(rt(svc(1)).lastMetaUpdateMs, past, 'STREAM refreshed after 6 s');
    assert.equal(rt(svc(2)).lastMetaUpdateMs, past, 'JSON waits for its 300 s');
  });

  it('a metadata edit is applied at the next tick, not after the interval', async () => {
    rt(svc(2)).lastMetaUpdateMs = Date.now();
    state.setService(svc(2).id, { metadata: { defaultDls: 'New fallback' } });
    assert.equal(rt(svc(2)).lastMetaUpdateMs, 0);
    await state._updateMetadata();
    assert.equal(rt(svc(2)).currentDls, 'New fallback');
  });

  it('ZMQ/EDI direct inputs are skipped (their DLS comes from the remote encoder)', async () => {
    svc(1).input.mode = 'EDI';
    rt(svc(1)).lastMetaUpdateMs = 0;
    rt(svc(1)).currentDls = 'untouched';
    await state._updateMetadata();
    assert.equal(rt(svc(1)).lastMetaUpdateMs, 0);
    assert.equal(rt(svc(1)).currentDls, 'untouched');
    svc(1).input.mode = 'GSTREAMER';
  });
});

describe('on-air slides (cover has priority over the logos)', () => {
  let dir, state, svc, slideDir, airDir;
  const air = () => fs.readdirSync(airDir).sort();
  const put = (name, bytes) => fs.writeFileSync(path.join(slideDir, name), Buffer.alloc(bytes, 7));

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-air-'));
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
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('without cover, the logos rotate (all images of slide/)', () => {
    put('logo.jpg', 7000);
    put('logo_1.jpg', 5000);
    fs.writeFileSync(path.join(slideDir, 'notes.txt'), 'not an image');
    assert.equal(state._syncAirSlides(svc), airDir);
    assert.deepEqual(air(), ['logo.jpg', 'logo_1.jpg']);
    assert.deepEqual(state.serviceRuntime.get(svc.id).airSlides.sort(), ['logo.jpg', 'logo_1.jpg']);
  });

  it('with a track cover, only the cover is on air', () => {
    put('cover.jpg', 20000);
    state._syncAirSlides(svc);
    assert.deepEqual(air(), ['cover.jpg']);
    assert.deepEqual(state.serviceRuntime.get(svc.id).airSlides, ['cover.jpg']);
  });

  it('a new cover (next track) replaces the on-air copy', () => {
    put('cover.jpg', 18000);
    state._syncAirSlides(svc);
    assert.equal(fs.statSync(path.join(airDir, 'cover.jpg')).size, 18000);
  });

  it('cover removed (no cover for this track) → logos back on air', () => {
    fs.unlinkSync(path.join(slideDir, 'cover.jpg'));
    state._syncAirSlides(svc);
    assert.deepEqual(air(), ['logo.jpg', 'logo_1.jpg']);
    assert.equal(fs.readdirSync(path.dirname(airDir)).filter((f) => f.startsWith('.air_')).length, 0, 'no temp file left');
  });

  it('on error, falls back to slide/ (previous behaviour)', () => {
    fs.rmSync(slideDir, { recursive: true, force: true });
    assert.equal(state._syncAirSlides(svc), slideDir);
  });
});

describe('end of track (no cover / title stuck on air during ads)', () => {
  const now = Date.UTC(2026, 10, 11, 22, 0, 0);

  it('parses start times: epoch ms, epoch s, ISO date; ignores future / stale / garbage', () => {
    assert.equal(parseTimeMs(now - 60000, now), now - 60000);
    assert.equal(parseTimeMs(String((now - 60000) / 1000), now), now - 60000);
    assert.equal(parseTimeMs(new Date(now - 60000).toISOString(), now), now - 60000);
    assert.equal(parseTimeMs(now + 3600000, now), null);
    assert.equal(parseTimeMs(now - 2 * 86400000, now), null);
    assert.equal(parseTimeMs('soon', now), null);
    assert.equal(parseTimeMs('', now), null);
  });

  it('parses durations: seconds, milliseconds, mm:ss, hh:mm:ss', () => {
    assert.equal(parseDurationMs('215'), 215000);
    assert.equal(parseDurationMs(215000), 215000);
    assert.equal(parseDurationMs('3:35'), 215000);
    assert.equal(parseDurationMs('1:02:03'), 3723000);
    assert.equal(parseDurationMs('0'), null);
    assert.equal(parseDurationMs(''), null);
  });

  it('duration known → start + duration (+grace), for any item (a 2 h show keeps its logo 2 h)', () => {
    assert.equal(trackEndMs({ startMs: now, durationMs: 200000 }), now + 200000 + TRACK_END_GRACE_MS);
    assert.equal(trackEndMs({ startMs: now, durationMs: 7200000, itemType: 'other' }), now + 7200000 + TRACK_END_GRACE_MS);
    assert.equal(trackEndMs({ firstSeenMs: now, durationMs: 200000 }), now + 200000 + TRACK_END_GRACE_MS);
  });

  it('no duration: song capped (0 = never), ad over at once, show / unknown never cut', () => {
    assert.equal(trackEndMs({ startMs: now, itemType: 'song', maxMin: 8 }), now + 8 * 60000);
    assert.equal(trackEndMs({ startMs: now, itemType: 'song', maxMin: 0 }), null);
    assert.equal(trackEndMs({ firstSeenMs: now, itemType: 'ad' }), now);
    assert.equal(trackEndMs({ startMs: now, itemType: 'other' }), null);
    assert.equal(trackEndMs({ startMs: now, itemType: null }), null);
  });

  it('classifies item types (song / ad / other)', () => {
    for (const t of ['song', 'Music', 'track', 'Titel']) assert.equal(classifyItemType(t), 'song', t);
    for (const t of ['ad', 'Advertisement', 'commercial', 'Werbung', 'jingle', 'promo', 'PUB']) assert.equal(classifyItemType(t), 'ad', t);
    for (const t of ['show', 'moderation', 'news', 'talk', 'programme']) assert.equal(classifyItemType(t), 'other', t);
    assert.equal(classifyItemType(''), null);
    assert.equal(classifyItemType(null), null);
  });

  it('finds start / duration / type next to the title (RTL-like and flat APIs)', () => {
    const rtl = [{ name: 'x' }, { name: 'ukw', playHistories: [{ start: 1794436424000, track: { title: 'Sugar', artist: 'Robin Schulz', type: 'song', creationTime: 1 } }] }];
    const key = '1.playHistories.0.track.title';
    assert.equal(findNearTitle(rtl, key, 'type'), 'song');
    assert.equal(findNearTitle(rtl, key, 'start'), 1794436424000);
    assert.equal(findNearTitle(rtl, key, 'duration'), null);
    const flat = { now: { title: 'T', artist: 'A', Duration: '3:35', played_at: '2026-11-11T21:58:00Z' } };
    assert.equal(findNearTitle(flat, 'now.title', 'duration'), '3:35');
    assert.equal(findNearTitle(flat, 'now.title', 'start'), '2026-11-11T21:58:00Z');
  });

  it('JSON still returning the last song after its end → logo + default DLS, then the next track', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-trackend-'));
    fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
    fs.copyFileSync(demoPreset, path.join(dir, 'presets', 'demo.json'));
    const state = new AppState({ settings: structuredClone(DEFAULT_SETTINGS), dataDir: dir, logger: { line() {} }, processManager: { isRunning: () => false } });
    state._initRuntime();
    state.muxRunning = true;
    state.preset.services.forEach((s, i) => { s.enabled = i === 0; });
    const svc = state.preset.services[0];
    Object.assign(svc.metadata, { mode: 'JSON', url: 'http://api.invalid/now', artistKey: 'artist', titleKey: 'title', slsKey: 'cover',
      startKey: '', durationKey: '', trackMaxMin: 8, defaultDls: 'Station name', defaultDlsAllowed: true, intervalSec: 10 });
    let api = { artist: 'A', title: 'Song 1', cover: 'http://img.invalid/1.jpg', start: Date.now() - 2 * 60000, type: 'song' };
    state._fetchText = async () => JSON.stringify(api);
    state._downloadImage = async () => false;   // no network in tests
    const rt = state.serviceRuntime.get(svc.id);
    const tick = async () => { rt.lastMetaUpdateMs = 0; await state._updateMetadata(); };

    await tick();
    assert.equal(rt.currentDls, 'A - Song 1', 'song playing for 2 min: title on air');
    assert.equal(rt.metaStatus.ok, true);
    assert.match(rt.metaStatus.msg, /artist ✓ · title ✓ · cover ✓/);
    api = { ...api, start: Date.now() - 9 * 60000 };          // same song reported 9 min after its start (ads)
    await tick();
    assert.equal(rt.currentDls, 'Station name', 'track over: default DLS');
    assert.equal(rt.currentSlsUrl, null, 'track over: no cover');
    await tick();   // a second tick in the 'over' state (log already written)
    assert.equal(rt.currentDls, 'Station name', 'still over on the next tick');
    assert.match(rt.metaStatus.msg, /item over \(song longer than 8 min\)/);
    assert.ok(rt.metaStatus.at > 0);
    api = { artist: 'B', title: 'Song 2', cover: 'http://img.invalid/2.jpg', start: Date.now() - 10000, type: 'song' };
    await tick();
    assert.equal(rt.currentDls, 'B - Song 2', 'next track back on air');
    api = { artist: 'Morning', title: 'Show', cover: 'http://img.invalid/show.jpg', start: Date.now() - 90 * 60000, type: 'show' };
    await tick();
    assert.equal(rt.currentDls, 'Morning - Show', 'a show running for 90 min keeps its title (and logo)');
    api = { artist: 'C', title: 'No type', cover: 'http://img.invalid/3.jpg', start: Date.now() - 30 * 60000 };
    await tick();
    assert.equal(rt.currentDls, 'C - No type', 'no type, no duration: never cut (previous behaviour)');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('on-air slides: station logo every N seconds during a cover', () => {
  let dir, state, svc, slideDir, airDir, rt;
  const air = () => fs.readdirSync(airDir).sort();
  const put = (name, bytes) => fs.writeFileSync(path.join(slideDir, name), Buffer.alloc(bytes, 7));
  const elapse = (ms) => {   // move the rotation clock back instead of waiting
    if (rt.airLogoPhaseStartMs) rt.airLogoPhaseStartMs -= ms;
    if (rt.airLogoPhaseUntilMs) rt.airLogoPhaseUntilMs -= ms;
  };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-logoevery-'));
    fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
    fs.copyFileSync(demoPreset, path.join(dir, 'presets', 'demo.json'));
    state = new AppState({ settings: structuredClone(DEFAULT_SETTINGS), dataDir: dir, logger: { line() {} }, processManager: { isRunning: () => false } });
    state._initRuntime();
    svc = state.preset.services[0];
    svc.metadata.logoEverySec = 60;
    svc.dab.padSize = 58;
    const mot = state._resolveMotDir(svc);
    slideDir = path.resolve(mot, svc.pad?.slideDir || 'slide');
    airDir = path.resolve(mot, 'air');
    fs.mkdirSync(slideDir, { recursive: true });
    rt = state.serviceRuntime.get(svc.id);
    put('logo.jpg', 7000);
    put('logo_1.jpg', 5000);
    put('cover.jpg', 20000);
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a new cover goes first', () => {
    state._syncAirSlides(svc);
    assert.deepEqual(air(), ['cover.jpg']);
  });

  it('after N seconds the logo replaces it just long enough to be sent, then the cover is back', () => {
    elapse(30000);
    state._syncAirSlides(svc);
    assert.deepEqual(air(), ['cover.jpg'], 'not yet (30 s < 60 s)');
    elapse(31000);
    state._syncAirSlides(svc);
    assert.deepEqual(air(), ['logo.jpg'], 'logo.jpg first');
    const window = rt.airLogoPhaseUntilMs - rt.airLogoPhaseStartMs;
    assert.ok(window >= 6000 && window <= 15000, `window ${window} ms for 7 kB at PAD 58`);
    elapse(window + 1);
    state._syncAirSlides(svc);
    assert.deepEqual(air(), ['cover.jpg'], 'cover back');
  });

  it('logos take turns', () => {
    elapse(61000);
    state._syncAirSlides(svc);
    assert.deepEqual(air(), ['logo_1.jpg']);
  });

  it('a new cover (next track) cuts the logo phase and restarts the count', () => {
    const t = new Date(Date.now() + 5000);
    put('cover.jpg', 19000);
    fs.utimesSync(path.join(slideDir, 'cover.jpg'), t, t);
    state._syncAirSlides(svc);
    assert.deepEqual(air(), ['cover.jpg']);
    elapse(30000);
    state._syncAirSlides(svc);
    assert.deepEqual(air(), ['cover.jpg'], 'count restarted with the new cover');
  });

  it('order: logo, cover, logo_1, cover, logo_2 … logo_10 (numeric), then back to logo', () => {
    for (const n of [2, 10]) put(`logo_${n}.jpg`, 4000);
    const seen = [];
    for (let i = 0; i < 4; i++) {
      elapse(61000);
      state._syncAirSlides(svc);
      seen.push(air()[0]);
      elapse(rt.airLogoPhaseUntilMs - rt.airLogoPhaseStartMs + 1);
      state._syncAirSlides(svc);
      assert.deepEqual(air(), ['cover.jpg'], 'the cover between two logos');
    }
    // the previous test left the rotation on logo_1.jpg
    assert.deepEqual(seen, ['logo_2.jpg', 'logo_10.jpg', 'logo.jpg', 'logo_1.jpg']);
  });

  it('logoEverySec = 0 → cover only', () => {
    svc.metadata.logoEverySec = 0;
    elapse(600000);
    state._syncAirSlides(svc);
    assert.deepEqual(air(), ['cover.jpg']);
  });
});

describe('on-air slides: default logo interval', () => {
  it('without setting, the logo comes back every 40 s during a cover', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-logodefault-'));
    fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
    fs.copyFileSync(demoPreset, path.join(dir, 'presets', 'demo.json'));
    const state = new AppState({ settings: structuredClone(DEFAULT_SETTINGS), dataDir: dir, logger: { line() {} }, processManager: { isRunning: () => false } });
    state._initRuntime();
    const svc = state.preset.services[0];
    delete svc.metadata.logoEverySec;
    const mot = state._resolveMotDir(svc);
    const slideDir = path.resolve(mot, svc.pad?.slideDir || 'slide');
    fs.mkdirSync(slideDir, { recursive: true });
    fs.writeFileSync(path.join(slideDir, 'logo.jpg'), Buffer.alloc(5000, 1));
    fs.writeFileSync(path.join(slideDir, 'cover.jpg'), Buffer.alloc(15000, 2));
    const rt = state.serviceRuntime.get(svc.id);
    const air = () => fs.readdirSync(path.resolve(mot, 'air'));
    state._syncAirSlides(svc);
    assert.deepEqual(air(), ['cover.jpg']);
    rt.airLogoPhaseStartMs -= 39000;
    state._syncAirSlides(svc);
    assert.deepEqual(air(), ['cover.jpg'], '39 s: still the cover');
    rt.airLogoPhaseStartMs -= 2000;
    state._syncAirSlides(svc);
    assert.deepEqual(air(), ['logo.jpg'], '41 s: the logo');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
