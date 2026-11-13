import express from 'express';
import morgan from 'morgan';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { execSync, execFileSync, execFile, spawn } from 'node:child_process';
import archiver from 'archiver';
import bcrypt from 'bcryptjs';

import { DEFAULT_SETTINGS, WEAK_PASSWORDS, MIN_PASSWORD_LENGTH } from './defaults.js';
import { ensureDir, readJson, writeJson } from './fsutil.js';
import { FileLogger } from './logger.js';
import { TelegramLogNotifier } from './telegramNotifier.js';
import { OutputMonitor } from './outputMonitor.js';
import { OdrProcessManager } from './odr/processManager.js';
import { AppState } from './appState.js';
import { queryDabmux, normalizeValues } from './odr/dabmuxStats.js';
import { convertToSlide as convertSlideImage, removeBlackBands, imageCoder } from './slideImage.js';
import { detectJsonKeys } from './utils/jsonKeys.js';
import { resetPassword, resolveDataDir } from './resetPassword.js';
import { normalizeOutput, normalizeOutputs, normalizeEdiOptions, validateOutputs, outputsFromLegacy, sdrDeviceString } from './odr/outputs.js';
import { streamService, missingPlayerTools, acquireListenerSlot, playerListeners, playerLevels, playerLastError, PLAYER_MAX_LISTENERS } from './player.js';
import {
  LoginAttemptLimiter,
  REMEMBERED_SESSION_MAX_AGE_MS,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  clearSessionCookie,
  createSessionToken,
  getOrCreateSessionSecret,
  makeSessionCookie,
  parseCookies,
  verifySessionToken
} from './auth/sessionAuth.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

// When running as a self-contained pkg binary, derive paths from the executable
// location; otherwise fall back to the development layout (cwd parent).
const isPkg = typeof process.pkg !== 'undefined';
const appDir = isPkg
  ? path.resolve(path.dirname(process.execPath), '..')  // /opt/dabcast/bin/.. → /opt/dabcast
  : path.resolve(process.cwd(), '..');
const webDir = path.resolve(appDir, 'web');

const dataDir = process.env.DABCAST_DATA_DIR
  ? path.resolve(process.env.DABCAST_DATA_DIR)
  : path.resolve(appDir, 'data');

// `dabcast --reset-password [username]` (sudo): reset lost credentials, then exit (no server)
if (process.argv.includes('--reset-password')) {
  const i = process.argv.indexOf('--reset-password');
  const user = process.argv[i + 1] && !process.argv[i + 1].startsWith('-') ? process.argv[i + 1] : null;
  try {
    console.log(resetPassword(resolveDataDir(path.resolve(appDir, 'data'), { installed: isPkg }), user));
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
ensureDir(dataDir);
ensureDir(path.resolve(dataDir, 'presets'));
ensureDir(path.resolve(dataDir, 'logs'));
ensureDir(path.resolve(dataDir, 'runtime'));

// settings.json
const settingsPath = path.resolve(dataDir, 'settings.json');
const settings = readJson(settingsPath, DEFAULT_SETTINGS) || DEFAULT_SETTINGS;

// Ensure auth defaults exist
if (!settings.auth) settings.auth = { ...DEFAULT_SETTINGS.auth };

// Auto-hash plain-text password on first startup
if (settings.auth.password && !settings.auth.password.startsWith('$2b$')) {
  const isDefault = WEAK_PASSWORDS.includes(settings.auth.password.toLowerCase());
  settings.auth.password = bcrypt.hashSync(settings.auth.password, 10);
  if (isDefault || settings.auth.mustChangePassword === undefined) {
    settings.auth.mustChangePassword = true;
  }
}

// Ensure mustChangePassword field exists
if (settings.auth.mustChangePassword === undefined) {
  settings.auth.mustChangePassword = false;
}
writeJson(settingsPath, settings);

// Signed browser sessions replace the browser-native HTTP Basic Auth prompt.
// The signing secret is generated once, stored outside the web root and kept private.
const sessionSecret = getOrCreateSessionSecret(path.resolve(dataDir, '.auth-secret'));
const loginLimiter = new LoginAttemptLimiter();
let logger;

function requestIsSecure(req) {
  return Boolean(req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}

function getRequestSession(req) {
  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE_NAME];
  return verifySessionToken(token, {
    username: settings.auth.username,
    passwordHash: settings.auth.password,
    secret: sessionSecret
  });
}

function issueSession(req, res, { remember = false } = {}) {
  const maxAgeMs = remember ? REMEMBERED_SESSION_MAX_AGE_MS : SESSION_MAX_AGE_MS;
  const token = createSessionToken({
    username: settings.auth.username,
    passwordHash: settings.auth.password,
    secret: sessionSecret,
    maxAgeMs
  });
  res.setHeader('Set-Cookie', makeSessionCookie(token, {
    maxAgeMs: remember ? maxAgeMs : undefined,
    secure: requestIsSecure(req)
  }));
  return maxAgeMs;
}

// Public login assets. The main application and every sensitive asset remain protected.
for (const filename of ['login.html', 'login.css', 'login.js', 'logodab.png', 'favicon.png']) {
  app.get(`/${filename}`, (req, res) => res.sendFile(path.resolve(webDir, filename)));
}

app.get('/api/auth/session', (req, res) => {
  const session = getRequestSession(req);
  res.json({
    authenticated: Boolean(session),
    username: session?.username || null,
    mustChangePassword: session ? Boolean(settings.auth.mustChangePassword) : false
  });
});

app.post('/api/auth/login', (req, res) => {
  const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
  const limit = loginLimiter.check(clientKey);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSec));
    return res.status(429).json({ error: `Too many login attempts. Try again in ${limit.retryAfterSec} seconds.` });
  }

  const username = String(req.body?.username || '').trim().slice(0, 128);
  const password = String(req.body?.password || '').slice(0, 1024);
  const passwordMatches = bcrypt.compareSync(password || '\u0000', settings.auth.password);
  if (username !== settings.auth.username || !passwordMatches) {
    loginLimiter.recordFailure(clientKey);
    logger?.line('auth', `Failed login from ${clientKey}`, 'WARN');
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  loginLimiter.recordSuccess(clientKey);
  issueSession(req, res, { remember: Boolean(req.body?.remember) });
  logger?.line('auth', `User ${username} signed in`);
  return res.json({
    ok: true,
    username,
    mustChangePassword: Boolean(settings.auth.mustChangePassword)
  });
});

function logout(req, res) {
  res.setHeader('Set-Cookie', clearSessionCookie({ secure: requestIsSecure(req) }));
  if (req.method === 'GET') return res.redirect('/login.html');
  return res.json({ ok: true });
}
app.get('/api/logout', logout);
app.post('/api/logout', logout);

app.use((req, res, next) => {
  const session = getRequestSession(req);
  if (session) {
    req.auth = session;
    return next();
  }

  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    const nextPath = req.originalUrl && req.originalUrl !== '/' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
    return res.redirect(`/login.html${nextPath}`);
  }
  return res.status(401).json({ error: 'Authentication required' });
});

// Gating: block sensitive API endpoints until default password is changed
const UNGATED_PATHS = new Set(['/', '/api/auth', '/api/state', '/api/system/info']);
const UNGATED_PREFIXES = ['/favicon', '/style', '/app.js', '/logodab'];

app.use((req, res, next) => {
  if (!settings.auth.mustChangePassword) return next();

  const p = req.path;
  if (UNGATED_PATHS.has(p)) return next();
  if (UNGATED_PREFIXES.some(pfx => p.startsWith(pfx))) return next();
  if (p.endsWith('.css') || p.endsWith('.js') || p.endsWith('.png') || p.endsWith('.ico')) return next();

  return res.status(423).json({ error: 'Password change required' });
});

const telegramConfigPath = path.resolve(dataDir, '.telegram.json');
const telegramFileConfig = readJson(telegramConfigPath, null);
let telegramConfig = telegramFileConfig || {
  enabled: Boolean(process.env.DABCAST_TELEGRAM_BOT_TOKEN && process.env.DABCAST_TELEGRAM_CHAT_ID),
  token: process.env.DABCAST_TELEGRAM_BOT_TOKEN || '',
  chatId: process.env.DABCAST_TELEGRAM_CHAT_ID || '',
  minLevel: process.env.DABCAST_TELEGRAM_MIN_LEVEL || 'ERROR',
  silent: /^(1|true|yes)$/i.test(process.env.DABCAST_TELEGRAM_SILENT || '')
};

function buildTelegramNotifier(config) {
  if (!config.enabled || !config.token || !config.chatId) return null;
  return new TelegramLogNotifier({
    token: config.token,
    chatId: config.chatId,
    minLevel: config.minLevel,
    silent: config.silent,
    // "✅ RESOLVED" messages, off by default (older .telegram.json files have no such fields)
    recovery: { outputs: config.recoveryOutputs === true, services: config.recoveryServices === true },
    onError: (message) => console.error(message)
  });
}

let telegramNotifier = buildTelegramNotifier(telegramConfig);
logger = new FileLogger(path.resolve(dataDir, 'logs', 'dabweb.log'), {
  notifier: telegramNotifier
});
const pm = new OdrProcessManager({ logger, odrBinDir: settings.odrBinDir, runtimeDir: path.resolve(dataDir, 'runtime') });

// Crash recovery: kill any orphan ODR processes from a previous crash
pm.cleanupOrphans();
// Snapshot ODR versions at boot (mux not running yet, autoStart comes later),
// so System information shows them even when "?" is first opened ON AIR.
refreshOdrVersions();

// ensure Demo preset exists (shipped default, or empty fallback)
const shippedDemo = path.resolve(appDir, 'defaults', 'demo.json');
const demoTarget = path.resolve(dataDir, 'presets', 'demo.json');
if (!fs.existsSync(demoTarget)) {
  if (fs.existsSync(shippedDemo)) {
    fs.copyFileSync(shippedDemo, demoTarget);
  } else {
    fs.writeFileSync(demoTarget, JSON.stringify({ id: 'demo', name: 'Demo', services: [] }, null, 2));
  }
}

// Copy shipped MOT logos if mot dir is empty (first install or missing logos)
const shippedMot = path.resolve(appDir, 'defaults', 'mot');
const dataMot = path.join(dataDir, 'mot');
if (fs.existsSync(shippedMot)) {
  // Seed logos if no logo.jpg exists yet (handles empty dir, partial copy, or first install)
  const hasLogo = fs.existsSync(dataMot) &&
    fs.readdirSync(dataMot).some(pi => fs.existsSync(path.join(dataMot, pi, 'slide', 'logo.jpg')));
  if (!hasLogo) {
    try {
      fs.cpSync(shippedMot, dataMot, { recursive: true, force: true, errorOnExist: false });
      logger.line('init', `MOT logos seeded from defaults`);
    } catch (e) {
      logger.line('init', `MOT seed error: ${e.message}`, 'WARN');
    }
  }
}

// ── SLS slides: every image odr-padenc reads must be a JPEG 320x240 ──
// Same conversion as AppState._convertToSlide (slideImage.js: bands in the picture's edge colours, quality 85).
// An unconverted logo (e.g. a 300x300 RGBA PNG named logo.jpg, written by an import) can weigh
// 50-110 kB: 30-80 s to transmit with a 58-byte PAD, versus 5-15 kB once converted.
function convertToSlideFile(src, dest) {
  try {
    convertSlideImage(src, dest);   // 320x240 JPEG, side bands in the picture's own edge colours
    return true;
  } catch (e) {
    logger.line('sls', `convert error: ${e.message}`, 'WARN');
    return false;
  }
}
// Write an imported image into a slide dir, converted. Temp files live outside the slide dir
// (odr-padenc reads every file there) and the result is moved in atomically.
// If ImageMagick fails, the image is written as received (previous behaviour).
function writeSlideImage(slideDir, filename, buf) {
  const motDir = path.dirname(slideDir);
  const stamp = `${process.pid}_${Date.now()}`;
  const raw = path.join(motDir, `.import_${stamp}.tmp`);
  const conv = path.join(motDir, `.import_${stamp}.jpg`);
  try {
    fs.writeFileSync(raw, buf);
    if (convertToSlideFile(raw, conv)) fs.renameSync(conv, path.join(slideDir, filename));
    // as received only if it really is a JPEG / PNG / GIF / WebP (odr-padenc reads the slide dir too)
    else if (imageCoder(raw)) fs.renameSync(raw, path.join(slideDir, filename));
    else throw new Error('not a JPEG / PNG / GIF / WebP picture');
  } finally {
    for (const f of [raw, conv]) { try { fs.unlinkSync(f); } catch { /* already moved */ } }
  }
}
// One-time repair at start-up (before autoStart): convert *.jpg slides that are not a real
// 320x240 JPEG. The original is kept in data/mot/<PI>/original/ (outside the slide dir).
function repairSlides() {
  if (!fs.existsSync(dataMot)) return;
  for (const pi of fs.readdirSync(dataMot)) {
    const slideDir = path.join(dataMot, pi, 'slide');
    let files = [];
    try { files = fs.readdirSync(slideDir).filter((f) => /\.jpe?g$/i.test(f)); } catch { continue; }
    for (const f of files) {
      const file = path.join(slideDir, f);
      let info = '';
      try { info = execFileSync('identify', ['-format', '%m %w %h|', file], { encoding: 'utf8', timeout: 5000 }).split('|')[0]; } catch { continue; }
      if (info === 'JPEG 320 240') continue;
      const origDir = path.join(dataMot, pi, 'original');
      try {
        ensureDir(origDir);
        let backup = path.join(origDir, f);
        if (fs.existsSync(backup)) backup = path.join(origDir, `${Date.now()}_${f}`);
        fs.copyFileSync(file, backup);
        const before = fs.statSync(file).size;
        const conv = path.join(dataMot, pi, `.repair_${process.pid}.jpg`);
        if (convertToSlideFile(file, conv)) {
          fs.renameSync(conv, file);
          logger.line('sls', `${pi}/${f}: converted to JPEG 320x240 (was ${info}, ${before} B → ${fs.statSync(file).size} B; original kept in mot/${pi}/original/)`);
        }
      } catch (e) {
        logger.line('sls', `${pi}/${f}: repair failed: ${e.message}`, 'WARN');
      }
    }
  }
}
repairSlides();

// One-time (marker mot/.slide-bands-v3), before autoStart: logos converted before v1.7 have black
// side bands baked in. Re-convert them with bands in their own edge colours: from the original
// kept in mot/<PI>/original/ when there is one, else by cutting the black bands off the slide
// (previous file kept in original/ as bands_<name>). Logos with a genuinely black background are
// left as they are (see blackBandWidths). Covers are re-converted at every track anyway.
function regenerateBandedLogos() {
  // v3: v2 (DABcast 1.7.1) cut only 2 px past the old bands, leaving a dull band on some logos
  const marker = path.join(dataMot, '.slide-bands-v3');
  if (!fs.existsSync(dataMot) || fs.existsSync(marker)) return;
  let done = 0;
  for (const pi of fs.readdirSync(dataMot)) {
    const motDir = path.join(dataMot, pi);
    const slideDir = path.join(motDir, 'slide');
    let files = [];
    try { files = fs.readdirSync(slideDir).filter((f) => /^logo(_\d+)?\.jpg$/i.test(f)); } catch { continue; }
    for (const f of files) {
      const file = path.join(slideDir, f);
      const orig = path.join(motDir, 'original', f);
      const out = path.join(motDir, `.regen_${process.pid}.jpg`);
      try {
        if (fs.existsSync(orig)) {
          if (!convertToSlideFile(orig, out)) continue;
          fs.renameSync(out, file);
          logger.line('sls', `${pi}/${f}: re-converted from the original (bands in the picture's colours)`);
        } else {
          // already de-banded by v2: start again from the banded file it kept, not from its output
          const banded = path.join(motDir, 'original', `bands_${f}`);
          const from = fs.existsSync(banded) ? banded : file;
          if (!removeBlackBands(from, out, motDir)) continue;
          ensureDir(path.join(motDir, 'original'));
          if (from === file) fs.copyFileSync(file, banded);
          fs.renameSync(out, file);
          logger.line('sls', `${pi}/${f}: black side bands replaced by the picture's colours (previous file in mot/${pi}/original/bands_${f})`);
        }
        done++;
      } catch (e) {
        logger.line('sls', `${pi}/${f}: band regeneration failed: ${e.message}`, 'WARN');
      } finally {
        try { fs.unlinkSync(out); } catch { /* moved */ }
      }
    }
  }
  try { fs.writeFileSync(marker, `done ${new Date().toISOString()} (${done} logo(s))\n`); } catch { /* ignore */ }
}
regenerateBandedLogos();

const state = new AppState({ settings, dataDir, logger, processManager: pm });

// static web
app.use('/', express.static(webDir));
// /data: only the pictures of the services (data/mot/…/*.jpg|png|webp). settings.json (password hash),
// logs, presets and runtime files are not served (security review; the web UI uses /api/mot).
app.use('/data', (req, res, next) => {
  if (path.basename(req.path).startsWith('.')) return res.status(404).end();
  if (!/^\/mot\/[^/]+\/(?:[^/]+\/)*[^/]+\.(?:jpe?g|png|webp)$/i.test(req.path)) return res.status(404).end();
  next();
}, express.static(dataDir));

// Compute LAN IP once at startup
function getLocalIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (!iface.internal && iface.family === 'IPv4') return iface.address;
    }
  }
  return '127.0.0.1';
}
const localIp = getLocalIp();

// API
app.get('/api/state', (req, res) => {
  res.json({
    ...state.getState(),
    localIp,
    authUser: req.auth?.username || settings.auth.username,
    mustChangePassword: !!settings.auth.mustChangePassword,
  });
});

app.get('/api/presets', (req, res) => {
  res.json({ presets: state.listPresets() });
});

// Global mux/ensemble settings
app.get('/api/settings', (req, res) => {
  res.json({ settings });
});

// NETWORK mode: ports a listening transmitter output must not take (this machine's other uses)
function reservedForOutputs(dabmux) {
  const r = new Map([[8080, 'lighttpd'], [9099, 'the audio probe'], [listenPort, 'the DABcast web interface']]);
  for (const k of ['managementPort', 'telnetPort']) if (Number(dabmux[k])) r.set(Number(dabmux[k]), `dabmux ${k}`);
  const zmqEp = /:(\d+)$/.exec(String(dabmux.zmqEndpoint || ''));
  if (zmqEp) r.set(Number(zmqEp[1]), 'dabmux remote control (ZMQ)');
  r.set(Number(dabmux.easyDabOutput?.netPort) || 9901, 'the ETI monitoring output (Player / Dablin)');
  for (const svc of state.preset?.services || []) {
    const port = Number(svc.network?.ediOutputTcp?.port);
    if (port) r.set(port, `the input port of ${svc.identity?.ps8 || svc.id}`);
  }
  return r;
}

app.patch('/api/settings', (req, res) => {
  try {
    const patch = req.body || {};
    // Transmitter outputs (NETWORK mode): normalized and checked BEFORE anything is changed
    if (patch.dabmux) {
      const next = { ...settings.dabmux, ...patch.dabmux };
      if (patch.dabmux.outputs !== undefined) patch.dabmux.outputs = normalizeOutputs(patch.dabmux.outputs);
      if (patch.dabmux.ediOptions !== undefined) patch.dabmux.ediOptions = normalizeEdiOptions(patch.dabmux.ediOptions);
      if (String(next.txMode || '').toUpperCase() === 'NETWORK') {
        const errors = validateOutputs(normalizeOutputs(patch.dabmux.outputs ?? next.outputs), {
          reserved: reservedForOutputs(next),
          ediOptions: normalizeEdiOptions(patch.dabmux.ediOptions ?? next.ediOptions),
        });
        if (errors.length) throw new Error(`Transmitter outputs: ${errors.join(' · ')}`);
      }
    }
    // ?check=1: validation only (the UI checks before stopping the multiplex ON AIR)
    if (req.query.check) return res.json({ ok: true, checked: true });

    if (patch.preset) {
      if (patch.preset.name !== undefined) {
        state.preset.name = patch.preset.name;
        state.savePreset();
      }
    }
    if (patch.autoStart !== undefined) {
      settings.autoStart = Boolean(patch.autoStart);
    }
    if (patch.ensemble) {
      settings.ensemble = { ...settings.ensemble, ...patch.ensemble };
    }
    if (patch.dabmux) {
      // shallow merge + merge nested easyDabOutput / hackrf with their PREVIOUS values
      // (the shallow merge already replaced them: merging with settings.dabmux.* lost e.g. easyDabOutput.netPort)
      const prevEasyDab = settings.dabmux.easyDabOutput;
      const prevHackrf = settings.dabmux.hackrf;
      settings.dabmux = { ...settings.dabmux, ...patch.dabmux };
      if (patch.dabmux.easyDabOutput) {
        settings.dabmux.easyDabOutput = { ...(prevEasyDab || {}), ...patch.dabmux.easyDabOutput };
      }
      if (patch.dabmux.hackrf) {
        settings.dabmux.hackrf = { ...(prevHackrf || {}), ...patch.dabmux.hackrf };
      }
    }

    writeJson(settingsPath, settings);
    res.json({ ok: true, settings });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// Web UI port (Settings ⚙ › Web server). Saved in settings.json, applied at the next start;
// PORT in the environment (/etc/default/dabcast) wins over it.
const RESERVED_WEB_PORTS = new Set([8080, 9099]);   // lighttpd on the target systems, audio probe sink
function portsInUseByChain() {
  const used = new Map();   // port -> what uses it
  const walk = (obj, where) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v === 'object') walk(v, `${where}.${k}`);
      else if (/port$/i.test(k) && Number.isInteger(Number(v)) && Number(v) > 0) used.set(Number(v), `${where}.${k}`);
      else if (typeof v === 'string') { const m = /:(\d{2,5})$/.exec(v); if (m) used.set(Number(m[1]), `${where}.${k}`); }
    }
  };
  walk(settings.dabmux, 'dabmux');
  for (const svc of state.preset?.services || []) {
    const port = svc.network?.ediOutputTcp?.port;
    if (port) used.set(Number(port), `input port of ${svc.identity?.ps8 || svc.id}`);
  }
  return used;
}
function portIsFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}
app.get('/api/settings/web', (req, res) => {
  res.json({
    port: listenPort,                                  // port this server listens on now
    savedPort: Number(settings.port) || 9090,          // port for the next start
    envPort: process.env.PORT ? Number(process.env.PORT) : null,
    canRestart: Boolean(process.env.INVOCATION_ID),   // set by systemd
    muxRunning: state.muxRunning,
  });
});
app.post('/api/settings/web', async (req, res) => {
  try {
    const port = Number(req.body?.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be a number between 1024 and 65535');
    if (process.env.PORT) throw new Error(`PORT=${process.env.PORT} is set in /etc/default/dabcast: change it there`);
    if (RESERVED_WEB_PORTS.has(port)) throw new Error(`Port ${port} is reserved (${port === 8080 ? 'lighttpd' : 'audio probe'})`);
    const chain = portsInUseByChain().get(port);
    if (chain) throw new Error(`Port ${port} is used by the broadcast chain (${chain})`);
    if (port !== listenPort && !(await portIsFree(port, listenHost))) throw new Error(`Port ${port} is already in use on this machine`);
    if (req.body?.dryRun) return res.json({ ok: true, checked: port });   // check only (before the confirmation)
    settings.port = port;
    writeJson(settingsPath, settings);
    logger.line('web', `Web UI port set to ${port} (applies at the next start)`);
    res.json({ ok: true, savedPort: port, restartRequired: port !== listenPort });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
// Restart DABcast (to apply the port): exits with an error code, systemd (Restart=on-failure)
// starts it again ~5 s later. ODR processes are cleaned up and autoStart puts the mux back on air.
app.post('/api/system/restart', (req, res) => {
  if (!process.env.INVOCATION_ID) return res.status(400).json({ error: 'Not running as the dabcast systemd service: restart it by hand' });
  logger.line('web', `Restart requested from the web UI (port ${settings.port || 9090} at the next start)`, 'WARN');
  res.json({ ok: true, port: Number(settings.port) || 9090 });
  setTimeout(() => process.exit(75), 500);   // non-zero: systemd restarts the service
});

// Telegram log notifications. The token is stored separately from settings.json
// and is never returned by the API or included in configuration exports.
app.get('/api/telegram', (req, res) => {
  const token = String(telegramConfig.token || '');
  res.json({
    enabled: Boolean(telegramConfig.enabled),
    configured: Boolean(token && telegramConfig.chatId),
    tokenConfigured: Boolean(token),
    tokenHint: token ? `••••${token.slice(-4)}` : '',
    chatId: String(telegramConfig.chatId || ''),
    minLevel: telegramConfig.minLevel || 'ERROR',
    silent: Boolean(telegramConfig.silent),
    recoveryOutputs: telegramConfig.recoveryOutputs === true,
    recoveryServices: telegramConfig.recoveryServices === true
  });
});

app.put('/api/telegram', (req, res) => {
  try {
    const body = req.body || {};
    const levels = new Set(['DEBUG', 'INFO', 'WARN', 'ERROR']);
    const minLevel = String(body.minLevel || 'ERROR').toUpperCase();
    if (!levels.has(minLevel)) throw new Error('Invalid Telegram log level');

    const next = {
      enabled: Boolean(body.enabled),
      token: String(body.token || '').trim() || String(telegramConfig.token || ''),
      chatId: String(body.chatId || '').trim(),
      minLevel,
      silent: Boolean(body.silent),
      recoveryOutputs: body.recoveryOutputs === true,
      recoveryServices: body.recoveryServices === true
    };
    if (body.clearToken === true) next.token = '';
    if (next.enabled && (!next.token || !next.chatId)) {
      throw new Error('Telegram bot token and chat ID are required');
    }

    writeJson(telegramConfigPath, next);
    fs.chmodSync(telegramConfigPath, 0o600);
    telegramConfig = next;
    telegramNotifier = buildTelegramNotifier(telegramConfig);
    logger.notifier = telegramNotifier;
    logger.line('telegram', next.enabled ? 'Telegram notifications enabled' : 'Telegram notifications disabled');
    res.json({ ok: true, enabled: next.enabled, configured: Boolean(next.token && next.chatId) });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/telegram/test', async (req, res) => {
  try {
    if (!telegramNotifier) throw new Error('Telegram notifications are not enabled or configured');
    await telegramNotifier.sendTest();
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Change auth credentials
app.patch('/api/auth', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    if (WEAK_PASSWORDS.includes(password.toLowerCase())) {
      return res.status(400).json({ error: 'This password is too common, please choose a stronger one' });
    }
    settings.auth.username = username;
    settings.auth.password = bcrypt.hashSync(password, 10);
    settings.auth.mustChangePassword = false;
    writeJson(settingsPath, settings);
    logger.line('web', `Auth credentials updated (user: ${username})`);
    const wasRemembered = Number(req.auth?.expiresAt) - Date.now() > SESSION_MAX_AGE_MS + 60_000;
    issueSession(req, res, { remember: wasRemembered });
    res.json({ ok: true, username });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get('/api/export/full', (req, res) => {
  // Never export credentials (username + password hash); /api/import/full ignores them anyway
  const { auth: _auth, ...exportedSettings } = settings;
  const result = { settings: exportedSettings, preset: state.preset };

  // Include all service logos as base64
  const logos = {};
  for (const svc of state.preset.services) {
    try {
      const motDir = path.join(dataDir, 'mot', svc.id);
      const logoPath = path.join(motDir, 'slide', 'logo.jpg');
      if (fs.existsSync(logoPath)) {
        const logoBuffer = fs.readFileSync(logoPath);
        logos[svc.id] = `data:image/jpeg;base64,${logoBuffer.toString('base64')}`;
      }
    } catch (err) {
      logger.line('export', `Failed to read logo for service ${svc.id}: ${err.message}`, 'WARN');
    }
  }

  // Only add logos object if at least one logo exists
  if (Object.keys(logos).length > 0) {
    result.logos = logos;
  }

  res.json(result);
});

app.post('/api/import/full', (req, res) => {
  try {
    const payload = req.body || {};
    // An imported file gets the same checks as the Settings screen (PATCH /api/settings), BEFORE
    // anything is written: its text ends up in the .mux / dabmod.ini (security review).
    if (payload.settings?.dabmux) {
      const imp = payload.settings.dabmux;
      if (imp.outputs !== undefined) imp.outputs = normalizeOutputs(imp.outputs);
      if (imp.ediOptions !== undefined) imp.ediOptions = normalizeEdiOptions(imp.ediOptions);
      const next = { ...settings.dabmux, ...imp };
      if (String(next.txMode || '').toUpperCase() === 'NETWORK') {
        const errors = validateOutputs(normalizeOutputs(next.outputs), {
          reserved: reservedForOutputs(next),
          ediOptions: normalizeEdiOptions(next.ediOptions),
        });
        if (errors.length) throw new Error(`Transmitter outputs: ${errors.join(' · ')}`);
      }
    }
    // logos: one per service PI code (4 hex digits) — never a path (no "../")
    const logoEntries = payload.logos && typeof payload.logos === 'object' ? Object.entries(payload.logos) : [];
    const badLogo = logoEntries.find(([k]) => !/^(0x)?[0-9A-F]{4}$/i.test(k));
    if (badLogo) throw new Error(`Invalid logo key "${String(badLogo[0]).slice(0, 40)}" (expected a PI code)`);
    if (payload.settings) {
      settings.ensemble = { ...settings.ensemble, ...payload.settings.ensemble };
      settings.dabmux = { ...settings.dabmux, ...payload.settings.dabmux };
      if (payload.settings.dabmux?.easyDabOutput) {
        settings.dabmux.easyDabOutput = { ...settings.dabmux.easyDabOutput, ...payload.settings.dabmux.easyDabOutput };
      }
      if (payload.settings.dabmux?.hackrf) {
        settings.dabmux.hackrf = { ...(settings.dabmux.hackrf || {}), ...payload.settings.dabmux.hackrf };
      }
      // odrBinDir (where the ODR programs are started from) is never taken from an imported file:
      // a crafted file could otherwise make DABcast start other programs (security review)
      if (payload.settings.odrBinDir !== undefined && payload.settings.odrBinDir !== settings.odrBinDir) {
        logger.line('export', `Import: odrBinDir "${String(payload.settings.odrBinDir).slice(0, 80)}" ignored (kept "${settings.odrBinDir || ''}")`, 'WARN');
      }
      writeJson(settingsPath, settings);
    }
    if (payload.preset) {
      state.setPreset(payload.preset);
    }

    // Import logos if present
    if (logoEntries.length) {
      for (const [key, logoBase64] of logoEntries) {
        const svcId = key.replace(/^0x/i, '').toUpperCase();   // checked above: 4 hex digits
        try {
          const motDir = path.join(dataDir, 'mot', svcId);
          const slideDir = path.join(motDir, 'slide');

          // Create directories recursively
          fs.mkdirSync(slideDir, { recursive: true });

          // Decode base64 and write logo.jpg (converted to a 320x240 JPEG slide)
          const base64Data = logoBase64.replace(/^data:image\/\w+;base64,/, '');
          const logoBuffer = Buffer.from(base64Data, 'base64');
          writeSlideImage(slideDir, 'logo.jpg', logoBuffer);

          logger.line('export', `Logo imported for service ${svcId}`, 'INFO');
        } catch (err) {
          logger.line('export', `Failed to write logo for service ${svcId}: ${err.message}`, 'WARN');
          // Don't fail the whole import if one logo fails
        }
      }
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get('/api/export/service/:id', (req, res) => {
  const svc = state.preset.services.find((s) => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: 'Unknown service' });

  const result = { service: svc };

  // Try to include logo.jpg as base64 if it exists
  try {
    const motDir = path.join(dataDir, 'mot', svc.id);
    const logoPath = path.join(motDir, 'slide', 'logo.jpg');
    if (fs.existsSync(logoPath)) {
      const logoBuffer = fs.readFileSync(logoPath);
      result.logo = `data:image/jpeg;base64,${logoBuffer.toString('base64')}`;
    }
  } catch (err) {
    // Logo not found or error reading - skip it, not critical
    logger.line('export', `Failed to read logo for service ${svc.id}: ${err.message}`, 'WARN');
  }

  res.json(result);
});

app.get('/api/export/all-services', (req, res) => {
  // Set response headers for ZIP download
  res.setHeader('Content-Type', 'application/zip');
  // all-services-<ensemble label>.zip (same naming as the configuration export of the web UI)
  const muxName = String(state.settings?.ensemble?.label || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
    || String(state.preset?.id || 'dabcast').replace(/[^A-Za-z0-9_-]+/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="all-services-${muxName}.zip"`);

  // Create ZIP archive
  const archive = archiver('zip', { zlib: { level: 9 } });

  // Handle archive errors
  archive.on('error', (err) => {
    logger.line('export', `Archive error: ${err.message}`, 'ERROR');
    if (!res.headersSent) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // Pipe archive to response
  archive.pipe(res);

  // Track used filenames to avoid duplicates
  const usedNames = new Set();

  for (const svc of state.preset.services) {
    // Generate safe filename from PS8
    const ps8 = svc.identity?.ps8 || svc.id;
    let safeName = ps8.replace(/[/\\:*?"<>|]/g, '_');

    // Handle duplicate names
    let filename = `dabcast_service_${safeName}.dct`;
    if (usedNames.has(filename)) {
      filename = `dabcast_service_${safeName}_${svc.id}.dct`;
    }
    usedNames.add(filename);

    // Build service export data
    const exportData = { service: svc };

    // Try to include logo
    try {
      const motDir = path.join(dataDir, 'mot', svc.id);
      const logoPath = path.join(motDir, 'slide', 'logo.jpg');
      if (fs.existsSync(logoPath)) {
        const logoBuffer = fs.readFileSync(logoPath);
        exportData.logo = `data:image/jpeg;base64,${logoBuffer.toString('base64')}`;
      }
    } catch (err) {
      logger.line('export', `Failed to read logo for service ${svc.id}: ${err.message}`, 'WARN');
    }

    // Add file to archive
    const jsonContent = JSON.stringify(exportData, null, 2);
    archive.append(jsonContent, { name: filename });
  }

  // Finalize archive (async)
  archive.finalize();

  logger.line('export', `Exported ${state.preset.services.length} services as ZIP`, 'INFO');
});

app.post('/api/import/service', (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.service) throw new Error('Missing service');
    const svc = state.upsertService(payload.service);

    // If logo is included in the import, write it to the service's slide directory
    if (payload.logo) {
      try {
        const motDir = path.join(dataDir, 'mot', svc.id);
        const slideDir = path.join(motDir, 'slide');

        // Create directories recursively
        fs.mkdirSync(slideDir, { recursive: true });

        // Decode base64 and write logo.jpg (converted to a 320x240 JPEG slide)
        const base64Data = payload.logo.replace(/^data:image\/\w+;base64,/, '');
        const logoBuffer = Buffer.from(base64Data, 'base64');
        writeSlideImage(slideDir, 'logo.jpg', logoBuffer);

        logger.line('export', `Logo imported for service ${svc.id}`, 'INFO');
      } catch (err) {
        logger.line('export', `Failed to write logo for service ${svc.id}: ${err.message}`, 'WARN');
        // Don't fail the whole import if logo write fails
      }
    }

    res.json({ ok: true, service: svc });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/services', (req, res) => {
  try {
    const svc = state.addService(req.body || {});
    res.status(201).json(svc);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.patch('/api/services/:id', (req, res) => {
  try {
    const svc = state.setService(req.params.id, req.body || {});
    res.json(svc);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.delete('/api/services/:id', (req, res) => {
  try {
    state.deleteService(req.params.id);
    res.status(204).end();
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/services/reorder', (req, res) => {
  try {
    const { order } = req.body || {};
    if (!Array.isArray(order)) {
      return res.status(400).json({ error: 'Order must be an array of service IDs' });
    }
    state.reorderServices(order);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/mux/start', async (req, res) => {
  try {
    await state.startMux();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/mux/stop', async (req, res) => {
  try {
    await state.stopMux();
    // Kill dablin_gtk + socat (no audio source once mux is stopped)
    try { execSync('pkill -x dablin_gtk', { stdio: 'ignore' }); } catch (_) { /* not running */ }
    try { execSync('pkill -f "socat.*dablin"', { stdio: 'ignore' }); } catch (_) { /* not running */ }
    // Clean up DL+ cover images (they'll be regenerated on next start)
    const motBase = path.join(dataDir, 'mot');
    if (fs.existsSync(motBase)) {
      for (const dir of fs.readdirSync(motBase)) {
        const cover = path.join(motBase, dir, 'slide', 'cover.jpg');
        try { fs.unlinkSync(cover); } catch (_) { /* no cover */ }
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/dablin/start', (req, res) => {
  try {
    // Check if dablin_gtk or dablin is installed (Debian 13 may ship as 'dablin')
    let dablinBin = 'dablin_gtk';
    try {
      execSync('which dablin_gtk', { stdio: 'ignore' });
    } catch (e) {
      try {
        execSync('which dablin', { stdio: 'ignore' });
        dablinBin = 'dablin';
      } catch (e2) {
        return res.status(400).json({ error: 'Dablin not installed (dablin_gtk / dablin not found in PATH)' });
      }
    }

    // Build a display-aware environment for the spawned process
    // Ensures dablin_gtk works under Wayland (XWayland) and systemd (no DISPLAY set)
    const spawnEnv = { ...process.env };
    if (!spawnEnv.DISPLAY && !spawnEnv.WAYLAND_DISPLAY) {
      spawnEnv.DISPLAY = ':0'; // last-resort fallback for headless systemd launch
    }
    // Force X11 backend for GTK — Wayland backend fails in VMs and remote sessions (NX, VNC, RDP)
    spawnEnv.GDK_BACKEND = 'x11';
    // PulseAudio requires XDG_RUNTIME_DIR — not set when running as a systemd service
    if (!spawnEnv.XDG_RUNTIME_DIR && process.getuid) {
      spawnEnv.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
    }

    // Check if dablin is already running
    try {
      execSync(`pgrep -x ${dablinBin}`, { stdio: 'ignore' });
      // Dablin is already running, bring window to front
      try {
        execSync('wmctrl -a dablin', { stdio: 'ignore' });
        logger.line('web', 'Dablin already running - window brought to the front');
        return res.json({ ok: true });
      } catch (wmctrlErr) {
        // wmctrl not available, try xdotool as fallback
        try {
          execSync('xdotool search --name dablin windowactivate', { stdio: 'ignore' });
          logger.line('web', 'Dablin already running - window brought to the front (xdotool)');
          return res.json({ ok: true });
        } catch (xdotoolErr) {
          // No tool available, just notify that it's already running
          logger.line('web', 'Dablin already running (no window management tool available)');
          return res.json({ ok: true });
        }
      }
    } catch (e) {
      // Dablin is not running, proceed to launch it
    }

    // Check that the mux is running — socat will fail immediately if no stream
    if (!state.muxRunning) {
      return res.status(400).json({ error: 'Mux is not running — start the mux before launching Dablin.' });
    }

    // Check TX mode
    const txMode = (settings.dabmux?.txMode || 'EASYDAB').toUpperCase();

    if (txMode === 'EDI' || txMode === 'HACKRF' || txMode === 'NETWORK') {
      // DABlin receives the dedicated raw ETI monitoring output. This remains
      // compatible when the transmitter-facing EDI output uses PFT/FEC.
      try {
        execSync('which socat', { stdio: 'ignore' });
      } catch (e) {
        return res.status(400).json({ error: 'socat not installed (required for DABlin monitoring)' });
      }

      const port = settings.dabmux?.easyDabOutput?.netPort || 9901;

      // Pre-select first enabled service (dablin accepts 0xXXXX format)
      const firstEdi = (state.preset || {}).services?.find(s => s.enabled);
      const firstEdiId = firstEdi?.identity?.serviceIdHex || firstEdi?.identity?.pi;
      const dablinCmd = firstEdiId ? `${dablinBin} -I -s ${firstEdiId}` : `${dablinBin} -I`;

      // Raw ETI TCP monitoring output -> stdin -> DABlin
      const cmd = 'sh';
      const args = ['-c', `socat -u TCP:127.0.0.1:${port} STDOUT | ${dablinCmd}`];

      const proc = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        env: spawnEnv
      });
      proc.unref();

      logger.line('web', `Dablin started from ETI monitoring output: socat -u TCP:127.0.0.1:${port} - | ${dablinCmd}`);
      res.json({ ok: true, message: `Dablin started (local ETI monitoring, binary: ${dablinBin})` });
    } else if (txMode === 'EASYDAB') {
      // Check if socat is installed
      try {
        execSync('which socat', { stdio: 'ignore' });
      } catch (e) {
        return res.status(400).json({ error: 'socat not installed (required for EASYDAB mode)' });
      }

      // Use net output port from settings (default 9901)
      const port = settings.dabmux?.easyDabOutput?.netPort || 9901;

      // Pre-select first enabled service (dablin accepts 0xXXXX format)
      const firstSvc = (state.preset || {}).services?.find(s => s.enabled);
      const firstSvcId = firstSvc?.identity?.serviceIdHex || firstSvc?.identity?.pi;
      const dablinCmd = firstSvcId ? `${dablinBin} -s ${firstSvcId}` : dablinBin;

      const cmd = 'sh';
      const args = ['-c', `socat -u TCP:127.0.0.1:${port} STDOUT | ${dablinCmd}`];

      // Launch socat + dablin in detached mode
      const proc = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        env: spawnEnv
      });
      proc.unref();

      logger.line('web', `Dablin started: socat -u tcp:127.0.0.1:${port} - | ${dablinCmd}`);
      res.json({ ok: true, message: `Dablin started (EASYDAB mode via socat, binary: ${dablinBin})` });
    } else {
      res.status(400).json({
        error: `Current TX mode: ${txMode}. Dablin supports EDI and EASYDAB only.`
      });
    }
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ── CPU usage sampling (real usage via /proc/stat, like htop) ──
function readCpuTimes() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0]; // "cpu  user nice system idle ..."
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch { return null; }
}

let _prevCpu = readCpuTimes();
let _cpuPct = null;

setInterval(() => {
  const cur = readCpuTimes();
  if (cur && _prevCpu) {
    const dTotal = cur.total - _prevCpu.total;
    const dIdle = cur.idle - _prevCpu.idle;
    _cpuPct = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 1000) / 10 : 0;
  }
  _prevCpu = cur;
}, 2000);

// ── Light system load for the main page "System" card (polled every 5 s) ──
// Reads /proc only; disk usage cached 30 s (statfs, or df on old Node). No ODR tool is spawned.
let _diskCache = { at: 0, v: null };
function diskUsage() {
  if (_diskCache.at && Date.now() - _diskCache.at < 30000) return _diskCache.v;
  let v = null;
  try {
    let totalB, usedB, availB;
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(dataDir);
      totalB = st.blocks * st.bsize; usedB = (st.blocks - st.bfree) * st.bsize; availB = st.bavail * st.bsize;
    } else {
      const f = execSync(`df -Pk "${dataDir}"`, { encoding: 'utf8', timeout: 3000 }).trim().split('\n')[1].split(/\s+/);
      totalB = Number(f[1]) * 1024; usedB = Number(f[2]) * 1024; availB = Number(f[3]) * 1024;
    }
    const gb = (b) => Math.round(b / 1e8) / 10;
    v = { totalGb: gb(totalB), freeGb: gb(availB), usedPct: Math.ceil(usedB / (usedB + availB) * 100) };   // same % as df
  } catch { /* unavailable */ }
  _diskCache = { at: Date.now(), v };
  return v;
}
app.get('/api/system/load', (req, res) => {
  let memTotalMb = null, memAvailableMb = null;
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const t = mi.match(/MemTotal:\s+(\d+)/), a = mi.match(/MemAvailable:\s+(\d+)/);
    if (t) memTotalMb = Math.round(Number(t[1]) / 1024);
    if (a) memAvailableMb = Math.round(Number(a[1]) / 1024);
  } catch { /* ignore */ }
  res.json({ cpuPct: _cpuPct, cores: os.cpus().length, memTotalMb, memAvailableMb, disk: diskUsage() });
});

// ── System info (About dialog) ──
// ODR tool versions via `<bin> --version`. Only called while the mux is NOT running:
// spawning a second odr-dabmux next to a live one could conflict with its ports.
function refreshOdrVersions() {
  const bins = {
    'ODR-DabMux': 'odr-dabmux',
    'ODR-AudioEnc': 'odr-audioenc',
    'ODR-PadEnc': 'odr-padenc',
    'ODR-DabMod': 'odr-dabmod'
  };
  const versions = {};
  for (const [label, bin] of Object.entries(bins)) {
    try {
      const out = execSync(`${bin} --version 2>&1`, { encoding: 'utf8', timeout: 3000 });
      const first = out.split('\n')[0].trim();
      const vm = first.match(/(\d+\.\d+[\.\d]*)/);
      versions[label] = vm ? vm[1] : first;
    } catch {
      versions[label] = null;
    }
  }
  app._odrVersionsCache = versions;
  app._odrVersionsCacheTs = Date.now();
}

app.get('/api/system/info', (req, res) => {
  try {
    // Memory: read /proc/meminfo
    let memAvailableMb = null;
    try {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const m = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
      if (m) memAvailableMb = Math.round(Number(m[1]) / 1024);
    } catch { /* ignore */ }

    // CPU: real usage from /proc/stat sampling
    const cpuLoadPct = _cpuPct;

    // Disk: df on dataDir
    let diskUsedPct = null;
    try {
      const dfOut = execSync(`df -P "${dataDir}"`, { encoding: 'utf8', timeout: 3000 });
      const lines = dfOut.trim().split('\n');
      if (lines.length >= 2) {
        const m = lines[1].match(/(\d+)%/);
        if (m) diskUsedPct = Number(m[1]);
      }
    } catch { /* ignore */ }

    // ODR tool versions (cached 60s) — never spawn while the mux is running
    // (see refreshOdrVersions); the startup snapshot is shown instead.
    // Read muxRunning directly: getState() would consume lastError.
    if (!state.muxRunning && (!app._odrVersionsCache || Date.now() - app._odrVersionsCacheTs > 60000)) {
      refreshOdrVersions();
    }

    res.json({
      memAvailableMb,
      cpuLoadPct,
      diskUsedPct,
      versions: app._odrVersionsCache
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// odr-dabmux management server = ZMQ REP (not HTTP). Read-only "values" query,
// shared between concurrent clients and cached 2s to spare the Pi and dabmux.
let _muxStatsCache = { at: 0, body: null };
let _muxStatsInFlight = null;
// Transmitter outputs (NETWORK mode, Multiplex dialog): who is connected to each listening output.
// Read-only: established TCP connections whose local port is the output port (/proc/net/tcp and
// tcp6, read asynchronously). An EasyDAB connects to the ZMQ output, a transmitter / converter /
// remote odr-dabmod to an EDI/TCP output. EDI/UDP has no connection: only the destination is known.
const hexIp4 = (h) => [3, 2, 1, 0].map((i) => parseInt(h.slice(i * 2, i * 2 + 2), 16)).join('.');
function hexIp6(h) {
  if (h.startsWith('0000000000000000FFFF0000')) return hexIp4(h.slice(24));   // IPv4-mapped
  const words = [];
  for (let i = 0; i < 32; i += 8) { const w = h.slice(i, i + 8).match(/../g).reverse().join(''); words.push(w.slice(0, 4), w.slice(4)); }
  return words.map((w) => parseInt(w, 16).toString(16)).join(':');
}
// /proc files report a size of 0: read them chunk by chunk until EOF. fs.promises.readFile of
// Node 18 (the runtime of the packaged binary) stops after the first page (~4 kB, ~27 sockets),
// so a transmitter connection further in the table was never seen.
async function readProcFile(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const chunks = [];
    const buf = Buffer.alloc(65536);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await fh.close();
  }
}
async function establishedPeers() {
  const peers = new Map();   // local port -> [remote ip]
  for (const [file, toIp] of [['/proc/net/tcp', hexIp4], ['/proc/net/tcp6', hexIp6]]) {
    let text = '';
    try { text = await readProcFile(file); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 4 || f[3] !== '01') continue;   // 01 = ESTABLISHED
      const [, lport] = f[1].split(':');
      const [rip] = f[2].split(':');
      const port = parseInt(lport, 16);
      if (!peers.has(port)) peers.set(port, []);
      peers.get(port).push(toIp(rip));
    }
  }
  return peers;
}
// Transmitter outputs where dabmux listens: alert when a connected transmitter goes away (OutputMonitor).
// Every 5 s ON AIR, async /proc read (same as /api/mux/outputs), one iteration at a time.
const outputMonitor = new OutputMonitor({ logger });
let _outputMonitorBusy = false;
setInterval(async () => {
  if (_outputMonitorBusy) return;
  _outputMonitorBusy = true;
  try {
    const dabmux = settings.dabmux || {};
    const network = String(dabmux.txMode || 'EASYDAB').toUpperCase() === 'NETWORK';
    const outputs = network ? normalizeOutputs(dabmux.outputs) : outputsFromLegacy(dabmux);
    const peers = state.muxRunning ? await establishedPeers() : new Map();
    outputMonitor.tick({ running: state.muxRunning, runKey: state.muxSinceMs, outputs, peers });
  } catch { /* monitoring only: never affects the broadcast */ } finally {
    _outputMonitorBusy = false;
  }
}, 5000).unref();

// 'Check HackRF' (HackRF output / HACKRF mode): hackrf_info only reads the board (never transmits).
// While hackrf_transfer runs it holds the device: reported as in use instead of a failing check.
app.post('/api/hackrf/check', (req, res) => {
  if (pm.isRunning('mux:hackrf_transfer')) {
    return res.json({ ok: true, inUse: true, message: 'HackRF in use by hackrf_transfer (transmitting)' });
  }
  execFile('hackrf_info', [], { timeout: 6000 }, (err, stdout, stderr) => {
    const out = `${stdout || ''}${stderr || ''}`;
    if (err && err.code === 'ENOENT') return res.json({ ok: false, message: 'hackrf_info not installed (sudo apt install hackrf)' });
    if (/No HackRF boards found/i.test(out) || !/Found HackRF/i.test(out)) {
      return res.json({ ok: false, message: 'No HackRF found: check the USB cable and port (lsusb | grep -i hackrf)' });
    }
    const pick = (re) => (re.exec(out) || [])[1]?.trim() || '';
    const serial = pick(/Serial number:\s*(\S+)/i).replace(/^0+/, '');
    const firmware = pick(/Firmware Version:\s*(.+)/i);
    const board = [pick(/Board ID Number:\s*\d+\s*\(([^)]+)\)/i), pick(/Hardware Revision:\s*(.+)/i)].filter(Boolean).join(' ');
    const busy = /Resource busy|LIBUSB_ERROR_BUSY/i.test(out);
    res.json({ ok: !busy, message: busy ? 'HackRF found but busy (used by another program)'
      : `HackRF connected${board ? ` — ${board}` : ''}${firmware ? ` · firmware ${firmware}` : ''}${serial ? ` · serial …${serial.slice(-8)}` : ''}` });
  });
});

// 'Check device' of the SDR output: SoapySDRUtil --find only enumerates devices (never transmits).
// While odr-dabmod drives a SoapySDR device it holds it: reported as in use.
app.post('/api/sdr/check', (req, res) => {
  const o = normalizeOutput({ ...(req.body || {}), type: 'sdr' });
  const device = sdrDeviceString(o);
  if (!device || !/^[A-Za-z0-9_=,.:/ -]+$/.test(device)) return res.json({ ok: false, message: 'Enter the SoapySDR device args (e.g. driver=lime)' });
  if (pm.isRunning('mux:odr-dabmod') && state._localSoapy()) {
    return res.json({ ok: true, inUse: true, message: 'SDR in use by odr-dabmod (SoapySDR, transmitting)' });
  }
  execFile('SoapySDRUtil', [`--find=${device}`], { timeout: 10000 }, (err, stdout, stderr) => {
    const out = `${stdout || ''}${stderr || ''}`;
    if (err && err.code === 'ENOENT') return res.json({ ok: false, message: 'SoapySDRUtil not installed (sudo apt install soapysdr-tools)' });
    const label = (/^\s*label\s*=\s*(.+)$/m.exec(out) || [])[1]?.trim();
    if (!/Found device/i.test(out)) {
      return res.json({ ok: false, message: `No device found for ${device}: check the USB / network link and that its SoapySDR module is installed (SoapySDRUtil --info)` });
    }
    res.json({ ok: true, message: `Found: ${label || device}` });
  });
});

app.get('/api/mux/outputs', async (req, res) => {
  const dabmux = settings.dabmux || {};
  // NETWORK: the outputs list; a legacy mode not converted yet: its equivalent outputs (what it sends)
  const network = String(dabmux.txMode || 'EASYDAB').toUpperCase() === 'NETWORK';
  const outputs = network ? normalizeOutputs(dabmux.outputs) : outputsFromLegacy(dabmux);
  const peers = state.muxRunning ? await establishedPeers() : new Map();
  const monitorPort = Number(dabmux.easyDabOutput?.netPort) || 9901;
  res.json({
    running: state.muxRunning,
    txMode: String(dabmux.txMode || 'EASYDAB').toUpperCase(),
    outputs: outputs.map((o) => ({
      id: o.id, name: o.name, type: o.type, enabled: o.enabled, port: o.port,
      ...(o.type === 'edi-udp' ? { destination: o.destination } : {}),
      ...(o.type === 'hackrf' || o.type === 'sdr' ? { dabBlock: o.dabBlock } : {}),
      connected: o.type === 'edi-udp' || o.type === 'hackrf' || o.type === 'sdr' || !o.enabled ? null : [...new Set(peers.get(o.port) || [])],
      // local HackRF chain: odr-dabmod (connected to the internal EDI port) + hackrf_transfer
      // failing = broken / stalled (watchdog restarting it, see _superviseLocalModulator)
      ...(o.type === 'hackrf' && o.enabled ? { local: { dabmod: pm.isRunning('mux:odr-dabmod'), hackrf: pm.isRunning('mux:hackrf_transfer'), failing: Boolean(state._modState?.failing) } } : {}),
      // SDR (SoapySDR): odr-dabmod alone drives the device, so it stands for both
      ...(o.type === 'sdr' && o.enabled ? { local: { dabmod: pm.isRunning('mux:odr-dabmod'), hackrf: pm.isRunning('mux:odr-dabmod'), driver: 'soapy', failing: Boolean(state._modState?.failing) } } : {}),
    })),
    monitor: { port: monitorPort, connected: [...new Set(peers.get(monitorPort) || [])] },
  });
});

app.get('/api/mux/stats', async (req, res) => {
  // Read fields directly: getState() would consume lastError meant for /api/state.
  if (!state.muxRunning) return res.json({ running: false });

  // sub_N numbering must match muxBuilder: services not explicitly disabled, sorted by ui.order ?? 0
  const sorted = [...(state.preset?.services || [])]
    .filter((s) => s.enabled !== false)
    .sort((a, b) => (a.ui?.order ?? 0) - (b.ui?.order ?? 0));
  const serviceMap = {};
  sorted.forEach((svc, idx) => {
    serviceMap[`sub_${idx + 1}`] = { name: svc.identity?.ps8 || svc.id, id: svc.id };
  });

  const port = Number(state.settings?.dabmux?.managementPort) || 0;
  if (!port) return res.json({ running: true, serviceMap, error: 'Management port disabled' });

  if (_muxStatsCache.body && Date.now() - _muxStatsCache.at < 2000) {
    return res.json({ running: true, serviceMap, ..._muxStatsCache.body });
  }
  if (!_muxStatsInFlight) {
    _muxStatsInFlight = queryDabmux(port, 'values', { timeoutMs: 1000 })
      .then((text) => ({ inputs: normalizeValues(JSON.parse(text), serviceMap), at: Date.now() }))
      .catch((err) => ({ error: String(err.message || err) }))
      .finally(() => { _muxStatsInFlight = null; });
  }
  const body = await _muxStatsInFlight;
  if (!body.error) _muxStatsCache = { at: Date.now(), body };
  res.json({ running: true, serviceMap, ...body });
});

// Web player: decodes one service of the running mux from its ETI monitoring output (the same
// read-only source as the Dablin button) and streams it as MP3. See player.js.
const PLAYER_TX_MODES = ['EDI', 'HACKRF', 'EASYDAB', 'NETWORK'];
app.get('/api/player/info', (req, res) => {
  const txMode = (state.settings?.dabmux?.txMode || 'EASYDAB').toUpperCase();
  res.json({
    missing: missingPlayerTools(),
    supported: PLAYER_TX_MODES.includes(txMode),
    txMode,
    listeners: playerListeners(),
    maxListeners: PLAYER_MAX_LISTENERS,
    lastError: req.query.k ? playerLastError(req.query.k) : null,   // why the stream of this listener failed
  });
});
app.get('/api/player/stream', (req, res) => {
  if (!state.muxRunning) return res.status(409).json({ error: 'Multiplex is off air' });
  const txMode = (state.settings?.dabmux?.txMode || 'EASYDAB').toUpperCase();
  if (!PLAYER_TX_MODES.includes(txMode)) return res.status(409).json({ error: `Player not available in ${txMode} mode` });
  const missing = missingPlayerTools();
  if (missing.length) return res.status(503).json({ error: `Not installed: ${missing.join(', ')}` });
  // sub-channel id = position in the .mux (same filter and order as muxBuilder)
  const sorted = [...(state.preset?.services || [])]
    .filter((s) => s.enabled !== false)
    .sort((a, b) => (a.ui?.order ?? 0) - (b.ui?.order ?? 0));
  const idx = sorted.findIndex((s) => s.id === String(req.query.id || ''));
  if (idx < 0) return res.status(404).json({ error: 'Service not on air' });
  if (!acquireListenerSlot()) return res.status(429).json({ error: `Player busy (max ${PLAYER_MAX_LISTENERS} listeners)` });
  const port = Number(state.settings?.dabmux?.easyDabOutput?.netPort) || 9901;
  const key = String(req.query.k || '').slice(0, 40);
  streamService({ port, subchId: idx + 1, dabPlus: true, key, req, res, log: (m, l) => logger.line('web', m, l) });
});
// Server-side meter of a playing stream (for browsers that cannot analyse it, e.g. iOS Safari)
app.get('/api/player/levels', (req, res) => {
  const levels = playerLevels(req.query.k, Number(req.query.since) || 0);
  if (!levels) return res.status(404).json({ error: 'No such stream' });
  res.json({ levels });
});

// Lines below the requested level removed (lines without a level tag kept, old format)
function filterLogLevel(content, level) {
  if (!level || level === 'DEBUG') return content;
  const hide = level === 'ERROR' ? ['DEBUG', 'WARN', 'INFO'] : level === 'WARN' ? ['DEBUG', 'INFO'] : ['DEBUG'];
  return content.split('\n').filter((line) => {
    const m = line.match(/^\[.*?\] \[([A-Z]+)\] /);
    if (!m) return true; // old format or non-log line — always include
    return !hide.includes(m[1]);
  }).join('\n');
}
const LOG_TAIL_MAX = 4 * 1024 * 1024;
app.get('/api/logs', async (req, res) => {
  const logPath = path.resolve(dataDir, 'logs', 'dabweb.log');
  const level = String(req.query.level || '').toUpperCase();
  // Logs panel: ?tail=N = only the last N bytes (whole lines), ?since=S = only what was appended after
  // byte S (nothing when the file did not change). Read asynchronously: the log can reach 10 MB and a
  // synchronous read every 3 s blocked the server (Pi). X-Log-Size = where to continue next time;
  // X-Log-Mode = tail (replace the text) | append (add to it). No tail = the whole file, as before.
  if (req.query.tail !== undefined) {
    const tail = Math.min(Math.max(Number(req.query.tail) || 0, 1024), LOG_TAIL_MAX);
    const since = req.query.since === undefined ? -1 : Number(req.query.since);
    let fh = null;
    try {
      fh = await fs.promises.open(logPath, 'r');
      const { size } = await fh.stat();
      // same size = no change; smaller = cleared / rotated; far behind = start again from the tail
      const append = Number.isFinite(since) && since >= 0 && since <= size && size - since <= tail;
      const start = append ? since : Math.max(0, size - tail);
      const buf = Buffer.alloc(size - start);
      let got = 0;
      while (got < buf.length) {   // chunk by chunk (one read may return less)
        const { bytesRead } = await fh.read(buf, got, buf.length - got, start + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      let from = 0;
      if (!append && start > 0) from = buf.indexOf(0x0a, 0) + 1;   // drop the cut first line
      const lastNl = buf.lastIndexOf(0x0a, got - 1);
      const end = lastNl >= from ? lastNl + 1 : from;   // a line being written is sent next time
      res.set('X-Log-Size', String(start + end));
      res.set('X-Log-Mode', append ? 'append' : 'tail');
      return res.type('text/plain').send(filterLogLevel(buf.subarray(from, end).toString('utf8'), level));
    } catch (e) {
      res.set('X-Log-Size', '0');
      res.set('X-Log-Mode', 'tail');
      return res.type('text/plain').send(e.code === 'ENOENT' ? '' : `Cannot read the log: ${e.message}`);
    } finally {
      await fh?.close().catch(() => {});
    }
  }
  const content = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  res.type('text/plain').send(filterLogLevel(content, level));
});

app.delete('/api/logs', (req, res) => {
  const logPath = path.resolve(dataDir, 'logs', 'dabweb.log');
  try {
    fs.writeFileSync(logPath, '', 'utf8');
    logger.line('web', 'Log cleared by user');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/logs/download', (req, res) => {
  const logPath = path.resolve(dataDir, 'logs', 'dabweb.log');
  if (!fs.existsSync(logPath)) return res.status(404).type('text/plain').send('No log file');
  res.download(logPath, 'dabweb.log');
});

app.get('/api/logs/metadata', (req, res) => {
  try {
    const logPath = path.resolve(dataDir, 'logs', 'dabweb.log');
    if (!fs.existsSync(logPath)) return res.json({ ok: true, lines: [] });

    // Tail last 256KB
    const stat = fs.statSync(logPath);
    const readSize = Math.min(stat.size, 256 * 1024);
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);
    const content = buf.toString('utf8');

    const svcFilter = String(req.query.svc || '').toUpperCase();
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 300), 2000);

    const pattern = svcFilter ? `svc:${svcFilter}:meta` : 'svc:';
    const lines = content.split('\n')
      .filter((l) => l.includes(pattern) && (!svcFilter || l.includes(`svc:${svcFilter}:meta`)))
      .slice(-limit);

    res.json({ ok: true, lines });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// List running ODR processes (safe ps — no grep self-match)
app.get('/api/ps', (req, res) => {
  const running = [];
  for (const [key, child] of pm.procs.entries()) {
    running.push({ key, pid: child.pid, killed: child.killed });
  }
  res.json({ processes: running });
});

app.post('/api/metadata/test/dls', async (req, res) => {
  try {
    const url = String((req.body || {}).url || '');
    const result = await state.testDlsUrl(url);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/metadata/test/sls', async (req, res) => {
  try {
    const url = String((req.body || {}).url || '');
    const result = await state.testSlsUrl(url);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/metadata/test/json', async (req, res) => {
  try {
    const { url, artistKey, titleKey, slsKey } = req.body || {};
    if (!url) return res.json({ ok: false, error: 'URL required' });
    const text = await state._fetchText(String(url), 5000);
    if (!text) return res.json({ ok: false, error: 'Empty response' });
    const data = JSON.parse(text);
    const { resolveFirst } = await import('./appState.js');
    const artist = resolveFirst(data, artistKey || 'artist');
    const title = resolveFirst(data, titleKey || 'title');
    const coverUrl = resolveFirst(data, slsKey || 'slide');
    res.json({ ok: true, artist, title, coverUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// 'Detect keys' (Metadata tab, JSON mode): read-only, suggests the artist / title / cover keys
app.post('/api/metadata/detect/json', async (req, res) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return res.json({ ok: false, error: 'HTTP(S) URL required' });
    const text = await state._fetchText(url, 5000);
    if (!text) return res.json({ ok: false, error: 'Empty response' });
    let data;
    try { data = JSON.parse(text); } catch { return res.json({ ok: false, error: 'Not JSON (is it the API address, not the web page?)' }); }
    res.json({ ok: true, ...detectJsonKeys(data) });
  } catch (e) {
    res.json({ ok: false, error: String(e.message || e) });
  }
});

// 'Test' button of the service dialog: does this stream URL answer, and what does it announce?
// Read-only: opens the stream, reads the response headers (ICY name / bitrate), then closes it.
// node:http with insecureHTTPParser, not fetch(): many Shoutcast/streamABC servers answer with
// non-standard status lines ('ICY 200 OK', LF-only) that fetch rejects ('fetch failed').
// ICY title reader: after every `metaint` audio bytes come 1 length byte (×16) and
// "StreamTitle='…';". Calls done(title) once: the title ('' if empty), or null at the deadline.
function icyTitleReader(metaint, deadline, done) {
  let buf = Buffer.alloc(0);
  let finished = false;
  const finish = (title) => { if (!finished) { finished = true; clearTimeout(timer); done(title); } };
  const timer = setTimeout(() => finish(null), Math.max(0, deadline - Date.now() - 300));
  return {
    data(c) {
      if (finished) return;
      buf = Buffer.concat([buf, c]);
      if (buf.length <= metaint) return;
      const len = buf[metaint] * 16;
      if (buf.length < metaint + 1 + len) return;
      // ICY titles are UTF-8 or (older servers) ISO-8859-1: fall back when UTF-8 is invalid
      const raw = buf.subarray(metaint + 1, metaint + 1 + len);
      let meta = raw.toString('utf8');
      if (meta.includes('�')) meta = raw.toString('latin1');
      const m = /StreamTitle='(.*?)';/s.exec(meta);
      finish(m ? m[1].trim() : '');
    },
    end() { finish(null); },
  };
}

// Old Shoutcast v1 servers answer 'ICY 200 OK', a status line node:http refuses even with
// insecureHTTPParser: read the answer over a plain TCP / TLS socket instead.
function probeStreamRaw(url, deadline) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    const port = Number(u.port) || (secure ? 443 : 80);
    const sock = secure ? tls.connect({ host: u.hostname, port, servername: u.hostname }) : net.connect({ host: u.hostname, port });
    const stop = setTimeout(() => sock.destroy(Object.assign(new Error('no answer within 6 s'), { code: 'TIMEOUT' })), Math.max(500, deadline - Date.now()));
    let head = Buffer.alloc(0), reader = null, result = null;
    const finish = (title) => { clearTimeout(stop); sock.destroy(); resolve({ ...result, title }); };
    sock.on(secure ? 'secureConnect' : 'connect', () => {
      sock.write(`GET ${u.pathname}${u.search} HTTP/1.0\r\nHost: ${u.host}\r\nIcy-MetaData: 1\r\nUser-Agent: DABcast stream test\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', (c) => {
      if (reader) { reader.data(c); return; }
      head = Buffer.concat([head, c]);
      const m = /\r?\n\r?\n/.exec(head.toString('latin1'));
      if (!m) { if (head.length > 16384) sock.destroy(new Error('invalid answer')); return; }
      const lines = head.toString('latin1', 0, m.index).split(/\r?\n/);
      const st = /^(?:ICY|HTTP\/\d(?:\.\d)?)\s+(\d{3})/i.exec(lines[0] || '');
      if (!st) { sock.destroy(new Error('invalid answer')); return; }
      const headers = {};
      for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
      result = { status: Number(st[1]), headers, url, redirected: false };
      const metaint = Number(headers['icy-metaint']) || 0;
      if (!metaint || result.status < 200 || result.status >= 300) { finish(null); return; }
      reader = icyTitleReader(metaint, deadline, finish);
      const body = head.subarray(m.index + m[0].length);
      if (body.length) reader.data(body);
    });
    sock.on('end', () => (reader ? reader.end() : result ? finish(null) : null));
    sock.on('error', (e) => { clearTimeout(stop); if (!result) reject(e); else finish(null); });
  });
}

function probeStream(url, redirectsLeft = 5, deadline = Date.now() + 6000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'Icy-MetaData': '1', 'User-Agent': 'DABcast stream test' }, insecureHTTPParser: true }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirectsLeft > 0) {
        r.destroy();
        probeStream(new URL(r.headers.location, url).href, redirectsLeft - 1, deadline)
          .then((x) => resolve({ ...x, redirected: true }), reject);
        return;
      }
      const base = { status: r.statusCode, headers: r.headers, url, redirected: false };
      const metaint = Number(r.headers['icy-metaint']) || 0;
      if (!metaint || r.statusCode < 200 || r.statusCode >= 300) {
        resolve({ ...base, title: null });
        r.destroy();
        return;
      }
      const reader = icyTitleReader(metaint, deadline, (title) => { resolve({ ...base, title }); r.destroy(); });
      r.on('data', (c) => reader.data(c));
      r.on('end', () => reader.end());
    });
    req.on('error', (e) => {
      if (e.code === 'HPE_INVALID_CONSTANT') probeStreamRaw(url, deadline).then(resolve, reject);   // 'ICY 200 OK'
      else reject(e);
    });
    req.setTimeout(Math.max(500, deadline - Date.now()), () => req.destroy(Object.assign(new Error('no answer within 6 s'), { code: 'TIMEOUT' })));
  });
}
app.post('/api/streams/test', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.json({ ok: null, message: url ? 'Not an HTTP(S) stream: not tested here (checked when the encoder starts)' : 'URL required' });
  }
  const t0 = Date.now();
  try {
    const r = await probeStream(url);
    const h = (k) => String(r.headers[k] || '');
    const type = h('content-type').split(';')[0];
    const audio = /^audio\/|mpegurl|ogg|aac|mpeg|octet-stream/i.test(type);
    const parts = [
      `HTTP ${r.status}`,
      type || 'no content type',
      h('icy-br') && `${h('icy-br').split(',')[0].trim()} kbps`,
      h('icy-name') && `“${h('icy-name')}”`,
      r.redirected && `via ${new URL(r.url).host}`,
      `${Date.now() - t0} ms`,
    ].filter(Boolean);
    const ok = r.status >= 200 && r.status < 300 && audio;
    // 503 from Icecast/Shoutcast = all listener slots taken: the stream exists (same rule as the watchdog)
    const message = ok ? `✓ ${parts.join(' · ')}`
      : r.status === 503 ? `⚠ ${parts.join(' · ')} — server full (stream exists)`
      : r.status >= 200 && r.status < 300 ? `⚠ ${parts.join(' · ')} — not an audio stream?`
      : `✗ ${parts.join(' · ')}`;
    // ICY title: null = the stream sends no ICY metadata, '' = it sends an empty title
    res.json({ ok: ok ? true : r.status === 503 ? null : false, message, title: r.title, icyMeta: Boolean(r.headers['icy-metaint']) });
  } catch (e) {
    res.json({ ok: false, message: `✗ ${e.code === 'TIMEOUT' ? 'no answer within 6 s' : String(e.code || e.message || e)}` });
  }
});

// Download/refresh slides for all services (or a single one)
app.post('/api/slides/refresh', async (req, res) => {
  try {
    const results = [];
    for (const svc of state.preset.services) {
      if (svc.metadata?.slsUrl) {
        const ok = await state.downloadSlideForService(svc);
        results.push({ id: svc.id, ok });
      }
    }
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Download logo immediately for a service (from URL or data: base64)
app.post('/api/services/:id/logo/download', async (req, res) => {
  try {
    const svcId = String(req.params.id || '');
    const svc = state.preset.services.find((s) => s.id === svcId);
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    // Download using current slsUrl
    const ok = await state.downloadSlideForService(svc);
    if (ok) {
      res.json({ ok: true, message: 'Logo downloaded successfully' });
    } else {
      res.status(400).json({ error: 'Failed to download logo' });
    }
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Upload logo immediately for a service (from file - expects base64 data: URL)
app.post('/api/services/:id/logo/upload', async (req, res) => {
  try {
    const svcId = String(req.params.id || '');
    const { dataUrl } = req.body;
    if (!dataUrl) return res.status(400).json({ error: 'dataUrl required' });

    const svc = state.preset.services.find((s) => s.id === svcId);
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    // Temporarily set slsUrl to the data URL and download
    const originalSlsUrl = svc.metadata?.slsUrl;
    if (!svc.metadata) svc.metadata = {};
    svc.metadata.slsUrl = dataUrl;

    const ok = await state.downloadSlideForService(svc);

    // Restore original slsUrl (don't keep data: URL in config)
    svc.metadata.slsUrl = originalSlsUrl;

    if (ok) {
      res.json({ ok: true, message: 'Logo uploaded successfully' });
    } else {
      res.status(400).json({ error: 'Failed to upload logo' });
    }
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Serve MOT/SLS demo assets for preview (logo, slideshow directory, etc.)
// :svcId of the /api/mot routes names a folder of data/mot (PI code, or an older fifoName / PS8):
// one path segment only — no "/" or "\\" (Express decodes %2F), no "." / "..", no control character —
// so that it can never reach a file outside data/mot (security review).
app.param('svcId', (req, res, next, value) => {
  const v = String(value || '');
  if (!v || v.length > 32 || /[/\\\u0000-\u001f]/.test(v) || /^\.+$/.test(v)) {
    return res.status(400).json({ error: 'Invalid service id' });
  }
  next();
});

app.get('/api/mot/:svcId/logo', (req, res) => {
  try {
    const svcId = String(req.params.svcId || '').toUpperCase();
    const candidates = [
      path.resolve(dataDir, 'mot', svcId, 'slide', 'logo.jpg'),
      path.resolve(dataDir, 'mot', svcId, 'slide', 'logo.png'),
      path.resolve(dataDir, 'mot', svcId, 'slide', 'logo.webp')
    ];
    const file = candidates.find((p) => fs.existsSync(p));
    if (!file) return res.status(404).end();
    res.sendFile(file);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Upload/clear SLS logo
app.post('/api/mot/:svcId/logo', (req, res) => {
  try {
    const svcId = String(req.params.svcId || '').toUpperCase();
    const dataUrl = String((req.body || {}).dataUrl || '');
    if (!dataUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'dataUrl must be a data:image/* URL' });
    }
    const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'Invalid dataUrl' });
    const mime = m[1].toLowerCase();
    const b64 = m[2];
    const buf = Buffer.from(b64, 'base64');
    let ext = 'png';
    if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
    else if (mime.includes('webp')) ext = 'webp';
    else if (mime.includes('png')) ext = 'png';

    const dir = path.resolve(dataDir, 'mot', svcId, 'slide');
    ensureDir(dir);
    // converted to a 320x240 JPEG slide; written as received (logo.<ext>) only if conversion fails
    const conv = path.resolve(dataDir, 'mot', svcId, `.upload_${process.pid}.jpg`);
    const raw = path.resolve(dataDir, 'mot', svcId, `.upload_${process.pid}.${ext}`);
    try {
      fs.writeFileSync(raw, buf);
      if (convertToSlideFile(raw, conv)) fs.renameSync(conv, path.resolve(dir, 'logo.jpg'));
      // as received only if it really is a picture (odr-padenc reads the slide dir too)
      else if (imageCoder(raw)) fs.renameSync(raw, path.resolve(dir, `logo.${ext}`));
      else return res.status(400).json({ error: 'Not a JPEG / PNG / GIF / WebP picture' });
    } finally {
      for (const f of [raw, conv]) { try { fs.unlinkSync(f); } catch { /* moved */ } }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.delete('/api/mot/:svcId/logo', (req, res) => {
  try {
    const svcId = String(req.params.svcId || '').toUpperCase();
    const dir = path.resolve(dataDir, 'mot', svcId, 'slide');
    const candidates = [
      path.resolve(dir, 'logo.png'),
      path.resolve(dir, 'logo.jpg'),
      path.resolve(dir, 'logo.webp')
    ];
    for (const p of candidates) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Upload additional logos (logo_1.jpg, logo_2.jpg...) with 320x240 conversion
app.post('/api/mot/:svcId/upload-logo', (req, res) => {
  try {
    const svcId = String(req.params.svcId || '').toUpperCase();
    const dataUrl = String((req.body || {}).dataUrl || '');
    if (!dataUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'dataUrl must be a data:image/* URL' });
    }
    const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'Invalid dataUrl' });
    const mime = m[1].toLowerCase();
    const b64 = m[2];
    const buf = Buffer.from(b64, 'base64');

    // Determine file extension
    let ext = 'png';
    if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
    else if (mime.includes('webp')) ext = 'webp';
    else if (mime.includes('png')) ext = 'png';

    const dir = path.resolve(dataDir, 'mot', svcId, 'slide');
    ensureDir(dir);

    // Find next available logo_N number
    const existingLogos = fs.readdirSync(dir)
      .filter(f => /^logo_\d+\.jpg$/i.test(f))
      .map(f => parseInt(f.match(/^logo_(\d+)\.jpg$/i)[1], 10))
      .filter(n => !isNaN(n));
    const nextNum = existingLogos.length > 0 ? Math.max(...existingLogos) + 1 : 1;

    // Save temp file first
    const tmpPath = path.resolve(dir, `logo_${nextNum}_tmp.${ext}`);
    fs.writeFileSync(tmpPath, buf);

    // Convert to 320x240 JPEG using ImageMagick
    const finalPath = path.resolve(dir, `logo_${nextNum}.jpg`);
    try {
      execFileSync('convert', [
        tmpPath,
        '-resize', '320x240',
        '-background', 'black',
        '-gravity', 'center',
        '-extent', '320x240',
        '-quality', '85',
        finalPath
      ], { timeout: 10000 });

      // Clean up temp file
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

      logger.line('upload', `${svcId}: logo_${nextNum}.jpg saved (320x240)`);
      res.json({ ok: true, filename: `logo_${nextNum}.jpg` });
    } catch (err) {
      // Clean up temp file on error
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      logger.line('upload', `${svcId}: convert error: ${err.message}`, 'ERROR');
      res.status(500).json({ error: 'Image conversion failed. ImageMagick may not be installed.' });
    }
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Delete a specific logo by filename
app.delete('/api/mot/:svcId/logo/:filename', (req, res) => {
  try {
    const svcId = String(req.params.svcId || '').toUpperCase();
    const filename = path.basename(String(req.params.filename || ''));

    // Only allow deletion of logo_N.jpg files, not logo.jpg (main logo)
    if (!/^logo_\d+\.jpg$/i.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename. Only logo_N.jpg files can be deleted.' });
    }

    const dir = path.resolve(dataDir, 'mot', svcId, 'slide');
    const filePath = path.resolve(dir, filename);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.line('upload', `${svcId}: deleted ${filename}`);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// List all images in a service's slide directory
app.get('/api/mot/:svcId/slides', (req, res) => {
  try {
    const svcId = String(req.params.svcId || '').toUpperCase();
    const dir = path.resolve(dataDir, 'mot', svcId, 'slide');
    if (!fs.existsSync(dir)) return res.json([]);
    const files = fs.readdirSync(dir)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .sort();
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Serve a specific slide image by filename
app.get('/api/mot/:svcId/slide/:filename', (req, res) => {
  try {
    const svcId = String(req.params.svcId || '').toUpperCase();
    const filename = path.basename(String(req.params.filename || ''));
    if (!/\.(jpe?g|png|webp)$/i.test(filename)) return res.status(400).end();
    const file = path.resolve(dataDir, 'mot', svcId, 'slide', filename);
    if (!fs.existsSync(file)) return res.status(404).end();
    res.sendFile(file);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// In-memory cache for GitHub release check (1 hour TTL)
let _releaseCache = null;
let _releaseCacheTime = 0;
let _updateNotifiedVersion = null;

app.get('/api/update/check', async (req, res) => {
  try {
    const now = Date.now();
    if (_releaseCache && (now - _releaseCacheTime) < 3600000 && !req.query.force) {
      return res.json(_releaseCache);
    }
    const r = await fetch(
      'https://api.github.com/repos/DABodr/DABcast-diffusion-software/releases/latest',
      {
        headers: { 'User-Agent': 'DABcast', 'Accept': 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000)
      }
    );
    if (!r.ok) return res.json({ latestVersion: null, releaseUrl: null, assets: [] });
    const data = await r.json();
    // Prefer proper release assets; fall back to .deb links embedded in the release body
    let assets = (data.assets || []).map(a => ({ name: a.name, url: a.browser_download_url, size: a.size || 0 }));
    if (!assets.length && data.body) {
      const re = /\[([^\]]+\.deb)\]\((https?:\/\/[^)]+)\)/g;
      let m;
      while ((m = re.exec(data.body)) !== null) {
        assets.push({ name: m[1], url: m[2], size: 0 });
      }
    }
    _releaseCache = {
      latestVersion: String(data.tag_name || '').replace(/^v/, ''),
      releaseUrl: data.html_url || null,
      releaseNotes: data.body || null,
      assets
    };
    _releaseCacheTime = now;

    // Telegram notification — once per new version
    const currentVersion = state.getState().appVersion;
    const latestVersion = _releaseCache.latestVersion;
    if (latestVersion && currentVersion && latestVersion !== _updateNotifiedVersion) {
      const toNums = s => s.replace(/^v/, '').split('.').map(Number);
      const latest = toNums(latestVersion);
      const current = toNums(currentVersion);
      let newer = false;
      for (let i = 0; i < 3; i++) {
        if ((latest[i] || 0) > (current[i] || 0)) { newer = true; break; }
        if ((latest[i] || 0) < (current[i] || 0)) break;
      }
      if (newer) {
        _updateNotifiedVersion = latestVersion;
        logger.line('update', `New version available: v${latestVersion}`, 'WARN');
      }
    }

    res.json(_releaseCache);
  } catch (_) {
    res.json({ latestVersion: null, releaseUrl: null, assets: [] });
  }
});

// Update progress state
let _updateState = { status: 'idle', progress: 0, error: null, version: null };

app.get('/api/update/progress', (req, res) => {
  res.json(_updateState);
});

app.post('/api/update/apply', async (req, res) => {
  if (_updateState.status !== 'idle' && _updateState.status !== 'error') {
    return res.status(409).json({ error: 'Update already in progress' });
  }
  if (!_releaseCache?.assets?.length) {
    return res.status(400).json({ error: 'No release info — call /api/update/check first' });
  }
  if (state.getState().muxRunning) {
    return res.status(409).json({ error: 'Cannot update while ON AIR. Stop the broadcast first.' });
  }

  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const asset = _releaseCache.assets.find(a => a.name.endsWith('.deb') && a.name.includes(arch));
  if (!asset) {
    return res.status(400).json({ error: `No package found for architecture: ${arch}` });
  }

  _updateState = { status: 'downloading', progress: 0, error: null, version: _releaseCache.latestVersion };
  res.json({ ok: true, arch, asset: asset.name });

  _doUpdate(asset, _releaseCache.latestVersion).catch(err => {
    logger.line('update', `Update failed: ${err.message || err}`, 'ERROR');
    _updateState = { status: 'error', progress: 0, error: String(err.message || err), version: null };
  });
});

// The root helper (dabcast-install-update, sudo rule of the package) downloads the official release
// itself and checks it: the service only gives the version number, never a file (security).
// Its "PROGRESS n" lines drive the progress bar, "INSTALLING" switches to the installing step.
async function _doUpdate(asset, version) {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(version || ''))) throw new Error(`Invalid release version: ${version}`);
  logger.line('update', `Downloading and installing ${asset.name} (v${version})...`);
  let errText = '';
  await new Promise((ok, fail) => {
    const child = spawn('sudo', ['-n', '/opt/dabcast/bin/dabcast-install-update', version], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const m = /^PROGRESS (\d+)$/.exec(line);
        if (m) _updateState.progress = Math.min(100, Number(m[1]));
        else if (line === 'INSTALLING') {
          _updateState = { ..._updateState, status: 'installing', progress: 100 };
          logger.line('update', `Installing ${asset.name}...`);
        } else if (line) logger.line('update', line, 'DEBUG');
      }
    });
    child.stderr.on('data', (d) => { errText = (errText + d.toString()).slice(-500); });
    child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`Installer exited with code ${code}${errText.trim() ? `: ${errText.trim().split('\n').pop()}` : ''}`))));
    child.on('error', fail);
  });

  _updateState = { ..._updateState, status: 'restarting' };
  logger.line('update', 'Update installed, service restarting...');
}

const listenHost = process.env.HOST || settings.host || '0.0.0.0';
const listenPort = Number(process.env.PORT || settings.port || 9090);
const server = app.listen(listenPort, listenHost, () => {
  console.log(`DABcast listening on http://${listenHost}:${listenPort}`);
  logger.line('web', `WebUI on http://${listenHost}:${listenPort}`);

  if (settings.autoStart) {
    // Small delay to let the event loop settle before spawning ODR processes
    setTimeout(async () => {
      try {
        await state.startMux();
        logger.line('web', 'Auto-start: mux started');
      } catch (e) {
        logger.line('web', `Auto-start: ${String(e.message || e)}`, 'ERROR');
      }
    }, 2000);
  }
});

// Periodic memory usage log — helps detect leaks over long broadcasts
setInterval(() => {
  const m = process.memoryUsage();
  const mb = (v) => `${Math.round(v / 1024 / 1024)} MB`;
  logger.line('mem', `rss=${mb(m.rss)} heap=${mb(m.heapUsed)}/${mb(m.heapTotal)} ext=${mb(m.external)}`);
}, 60 * 60 * 1000); // every hour

server.on('error', (err) => {
  logger.line('web', `listen error: ${String(err?.message || err)}`);
  // Make the error visible to the user in the terminal.
  console.error(err);
  process.exit(1);
});

// Graceful shutdown (stop ODR tools)
async function shutdown() {
  try {
    await state.stopMux();
  } catch (e) {
    logger.line('web', `shutdown error: ${String(e?.message || e)}`);
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
