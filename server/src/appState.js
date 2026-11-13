import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { nanoid } from 'nanoid';
import { ensureDir, readJson, writeJson, safeExists } from './fsutil.js';
import { buildMuxConfig } from './odr/muxBuilder.js';
import { convertToSlide as convertSlideImage } from './slideImage.js';
import { buildAudioEncCommand, buildDabMuxCommand, buildPadEncCommand, buildDabModConfig, buildHackrfTransferCommand, buildProbeCommand } from './odr/commandBuilder.js';
import { localHackrfOutput, sdrDeviceString } from './odr/outputs.js';
import { getDabmodValue } from './odr/dabmodRc.js';
import { DEFAULT_FILTERTAPS } from './odr/filtertaps.js';
import { validateService } from './odr/validate.js';
import { ALLOWED_BITRATES_KBPS, DEFAULT_BITRATE_KBPS, DEFAULT_ZMQ_BUFFER, DEFAULT_ZMQ_PREBUFFER, DEFAULT_DEMO_PRESET_ID, DAB_FREQ_TABLE } from './defaults.js';
import { estimateCU, sumCU } from './cu.js';
import { buildDlPlusFileContent, writeTextFileAtomicIfChanged, parseNowPlaying } from './utils/dlplus.js';
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined'
  ? __APP_VERSION__
  : (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version; } catch { return '0.0.0'; } })();

function nowMs() { return Date.now(); }

// Failover constants
const FAILOVER_CRASH_THRESHOLD = 1;  // crashes before switching to backup
const FAILOVER_STABLE_MS = 30000;    // encoder must run 30s before crash counter resets
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;   // largest cover / logo downloaded (_downloadImage)
// Local modulator (SDR / HackRF) supervision by the watchdog (_superviseLocalModulator)
const MOD_STALL_MS = 15000;          // SoapySDR: no frame sent for 15 s = stalled (device unplugged)
const MOD_RETRY_MS = 30000;          // broken / stalled chain restarted every 30 s until it transmits
const MOD_STABLE_MS = 10000;         // hackrf_transfer chain: alive 10 s after a restart = back on air

/**
 * Resolve a value from a JSON object using dot-path, array index, and pipe fallbacks.
 * Examples: "artist", "now.artist", "data.0.name", "artist|name|label"
 * Returns empty string if not found.
 */
export function resolveFirst(data, keySpec) {
  if (!data || !keySpec) return '';
  const candidates = String(keySpec).split('|');
  for (const key of candidates) {
    let val = data;
    for (const part of key.split('.')) {
      if (val == null) break;
      val = Array.isArray(val) && /^\d+$/.test(part) ? val[Number(part)] : val[part];
    }
    if (val != null && val !== '') return String(val).trim();
  }
  return '';
}

// ── End of the current track (JSON mode) ──
// Many now-playing APIs keep returning the last song during ads / jingles, so its cover and title
// would stay on air. Rules, for every station, with no per-station setting:
//  - duration known (configured key, or a field next to the title): over at start + duration + grace;
//  - item type known (field next to the title): an ad / jingle is over at once (logo + default text),
//    a song is capped at trackMaxMin minutes (default 8), a show / talk / news is never cut;
//  - neither: never cut (previous behaviour). A show logo may legitimately stay for hours, and a
//    stale song cover during ads only lasts until the next song.
export const TRACK_END_GRACE_MS = 15000;
// Track start from an API value: epoch ms, epoch seconds or a date string. null if unusable
// (absent, unparsable, in the future or more than a day old: clock skew / stale data).
export function parseTimeMs(raw, nowMs = Date.now()) {
  if (raw == null || raw === '') return null;
  const str = String(raw).trim();
  let ms = null;
  if (/^\d+(\.\d+)?$/.test(str)) {
    const n = Number(str);
    ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : null;
  } else {
    const p = Date.parse(str);
    ms = Number.isFinite(p) ? p : null;
  }
  if (ms == null || ms > nowMs + 60000 || ms < nowMs - 24 * 3600 * 1000) return null;
  return ms;
}
// Track duration: seconds, milliseconds (values > 3600) or "mm:ss" / "hh:mm:ss". null if unusable.
export function parseDurationMs(raw) {
  if (raw == null || raw === '') return null;
  const str = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(str)) {
    const n = Number(str);
    if (n <= 0) return null;
    return n > 3600 ? n : n * 1000;
  }
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(str);
  return m ? ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 : null;
}
// Item type from an API value: 'song', 'ad' (ad / jingle / promo), 'other' (show, talk, news…), null.
export function classifyItemType(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return null;
  if (/\b(song|songs|music|musik|track|titel|title|chanson|titre|morceau)\b/.test(t)) return 'song';
  if (/\b(ad|ads|advert\w*|commercial\w*|spot|werbung|pub|publicit\w*|jingle\w*|promo\w*|sponsor\w*|trailer)\b/.test(t)) return 'ad';
  return 'other';
}
// Common field names next to the title, for APIs where no key is configured.
const SIBLING_NAMES = {
  start: ['start', 'starttime', 'start_time', 'started', 'startedat', 'started_at', 'playedat', 'played_at', 'playtime', 'play_time', 'airtime', 'air_time'],
  duration: ['duration', 'durationms', 'duration_ms', 'durationseconds', 'duration_seconds', 'durationinseconds', 'length', 'runtime'],
  type: ['type', 'kind', 'category', 'itemtype', 'item_type', 'class'],
};
// Value of a scalar field named like `kind` in the object holding the title, or the one above it
// (e.g. playHistories.0.start next to playHistories.0.track.title). null if none.
export function findNearTitle(data, titleKeySpec, kind) {
  const parts = String(titleKeySpec || '').split('|')[0].split('.').filter(Boolean);
  const names = SIBLING_NAMES[kind] || [];
  for (let up = 1; up <= 2 && up <= parts.length; up++) {
    let obj = data;
    for (const p of parts.slice(0, parts.length - up)) {
      if (obj == null) break;
      obj = Array.isArray(obj) && /^\d+$/.test(p) ? obj[Number(p)] : obj[p];
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    for (const [k, v] of Object.entries(obj)) {
      if (names.includes(k.toLowerCase()) && v != null && v !== '' && typeof v !== 'object') return v;
    }
  }
  return null;
}
// When the item is over (ms epoch), or null = never.
export function trackEndMs({ startMs = null, durationMs = null, firstSeenMs = null, maxMin = 8, itemType = null }) {
  const from = startMs ?? firstSeenMs;
  if (from == null) return null;
  if (durationMs != null) return from + durationMs + TRACK_END_GRACE_MS;
  if (itemType === 'ad') return from;   // ad / jingle: logo + default text right away
  if (itemType === 'song') {
    const cap = Number(maxMin) > 0 ? Number(maxMin) * 60000 : 0;
    return cap ? from + cap : null;
  }
  return null;   // show / talk / unknown: never cut
}

// Parse odr-audioenc VU meter: "In: [LLLLLL|RRRRRR] P"
// Be tolerant to spacing after 'In:' (some builds use multiple spaces).
const LEVEL_STEREO_RE = /In:\s*\[(.{6})\|(.{6})\]/;
const LEVEL_MONO_RE = /In:\s*\[(.{6})\]/;
export function parseAudioLevel(text) {
  const countLevel = (s) => {
    let n = 0;
    for (const c of s) if (c !== ' ') n++;
    return n;
  };
  const ms = LEVEL_STEREO_RE.exec(text);
  if (ms) {
    return {
      left: countLevel(ms[1]),
      right: countLevel(ms[2]),
      clipLeft: ms[1].includes('!'),
      clipRight: ms[2].includes('!')
    };
  }
  const mm = LEVEL_MONO_RE.exec(text);
  if (mm) {
    const lvl = countLevel(mm[1]);
    const clip = mm[1].includes('!');
    return { left: lvl, right: 0, clipLeft: clip, clipRight: false, mono: true };
  }
  return null;
}

// Check if a stream URL is reachable.
// Strategy: try HEAD first (lightweight). If HEAD fails for ANY reason
// (timeout, 4xx, 5xx, network error), fall back to a short GET.
// Icecast/Shoutcast typically reject HEAD with 400/405, but some servers
// return 501 or 403, and slow networks can cause HEAD to timeout before
// we get a response — all of these are handled by the GET fallback.
async function headOk(url, timeoutMs = 3000) {
  if (!url) return false;

  // Step 1: try HEAD (doesn't open a stream listener slot)
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    if (res.ok || (res.status >= 300 && res.status < 400)) return true;
    // HEAD returned 4xx/5xx — fall through to GET
  } catch {
    // HEAD timed out or network error — fall through to GET
  } finally {
    clearTimeout(t);
  }

  // Step 2: GET fallback — abort as soon as headers arrive
  const ctrl2 = new AbortController();
  const t2 = setTimeout(() => ctrl2.abort(), timeoutMs);
  try {
    const res2 = await fetch(url, { method: 'GET', signal: ctrl2.signal });
    if (res2.ok || res2.status === 503) {
      // 200 = stream alive; 503 = stream full (encoder occupies the slot) = alive
      ctrl2.abort();
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(t2);
  }
}

// Quick TCP connectivity check (~1s). Returns true if a TCP connection succeeds.
// For protocols without a TCP handshake (UDP, RTP, ALSA), returns true immediately
// to let the audio probe decide.
function quickTcpCheck(uri, timeoutMs = 1000) {
  return new Promise(resolve => {
    let parsed;
    try { parsed = new URL(uri); } catch { return resolve(false); }
    const host = parsed.hostname;
    const proto = parsed.protocol;
    // Non-TCP protocols: skip check, go straight to audio probe
    if (!host || /^(udp:|rtp:|alsa:|file:)/.test(proto)) return resolve(true);
    const port = Number(parsed.port) || (proto === 'https:' ? 443 : 80);
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.connect(port, host, () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

// Metadata refresh period for modes that read local data (STREAM = ICY file written by
// odr-audioenc, NONE = fixed text). URL modes use the service's 'Refresh (sec)'.
const META_LOCAL_INTERVAL_SEC = 5;
// During a track cover, the station logo comes back every N seconds unless the service sets
// metadata.logoEverySec (0 = cover only).
const LOGO_EVERY_DEFAULT_SEC = 40;

export class AppState {
  constructor({ settings, dataDir, logger, processManager }) {
    this.settings = settings;
    this.dataDir = dataDir;
    this.logger = logger;
    this.pm = processManager;

    this.presetsDir = path.resolve(dataDir, 'presets');
    this.runtimeDir = path.resolve(dataDir, 'runtime');
    this.logFile = path.resolve(dataDir, 'logs', 'dabweb.log');
    this._statePath = path.resolve(dataDir, 'runtime', 'state.json');
    ensureDir(this.presetsDir);
    ensureDir(this.runtimeDir);

    this.currentPresetId = DEFAULT_DEMO_PRESET_ID;
    this.preset = this._loadPreset(this.currentPresetId);
    this._repairDuplicatePorts();

    // muxRunning is always false on startup (orphan processes were already cleaned)
    this.muxRunning = false;
    this.muxStatus = 'off'; // 'off' | 'on' | 'fail'
    this.lastError = null;
    this.muxSinceMs = Date.now(); // timestamp of last ON/OFF transition
    this._persistMuxState(false);
    this.watchdogTimer = null;
    this.metadataTimer = null;
    this.serviceRuntime = new Map();

    // CRITICAL FIX: Locks to prevent race conditions
    this._watchdogRunning = false;        // Guard flag for watchdog loop
    this._switchLocks = new Map();        // Per-service locks for URI switching
    this._probeTimer = null;              // Probe loop timer
    this._probeRunning = false;           // Guard flag for probe loop

    this._initRuntime();
    this._imgBinLogged = false;
  }

  _logMeta(svc, scope, msg, level) {
    this.logger.line(`svc:${svc.id}:meta`, `[${scope}] ${msg}`, level);
  }

  _loadPreset(id) {
    const p = path.resolve(this.presetsDir, `${id}.json`);
    const preset = readJson(p, null);
    if (!preset) {
      throw new Error(`Preset not found: ${p}`);
    }
    return preset;
  }

  _applyDefaults(svc) {
    // Apply missing defaults to imported service
    const id = svc.id || nanoid(8);
    return {
      id,
      enabled: svc.enabled !== false,
      identity: {
        pi: svc.identity?.pi || '0000',
        serviceIdHex: svc.identity?.serviceIdHex || `0x${svc.identity?.pi || '0000'}`,
        ps8: svc.identity?.ps8 || 'RADIO',
        ps16: svc.identity?.ps16 || null,
        languageHex: svc.identity?.languageHex || '0x0F',
        pty: Number.isInteger(svc.identity?.pty) ? svc.identity.pty : 10
      },
      dab: {
        bitrateKbps: ALLOWED_BITRATES_KBPS.includes(svc.dab?.bitrateKbps) ? svc.dab.bitrateKbps : DEFAULT_BITRATE_KBPS,
        protectionLevel: Number.isInteger(svc.dab?.protectionLevel) ? svc.dab.protectionLevel : 3,
        eepMode: svc.dab?.eepMode || 'A',
        padSize: Number.isInteger(svc.dab?.padSize) ? svc.dab.padSize : 58
      },
      input: {
        mode: svc.input?.mode || 'GSTREAMER',
        uri: svc.input?.uri || null,
        backupUri: svc.input?.backupUri || null,
        zmqBuffer: Number.isInteger(svc.input?.zmqBuffer) ? svc.input.zmqBuffer : DEFAULT_ZMQ_BUFFER,
        zmqPrebuffering: Number.isInteger(svc.input?.zmqPrebuffering) ? svc.input.zmqPrebuffering : DEFAULT_ZMQ_PREBUFFER,
        encoderBufferMs: Number.isInteger(svc.input?.encoderBufferMs) ? svc.input.encoderBufferMs : 200
      },
      audio: {
        channels: Number.isInteger(svc.audio?.channels) ? svc.audio.channels : 2,
        sampleRateHz: Number.isInteger(svc.audio?.sampleRateHz) ? svc.audio.sampleRateHz : 48000,
        gainDb: typeof svc.audio?.gainDb === 'number' ? svc.audio.gainDb : 0,
        codec: svc.audio?.codec || 'HE-AAC v1 (SBR)'
      },
      pad: {
        enabled: true,
        fifoName: svc.pad?.fifoName || id.toUpperCase(),
        dlsFile: svc.pad?.dlsFile || `${id.toUpperCase()}.dls`,
        slideDir: svc.pad?.slideDir || 'slide',
        motDir: svc.pad?.motDir || `mot/${id.toUpperCase()}`,
        sls: { enabled: true, logoPath: null, ...svc.pad?.sls }
      },
      network: {
        ediOutputTcp: {
          host: svc.network?.ediOutputTcp?.host || '127.0.0.1',
          port: Number.isInteger(svc.network?.ediOutputTcp?.port) ? svc.network.ediOutputTcp.port : this._pickFreePort()
        }
      },
      watchdog: {
        enabled: svc.watchdog?.enabled !== false,
        silenceThresholdSec: svc.watchdog?.silenceThresholdSec ?? 10,
        warningThresholdSec: svc.watchdog?.warningThresholdSec ?? 5,
        switchToBackupOnSilence: svc.watchdog?.switchToBackupOnSilence !== false,
        returnToMainAfterSec: svc.watchdog?.returnToMainAfterSec ?? 60
      },
      metadata: {
        mode: svc.metadata?.mode || 'NONE',
        intervalSec: svc.metadata?.intervalSec ?? 10,
        url: svc.metadata?.url || null,
        artistKey: svc.metadata?.artistKey || 'artist',
        titleKey: svc.metadata?.titleKey || 'title',
        slsKey: svc.metadata?.slsKey || 'slide',
        defaultDls: svc.metadata?.defaultDls || '',
        slsUrl: svc.metadata?.slsUrl || null,
        slsBackColor: svc.metadata?.slsBackColor || '',
        slsFontColor: svc.metadata?.slsFontColor || '',
        defaultDlsAllowed: svc.metadata?.defaultDlsAllowed !== false,
        defaultSlsAllowed: svc.metadata?.defaultSlsAllowed !== false,
        dlsIncluded: svc.metadata?.dlsIncluded === true
      },
      dlplus: { enabled: svc.dlplus?.enabled !== false, ...svc.dlplus },
      ui: {
        order: svc.ui?.order ?? (this.preset.services.length + 1),
        ...svc.ui
      },
    };
  }

  _savePreset() {
    const p = path.resolve(this.presetsDir, `${this.preset.id}.json`);
    writeJson(p, this.preset);
  }

  _persistMuxState(running) {
    try {
      writeJson(this._statePath, { muxRunning: running, muxSinceMs: this.muxSinceMs, ts: new Date().toISOString() });
    } catch { /* non-critical */ }
  }

  _initRuntime() {
    for (const svc of this.preset.services) {
      this.serviceRuntime.set(svc.id, {
        status: 'STOPPED',
        activeUri: svc.input.uri,
        lastOkMainMs: 0,
        lastOkBackupMs: 0,
        lastSwitchMs: 0,
        failuresSinceMs: 0,
        lastMetaUpdateMs: 0,
        currentDls: '',
        currentSlsUrl: '',
        dlplusActive: false,
        warningSinceMs: 0,
        audioLevels: { left: 0, right: 0, clipLeft: false, clipRight: false },
        consecutiveCrashes: 0,  // Track encoder crash loops for failover
        lastStartMs: 0,         // Timestamp of last encoder spawn
        lastDeathMs: 0,         // Timestamp of last encoder death detection
        encWasAlive: false      // Encoder was alive on previous tick (for transition detection)
      });
    }
  }

  getState() {
    const services = this.preset.services.map((svc) => {
      const rt = this.serviceRuntime.get(svc.id) || { status: 'UNKNOWN' };
      const cu = estimateCU(svc.dab?.bitrateKbps ?? 0, svc.dab?.protectionLevel ?? 3, svc.dab?.eepMode);
      return {
        ...svc,
        cu,
        runtime: rt
      };
    });

    const error = this.lastError;
    if (error) this.lastError = null;

    return {
      muxRunning: this.muxRunning,
      muxStatus: this.muxStatus,
      muxSinceMs: this.muxSinceMs,
      lastError: error,
      preset: {
        id: this.preset.id,
        name: this.preset.name,
        services,
        capacity: {
          totalCu: services.reduce((a, s) => a + (s.enabled ? (s.cu ?? 0) : 0), 0),
          maxCu: 864
        }
      },
      settings: {
        dabmux: this.settings.dabmux,
        ensemble: this.settings.ensemble,
        autoStart: this.settings.autoStart ?? false
      },
      allowedBitratesKbps: ALLOWED_BITRATES_KBPS,
      appVersion: APP_VERSION
    };
  }

  listPresets() {
    const files = fs.readdirSync(this.presetsDir).filter((f) => f.endsWith('.json'));
    return files.map((f) => {
      const p = readJson(path.resolve(this.presetsDir, f), null);
      return p ? { id: p.id, name: p.name } : null;
    }).filter(Boolean);
  }

  setPreset(preset) {
    if (this.muxRunning) throw new Error('Cannot replace preset while ON AIR');
    if (!preset || !Array.isArray(preset.services)) {
      throw new Error('Invalid preset payload');
    }
    const next = structuredClone(preset);
    next.id = this.currentPresetId; // always save to the active slot (demo.json)
    next.name = String(preset.name || preset.id || next.id);
    next.services = next.services.map((svc, idx) => {
      const s = structuredClone(svc || {});
      if (!s.id) s.id = nanoid(8);
      s.ui = { ...(s.ui || {}), order: s.ui?.order ?? (idx + 1) };
      return s;
    });
    this.preset = next;
    this._repairDuplicatePorts();
    this._savePreset();
    this.serviceRuntime.clear();
    this._initRuntime();
  }

  upsertService(service) {
    if (!service || typeof service !== 'object') {
      throw new Error('Invalid service payload');
    }
    const next = structuredClone(service);
    if (!next.id) next.id = nanoid(8);
    // ON AIR: an imported service is forced OFF (not in the running .mux; ON/OFF button puts it on air).
    // Replacing an existing service is only allowed if it is OFF and its encoder is not running.
    if (this.muxRunning) {
      const cur = this.preset.services.find((s) => s.id === next.id);
      if (cur && (cur.enabled !== false || this.pm.isRunning(`svc:${cur.id}:audioenc`) || this.pm.isRunning(`svc:${cur.id}:padenc`))) {
        throw new Error('Cannot replace a service that is ON while ON AIR — turn it OFF first');
      }
      next.enabled = false;
    }
    next.ui = { ...(next.ui || {}), order: next.ui?.order ?? (this.preset.services.length + 1) };
    // A service exported from another mux keeps its port (9001, 9002…): if it is already used here,
    // give it a free one, otherwise odr-dabmux cannot bind both inputs ("Could not bind").
    const wantedPort = Number(next.network?.ediOutputTcp?.port);
    const portTaken = this.preset.services.some((s) => s.id !== next.id && s.network?.ediOutputTcp?.port === wantedPort);
    if (!Number.isInteger(wantedPort) || wantedPort < 1024 || wantedPort > 65535 || portTaken) {
      const port = this._pickFreePort();
      next.network = { ...next.network, ediOutputTcp: { host: '127.0.0.1', ...next.network?.ediOutputTcp, port } };
      this.logger.line('service', `${next.id}: input port ${Number.isNaN(wantedPort) ? '(none)' : wantedPort} already used or invalid — assigned ${port}`, 'WARN');
    }

    const { errors, warnings, normalized } = validateService(next, ALLOWED_BITRATES_KBPS);
    if (errors.length) throw new Error(errors.join(' '));
    if (warnings?.length) {
      warnings.forEach(w => this.logger.line('service', `${next.id}: ${w}`, 'WARN'));
    }

    const idx = this.preset.services.findIndex((s) => s.id === next.id);
    if (idx >= 0) {
      this.preset.services[idx] = normalized;
    } else {
      this.preset.services.push(normalized);
    }

    this.serviceRuntime.set(normalized.id, {
      status: 'STOPPED',
      activeUri: normalized.input?.uri || null,
      lastOkMainMs: 0,
      lastOkBackupMs: 0,
      lastSwitchMs: 0,
      failuresSinceMs: 0,
      lastMetaUpdateMs: 0,
      currentDls: '',
      currentSlsUrl: '',
      dlplusActive: false,
      warningSinceMs: 0
    });
    this._savePreset();

    // Download slide immediately if slsUrl is set
    if (normalized.metadata?.slsUrl) {
      this.downloadSlideForService(normalized).catch((err) => {
        this.logger.line('sls', `immediate slide download failed: ${err.message}`);
      });
    }

    return normalized;
  }

  setService(id, patch) {
    const idx = this.preset.services.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error(`Unknown service: ${id}`);

    // lock certain fields while ON AIR
    const locked = this.muxRunning;
    const existing = this.preset.services[idx];

    const next = structuredClone(existing);

    // Always editable (even when ON AIR)
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (patch.input) {
      next.input.uri = patch.input.uri ?? next.input.uri;
      next.input.backupUri = patch.input.backupUri ?? next.input.backupUri;
      if (typeof patch.input.mode === 'string') next.input.mode = patch.input.mode;
      if (Number.isInteger(patch.input.encoderBufferMs)) next.input.encoderBufferMs = patch.input.encoderBufferMs;
    }
    if (patch.audio) {
      if (typeof patch.audio.gainDb === 'number') next.audio.gainDb = patch.audio.gainDb;
    }
    // Language, PTY, Channels remain editable when ON AIR
    if (patch.identity) {
      if (patch.identity.pty != null) next.identity.pty = patch.identity.pty;
      if (patch.identity.languageHex != null) next.identity.languageHex = patch.identity.languageHex;
    }
    if (patch.audio) {
      if (Number.isInteger(patch.audio.channels)) next.audio.channels = patch.audio.channels;
    }
    if (patch.metadata) {
      next.metadata = { ...(next.metadata || {}), ...(patch.metadata || {}) };
      // apply the new text / mode / URL at the next metadata tick (≤ 1 s), not after the interval
      const rtMeta = this.serviceRuntime.get(id);
      if (rtMeta) rtMeta.lastMetaUpdateMs = 0;
      // Clear DLS file when defaultDlsAllowed is turned off
      if (next.metadata.defaultDlsAllowed === false) {
        this._writeDlsFile(next, '');
        const rt = this.serviceRuntime.get(id);
        if (rt) rt.currentDls = '';
        this.logger.line(`svc:${id}`, 'cleared DLS (Show default DLS = No)');
      }
      // Cleanup cover.jpg when switching away from JSON mode
      const newMode = String(next.metadata.mode || 'NONE').toUpperCase();
      if (newMode !== 'JSON') {
        const motDir = this._resolveMotDir(next);
        const coverPath = path.resolve(motDir, next.pad?.slideDir || 'slide', 'cover.jpg');
        if (safeExists(coverPath)) {
          try { fs.unlinkSync(coverPath); } catch { /* ignore */ }
          this.logger.line(`svc:${id}`, `removed cover.jpg (mode changed to ${newMode})`);
        }
        // Clear runtime SLS URL so frontend falls back to logo.jpeg
        const rt = this.serviceRuntime.get(id);
        if (rt) rt.currentSlsUrl = '';
      }
    }
    if (patch.dlplus && typeof patch.dlplus.enabled === 'boolean') {
      const dlplusPrev = existing.dlplus?.enabled !== false;
      const dlplusNext = patch.dlplus.enabled !== false;
      if (!next.dlplus) next.dlplus = {};
      next.dlplus.enabled = patch.dlplus.enabled;
      // If DL+ enabled state changed, force immediate DLS rewrite on next metadata tick
      if (dlplusPrev !== dlplusNext) {
        const rt = this.serviceRuntime.get(id);
        if (rt) { rt.lastMetaUpdateMs = 0; rt.currentDls = ''; }
      }
    }
    if (patch.watchdog) {
      if (typeof patch.watchdog.enabled === 'boolean') next.watchdog.enabled = patch.watchdog.enabled;
      if (Number.isInteger(patch.watchdog.silenceThresholdSec)) next.watchdog.silenceThresholdSec = patch.watchdog.silenceThresholdSec;
      if (Number.isInteger(patch.watchdog.warningThresholdSec)) next.watchdog.warningThresholdSec = patch.watchdog.warningThresholdSec;
      if (typeof patch.watchdog.switchToBackupOnSilence === 'boolean') next.watchdog.switchToBackupOnSilence = patch.watchdog.switchToBackupOnSilence;
      if (Number.isInteger(patch.watchdog.returnToMainAfterSec)) next.watchdog.returnToMainAfterSec = patch.watchdog.returnToMainAfterSec;
    }

    // Editable ONLY when stopped (locked during ON AIR)
    if (!locked) {
      if (patch.identity) {
        if (patch.identity.pi) {
          const piRaw = String(patch.identity.pi).replace(/^0x/i, '').toUpperCase();
          next.identity.pi = piRaw;
          next.identity.serviceIdHex = `0x${piRaw}`;
          // Update service ID to match new PI (for MOT directory consistency)
          if (piRaw.length === 4) {
            next.id = piRaw;
          }
        }
        next.identity.ps8 = patch.identity.ps8 ?? next.identity.ps8;
        next.identity.ps16 = patch.identity.ps16 ?? next.identity.ps16;
      }
      if (patch.dab) {
        if (Number.isInteger(patch.dab.bitrateKbps)) {
          if (!ALLOWED_BITRATES_KBPS.includes(patch.dab.bitrateKbps)) {
            throw new Error(`Bitrate not allowed: ${patch.dab.bitrateKbps}`);
          }
          next.dab.bitrateKbps = patch.dab.bitrateKbps;
        }
        if (Number.isInteger(patch.dab.protectionLevel)) {
          next.dab.protectionLevel = patch.dab.protectionLevel;
        }
        if (typeof patch.dab.eepMode === 'string') next.dab.eepMode = patch.dab.eepMode;
        if (Number.isInteger(patch.dab.padSize)) next.dab.padSize = patch.dab.padSize;
      }

      if (patch.audio) {
        if (Number.isInteger(patch.audio.sampleRateHz)) next.audio.sampleRateHz = patch.audio.sampleRateHz;
        if (typeof patch.audio.codec === 'string') next.audio.codec = patch.audio.codec;
      }

      if (patch.input) {
        if (Number.isInteger(patch.input.zmqBuffer)) next.input.zmqBuffer = patch.input.zmqBuffer;
        if (Number.isInteger(patch.input.zmqPrebuffering)) next.input.zmqPrebuffering = patch.input.zmqPrebuffering;
      }

      // Mux input port (written to the .mux; for ZMQ/EDI direct it is the port the external encoder sends to)
      if (patch.network?.ediOutputTcp?.port != null) {
        const port = this._checkInputPort(patch.network.ediOutputTcp.port, existing.id);
        next.network = { ...next.network, ediOutputTcp: { ...next.network?.ediOutputTcp, port } };
      }
    }

    const { errors, warnings, normalized } = validateService(next, ALLOWED_BITRATES_KBPS);
    if (errors.length) throw new Error(errors.join(' '));
    if (warnings?.length) {
      warnings.forEach(w => this.logger.line('service', `${next.id}: ${w}`, 'WARN'));
    }

    // CRITICAL: Check if PID changed (only allowed when mux is stopped)
    const pidChanged = existing.id !== normalized.id;
    if (pidChanged) {
      // Check if another service already uses this PID
      const collision = this.preset.services.find((s) => s.id === normalized.id && s.id !== existing.id);
      if (collision) {
        throw new Error(`Service ID ${normalized.id.toUpperCase()} already exists in multiplex`);
      }

      // Check if target directory already exists
      const newMotDir = path.resolve(this.dataDir, 'mot', normalized.id.toUpperCase());
      if (fs.existsSync(newMotDir)) {
        throw new Error(`MOT directory ${normalized.id.toUpperCase()} already exists`);
      }

      // Rename MOT directory if it exists
      const oldMotDir = path.resolve(this.dataDir, 'mot', existing.id.toUpperCase());
      if (fs.existsSync(oldMotDir)) {
        try {
          fs.renameSync(oldMotDir, newMotDir);
          this.logger.line(`svc:${id}`, `renamed MOT directory: ${existing.id.toUpperCase()} → ${normalized.id.toUpperCase()}`);
        } catch (err) {
          throw new Error(`Failed to rename MOT directory: ${err.message}`);
        }
      }

      // Update pad paths to match new ID
      normalized.pad.fifoName = normalized.id.toUpperCase();
      normalized.pad.dlsFile = `${normalized.id.toUpperCase()}.dls`;
      normalized.pad.motDir = `mot/${normalized.id.toUpperCase()}`;

      // Update serviceRuntime map (move runtime state to new ID)
      const rt = this.serviceRuntime.get(existing.id);
      if (rt) {
        this.serviceRuntime.delete(existing.id);
        this.serviceRuntime.set(normalized.id, rt);
      }

      this.logger.line(`svc:${id}`, `service ID changed: ${existing.id} → ${normalized.id}`);
    }

    // Detect if encoder needs restart (mode or URI changed while ON AIR)
    const uriChanged = existing.input.uri !== normalized.input.uri;
    const modeChanged = existing.input.mode !== normalized.input.mode;
    const needRestart = locked && (modeChanged || uriChanged);
    // ON AIR gain change: restart only this service's encoder, on its active stream (same
    // in-place restart as the watchdog) — the mux and the other services keep running.
    const gainChanged = (existing.audio?.gainDb ?? 0) !== (normalized.audio?.gainDb ?? 0);
    const gainRestart = locked && !needRestart && gainChanged && this.pm.isRunning(`svc:${id}:audioenc`);

    this.logger.line(`svc:${id}`, `setService: locked=${locked} uriChanged=${uriChanged} (${existing.input.uri} => ${normalized.input.uri}) needRestart=${needRestart}`, 'DEBUG');

    // ON AIR: these fields are saved now but only reach the encoder/mux at the next encoder
    // restart or mux Start. Expose them as rt.pendingRestart for a UI hint (display only).
    // rt is rebuilt by _initRuntime() at startMux(), which clears the hint.
    if (locked) {
      const rt = this.serviceRuntime.get(normalized.id);
      if (rt) {
        const pick = (s) => ({ enabled: s.enabled, gainDb: s.audio?.gainDb, channels: s.audio?.channels,
          encoderBufferMs: s.input?.encoderBufferMs, pty: s.identity?.pty, languageHex: s.identity?.languageHex });
        const cur = pick(normalized);
        if (!rt.appliedConfig) rt.appliedConfig = pick(existing);
        if ((needRestart || gainRestart) && this.pm.isRunning(`svc:${id}:audioenc`)) {
          // encoder restarts below with the new config → encoder-level fields get applied
          Object.assign(rt.appliedConfig, { gainDb: cur.gainDb, channels: cur.channels, encoderBufferMs: cur.encoderBufferMs });
        }
        rt.pendingRestart = Object.keys(cur).filter((k) => cur[k] !== rt.appliedConfig[k]);
      }
    }

    this.preset.services[idx] = normalized;
    this._savePreset();

    if (needRestart && this.pm.isRunning(`svc:${id}:audioenc`)) {
      this.logger.line(`svc:${id}`, `input changed while ON AIR — restarting encoder`);
      this._switchServiceUri(normalized, normalized.input.uri);
    }
    if (gainRestart) {
      const rt = this.serviceRuntime.get(normalized.id);
      this.logger.line(`svc:${id}`, `audio gain changed while ON AIR (${existing.audio?.gainDb ?? 0} → ${normalized.audio?.gainDb ?? 0} dB) — restarting encoder only`);
      this._switchServiceUri(normalized, rt?.activeUri || normalized.input.uri).catch(() => { /* logged by _switchServiceUri */ });
    }

    // Download slide if slsUrl changed
    const oldSlsUrl = existing.metadata?.slsUrl || '';
    const newSlsUrl = normalized.metadata?.slsUrl || '';
    if (newSlsUrl && newSlsUrl !== oldSlsUrl) {
      this.downloadSlideForService(normalized).catch((err) => {
        this.logger.line('sls', `immediate slide download failed: ${err.message}`);
      });
    }

    return normalized;
  }

  addService(svc) {
    // ON AIR: the service is added OFF (enabled: false). It is not in the running .mux and every
    // ON AIR loop skips disabled services; the row ON/OFF button restarts the mux to put it on air.
    const addedOnAir = this.muxRunning;

    // Use PI code (hex, no 0x prefix) as service ID for readable MOT directory names
    const piHex = String(svc.identity?.pi || '').replace(/^0x/i, '').toUpperCase();
    const id = svc.id || (piHex.length === 4 ? piHex : nanoid(8));
    if (this.preset.services.some((s) => s.id === id)) {
      throw new Error('Service id already exists');
    }

    const newSvc = {
      id,
      enabled: !addedOnAir,
      identity: {
        pi: svc.identity?.pi || '0000',
        serviceIdHex: svc.identity?.serviceIdHex || `0x${svc.identity?.pi || '0000'}`,
        ps8: svc.identity?.ps8 || 'RADIO',
        ps16: svc.identity?.ps16 || null,
        languageHex: svc.identity?.languageHex || '0x0F',
        pty: Number.isInteger(svc.identity?.pty) ? svc.identity.pty : 10
      },
      dab: {
        bitrateKbps: ALLOWED_BITRATES_KBPS.includes(svc.dab?.bitrateKbps) ? svc.dab.bitrateKbps : DEFAULT_BITRATE_KBPS,
        protectionLevel: Number.isInteger(svc.dab?.protectionLevel) ? svc.dab.protectionLevel : 3,
        eepMode: svc.dab?.eepMode || 'A',
        padSize: Number.isInteger(svc.dab?.padSize) ? svc.dab.padSize : 58
      },
      input: {
        mode: svc.input?.mode || 'GSTREAMER',
        uri: svc.input?.uri || null,
        backupUri: svc.input?.backupUri || null,
        zmqBuffer: Number.isInteger(svc.input?.zmqBuffer) ? svc.input.zmqBuffer : DEFAULT_ZMQ_BUFFER,
        zmqPrebuffering: Number.isInteger(svc.input?.zmqPrebuffering) ? svc.input.zmqPrebuffering : DEFAULT_ZMQ_PREBUFFER,
        encoderBufferMs: Number.isInteger(svc.input?.encoderBufferMs) ? svc.input.encoderBufferMs : 200
      },
      audio: {
        channels: Number.isInteger(svc.audio?.channels) ? svc.audio.channels : 2,
        sampleRateHz: Number.isInteger(svc.audio?.sampleRateHz) ? svc.audio.sampleRateHz : 48000,
        gainDb: typeof svc.audio?.gainDb === 'number' ? svc.audio.gainDb : 0,
        codec: svc.audio?.codec || 'HE-AAC v1 (SBR)'
      },
      pad: {
        enabled: true,
        fifoName: id.toUpperCase(),
        dlsFile: `${id.toUpperCase()}.dls`,
        slideDir: 'slide',
        motDir: `./data/mot/${id.toUpperCase()}`,
        sls: { enabled: true, logoPath: null }
      },
      network: {
        ediOutputTcp: {
          host: '127.0.0.1',
          port: svc.network?.ediOutputTcp?.port != null ? this._checkInputPort(svc.network.ediOutputTcp.port) : this._pickFreePort()
        }
      },
      watchdog: {
        enabled: true,
        silenceThresholdSec: 10,
        warningThresholdSec: 5,
        switchToBackupOnSilence: true,
        returnToMainAfterSec: 60
      },
      metadata: {
        mode: 'NONE',
        intervalSec: 10,
        url: null,
        artistKey: 'artist',
        titleKey: 'title',
        slsKey: 'slide',
        defaultDls: '',
        slsUrl: null,
        slsBackColor: '',
        slsFontColor: '',
        defaultDlsAllowed: true,
        defaultSlsAllowed: true,
        dlsIncluded: false
      },
      ui: {
        order: this.preset.services.length + 1
      },
      dlplus: {
        enabled: true,
        offsetMode: 'bytes',
        maxLen: 128
      }
    };

    const { errors, warnings, normalized } = validateService(newSvc, ALLOWED_BITRATES_KBPS);
    if (errors.length) throw new Error(errors.join(' '));
    if (warnings?.length) {
      warnings.forEach(w => this.logger.line('service', `${newSvc.id}: ${w}`, 'WARN'));
    }

    this.preset.services.push(normalized);
    this.serviceRuntime.set(normalized.id, {
      status: 'STOPPED',
      activeUri: normalized.input.uri,
      lastOkMainMs: 0,
      lastOkBackupMs: 0,
      lastSwitchMs: 0,
      failuresSinceMs: 0,
      lastMetaUpdateMs: 0,
      currentDls: '',
      currentSlsUrl: '',
      dlplusActive: false,
      warningSinceMs: 0
    });
    this._savePreset();

    // Download slide immediately if slsUrl is set
    if (normalized.metadata?.slsUrl) {
      this.downloadSlideForService(normalized).catch((err) => {
        this.logger.line('sls', `immediate slide download failed: ${err.message}`);
      });
    }

    return normalized;
  }

  deleteService(id) {
    const idx = this.preset.services.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const svc = this.preset.services[idx];
    // ON AIR: only an OFF service (not in the running .mux, no encoder) can be deleted
    if (this.muxRunning && (svc.enabled !== false || this.pm.isRunning(`svc:${id}:audioenc`) || this.pm.isRunning(`svc:${id}:padenc`))) {
      throw new Error('Cannot delete a service that is ON while ON AIR — turn it OFF first');
    }

    // Clean up MOT directory (slides, DLS, fifo)
    try {
      const motDirAbs = this._resolveMotDir(svc);
      if (fs.existsSync(motDirAbs)) {
        fs.rmSync(motDirAbs, { recursive: true, force: true });
        this.logger.line(`svc:${id}`, `deleted MOT directory: ${motDirAbs}`);
      }
    } catch (err) {
      this.logger.line(`svc:${id}`, `failed to delete MOT directory: ${err.message}`);
    }

    this.preset.services.splice(idx, 1);
    this.serviceRuntime.delete(id);
    this._savePreset();
  }

  reorderServices(orderedIds) {
    // Reorder services based on array of IDs
    if (!Array.isArray(orderedIds)) {
      throw new Error('Order must be an array of service IDs');
    }

    // Physically reorder the services array according to orderedIds
    const reordered = [];
    orderedIds.forEach((id, index) => {
      const svc = this.preset.services.find((s) => s.id === id);
      if (svc) {
        if (!svc.ui) svc.ui = {};
        svc.ui.order = index + 1;
        reordered.push(svc);
      }
    });

    // Replace services array with reordered array
    this.preset.services = reordered;
    this._savePreset();
    this.logger.line('preset', `services reordered: ${orderedIds.join(', ')}`);
  }

  // Two services on the same mux input port make odr-dabmux fail ("Could not bind").
  // Keep the port of the first one (multiplex order) and give the others a free port.
  _repairDuplicatePorts() {
    const seen = new Set();
    const sorted = [...(this.preset?.services || [])].sort((a, b) => (a.ui?.order ?? 0) - (b.ui?.order ?? 0));
    let changed = 0;
    for (const s of sorted) {
      const port = s.network?.ediOutputTcp?.port;
      if (!seen.has(port)) { seen.add(port); continue; }
      const newPort = this._pickFreePort();
      s.network = { ...s.network, ediOutputTcp: { ...s.network?.ediOutputTcp, port: newPort } };
      seen.add(newPort);
      changed++;
      this.logger.line('service', `${s.id}: duplicate input port ${port} — reassigned to ${newPort}`, 'WARN');
    }
    if (changed) this._savePreset();
    return changed;
  }

  // Validate a service mux input port: integer 1024–65535, not used by another service.
  _checkInputPort(value, exceptId = null) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`Invalid input port: ${value} (1024–65535)`);
    }
    const other = this.preset.services.find((s) => s.id !== exceptId && s.network?.ediOutputTcp?.port === port);
    if (other) throw new Error(`Port ${port} is already used by ${other.identity?.ps8 || other.id}`);
    return port;
  }

  _pickFreePort() {
    // naive: pick next after max current
    const ports = this.preset.services.map((s) => s.network.ediOutputTcp.port);
    const max = ports.length ? Math.max(...ports) : 9000;
    return max + 1;
  }

  _resolveMotDir(svc) {
    const fifoName = svc.pad?.fifoName || svc.identity?.ps8 || svc.id;
    const motDir = svc.pad?.motDir || `mot/${fifoName}`;
    if (path.isAbsolute(motDir)) return motDir;
    const cleaned = motDir.replace(/^[./]*/, '');
    if (cleaned.startsWith('data/mot/')) {
      return path.resolve(this.dataDir, cleaned.slice('data/'.length));
    }
    if (cleaned.startsWith('mot/')) {
      return path.resolve(this.dataDir, cleaned);
    }
    return path.resolve(this.dataDir, 'mot', cleaned);
  }

  _getMtaPath(svc) {
    const pi = (svc.identity?.pi || svc.id || 'service').toUpperCase().replace(/^0X/, '');
    return path.resolve(this.runtimeDir, `${pi}.mta`);
  }

  /**
   * Get absolute path to DLS runtime file for a service.
   * Returns: data/runtime/<PI>.dls
   */
  _getDlsRuntimePath(svc) {
    const pi = (svc.identity?.pi || svc.id || 'service').toUpperCase().replace(/^0X/, '');
    return path.resolve(this.runtimeDir, `${pi}.dls`);
  }

  /**
   * Write DLS file with optional DL+ support.
   * If DL+ is enabled, parses "Artist - Title" and generates DL+ tags.
   * Otherwise, writes plain DLS text.
   */
  _writeDlsFile(svc, dlsValue) {
    const dlsPath = this._getDlsRuntimePath(svc);
    const dlplusEnabled = svc.dlplus?.enabled !== false;

    let content = dlsValue || '';

    let dlplusActive = false;
    if (dlplusEnabled && content) {
      // Parse "Artist - Title" format
      const { artist, title } = parseNowPlaying(content);

      if (artist && title) {
        // Generate DL+ content with tags (without homepage URL)
        content = buildDlPlusFileContent({
          artist,
          title,
          url: '',  // Homepage URL removed per user request
          offsetMode: svc.dlplus?.offsetMode || 'bytes',
          maxPayloadLen: svc.dlplus?.maxLen || 128
        });
        dlplusActive = true;
      }
      // If parsing failed (no artist/title), fall back to plain DLS
    }

    // Update runtime DL+ status
    const rt = this.serviceRuntime.get(svc.id);
    if (rt) rt.dlplusActive = dlplusActive;

    // Write file atomically only if changed
    try {
      writeTextFileAtomicIfChanged(dlsPath, content);
    } catch (err) {
      this.logger.line('dls', `Failed to write DLS file ${dlsPath}: ${err.message}`, 'ERROR');
    }
  }

  _extractXmlValue(xml, key) {
    if (!xml || !key) return '';
    const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<${escKey}>(?:<!\\[CDATA\\[)?([^<]*)(?:\\]\\]>)?<\\/${escKey}>`, 'i');
    const match = xml.match(re);
    return match ? String(match[1] || '').trim() : '';
  }

  async _fetchText(url, timeoutMs = 2500) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return '';
      // Server-Sent Events feeds (text/event-stream, e.g. lorfm.com/ws/metas) never end: read up to
      // the first event carrying data and return that data (the JSON), then close the connection
      if (/text\/event-stream/i.test(res.headers.get('content-type') || '')) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true }).replace(/\r/g, '');
            const events = buf.split('\n\n');
            for (const ev of events.slice(0, -1)) {   // complete events only
              const data = ev.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
              if (data.length && data.join('').trim()) return data.join('\n');
            }
          }
        } finally {
          reader.cancel().catch(() => {});
        }
        return '';
      }
      return await res.text();
    } catch {
      return '';
    } finally {
      clearTimeout(t);
    }
  }

  async _downloadImage(url, destPath, timeoutMs = 5000) {
    // Handle data: URLs (base64-encoded images from the frontend)
    const dataMatch = url.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
    if (dataMatch) {
      try {
        const buf = Buffer.from(dataMatch[2], 'base64');
        fs.writeFileSync(destPath, buf);
        return true;
      } catch (err) {
        this.logger.line('sls', `data: URL decode error: ${err.message}`, 'ERROR');
        return false;
      }
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        this.logger.line('sls', `download failed ${url}: HTTP ${res.status}`, 'WARN');
        return false;
      }
      // size limit while reading (a cover / logo is a few hundred kB): a huge or endless answer from a
      // metadata API must not fill the memory (Raspberry Pi)
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared > MAX_IMAGE_BYTES) throw new Error(`image too large (${Math.round(declared / 1048576)} MB, max ${MAX_IMAGE_BYTES / 1048576} MB)`);
      const chunks = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) { ctrl.abort(); throw new Error(`image too large (max ${MAX_IMAGE_BYTES / 1048576} MB)`); }
        chunks.push(chunk);
      }
      fs.writeFileSync(destPath, Buffer.concat(chunks));
      return true;
    } catch (err) {
      this.logger.line('sls', `download error ${url}: ${err.message}`, 'ERROR');
      return false;
    } finally {
      clearTimeout(t);
    }
  }

  async testDlsUrl(url, timeoutMs = 2500) {
    if (!url) return { ok: false, text: '' };
    const text = await this._fetchText(url, timeoutMs);
    const line = text.split('\n')[0]?.trim() || '';
    return { ok: Boolean(line), text: line };
  }

  async testSlsUrl(url, timeoutMs = 4000) {
    if (!url) return { ok: false, error: 'URL required' };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const contentType = res.headers.get('content-type') || 'image/jpeg';
      if (contentType.includes('svg')) return { ok: false, error: 'SVG non supporté par odr-padenc (JPEG/PNG uniquement)' };
      const arr = await res.arrayBuffer();
      const bytes = arr.byteLength;
      if (bytes > 500 * 1024) return { ok: false, error: `Image too large: ${Math.round(bytes / 1024)} KB (max 500 KB)` };
      const b64 = Buffer.from(arr).toString('base64');
      return { ok: true, dataUrl: `data:${contentType};base64,${b64}`, contentType, bytes };
    } catch (err) {
      return { ok: false, error: err.name === 'AbortError' ? 'Timeout (4s)' : String(err.message || err) };
    } finally {
      clearTimeout(t);
    }
  }

  _getCodecArgs(codec) {
    const label = String(codec || 'HE-AAC v1 (SBR)').toUpperCase();
    if (label.includes('AAC-LC')) return [];
    if (label.includes('V2') || label.includes('PS')) return ['--ps'];
    return ['--sbr'];
  }

  _copyDefaultSls(slideDir) {
    // If logo.jpg already exists (created via downloadSlideForService), do nothing
    const logoJpg = path.resolve(slideDir, 'logo.jpg');
    if (fs.existsSync(logoJpg)) return;

    // Otherwise, look for logo.png or logo.webp and convert to logo.jpg
    const candidates = [
      path.resolve(slideDir, 'logo.png'),
      path.resolve(slideDir, 'logo.webp')
    ];
    const logo = candidates.find((p) => fs.existsSync(p));
    if (!logo) return;
    try {
      this._convertToSlide(logo, logoJpg);
    } catch {
      // fallback: direct copy
      try { fs.copyFileSync(logo, logoJpg); } catch { /* ignore */ }
    }
  }

  /**
   * Convert any image to JPEG 320x240 using ImageMagick.
   * odr-padenc works best with JPEG slides at 320x240.
   */
  _convertToSlide(srcPath, destPath) {
    if (!this._imgBinLogged) {
      try {
        const out = execFileSync('which', ['convert'], { encoding: 'utf8', timeout: 2000 }).trim();
        this.logger.line('img', `ImageMagick binary: ${out}`);
      } catch {
        this.logger.line('img', 'ImageMagick binary: NOT FOUND', 'ERROR');
      }
      this._imgBinLogged = true;
    }
    try {
      // 320x240 JPEG, side bands in the picture's own edge colours (slideImage.js)
      convertSlideImage(srcPath, destPath);
      return true;
    } catch (err) {
      this.logger.line('sls', `convert error: ${err.message}`, 'ERROR');
      return false;
    }
  }

  /**
   * Download and convert SLS image for a service (can be called outside ON AIR).
   * Returns true if a slide was saved.
   */
  async downloadSlideForService(svc) {
    const slsUrl = String(svc.metadata?.slsUrl || '').trim();
    if (!slsUrl) return false;

    // Reject SVG
    if (/^data:image\/svg/i.test(slsUrl) || /\.svg(\?.*)?$/i.test(slsUrl)) {
      this.logger.line('sls', `SVG not supported by odr-padenc: ${slsUrl.slice(0, 80)}`);
      return false;
    }

    const motDirAbs = this._resolveMotDir(svc);
    const slideDir = path.resolve(motDirAbs, svc.pad?.slideDir || 'slide');
    ensureDir(motDirAbs);
    ensureDir(slideDir);

    // Download to a temp file first, then convert to logo.jpg (permanent station logo)
    this._logMeta(svc, 'sls', `download logo: ${slsUrl.slice(0, 120)}`);
    const tmpPath = path.resolve(slideDir, 'logo_tmp');
    const ok = await this._downloadImage(slsUrl, tmpPath);
    if (!ok) {
      this._logMeta(svc, 'err', `logo download failed: ${slsUrl.slice(0, 120)}`, 'WARN');
      return false;
    }

    const destPath = path.resolve(slideDir, 'logo.jpg');
    const converted = this._convertToSlide(tmpPath, destPath);

    // Clean up temp file
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

    this._logMeta(svc, 'img', converted ? `resize OK -> ${destPath}` : `resize FAIL -> ${destPath}`, converted ? undefined : 'WARN');
    return converted;
  }

  _startMetadataLoop() {
    if (this.metadataTimer) return;
    this.metadataTimer = setInterval(() => {
      this._updateMetadata().catch((err) => {
        this.logger.line('metadata', `update error: ${String(err?.message || err)}`);
      });
    }, 1000);
  }

  _stopMetadataLoop() {
    if (this.metadataTimer) {
      clearInterval(this.metadataTimer);
      this.metadataTimer = null;
    }
  }

  async _updateMetadata() {
    if (!this.muxRunning) return;
    const now = Date.now();
    for (const svc of this.preset.services.filter((s) => s.enabled)) {
      // ZMQ/EDI direct inputs: DLS / DL+ / slides come from the remote encoder (no padenc here)
      if (['ZMQ', 'EDI'].includes(String(svc.input?.mode || '').toUpperCase())) continue;
      const rt = this.serviceRuntime.get(svc.id);
      if (!rt) continue;
      // 'Refresh (sec)' is the polling period of a remote URL (JSON / XML / FILE). STREAM reads the
      // local ICY file and NONE a fixed text: short fixed period, whatever the hidden JSON setting.
      const mode = String(svc.metadata?.mode || 'NONE').toUpperCase();
      const intervalSec = ['JSON', 'XML', 'FILE'].includes(mode) ? Number(svc.metadata?.intervalSec ?? 10) : META_LOCAL_INTERVAL_SEC;
      const intervalMs = Math.max(1, intervalSec) * 1000;
      if (rt.lastMetaUpdateMs && now - rt.lastMetaUpdateMs < intervalMs) {
        // logo every N s during a cover: on-air dir checked each second (readdir + stat, copies only on change)
        if (Number(svc.metadata?.logoEverySec ?? LOGO_EVERY_DEFAULT_SEC) > 0) this._syncAirSlides(svc);
        continue;
      }
      rt.lastMetaUpdateMs = now;
      await this._updateServiceMetadata(svc, rt);
    }
  }

  /**
   * On-air slide directory given to odr-padenc: mot/<PI>/air.
   * odr-padenc sends every image of its directory in turn, with no priority. While the current
   * track has a cover (JSON mode → slide/cover.jpg) only the cover is put on air, so receivers keep
   * showing it; otherwise the station logos (slide/ minus cover.jpg) rotate as before.
   * slide/ stays the source of truth (UI, uploads, exports). Copies go through a temp file outside
   * the air dir + rename (odr-padenc reads every file there). Returns the directory for -d; on any
   * error, slide/ itself (previous behaviour).
   */
  /**
   * Which slides go on air. No cover: every logo of slide/. Track cover: the cover alone, except
   * that with metadata.logoEverySec > 0 one logo (in turn) replaces it every N seconds, just long
   * enough to be sent once (size / PAD throughput + margin). A new cover always goes first and
   * restarts the count, so a logo never cuts a cover that has just arrived.
   */
  _airChoice(svc, slideDir, src) {
    // logo.jpg first, then logo_1, logo_2 … logo_10 in numeric order
    const logos = src.filter((f) => f !== 'cover.jpg').sort((a, b) => (a === 'logo.jpg' ? -1 : b === 'logo.jpg' ? 1 : a.localeCompare(b, undefined, { numeric: true })));
    if (!src.includes('cover.jpg')) return logos;
    const rt = this.serviceRuntime.get(svc.id);
    const every = Number(svc.metadata?.logoEverySec ?? LOGO_EVERY_DEFAULT_SEC) || 0;   // explicit 0 = cover only
    if (!rt || every <= 0 || !logos.length) return ['cover.jpg'];
    const now = Date.now();
    const coverMtime = fs.statSync(path.join(slideDir, 'cover.jpg')).mtimeMs;
    if (rt.airCoverMtime !== coverMtime) {          // new cover (new track): cover first, count restarts
      rt.airCoverMtime = coverMtime;
      rt.airLogoPhaseStartMs = now;
      rt.airLogoPhaseUntilMs = 0;
      return ['cover.jpg'];
    }
    if (rt.airLogoPhaseUntilMs && now < rt.airLogoPhaseUntilMs) return [rt.airLogoName];
    if (now - (rt.airLogoPhaseStartMs || 0) >= every * 1000) {
      rt.airLogoIdx = ((rt.airLogoIdx ?? -1) + 1) % logos.length;
      rt.airLogoName = logos[rt.airLogoIdx];
      // time to send it once: X-PAD ≈ PAD bytes × ~24 AU/s (≈ 1.4 kB/s with PAD 58), + margin
      const bytesPerSec = Math.max(200, (Number(svc.dab?.padSize) || 58) * 24);
      const size = fs.statSync(path.join(slideDir, rt.airLogoName)).size;
      rt.airLogoPhaseStartMs = now;
      rt.airLogoPhaseUntilMs = now + Math.max(6000, Math.ceil(size / bytesPerSec * 1000) + 4000);
      return [rt.airLogoName];
    }
    return ['cover.jpg'];
  }

  _syncAirSlides(svc) {
    const motDirAbs = this._resolveMotDir(svc);
    const slideDir = path.resolve(motDirAbs, svc.pad?.slideDir || 'slide');
    const airDir = path.resolve(motDirAbs, 'air');
    try {
      ensureDir(airDir);
      const isImg = (f) => /\.(jpe?g|png|webp)$/i.test(f);
      const src = fs.readdirSync(slideDir).filter((f) => isImg(f) && fs.statSync(path.join(slideDir, f)).isFile());
      const want = this._airChoice(svc, slideDir, src);
      for (const f of want) {
        const from = path.join(slideDir, f);
        const to = path.join(airDir, f);
        const a = fs.statSync(from);
        let b = null;
        try { b = fs.statSync(to); } catch { /* not copied yet */ }
        if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) continue;
        const tmp = path.join(motDirAbs, `.air_${f}`);
        fs.copyFileSync(from, tmp);
        fs.renameSync(tmp, to);
      }
      for (const f of fs.readdirSync(airDir)) {
        if (!want.includes(f)) { try { fs.unlinkSync(path.join(airDir, f)); } catch { /* ignore */ } }
      }
      const rt = this.serviceRuntime.get(svc.id);
      if (rt) rt.airSlides = want;   // what odr-padenc sends now (UI hint)
      return airDir;
    } catch (err) {
      this.logger.line(`svc:${svc.id}`, `on-air slides sync failed, using slide/: ${err.message}`, 'WARN');
      return slideDir;
    }
  }

  async _updateServiceMetadata(svc, rt) {
    const mode = String(svc.metadata?.mode || 'NONE').toUpperCase();

    const motDirAbs = this._resolveMotDir(svc);
    const slideDir = path.resolve(motDirAbs, svc.pad?.slideDir || 'slide');
    ensureDir(motDirAbs);
    ensureDir(slideDir);

    let dlsValue = '';
    let slsUrl = '';
    const defaultDlsAllowed = svc.metadata?.defaultDlsAllowed !== false;
    const defaultSlsAllowed = svc.metadata?.defaultSlsAllowed !== false;

    // Cleanup cover.jpg when mode is not JSON
    if (mode !== 'JSON') {
      const coverPath = path.resolve(slideDir, 'cover.jpg');
      if (safeExists(coverPath)) {
        try { fs.unlinkSync(coverPath); } catch { /* ignore */ }
        this._logMeta(svc, 'cleanup', `removed cover.jpg (mode=${mode})`);
      }
    }

    // DLS metadata extraction per mode
    // result of this update, for the 'On air now' panel (rt.metaStatus, UI only)
    let metaStatus = { ok: true, msg: mode.toLowerCase() };
    if (mode === 'NONE') {
      // Manual mode: the DLS text entered by the user, unless 'Show default DLS' is No
      dlsValue = defaultDlsAllowed ? (svc.metadata?.defaultDls || '') : '';
      metaStatus = { ok: true, msg: dlsValue ? 'manual text' : 'manual text switched off' };
    } else if (mode === 'STREAM') {
      const mtaPath = this._getMtaPath(svc);
      if (fs.existsSync(mtaPath)) {
        const line = fs.readFileSync(mtaPath, 'utf8').split('\n')[0] || '';
        dlsValue = line.trim();
      }
      metaStatus = { ok: true, msg: dlsValue ? 'title from the stream (ICY)' : 'no title in the stream → default text' };
      if (!dlsValue && defaultDlsAllowed) dlsValue = svc.metadata?.defaultDls || '';
    } else if (mode === 'FILE') {
      const src = String(svc.metadata?.url || '');
      if (src.startsWith('http://') || src.startsWith('https://')) {
        dlsValue = (await this._fetchText(src)).trim();
      } else if (src) {
        if (fs.existsSync(src)) {
          dlsValue = fs.readFileSync(src, 'utf8').split('\n')[0]?.trim() || '';
        }
      }
      if (!dlsValue && defaultDlsAllowed) dlsValue = svc.metadata?.defaultDls || '';
    } else if (mode === 'JSON') {
      const url = String(svc.metadata?.url || '');
      metaStatus = { ok: false, msg: 'no JSON URL' };
      if (url) {
        this._logMeta(svc, 'json', 'fetch URL OK', 'DEBUG');
        const text = await this._fetchText(url);
        if (!text) {
          this._logMeta(svc, 'err', 'empty response from URL', 'WARN');
          metaStatus = { ok: false, msg: 'no answer from the JSON URL (or empty)' };
        } else {
          try {
            const data = JSON.parse(text);
            const artistKey = svc.metadata?.artistKey || 'artist';
            const titleKey = svc.metadata?.titleKey || 'title';
            const slsKey = svc.metadata?.slsKey || 'slide';
            const artist = resolveFirst(data, artistKey);
            const title = resolveFirst(data, titleKey);
            dlsValue = [artist, title].filter(Boolean).join(' - ');
            let coverUrl = resolveFirst(data, slsKey);
            this._logMeta(svc, 'json', `artist=${artist ? 'OK' : 'none'} title=${title ? 'OK' : 'none'} cover=${coverUrl ? 'yes' : 'none'}`);
            metaStatus = { ok: Boolean(artist || title), msg: `JSON: artist ${artist ? '✓' : '✗'} · title ${title ? '✓' : '✗'} · cover ${coverUrl ? '✓' : '✗'}` };
            // Track over (ad / jingle while the API still returns the last song): logo + default text
            if (dlsValue) {
              if (rt.trackKey !== dlsValue) { rt.trackKey = dlsValue; rt.trackFirstSeenMs = Date.now(); rt.trackOverLogged = false; }
              // configured keys first, else the usual fields next to the title (start, duration, type)
              const near = (key, kind) => (key ? resolveFirst(data, key) : findNearTitle(data, titleKey, kind));
              const itemType = classifyItemType(near(svc.metadata?.typeKey, 'type'));
              const durationMs = parseDurationMs(near(svc.metadata?.durationKey, 'duration'));
              const end = trackEndMs({
                startMs: parseTimeMs(near(svc.metadata?.startKey, 'start')),
                durationMs,
                firstSeenMs: rt.trackFirstSeenMs,
                maxMin: svc.metadata?.trackMaxMin ?? 8,
                itemType,
              });
              if (end != null && Date.now() > end) {
                const why = durationMs != null ? 'duration elapsed' : itemType === 'ad' ? 'ad / jingle' : `song longer than ${svc.metadata?.trackMaxMin ?? 8} min`;
                if (!rt.trackOverLogged) {
                  rt.trackOverLogged = true;
                  this._logMeta(svc, 'json', `item over (${why}): "${dlsValue}" → logo and default DLS until the next item`);
                }
                metaStatus = { ok: true, msg: `item over (${why}) → logo and default text until the next item` };
                dlsValue = '';
                coverUrl = '';
              }
            }
            if (coverUrl) {
              slsUrl = coverUrl;
              // Re-download when URL changes OR when DLS changes (same URL, new song)
              const dlsChanged = dlsValue && dlsValue !== rt.currentDls;
              if (coverUrl !== rt.currentSlsUrl || dlsChanged) {
                this._logMeta(svc, 'sls', `download cover${dlsChanged ? ' (new track)' : ''}`, 'DEBUG');
                const tmpPath = path.resolve(slideDir, 'cover_tmp');
                const ok = await this._downloadImage(coverUrl, tmpPath);
                if (ok) {
                  const coverDest = path.resolve(slideDir, 'cover.jpg');
                  const converted = this._convertToSlide(tmpPath, coverDest);
                  this._logMeta(svc, 'img', converted ? 'resize OK' : 'resize FAIL', converted ? undefined : 'WARN');
                } else {
                  this._logMeta(svc, 'err', 'cover download failed', 'WARN');
                }
                try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
                rt.currentSlsUrl = coverUrl;
              }
            }
          } catch (err) {
            this._logMeta(svc, 'err', `json parse failed: ${String(err?.message || err)}`, 'WARN');
            metaStatus = { ok: false, msg: `invalid JSON: ${String(err?.message || err).slice(0, 80)}` };
          }
        }
      }
      // Cleanup cover.jpg when JSON fetch fails or returns no cover URL
      if (!slsUrl) {
        const coverPath = path.resolve(slideDir, 'cover.jpg');
        if (safeExists(coverPath)) {
          try { fs.unlinkSync(coverPath); } catch { /* ignore */ }
          this._logMeta(svc, 'cleanup', 'removed stale cover.jpg (no cover from JSON)');
        }
        if (rt.currentSlsUrl) {
          rt.currentSlsUrl = null;
        }
      }
      if (!dlsValue && defaultDlsAllowed) {
        dlsValue = svc.metadata?.defaultDls || '';
        if (dlsValue) this._logMeta(svc, 'json', `fallback DLS: "${dlsValue}"`);
      }
    } else if (mode === 'XML') {
      const url = String(svc.metadata?.url || '');
      const xml = url ? await this._fetchText(url) : '';
      if (xml) {
        const artistKey = svc.metadata?.artistKey || 'artist';
        const titleKey = svc.metadata?.titleKey || 'title';
        const slsKey = svc.metadata?.slsKey || 'slide';
        const artist = this._extractXmlValue(xml, artistKey);
        const title = this._extractXmlValue(xml, titleKey);
        dlsValue = [artist, title].filter(Boolean).join(' - ');
        slsUrl = this._extractXmlValue(xml, slsKey);
      }
      if (!dlsValue && defaultDlsAllowed) dlsValue = svc.metadata?.defaultDls || '';
    }

    // Override SLS URL from service config (works for ALL modes including NONE)
    if (svc.metadata?.slsUrl) {
      slsUrl = String(svc.metadata.slsUrl).trim();
    }

    rt.metaStatus = { ...metaStatus, at: Date.now() };

    // Write DLS file to runtime directory (with DL+ support if enabled)
    if (dlsValue !== rt.currentDls) {
      this._logMeta(svc, 'dls', `"${dlsValue}"`);
      this._writeDlsFile(svc, dlsValue);
      rt.currentDls = dlsValue;
    }

    // Download and convert SLS to 320x240 JPEG (skip for JSON — handled inline above)
    if (mode !== 'JSON') {
      if (slsUrl && slsUrl !== rt.currentSlsUrl) {
        const ok = await this.downloadSlideForService(svc);
        if (ok) {
          rt.currentSlsUrl = slsUrl;
        }
      } else if (!slsUrl && defaultSlsAllowed) {
        this._copyDefaultSls(slideDir);
      }
    }

    // put the new cover (or the logos again) on air
    this._syncAirSlides(svc);
  }

  // Local HackRF chain (odr-dabmod + hackrf_transfer): the HACKRF mode (settings.dabmux.hackrf,
  // EDI port ediTcpListenPort) or the HackRF output of the NETWORK mode (its own settings and
  // port). null = no local HackRF chain.
  _localHackrf() {
    const dm = this.settings.dabmux || {};
    const mode = String(dm.txMode || 'EASYDAB').toUpperCase();
    if (mode === 'HACKRF') return { hk: dm.hackrf || {}, ediPort: Number(dm.ediTcpListenPort) || 13000 };
    if (mode === 'NETWORK') {
      const o = localHackrfOutput(dm.outputs);
      if (o) return { hk: o, ediPort: o.port };
    }
    return null;
  }

  // true when the local SDR chain is odr-dabmod alone (SoapySDR, the 'sdr' output); false = hackrf_transfer
  _localSoapy() {
    return this._localHackrf()?.hk.type === 'sdr';
  }

  // Writes dabmod.ini and spawns the local modulator chain: odr-dabmod (+ hackrf_transfer unless SoapySDR).
  // Synchronous (throws on a bad setting). Called by startMux() and by the watchdog to restart a
  // broken / stalled chain without touching the encoders or odr-dabmux.
  _spawnLocalModulator(localHk) {
    const hk = localHk.hk;
    const dabBlock = hk.dabBlock || '7A';
    const freqHz = DAB_FREQ_TABLE[dabBlock];
    if (!freqHz) throw new Error(`Unknown DAB block: ${dabBlock}`);

    // numbers only: these values are written into dabmod.ini (the legacy HackRF settings are not normalized)
    const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);
    const rate = num(hk.rate, 0) || 4096000;
    const soapy = this._localSoapy();   // NETWORK 'sdr' output; HACKRF mode / 'hackrf' output = hackrf_transfer
    const fifoPath = path.resolve(this.runtimeDir, 'ofdm.fifo');
    const filtertapsPath = path.resolve(this.runtimeDir, 'filtertaps.txt');
    const dabmodIniPath = path.resolve(this.runtimeDir, 'dabmod.ini');

    // Copy filtertaps.txt to runtime dir (the .deb does not ship it: built-in default when absent)
    const srcFilterTaps = path.resolve(this.dataDir, 'filtertaps.txt');
    if (safeExists(srcFilterTaps)) fs.copyFileSync(srcFilterTaps, filtertapsPath);
    else fs.writeFileSync(filtertapsPath, DEFAULT_FILTERTAPS, 'utf8');

    // Create FIFO if not exists (hackrf_transfer chain only)
    if (!soapy && !safeExists(fifoPath)) {
      try { execFileSync('mkfifo', [fifoPath]); } catch (e) {
        throw new Error(`Failed to create FIFO ${fifoPath}: ${e.message}`);
      }
    }

    // Generate dabmod.ini
    const ediPort = localHk.ediPort;
    const dabmodConfig = buildDabModConfig({
      source: `tcp://localhost:${ediPort}`,
      maxFramesQueued: num(hk.maxFramesQueued, 0) || 580,
      gainmode: num(hk.gainmode, 2),
      digitalGain: num(hk.digitalGain, 1),
      rate,
      filtertapsPath,
      fifoPath,
      ...(soapy ? { soapy: { device: sdrDeviceString(hk), masterClockRate: hk.masterClockRate, txGain: hk.txGain, freqHz, bandwidth: hk.bandwidth, txAntenna: hk.txAntenna } } : {})
    });
    fs.writeFileSync(dabmodIniPath, dabmodConfig, 'utf8');
    this.logger.line('mux', `generated dabmod.ini: ${dabmodIniPath}`);

    // Start odr-dabmod
    this.pm.spawn('mux:odr-dabmod', 'odr-dabmod', [dabmodIniPath], {
      ...(soapy ? {
        onStderr: (line) => {
          if (/Error making SoapySDR device/i.test(line)) {   // once per failed start (not 'Cannot create…', same error)
            const msg = `SDR not detected (SoapySDR ${sdrDeviceString(hk)}) — check the device and its SoapySDR module`;
            if (this._modState?.failing) { this.logger.line('mux', `${msg} (retry ${this._modState.attempts})`, 'WARN'); return; }   // already reported
            this.logger.line('mux', msg, 'ERROR');
            if (!this._otherOutputsOn()) {   // other outputs on air: shown on the SDR output only
              this.lastError = msg;
              this.muxStatus = 'fail';
            }
          }
        }
      } : {}),
      onExit: (code) => {
        if (this.muxRunning && code !== 0) {
          // while the watchdog retries a broken chain: WARN (the failure was already reported as ERROR)
          this.logger.line('mux', `odr-dabmod crashed (code=${code})`, this._modState?.failing ? 'WARN' : 'ERROR');
        }
      }
    });
    this.logger.line('mux', `started odr-dabmod (block=${dabBlock}, freq=${freqHz}Hz${soapy ? `, SoapySDR ${sdrDeviceString(hk)}, txGain=${hk.txGain}` : ''})`);

    // Start hackrf_transfer (SoapySDR driver: none, odr-dabmod sends to the HackRF itself)
    if (!soapy) {
      const hackrfCmd = buildHackrfTransferCommand({
        fifoPath, freqHz, txGain: hk.txGain ?? 47, rate
      });
      this.pm.spawn('mux:hackrf_transfer', hackrfCmd.bin, hackrfCmd.args, {
        onStderr: (line) => {
          if (/hackrf.*not found/i.test(line)) {
            const msg = 'HackRF not detected — please connect HackRF device';
            // watchdog restart of the chain: keep the mux (and the other outputs) on air, retry later
            if (this._modState?.attempts) { this.logger.line('mux', `${msg} (retry ${this._modState.attempts})`, 'WARN'); return; }
            this.logger.line('mux', msg, 'ERROR');
            this.lastError = msg;
            this.muxStatus = 'fail';
            this.stopMux().catch(() => {});
          }
        },
        onExit: (code) => {
          if (this.muxRunning && code !== 0) {
            this.logger.line('mux', `hackrf_transfer crashed (code=${code})`, this._modState?.failing ? 'WARN' : 'ERROR');
          }
        }
      });
      this.logger.line('mux', `started hackrf_transfer (freq=${freqHz}Hz, txGain=${hk.txGain ?? 47})`);
    }
  }

  // Watchdog (every 5 s, ON AIR): the local modulator chain must be alive and, with SoapySDR, really send
  // frames — odr-dabmod keeps running without any error when its device is unplugged, only its 'sdr frames'
  // counter (remote control, read-only) stops. Broken or stalled = reported once (ERROR, muxStatus fail),
  // then this chain alone is restarted every MOD_RETRY_MS until it transmits again (INFO); the encoders,
  // odr-dabmux and the other outputs stay on air. The previous behaviour only logged "chain broken".
  // Line telling that an incident is over: Telegram "✅ RESOLVED" when its option is on (logger.recovery),
  // an ordinary INFO line otherwise (or with a logger without that method)
  _logRecovery(kind, scope, msg) {
    if (typeof this.logger.recovery === 'function') this.logger.recovery(kind, scope, msg);
    else this.logger.line(scope, msg);
  }

  // NETWORK mode: an output other than the local SDR / HackRF is ON (the mux still feeds a transmitter)
  _otherOutputsOn() {
    const dm = this.settings?.dabmux || {};
    if (String(dm.txMode || '').toUpperCase() !== 'NETWORK') return false;
    return (dm.outputs || []).some((o) => o.enabled !== false && o.type !== 'hackrf' && o.type !== 'sdr');
  }

  async _superviseLocalModulator() {
    const localHk = this._localHackrf();
    if (!localHk) return;
    const st = this._modState || (this._modState = { lastFrames: -1, lastProgressMs: Date.now(), failing: false, failingSinceMs: 0, restartAfterMs: 0, attempts: 0 });
    const now = Date.now();
    const label = localHk.hk.type === 'sdr' ? 'SDR' : 'HACKRF';
    const soapy = this._localSoapy();
    const dabmodAlive = this.pm.isRunning('mux:odr-dabmod');
    // SoapySDR: odr-dabmod is the whole chain (no hackrf_transfer)
    const hackrfAlive = soapy ? dabmodAlive : this.pm.isRunning('mux:hackrf_transfer');
    let problem = null;
    if (!dabmodAlive || !hackrfAlive) {
      problem = `${label} chain broken: dabmod=${dabmodAlive} hackrf=${hackrfAlive}`;
    } else if (soapy) {
      const v = await getDabmodValue('sdr', 'frames', { port: this.dabmodRcPort ?? 2121 });   // telnetport of dabmod.ini
      if (!this.muxRunning) return;   // Stop pressed meanwhile
      const frames = v === null ? NaN : Number(v);   // NaN = remote control not reachable: no verdict
      if (Number.isFinite(frames) && frames > st.lastFrames) {
        st.lastFrames = frames;
        st.lastProgressMs = now;
      } else if (Number.isFinite(frames) && now - st.lastProgressMs > MOD_STALL_MS) {
        problem = `${label} stalled: no frame sent for ${Math.round((now - st.lastProgressMs) / 1000)} s (device unplugged or blocked?)`;
      }
    }

    if (!problem) {
      // back on air: SoapySDR = frames sent since the restart; hackrf_transfer = alive for MOD_STABLE_MS
      const recovered = soapy ? st.lastFrames > 0 && st.lastProgressMs >= (st.restartedMs || 0) : now - (st.restartedMs || 0) >= MOD_STABLE_MS;
      if (st.failing && recovered) {
        this._logRecovery('outputs', 'watchdog', `${label} transmitting again (after ${Math.round((now - st.failingSinceMs) / 1000)} s, ${st.attempts} restart(s))`);
        st.failing = false;
        st.attempts = 0;
        if (this.muxStatus === 'fail') this.muxStatus = 'on';
      }
      return;
    }

    if (!st.failing) {   // reported once per incident
      st.failing = true;
      st.failingSinceMs = now;
      st.restartAfterMs = 0;
      this.logger.line('watchdog', `${problem} — restarting the ${label} chain every ${MOD_RETRY_MS / 1000} s until it transmits again`, 'ERROR');
      // other outputs (EasyDAB, EDI…) still on air: the mux stays ON AIR, the SDR output alone shows it
      if (!this._otherOutputsOn()) {
        this.lastError = problem;
        this.muxStatus = 'fail';
      }
    }
    if (now < st.restartAfterMs) return;
    st.restartAfterMs = now + MOD_RETRY_MS;
    st.attempts += 1;
    this.logger.line('watchdog', `restarting the ${label} chain (attempt ${st.attempts}): ${problem}`);
    try { await this.pm.stop('mux:hackrf_transfer'); } catch { /* not running */ }
    try { await this.pm.stop('mux:odr-dabmod'); } catch { /* not running */ }
    if (!this.muxRunning) return;   // Stop pressed meanwhile: never spawn after it
    if (this.pm.isRunning('mux:odr-dabmod') || this.pm.isRunning('mux:hackrf_transfer')) {
      st.restartAfterMs = now + 5000;   // still exiting (SIGKILL sent): spawn at the next tick
      return;
    }
    st.lastFrames = -1;   // counter restarts at 0 with the new odr-dabmod
    st.lastProgressMs = Date.now();
    st.restartedMs = Date.now();
    try {
      this._spawnLocalModulator(this._localHackrf());
    } catch (e) {
      this.logger.line('watchdog', `${label} restart failed: ${e?.message || e}`, 'WARN');
    }
  }

  async startMux() {
    if (this.muxRunning) {
      throw new Error('Mux déjà en cours (ON AIR).');
    }
    this.muxStatus = 'off';
    this.lastError = null;

    const totalCu = sumCU(this.preset.services);
    if (totalCu > 864) {
      throw new Error(`Capacity exceeded: ${totalCu} CU (max 864). Reduce bitrates/protection or disable services.`);
    }

    this.logger.line('mux', '--- START SEQUENCE ---');

    // Preflight: check required binaries
    const missingOdr = [];
    const missingOther = [];
    if (!this.pm.binaryExists('odr-dabmux')) missingOdr.push('odr-dabmux');
    if (!this.pm.binaryExists('odr-audioenc')) missingOdr.push('odr-audioenc');
    if (!this.pm.binaryExists('odr-padenc')) missingOdr.push('odr-padenc');
    if (this._localHackrf()) {
      if (!this.pm.binaryExists('odr-dabmod')) missingOdr.push('odr-dabmod');
      // SoapySDR (the 'sdr' output): odr-dabmod drives the device, no hackrf_transfer
      if (!this._localSoapy() && !this.pm.binaryExists('hackrf_transfer')) missingOther.push('hackrf_transfer');
    }
    if (missingOdr.length || missingOther.length) {
      const parts = [];
      if (missingOdr.length) parts.push(`${missingOdr.join(', ')} (install ODR-mmbTools)`);
      if (missingOther.length) parts.push(`${missingOther.join(', ')} (install libhackrf / hackrf)`);
      const msg = `Missing binaries: ${parts.join('; ')}`;
      this.logger.line('mux', msg, 'ERROR');
      throw new Error(msg);
    }

    // Reset runtime so every start uses current service config (fresh activeUri, etc.)
    this._initRuntime();

    // generate mux file
    const muxText = buildMuxConfig({ settings: this.settings, preset: this.preset });
    const muxPath = path.resolve(this.runtimeDir, 'current.mux');
    fs.writeFileSync(muxPath, muxText, 'utf8');
    this.logger.line('mux', 'generated mux: Ok');

    // Atomic start with rollback on failure
    const startedServices = [];
    try {
      for (const svc of this.preset.services.filter((s) => s.enabled)) {
        await this._startService(svc);
        startedServices.push(svc);
      }

      const dabmuxCmd = buildDabMuxCommand(muxPath);
      this.pm.spawn('mux:odr-dabmux', dabmuxCmd.bin, dabmuxCmd.args, {
        onExit: (code) => {
          if (this.muxRunning && code !== 0) {
            this.logger.line('mux', `odr-dabmux crashed (code=${code}) — stopping all`, 'ERROR');
            this.stopMux().then(() => {
              this.muxStatus = 'fail';
            }).catch(() => {
              this.muxStatus = 'fail';
            });
          }
        }
      });

      // ---- HACKRF: start odr-dabmod + hackrf_transfer ----
      // Wait briefly for odr-dabmux to open its EDI TCP port before odr-dabmod connects
      await new Promise((resolve) => setTimeout(resolve, 500));

      const localHk = this._localHackrf();   // HACKRF mode, or the HackRF output of the NETWORK mode
      if (localHk) {
        // fresh supervision state of the local modulator (watchdog: frames counter, restarts)
        this._modState = { lastFrames: -1, lastProgressMs: Date.now(), failing: false, failingSinceMs: 0, restartAfterMs: 0, attempts: 0 };
        this._spawnLocalModulator(localHk);
      }
    } catch (err) {
      // Rollback: stop any started services
      this.logger.line('mux', `start failed, rolling back: ${err?.message || err}`, 'ERROR');
      for (const svc of startedServices) {
        try { await this._stopService(svc); } catch { /* ignore */ }
      }
      try { await this.pm.stop('mux:odr-dabmod'); } catch { /* ignore */ }
      try { await this.pm.stop('mux:hackrf_transfer'); } catch { /* ignore */ }
      try { await this.pm.stop('mux:odr-dabmux'); } catch { /* ignore */ }
      this.muxStatus = 'fail';
      throw err;
    }

    this.muxRunning = true;
    this.muxStatus = 'on';
    this.muxSinceMs = Date.now();
    this._persistMuxState(true);
    this._startWatchdog();
    this._startMetadataLoop();
  }

  async stopMux() {
    this.logger.line('mux', '--- STOP SEQUENCE ---');
    this._stopWatchdog();
    this._stopMetadataLoop();

    if (!this.muxRunning) {
      this.logger.line('mux', 'stop requested while muxRunning=false; forcing svc cleanup');
      await this.pm.stopAll('svc:');
      await this.pm.stopAll('mux:');

      // Reset DLS and status for clean UI display when stopped
      for (const svc of this.preset.services) {
        const rt = this.serviceRuntime.get(svc.id);
        if (rt) {
          const defaultDlsAllowed = svc.metadata?.defaultDlsAllowed !== false;
          rt.currentDls = defaultDlsAllowed ? (svc.metadata?.defaultDls || '') : '';
          rt.dlplusActive = false;
          rt.status = 'STOPPED';
        }
      }

      if (this.muxStatus === 'fail') {
        this.muxStatus = 'off';
        this.muxSinceMs = Date.now();
      }
      this._persistMuxState(false);
      return;
    }

    // Disarm onExit crash handler BEFORE killing dabmux
    this.muxRunning = false;
    this.muxSinceMs = Date.now();

    // HACKRF: stop in reverse order (consumer first)
    try { await this.pm.stop('mux:hackrf_transfer'); } catch (e) {
      if (e?.message !== 'not running') this.logger.line('mux', `stop hackrf_transfer: ${e?.message || e}`, 'WARN');
    }
    try { await this.pm.stop('mux:odr-dabmod'); } catch (e) {
      if (e?.message !== 'not running') this.logger.line('mux', `stop odr-dabmod: ${e?.message || e}`, 'WARN');
    }
    try { await this.pm.stop('mux:odr-dabmux'); } catch (e) {
      this.logger.line('mux', `stop mux error: ${e?.message || e}`, 'WARN');
    }

    for (const svc of this.preset.services) {
      try { await this._stopService(svc); } catch (e) {
        this.logger.line(`svc:${svc.id}`, `stop error: ${e?.message || e}`, 'WARN');
      }
    }

    // Fallback: clean up any remaining processes
    await this.pm.stopAll('svc:');
    await this.pm.stopAll('mux:');

    // Reset DLS and status for clean UI display when stopped
    for (const svc of this.preset.services) {
      const rt = this.serviceRuntime.get(svc.id);
      if (rt) {
        const defaultDlsAllowed = svc.metadata?.defaultDlsAllowed !== false;
        rt.currentDls = defaultDlsAllowed ? (svc.metadata?.defaultDls || '') : '';
        rt.dlplusActive = false;
        rt.status = 'STOPPED';
      }
    }

    this.muxStatus = 'off';
    this._persistMuxState(false);
  }

  async _startService(svc) {
    const motDirAbs = this._resolveMotDir(svc);
    const fifoPath = path.resolve(motDirAbs, svc.pad.fifoName);
    const mtaPath = this._getMtaPath(svc);

    ensureDir(motDirAbs);
    ensureDir(path.dirname(mtaPath));

    // Direct input modes: external encoder pushes audio directly to dabmux — no audioenc/padenc
    const inputMode = (svc.input?.mode || '').toUpperCase();
    if (inputMode === 'ZMQ' || inputMode === 'EDI') {
      const rt = this.serviceRuntime.get(svc.id);
      if (rt) {
        rt.lastStartMs = nowMs();
        rt.encWasAlive = false;
        rt.status = 'RUNNING';
        rt.activeUri = null;
      }
      this.logger.line(`svc:${svc.id}`, `direct input mode ${inputMode} on port ${svc.network.ediOutputTcp.port} — no encoder spawned`);
      return;
    }

    // Pre-write DLS file so odr-padenc has content immediately
    const dlsAllowed = svc.metadata?.defaultDlsAllowed !== false;
    const dlsText = dlsAllowed ? (svc.metadata?.defaultDls || '') : '';
    if (dlsText) {
      this._writeDlsFile(svc, dlsText);
    }

    // create fifo if missing — synchronous to avoid race with padenc/audioenc
    if (!safeExists(fifoPath)) {
      try { execFileSync('mkfifo', [fifoPath]); } catch (e) {
        throw new Error(`Failed to create PAD FIFO ${fifoPath}: ${e.message}`);
      }
    }

    // padenc (watch the on-air slide directory, use runtime DLS file)
    const slideDir = path.resolve(motDirAbs, svc.pad?.slideDir || 'slide');
    const dlsRuntimePath = this._getDlsRuntimePath(svc);
    ensureDir(slideDir);
    const padCmd = buildPadEncCommand(svc, this._syncAirSlides(svc), dlsRuntimePath);
    this.pm.spawn(`svc:${svc.id}:padenc`, padCmd.bin, padCmd.args, { cwd: motDirAbs });

    // audioenc (uses the fifo name in cwd)
    const rt = this.serviceRuntime.get(svc.id);
    if (rt) rt.status = 'STARTING';

    const activeUri = rt?.activeUri || svc.input.uri;
    const codecArgs = this._getCodecArgs(svc.audio?.codec);
    const audioCmd = buildAudioEncCommand({
      svc: { ...svc, audio: { ...svc.audio, codecArgs } },
      activeUri,
      mtaPath
    });
    this.pm.spawn(`svc:${svc.id}:audioenc`, audioCmd.bin, audioCmd.args, {
      cwd: motDirAbs,
      onStderr: (text) => {
        const lvl = parseAudioLevel(text);
        if (lvl && rt) rt.audioLevels = lvl;
      }
    });

    if (rt) {
      rt.lastStartMs = nowMs();
      rt.encWasAlive = true;
      rt.status = 'RUNNING';
      rt.activeUri = activeUri;
    }
  }

  async _stopService(svc) {
    const rt = this.serviceRuntime.get(svc.id);
    if (rt) rt.status = 'STOPPING';

    const _inputMode = (svc.input?.mode || '').toUpperCase();
    if (_inputMode !== 'ZMQ' && _inputMode !== 'EDI') {
      await this.pm.stop(`svc:${svc.id}:audioenc`);
      await this.pm.stop(`svc:${svc.id}:padenc`);

      // mkfifo helper exits by itself
      await this.pm.stop(`svc:${svc.id}:mkfifo`);
    }

    if (rt) rt.status = 'STOPPED';
  }

  _startWatchdog() {
    if (this.watchdogTimer) return;

    this.watchdogTimer = setInterval(async () => {
      // CRITICAL FIX: Prevent concurrent watchdog execution
      if (this._watchdogRunning) {
        this.logger.line('watchdog', 'previous iteration still running, skipping', 'DEBUG');
        return;
      }

      if (!this.muxRunning) return;

      this._watchdogRunning = true;
      try {
        for (const svc of this.preset.services.filter((s) => s.enabled && s.watchdog?.enabled)) {
          const rt = this.serviceRuntime.get(svc.id);
          if (!rt) continue;

          // Skip direct input modes — no local encoder to monitor
          const _wdMode = (svc.input?.mode || '').toUpperCase();
          if (_wdMode === 'ZMQ' || _wdMode === 'EDI') continue;

          if (!rt.activeUri) rt.activeUri = svc.input.uri;

          // Check if encoder process is still alive
          const encKey = `svc:${svc.id}:audioenc`;
          const encAlive = this.pm.isRunning(encKey);

          // Health check main & backup (always, for both alive/dead paths)
          const hasDistinctBackup = svc.input.backupUri && svc.input.backupUri !== svc.input.uri;
          const okMain = await headOk(svc.input.uri);
          const okBackup = hasDistinctBackup ? await headOk(svc.input.backupUri) : false;
          // Stop pressed during the HTTP checks above: the encoders were stopped on purpose, not crashed
          if (!this.muxRunning) break;

          // --- CRASH DETECTION (transition-based) ---
          // Only count a NEW crash on alive→dead transition
          if (!encAlive && rt.encWasAlive) {
            rt.consecutiveCrashes = (rt.consecutiveCrashes || 0) + 1;
            rt.lastDeathMs = nowMs();
            const ranMs = rt.lastStartMs ? (rt.lastDeathMs - rt.lastStartMs) : 0;
            rt.status = 'ERROR';
            this.logger.line(`svc:${svc.id}`, `encoder died — crash #${rt.consecutiveCrashes}/${FAILOVER_CRASH_THRESHOLD}, ran ${Math.round(ranMs / 1000)}s, uri=${rt.activeUri}`, 'ERROR');
          }
          rt.encWasAlive = encAlive;

          // --- ENCODER DEAD: restart or failover ---
          if (!encAlive) {
            // CRITICAL: Check if mux is still running before attempting restart
            // Prevents race condition where stop was called during watchdog iteration
            if (!this.muxRunning) {
              this.logger.line(`svc:${svc.id}`, `encoder dead but mux stopping — skip restart`);
              continue;
            }

            const crashes = rt.consecutiveCrashes || 0;
            const activeIsMainUri = (rt.activeUri || svc.input.uri) === svc.input.uri;

            // Decide: switch to backup or restart on same URI?
            // When on backup, crashes restart on backup — probe handles return to main.
            if (crashes >= FAILOVER_CRASH_THRESHOLD && hasDistinctBackup && activeIsMainUri) {
              // Threshold reached on main — switch to backup
              const targetUri = svc.input.backupUri;
              const targetOk = activeIsMainUri ? okBackup : okMain;

              this.logger.line(`svc:${svc.id}`, `failover: ${crashes} crashes — switching ${activeIsMainUri ? 'main' : 'backup'} => ${activeIsMainUri ? 'backup' : 'main'} (${targetUri}) [headOk=${targetOk}]`);
              rt.consecutiveCrashes = 0;
              await Promise.race([
                this._switchServiceUri(svc, targetUri),
                new Promise((_, reject) => setTimeout(() => reject(new Error('switch timeout')), 5000))
              ]).catch(err => {
                this.logger.line(`svc:${svc.id}`, `switch failed: ${err.message}`, 'WARN');
                rt.status = 'ERROR';
              });
            } else if (crashes >= FAILOVER_CRASH_THRESHOLD && !hasDistinctBackup) {
              // Threshold reached but no distinct backup — restart on same, log once
              this.logger.line(`svc:${svc.id}`, `failover: ${crashes} crashes but no distinct backup — restarting on ${rt.activeUri}`);
              await Promise.race([
                this._switchServiceUri(svc, rt.activeUri || svc.input.uri),
                new Promise((_, reject) => setTimeout(() => reject(new Error('switch timeout')), 5000))
              ]).catch(err => {
                this.logger.line(`svc:${svc.id}`, `restart failed: ${err.message}`, 'WARN');
                rt.status = 'ERROR';
              });
            } else {
              // Under threshold — restart on current URI
              this.logger.line(`svc:${svc.id}`, `failover: restarting on ${rt.activeUri} (crash ${crashes}/${FAILOVER_CRASH_THRESHOLD})`);
              await Promise.race([
                this._switchServiceUri(svc, rt.activeUri || svc.input.uri),
                new Promise((_, reject) => setTimeout(() => reject(new Error('switch timeout')), 5000))
              ]).catch(err => {
                this.logger.line(`svc:${svc.id}`, `restart failed: ${err.message}`, 'WARN');
                rt.status = 'ERROR';
              });
            }
            continue;
          }

          // --- ENCODER ALIVE ---
          // Only reset crash counter after proven stability
          if (rt.consecutiveCrashes > 0 && rt.lastStartMs) {
            const upMs = nowMs() - rt.lastStartMs;
            if (upMs >= FAILOVER_STABLE_MS) {
              this._logRecovery('services', `svc:${svc.id}`, `encoder stable for ${Math.round(upMs / 1000)}s — crash counter reset (${svc.identity?.ps8 || svc.id} back on air)`);
              rt.consecutiveCrashes = 0;
            }
          }

          if (okMain) rt.lastOkMainMs = nowMs();
          if (okBackup) rt.lastOkBackupMs = nowMs();

          const thresholdMs = (svc.watchdog.silenceThresholdSec ?? 10) * 1000;

          // determine if active is failing
          let activeIsMain = false;
          if (rt.activeUri) {
            activeIsMain = rt.activeUri === svc.input.uri;
          }
          const activeOk = activeIsMain ? okMain : okBackup;
          // When encoder is alive, trust encoder state for status display regardless
          // of HTTP check result — headOk can fail for Icecast/SRT/HTTPS streams
          // even when audio is fine (HEAD rejected, timeout, slot full, etc.).
          const effectiveActiveOk = activeOk || encAlive;

          if (effectiveActiveOk) {
            rt.failuresSinceMs = 0;
            rt.warningSinceMs = 0;
            const backupUnstable = !activeIsMain && rt.consecutiveCrashes > 0;
            if (backupUnstable) {
              if (rt.status !== 'WARNING') rt.status = 'WARNING';
            } else if (rt.status && rt.status !== 'RUNNING') {
              rt.status = 'RUNNING';
            }
            // try returning to main if on backup
            if (!activeIsMain && svc.watchdog.returnToMainAfterSec > 0) {
              const backMs = svc.watchdog.returnToMainAfterSec * 1000;
              if (nowMs() - (rt.lastSwitchMs || 0) >= backMs && okMain) {
                // CRITICAL: Check if mux is still running before switching
                if (!this.muxRunning) {
                  this.logger.line(`svc:${svc.id}`, `mux stopping — skip return to main`);
                  continue;
                }
                // CRITICAL FIX: Timeout on switch to prevent blocking watchdog
                await Promise.race([
                  this._switchServiceUri(svc, svc.input.uri),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('switch timeout')), 5000))
                ]).catch(err => {
                  this.logger.line(`svc:${svc.id}`, `switch to main failed: ${err.message}`, 'WARN');
                });
              }
            }
            continue;
          }

          // active failed
          if (!rt.failuresSinceMs) rt.failuresSinceMs = nowMs();
          if (!rt.warningSinceMs) rt.warningSinceMs = nowMs();

          const warnSec = Math.max(1, Number(svc.watchdog.warningThresholdSec ?? Math.floor((svc.watchdog.silenceThresholdSec ?? 10) / 2)));
          if (nowMs() - rt.warningSinceMs >= warnSec * 1000 && rt.status !== 'WARNING') {
            rt.status = 'WARNING';
          }

          if (nowMs() - rt.failuresSinceMs >= thresholdMs) {
            if (svc.watchdog.switchToBackupOnSilence && svc.input.backupUri) {
              const target = activeIsMain ? svc.input.backupUri : svc.input.uri;
              const targetOk = activeIsMain ? okBackup : okMain;

              if (targetOk) {
                // CRITICAL: Check if mux is still running before switching
                if (!this.muxRunning) {
                  this.logger.line(`svc:${svc.id}`, `mux stopping — skip switch to backup`);
                  continue;
                }
                // CRITICAL FIX: Timeout on switch to prevent blocking watchdog
                await Promise.race([
                  this._switchServiceUri(svc, target),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('switch timeout')), 5000))
                ]).catch(err => {
                  this.logger.line(`svc:${svc.id}`, `switch to backup failed: ${err.message}`, 'WARN');
                });
                rt.failuresSinceMs = 0;
                rt.warningSinceMs = 0;
              }
            }
          }
        }
        // Local modulator (SDR / HackRF): alive, frames really sent, restarted when broken or stalled
        if (this.muxRunning && this._localHackrf()) {   // not after a Stop pressed during this iteration
          await this._superviseLocalModulator();
        }
      } catch (err) {
        this.logger.line('watchdog', `error: ${err?.message || err}`, 'ERROR');
      } finally {
        // CRITICAL FIX: Always release lock
        this._watchdogRunning = false;
      }
    }, 5000);

    this.logger.line('watchdog', 'started');
    this._startProbeLoop();
  }

  _stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
      this.logger.line('watchdog', 'stopped');
    }
    this._stopProbeLoop();
  }

  // Probe loop: runs a minimal odr-audioenc on the main URI for services currently
  // on backup, to detect audio return. One probe at a time, sequential per service.
  _startProbeLoop() {
    if (this._probeTimer) return;
    this._probeRunning = false;
    this._probeTimer = setInterval(async () => {
      if (this._probeRunning) return;
      if (!this.muxRunning) return;

      // Collect services currently on backup that have a main URI to probe
      const candidates = this.preset.services.filter(svc => {
        if (!svc.enabled || !svc.watchdog?.enabled) return false;
        const rt = this.serviceRuntime.get(svc.id);
        if (!rt || !rt.activeUri) return false;
        return rt.activeUri !== svc.input.uri && svc.input.uri;
      });
      if (!candidates.length) return;

      this._probeRunning = true;
      try {
        for (const svc of candidates) {
          if (!this.muxRunning) break;
          const rt = this.serviceRuntime.get(svc.id);
          if (!rt || rt.activeUri === svc.input.uri) continue; // already back on main

          const mainUri = svc.input.uri;

          // Audio probe — odr-audioenc with -s 15 exits on silence
          const probeKey = 'mux:probe-audioenc';
          if (this.pm.isRunning(probeKey)) await this.pm.stop(probeKey);
          this.logger.line('probe', `svc:${svc.id}: probing audio on ${mainUri}`);
          const cmd = buildProbeCommand(mainUri, svc.input.mode);
          this.pm.spawn(probeKey, cmd.bin, cmd.args);

          // Wait 17s: if probe still alive → audio present (-s 15 would have killed it on silence)
          await new Promise(resolve => setTimeout(resolve, 17000));
          if (!this.muxRunning) break;

          const audioDetected = this.pm.isRunning(probeKey);
          await this.pm.stop(probeKey);

          if (audioDetected) {
            this.logger.line('probe', `svc:${svc.id}: audio detected on ${mainUri} — switching back to main`);
            await Promise.race([
              this._switchServiceUri(svc, mainUri),
              new Promise((_, reject) => setTimeout(() => reject(new Error('switch timeout')), 5000))
            ]).catch(err => {
              this.logger.line('probe', `svc:${svc.id}: switch back failed: ${err.message}`, 'WARN');
            });
          } else {
            this.logger.line('probe', `svc:${svc.id}: no audio on ${mainUri} — still down`);
          }
        }
      } catch (err) {
        this.logger.line('probe', `error: ${err?.message || err}`, 'ERROR');
      } finally {
        this._probeRunning = false;
        this.pm.stop('mux:probe-audioenc').catch(() => {});
      }
    }, 5000);
    this.logger.line('probe', 'loop started');
  }

  _stopProbeLoop() {
    if (this._probeTimer) {
      clearInterval(this._probeTimer);
      this._probeTimer = null;
      this.logger.line('probe', 'loop stopped');
    }
    this.pm.stop('mux:probe-audioenc').catch(() => {});
  }

  async _switchServiceUri(svc, newUri) {
    // Per-service lock to prevent concurrent switches
    const lockKey = `switch:${svc.id}`;
    if (this._switchLocks.has(lockKey)) {
      this.logger.line(`svc:${svc.id}`, `[failover] switch SKIPPED — lock active`);
      return;
    }

    const rt = this.serviceRuntime.get(svc.id);
    if (!rt) return;

    const prevUri = rt.activeUri || svc.input.uri;
    this._switchLocks.set(lockKey, true);
    try {
      this.logger.line(`svc:${svc.id}`, `[failover] switch: ${prevUri} => ${newUri}`);

      // Stop current audioenc (padenc stays alive)
      this.logger.line(`svc:${svc.id}`, `[failover] stopping audioenc...`);
      await this.pm.stop(`svc:${svc.id}:audioenc`);
      this.logger.line(`svc:${svc.id}`, `[failover] audioenc stopped`);

      rt.activeUri = newUri;
      rt.lastSwitchMs = nowMs();
      rt.status = 'RESTARTING';

      // Rebuild audioenc command with new URI
      const motDirAbs = this._resolveMotDir(svc);
      const mtaPath = this._getMtaPath(svc);
      const codecArgs = this._getCodecArgs(svc.audio?.codec);
      const audioCmd = buildAudioEncCommand({
        svc: { ...svc, audio: { ...svc.audio, codecArgs } },
        activeUri: newUri,
        mtaPath
      });

      this.logger.line(`svc:${svc.id}`, `[failover] spawn: ${audioCmd.bin} ... ${newUri}`);
      this.pm.spawn(`svc:${svc.id}:audioenc`, audioCmd.bin, audioCmd.args, {
        cwd: motDirAbs,
        onStderr: (text) => {
          const lvl = parseAudioLevel(text);
          if (lvl && rt) rt.audioLevels = lvl;
        }
      });

      rt.lastStartMs = nowMs();
      rt.encWasAlive = true;
      rt.status = 'RUNNING';
      if (newUri === svc.input.uri && prevUri !== newUri) this._logRecovery('services', `svc:${svc.id}`, `[failover] switch OK — now on ${newUri} (${svc.identity?.ps8 || svc.id} back on its main stream)`);
      else this.logger.line(`svc:${svc.id}`, `[failover] switch OK — now on ${newUri}`);
    } catch (err) {
      this.logger.line(`svc:${svc.id}`, `[failover] switch FAILED: ${err.message}`, 'ERROR');
      rt.status = 'ERROR';
      throw err;
    } finally {
      this._switchLocks.delete(lockKey);
    }
  }
}
