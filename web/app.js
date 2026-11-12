const $ = (sel) => document.querySelector(sel);

const svcTableBody = $('#svcTable tbody');
const dlg = $('#dlgService');
const dlgLogs = $('#dlgLogs');
const dlgMux = $('#dlgMux');
const dlgManageLogos = $('#dlgManageLogos');
const fileImportAll = $('#fileImportAll');
const fileImportService = $('#fileImportService');
const fileUploadLogo = $('#fileUploadLogo');

const TAB_ORDER = ['general','audio','metadata'];
let activeTab = 'general';
let activeLogTab = 'all';

let STATE = null;
let editingId = null;
// Fields the server only accepts while the mux is stopped. Editing them ON AIR = Stop → save → Start.
const MUX_RESTART_FIELDS = ['f_pi','f_ps8','f_ps16','f_bitrate','f_prot','f_sr','f_zbuf','f_zpre','f_codec','f_lang','f_pty','f_ch','f_padsize','f_direct_port'];
let restartSnapshot = null;   // field values when the edit dialog opened ON AIR (null otherwise)
const restartFieldValues = () => MUX_RESTART_FIELDS.map((id) => document.getElementById(id)?.value ?? '');
const restartFieldsChanged = () => Boolean(restartSnapshot && STATE?.muxRunning
  && restartFieldValues().some((v, i) => v !== restartSnapshot[i]));
function updateRestartWarn() {
  document.getElementById('dlgRestartWarn')?.classList.toggle('hidden', !restartFieldsChanged());
}
let selectedServiceId = null;  // Track selected service for export
let logoManagingServiceId = null;  // Track service for logo management
let LOGS_TEXT = '';
let draggedRow = null;  // Track dragged row for reordering
let showRawOutput = false;   // toggle DEBUG lines in logs
let pwdDialogShown = false;  // auto-open password dialog once
let activeServiceFilter = ''; // filter logs by service ID
let durationTimer = null;    // 1-second interval for ON AIR duration
let _updateInfo = null;      // cached result of /api/update/check
// odr-dabmux input buffer stats (from /api/mux/stats, fetched at most every 5s while ON AIR)
let MUX_STATS = null;
let _muxStatsAt = 0;
const _bufLastGlitchAt = new Map();  // service id -> last time dabmux underruns increased
const BUF_GLITCH_WINDOW_MS = 30000;
// After mux Start, buffers fill up and dabmux reports start-up underruns / NoData: each input shows a
// neutral STARTING tag (no warning, no alarm) until its underruns have stopped rising for
// BUF_SETTLE_MS (adaptive: ~10-15 s for a fast stream), at most BUF_STARTUP_MS after Start.
const BUF_STARTUP_MS = 60000;
const BUF_SETTLE_MS = 5000;     // = one clean stats reading (stats are read every 5 s)
const _bufStartAct = new Map();   // service id -> last start-up activity (underrun rise / NoData / first reading)
const _bufSettled = new Set();    // service ids whose start-up is over (settled on a clean reading)
let _bufStartFor = 0;             // muxSinceMs these belong to (new Start = reset)
const muxStartingUp = () => Boolean(STATE?.muxRunning && STATE.muxSinceMs && Date.now() - STATE.muxSinceMs < BUF_STARTUP_MS);
const inputStarting = (id) => muxStartingUp() && !_bufSettled.has(id);
const BUF_STATES = {
  Streaming: ['ok', 'BUFFER OK'], Unstable: ['warn', 'UNSTABLE'], Silence: ['warn', 'SILENCE'], NoData: ['err', 'NO DATA'],
};
function bufTag(inp, always = false) {
  if (!inp) return '';
  if (inp.starting && inp.state !== 'Streaming') {
    const tip = `Mux just started: buffers are filling up, start-up underruns are normal (dabmux: ${inp.state}). Ends once underruns stop rising for ${BUF_SETTLE_MS / 1000} s (at most ${BUF_STARTUP_MS / 1000} s after Start).`;
    return `<span class="buf-tag pend" title="${esc(tip)}">STARTING</span>`;
  }
  let [cls, label] = BUF_STATES[inp.state] || ['', String(inp.state || '?').toUpperCase()];
  // dabmux keeps "Unstable" for minutes after old glitches (e.g. start-up prebuffering):
  // with no new underrun in BUF_GLITCH_WINDOW_MS the input is healthy → show it as BUFFER OK
  if (inp.state === 'Unstable' && !inp.recentGlitch) [cls, label] = BUF_STATES.Streaming;
  if (!always && !label) return '';
  const d = inp.underrunsDelta > 0 ? ` (+${inp.underrunsDelta})` : '';
  const note = inp.state === 'Unstable' && !inp.recentGlitch ? ` (past glitches only, no new underruns in the last ${BUF_GLITCH_WINDOW_MS / 1000} s)` : '';
  const tip = `Mux input: ${inp.state}${note} · fill ${inp.minFill}–${inp.maxFill} · underruns ${inp.underruns}${d} · overruns ${inp.overruns} · peak ${inp.peakLeft}/${inp.peakRight} dBFS`;
  return `<span class="buf-tag ${cls}" title="${esc(tip)}">${label}${d ? ' ▲' : ''}</span>`;
}
// ON AIR edits saved but not yet applied (rt.pendingRestart from setService)
const PENDING_LABELS = { gainDb: 'audio gain', encoderBufferMs: 'encoder buffer', channels: 'channels', pty: 'PTY', languageHex: 'language', enabled: 'enabled' };
function pendingTag(rt) {
  const keys = rt?.pendingRestart;
  if (!keys?.length) return '';
  const tip = `Saved, not applied yet: ${keys.map((k) => PENDING_LABELS[k] || k).join(', ')} — takes effect at the next mux Start (or when this encoder restarts)`;
  return `<span class="buf-tag pend" title="${esc(tip)}">PENDING</span>`;
}
// Server load for the "System" card (/api/system/load: /proc only, cheap), at most every 5 s
let SYS_LOAD = null;
let _sysLoadAt = 0;
function maybeFetchSysLoad() {
  if (Date.now() - _sysLoadAt < 5000) return;
  _sysLoadAt = Date.now();
  api('/api/system/load').then((d) => { SYS_LOAD = d; render(); }).catch(() => { /* best-effort */ });
}
function maybeFetchMuxStats() {
  if (!STATE?.muxRunning) { MUX_STATS = null; return; }
  if (Date.now() - _muxStatsAt < 5000) return;
  _muxStatsAt = Date.now();
  api('/api/mux/stats').then((st) => {
    const prev = MUX_STATS?.inputs || {};
    if (_bufStartFor !== STATE.muxSinceMs) { _bufStartAct.clear(); _bufSettled.clear(); _bufStartFor = STATE.muxSinceMs; }
    const now = Date.now();
    for (const [id, inp] of Object.entries(st.inputs || {})) {
      if (prev[id] && Number.isFinite(inp.underruns)) inp.underrunsDelta = inp.underruns - prev[id].underruns;
      if (inputStarting(id)) {
        // still starting: underruns are expected. Settles only on a clean reading (no new underrun,
        // not NoData) at least BUF_SETTLE_MS after the last start-up activity.
        const active = !(inp.underrunsDelta >= 0) || inp.underrunsDelta > 0 || inp.state === 'NoData';
        if (active) _bufStartAct.set(id, now);
        else if (now - (_bufStartAct.get(id) ?? 0) >= BUF_SETTLE_MS) _bufSettled.add(id);
      } else if (inp.underrunsDelta > 0) _bufLastGlitchAt.set(id, now);   // settled: a new underrun is a real glitch
      inp.starting = inputStarting(id);
      inp.recentGlitch = now - (_bufLastGlitchAt.get(id) || 0) < BUF_GLITCH_WINDOW_MS;
    }
    MUX_STATS = st;
    recordLevels(st);
    render();
    if (dlgLevels?.open) renderLevels();
  }).catch(() => { /* stats are best-effort */ });
}
// v1.4 table view prefs (display only — never written to ui.order)
const VIEW = { q: '', sort: 'order', compact: false };
try { Object.assign(VIEW, JSON.parse(localStorage.getItem('dabcast.view') || '{}'), { q: '' }); } catch { /* ignore */ }
function saveView() { try { localStorage.setItem('dabcast.view', JSON.stringify({ sort: VIEW.sort, compact: VIEW.compact })); } catch { /* ignore */ } }
function viewSort(list) {
  const key = {
    ps: (s) => (s.identity?.ps8 || '').toLowerCase(),
    pid: (s) => String(s.id || '').toUpperCase(),
    bitrate: (s) => -(s.dab?.bitrateKbps ?? 0),
    cu: (s) => -(s.cu ?? 0),
    port: (s) => s.network?.ediOutputTcp?.port ?? 0,
  }[VIEW.sort];
  if (!key) return list;
  return [...list].sort((a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0; });
}
function viewMatch(svc) {
  const q = VIEW.q.trim().toLowerCase();
  if (!q) return true;
  return [svc.identity?.ps8, svc.identity?.ps16, svc.id].some((v) => String(v || '').toLowerCase().includes(q));
}
/** @type {Map<string, {files: string[], index: number, key: string}>} slide rotation state per service */
const slideRotation = new Map();

// DAB Band III frequency table (Hz)
const DAB_FREQ_TABLE = {
  '5A': 174928000, '5B': 176640000, '5C': 178352000, '5D': 180064000,
  '6A': 181936000, '6B': 183648000, '6C': 185360000, '6D': 187072000,
  '7A': 188928000, '7B': 190640000, '7C': 192352000, '7D': 194064000,
  '8A': 195936000, '8B': 197648000, '8C': 199360000, '8D': 201072000,
  '9A': 202928000, '9B': 204640000, '9C': 206352000, '9D': 208064000,
  '10A': 209936000, '10B': 211648000, '10C': 213360000, '10D': 215072000,
  '11A': 216928000, '11B': 218640000, '11C': 220352000, '11D': 222064000,
  '12A': 223936000, '12B': 225648000, '12C': 227360000, '12D': 229072000,
  '13A': 230784000, '13B': 232496000, '13C': 234208000, '13D': 235776000,
  '13E': 237488000, '13F': 239200000
};

// ETSI EN 300 401 — EEP-A / EEP-B CU calculation
function estimateCu(bitrateKbps, protectionLevel = 3, eepMode = 'A') {
  const br = Number(bitrateKbps) || 0;
  const pl = Number(protectionLevel);

  if (eepMode === 'B') {
    switch (pl) {
      case 1: return Math.ceil(27 * br / 32);
      case 2: return Math.ceil(21 * br / 32);
      case 3: return Math.ceil(18 * br / 32);
      case 4: return Math.ceil(15 * br / 32);
      default: return Math.ceil(18 * br / 32);
    }
  }

  switch (pl) {
    case 1: return Math.ceil(12 * br / 8);
    case 2: return br;
    case 3: return Math.ceil(6 * br / 8);
    case 4: return Math.ceil(4 * br / 8);
    default: return Math.ceil(6 * br / 8);
  }
}

function updateCuPreview() {
  const bitrate = Number($('#f_bitrate')?.value || 0);
  const protection = Number($('#f_prot')?.value || 3);
  const cu = estimateCu(bitrate, protection, 'A');
  const cuEl = $('#f_cu');
  if (cuEl) cuEl.value = String(cu);
  updateCuImpact();
}
// Multiplex capacity once this service has the CU shown (the edited service counted once)
function updateCuImpact() {
  const el = $('#cuImpact');
  if (!el || !STATE?.preset) return;
  const cu = Number($('#f_cu')?.value) || 0;
  const max = STATE.preset.capacity?.maxCu ?? 864;
  const others = STATE.preset.services.filter((s) => s.enabled !== false && s.id !== editingId).reduce((t, s) => t + (s.cu ?? 0), 0);
  const svc = editingId ? STATE.preset.services.find((s) => s.id === editingId) : null;
  const counted = svc ? svc.enabled !== false : !STATE.muxRunning;   // a service added ON AIR arrives OFF
  const total = others + (counted ? cu : 0);
  el.textContent = `mux ${total} / ${max}${counted ? '' : ' (OFF, not counted)'}${total > max ? ' — exceeded' : ''}`;
  el.title = counted ? 'Capacity units used by the multiplex with this service' : 'This service is OFF: its CU are not counted in the multiplex';
  el.classList.toggle('over', total > max);
}
// PAD size → slide sending speed (X-PAD ≈ PAD bytes × ~24 AU/s)
function updatePadHelp() {
  const el = $('#padHelp');
  const pad = Number($('#f_padsize')?.value) || 0;
  if (!el) return;
  if (pad < 4) { el.textContent = ''; return; }
  const bps = pad * 24;
  const t = (kb) => Math.max(1, Math.round(kb * 1024 / bps));
  el.textContent = `≈ ${(bps / 1024).toFixed(1)} kB/s for slides: 5 kB logo ≈ ${t(5)} s, 15 kB cover ≈ ${t(15)} s`;
}
$('#f_padsize')?.addEventListener('input', updatePadHelp);
// PS8 / PS16 character counters
function updatePsCounts() {
  for (const [id, max] of [['ps8', 8], ['ps16', 16]]) {
    const el = $(`#${id}Count`);
    if (el) el.textContent = `${($(`#f_${id}`)?.value || '').length} / ${max}`;
  }
  // Live hint of the PS8 ⊂ PS16 rule (still enforced on save by validateServiceForm)
  const c16 = $('#ps16Count');
  const bad = shortLabelMismatch($('#f_ps8')?.value.trim(), $('#f_ps16')?.value.trim());
  if (c16) {
    if (bad) c16.textContent = `⚠ PS8 not in PS16 · ${c16.textContent}`;
    c16.classList.toggle('over', bad);
    c16.title = bad ? 'PS16 must contain all characters of PS8, in the same order' : '';
  }
  // Live hint for the PI: 4 hex digits, not used by another service (still checked on save)
  const piHint = $('#piHint');
  if (piHint) {
    const raw = $('#f_pi')?.value.trim() || '';
    const pi = normalizePiValue(raw);
    const dup = pi && STATE?.preset?.services?.find((s) => s.id !== editingId && normalizePiValue(s.identity?.pi || s.id) === pi);
    const msg = !raw ? '' : !pi ? '⚠ 4 hex digits (0-9, A-F)' : dup ? `⚠ already used by ${dup.identity?.ps8 || dup.id}` : '';
    piHint.textContent = msg;
    piHint.classList.toggle('over', Boolean(msg));
  }
}
['f_pi', 'f_ps8', 'f_ps16'].forEach((id) => document.getElementById(id)?.addEventListener('input', updatePsCounts));
// Failover block: silence / return only matter when switching to the backup is on
function updateFailoverVisibility() {
  const mode = $('#f_src')?.value;
  if (mode === 'ZMQ' || mode === 'EDI') return;   // whole block hidden by updateSourceVisibility
  const on = $('#f_switch')?.value === '1';
  for (const id of ['f_thresh_row', 'f_return_row']) {
    const el = document.getElementById(id);
    if (el) el.style.display = on ? '' : 'none';
  }
}
$('#f_switch')?.addEventListener('change', updateFailoverVisibility);
// 'Test' next to the main / backup stream URLs (server-side check, read-only)
document.querySelectorAll('[data-test-url]').forEach((btn) => btn.addEventListener('click', async () => {
  const id = btn.dataset.testUrl;
  const out = $(`#${id}_test`);
  const url = ($(`#${id}`)?.value || '').trim();
  if (!out) return;
  if (!url) { out.textContent = 'Enter a URL first'; out.className = 'field-note err'; return; }
  btn.disabled = true;
  out.textContent = 'Testing…';
  out.className = 'field-note';
  try {
    const r = await api('/api/streams/test', { method: 'POST', body: JSON.stringify({ url }) });
    out.className = `field-note ${r.ok === true ? 'ok' : r.ok === false ? 'err' : ''}`;
    // ICY title sent by the stream (what STREAM mode would put in the DLS)
    const title = r.ok === true || r.ok === null
      ? (r.title ? `<span class="stream-title">♪ ${esc(r.title)}</span>`
        : `<span class="stream-notitle">no title${r.icyMeta ? ' (empty ICY title)' : ' (no ICY metadata in this stream)'}</span>`)
      : '';
    out.innerHTML = `${esc(r.message)}${title ? `<br>${title}` : ''}`;
  } catch (err) {
    out.textContent = err.message || String(err);
    out.className = 'field-note err';
  } finally {
    btn.disabled = false;
  }
}));

function updateSourceVisibility() {
  const mode = $('#f_src')?.value;
  const isDirect = mode === 'ZMQ' || mode === 'EDI';
  // Metadata tab: text settings are not used for direct inputs (DLS / DL+ / slides from the remote encoder)
  $('#metaDirectNote')?.classList.toggle('hidden', !isDirect);
  for (const id of ['f_meta_mode', 'f_dlplus_enabled', 'f_json_default_dls', 'f_default_dls', 'f_json_url', 'f_json_interval', 'f_json_artist', 'f_json_title', 'f_json_sls', 'f_json_start', 'f_json_duration', 'f_json_trackmax', 'f_json_logoevery']) {
    const el = document.getElementById(id);
    if (el) el.disabled = isDirect;
  }
  updateMetaModeVisibility();   // mode buttons follow the disabled state
  updateFailoverVisibility();
  const encoderRowIds = ['f_gain_row', 'f_uri_row', 'f_thresh_row', 'f_return_row', 'f_switch_row', 'f_backup_row', 'f_swap_row', 'f_failover_card'];
  for (const id of encoderRowIds) {
    const el = document.getElementById(id);
    if (el) el.style.display = isDirect ? 'none' : '';
  }
  const directRowIds = ['f_direct_port_row', 'f_direct_bitrate_row', 'f_direct_prot_row'];
  for (const id of directRowIds) {
    const el = document.getElementById(id);
    if (el) el.style.display = isDirect ? '' : 'none';
  }
}

// EBU Latin character set (ETSI EN 300 401, Annex A):
// ASCII printable (0x20-0x7E) + accented European characters
const DAB_LABEL_INVALID_RE = /[^\x20-\x7EÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿŒœŠšŽžŸ]/g;

function attachDabLabelFilter(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => {
    const before = el.value;
    const after = before.replace(DAB_LABEL_INVALID_RE, '');
    if (before !== after) {
      const pos = el.selectionStart - (before.length - after.length);
      el.value = after;
      el.setSelectionRange(Math.max(0, pos), Math.max(0, pos));
    }
  });
}

['f_ps8', 'f_ps16', 'm_short', 'm_label'].forEach(attachDabLabelFilter);

function showToast(msg, type = 'error') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 5000);
}

async function api(path, opts) {
  const headers = { 'Content-Type': 'application/json' };
  const res = await fetch(path, {
    headers,
    ...opts
  });
  if (res.status === 401) {
    const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.replace(`/login.html?next=${encodeURIComponent(next)}`);
    throw new Error('Authentication required');
  }
  if (!res.ok) {
    const t = await res.text();
    let msg = t || `HTTP ${res.status}`;
    try {
      const j = JSON.parse(t);
      if (j.detail) msg = j.detail;
      else if (j.error) msg = j.error;
    } catch { /* not JSON */ }
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

function badge(status) {
  const s = (status || 'UNKNOWN').toUpperCase();
  let cls = 'pill';
  if (s.includes('RUN')) cls += ' ok';
  else if (s.includes('WARN')) cls += ' warn';
  else if (s.includes('START')) cls += ' warn';
  else if (s.includes('STOP')) cls += ' off';
  return `<span class="${cls}">${s}</span>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function readConfigFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || '');
        const data = JSON.parse(text);
        resolve(data);
      } catch (err) {
        reject(new Error('Invalid file format (JSON expected)'));
      }
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

// PTY cell of the services table: name from the dialog's PTY list ("10 - Pop Music" → "Pop Music")
function ptyCell(pty) {
  const n = Number.isInteger(Number(pty)) ? Number(pty) : 10;
  const full = document.querySelector(`#f_pty option[value="${n}"]`)?.textContent || String(n);
  const name = full.replace(/^\d+\s*-\s*/, '');
  return `<span title="PTY ${esc(full)}">${esc(name)}</span>`;
}
function streamDot(isActive, hasUri, isOnAir, isWarn = false) {
  if (!hasUri) return '';
  const cls = isActive ? (isWarn ? 'dot warn' : 'dot ok') : (isOnAir ? 'dot err' : 'dot');
  const title = isActive ? (isWarn ? 'Instable' : 'En lecture') : (isOnAir ? 'Hors ligne' : 'En attente');
  return `<span class="${cls}" title="${title}"></span>`;
}

// ZMQ/EDI direct inputs have no local odr-audioenc (whose stderr feeds rt.audioLevels):
// use the input peaks measured by odr-dabmux (dBFS, /api/mux/stats), mapped to the same
// 0–6 bar scale as odr-audioenc's level() (2 dB per step, '!' clip from -1 dBFS).
function dbToVuBar(db) {
  if (!Number.isFinite(db) || db <= -90) return { n: 0, clip: false };
  const vu = Math.floor(27 + db);
  const idx = vu < 26 ? Math.max(Math.floor(vu / 2), 0) : Math.min(vu - 13, 13);
  return { n: Math.min(Math.ceil(idx / 2), 6), clip: idx >= 13 };
}
function muxPeakLevels(inp) {
  if (!inp || !Number.isFinite(inp.peakLeft)) return null;
  const l = dbToVuBar(inp.peakLeft), r = dbToVuBar(inp.peakRight);
  return { left: l.n, right: r.n, clipLeft: l.clip, clipRight: r.clip };
}

// Audio levels assistant: odr-dabmux input peaks sampled every 5 s (maybeFetchMuxStats) while this
// page is open, over a sliding window. Display + suggestion only — a gain is saved on an explicit click.
let LEVEL_WINDOW_MS = 5 * 60 * 1000;   // analysis window, chosen in the dialog (5 / 15 / 30 min)
try { LEVEL_WINDOW_MS = (Number(localStorage.getItem('dabcast.levelWindowMin')) || 5) * 60000; } catch { /* ignore */ }
// Highest peak allowed before encoding: AAC (and SBR even more) raises the decoded peaks by 1-3 dB,
// so a source peaking at -1 dBFS can clip in the receiver (crackles). -3 dBFS keeps that margin.
const LEVEL_MAX_PEAK_DB = -3;
const LEVEL_MIN_OVER = 3;   // fewer samples than this above the margin = isolated peaks
const LEVEL_MIN_SAMPLES = 12;     // ≈ 1 min of audio before suggesting a gain
const LEVEL_SILENCE_DB = -40;     // quiet passages / silence are not counted
const _levelSamples = new Map();  // svc id -> { key, list: [{ t, db }] }
// a measurement is valid for one gain and one source (new measurement after a gain change or a main/backup switch)
const levelKey = (svc) => `${svc.audio?.gainDb ?? 0}|${svc.runtime?.activeUri ?? ''}`;
function recordLevels(st) {
  if (!STATE?.preset) return;
  const now = Date.now();
  for (const [id, inp] of Object.entries(st.inputs || {})) {
    const svc = STATE.preset.services.find((s) => s.id === id);
    if (!svc || inp.starting) continue;   // start-up peaks are not representative
    // saved gain not applied yet: the audio still has the old gain → do not mix the two
    if (svc.runtime?.pendingRestart?.includes('gainDb')) { _levelSamples.delete(id); continue; }
    const key = levelKey(svc);
    let rec = _levelSamples.get(id);
    if (!rec || rec.key !== key) { rec = { key, list: [], clips: [] }; _levelSamples.set(id, rec); }
    // odr-audioenc clip indicator ('!' of its level meter) seen at this sample: encoder input saturated
    const al = svc.runtime?.audioLevels;
    if (al?.clipLeft || al?.clipRight) rec.clips.push(now);
    while (rec.clips.length && now - rec.clips[0] > LEVEL_WINDOW_MS) rec.clips.shift();
    const db = Math.max(Number(inp.peakLeft), Number(inp.peakRight));
    // slow peak = dabmux maximum over a longer window: the 5 s samples alone miss the real peaks
    const slow = Math.max(Number(inp.peakLeftSlow), Number(inp.peakRightSlow));
    if (Number.isFinite(db) && db > LEVEL_SILENCE_DB) rec.list.push({ t: now, db, slow: Number.isFinite(slow) ? slow : db });
    while (rec.list.length && now - rec.list[0].t > LEVEL_WINDOW_MS) rec.list.shift();
  }
}
function levelStats(svc) {
  const rec = _levelSamples.get(svc.id);
  const list = rec && rec.key === levelKey(svc) ? rec.list : [];
  if (!list.length) return { n: 0 };
  const v = list.map((x) => x.db).sort((a, b) => a - b);
  const pct = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  const max = Math.max(v[v.length - 1], ...list.map((x) => x.slow));
  const over = v.filter((db) => db > LEVEL_MAX_PEAK_DB).length;   // 5 s samples above the margin
  return { n: v.length, median: pct(0.5), p95: pct(0.95), max, over, minutes: (list[list.length - 1].t - list[0].t) / 60000, clips: rec.clips?.length || 0 };
}
// New gain (dB) that brings the typical peak to the target. The highest peak measured (slow peak
// included) must stay at or below LEVEL_MAX_PEAK_DB (-3 dBFS, margin for the AAC overshoot), and
// a service whose encoder reported clipping always gets at least -2 dB.
// A boost is limited to +6 dB per step (measure again after applying).
const LEVEL_MAX_BOOST_DB = 6;
function suggestGain(curGain, st, target) {
  // isolated peaks (no encoder clipping, fewer than LEVEL_MIN_OVER samples above the margin): they
  // forbid a boost but do not force a reduction (a quiet station is not made quieter for one peak)
  const isolated = !st.clips && (st.over ?? 0) < LEVEL_MIN_OVER;
  const headroom = isolated ? Math.max(0, LEVEL_MAX_PEAK_DB - st.max) : LEVEL_MAX_PEAK_DB - st.max;
  let delta = Math.min(target - st.median, headroom, LEVEL_MAX_BOOST_DB);
  if (st.clips) delta = Math.min(delta, -2);
  // clipping (peaks flattened at 0 dBFS): the real level is unknown → remove the whole added boost
  if (st.max > -1 && curGain > 0) delta = Math.min(delta, -curGain);
  if (Math.abs(delta) < 1) return null;   // close enough
  const g = Math.round((curGain + delta) * 2) / 2;
  return Math.max(-20, Math.min(20, g));
}

function vuMeter(audioLevels) {
  const l = audioLevels?.left ?? 0;
  const r = audioLevels?.right ?? 0;
  const cl = audioLevels?.clipLeft;
  const cr = audioLevels?.clipRight;
  const pctL = Math.round((l / 6) * 100);
  const clsL = cl ? 'vu-fill clip' : l >= 5 ? 'vu-fill hot' : 'vu-fill';
  if (audioLevels?.mono) {
    return `<div class="vu"><div class="vu-row"><span class="vu-label">M</span><div class="vu-track"><div class="${clsL}" style="width:${pctL}%"></div></div></div></div>`;
  }
  const pctR = Math.round((r / 6) * 100);
  const clsR = cr ? 'vu-fill clip' : r >= 5 ? 'vu-fill hot' : 'vu-fill';
  return `<div class="vu"><div class="vu-row"><span class="vu-label">L</span><div class="vu-track"><div class="${clsL}" style="width:${pctL}%"></div></div></div><div class="vu-row"><span class="vu-label">R</span><div class="vu-track"><div class="${clsR}" style="width:${pctR}%"></div></div></div></div>`;
}

function normalizePiValue(pi) {
  const trimmed = String(pi || '').trim();
  const hex = trimmed.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
  return hex.toUpperCase();
}

function showServiceError(message) {
  const el = $('#svcError');
  if (!el) return;
  if (!message) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  el.textContent = message;
  el.classList.remove('hidden');
}

function validateServiceForm() {
  const errors = [];
  const piInput = $('#f_pi').value.trim();
  const normalizedPi = normalizePiValue(piInput);
  if (!normalizedPi) errors.push('Program identifier (PI) must be hexadecimal!');

  const ps8 = $('#f_ps8').value.trim();
  const ps16 = $('#f_ps16').value.trim();
  if (ps8.length > 8) errors.push('PS8 must contain at most 8 characters.');
  if (ps16.length > 16) errors.push('PS16 must contain at most 16 characters.');
  if (ps8 && ps16 && shortLabelMismatch(ps8, ps16)) {
    errors.push('PS16 must contain all characters from PS8.');
  }

  const bitrate = Number($('#f_bitrate').value);
  const allowed = STATE.allowedBitratesKbps || [];
  if (!allowed.includes(bitrate)) errors.push('Bitrate not allowed.');

  const codec = $('#f_codec').value;
  const channels = Number($('#f_ch').value || 2);
  if (codec === 'HE-AAC v2 (PS)' && channels !== 2) {
    errors.push('HE-AAC v2 (PS) requires stereo mode (2 channels).');
  }

  return { errors, normalizedPi };
}

function shortLabelMismatch(ps8, ps16) {
  const short = String(ps8 || '').toUpperCase();
  const long = String(ps16 || '').toUpperCase();
  if (!short || !long) return false;
  let pos = 0;
  for (const ch of short) {
    if (ch === ' ') continue;
    const idx = long.indexOf(ch, pos);
    if (idx === -1) return true;
    pos = idx + 1;
  }
  return false;
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d)}:${pad(h)}:${pad(m)}:${pad(s)}`;
}

function updateDuration() {
  if (!STATE || !STATE.muxSinceMs) return;
  const el = $('#onAirDuration');
  if (!el) return;
  const elapsed = Date.now() - STATE.muxSinceMs;
  el.textContent = formatDuration(Math.max(0, elapsed));
}

// v1.4 stats cards — derived only from existing /api/state fields
function sysCard(card) {
  const L = SYS_LOAD;
  if (!L) return card('System', '—', 'loading…', '');
  const cpu = Number.isFinite(L.cpuPct) ? L.cpuPct : null;
  const cls = cpu === null ? '' : cpu < 70 ? 'cap-ok' : cpu < 90 ? 'cap-warn' : 'cap-bad';
  const gb = (mb) => (mb / 1024).toFixed(1);
  const memUsed = L.memTotalMb && L.memAvailableMb != null ? L.memTotalMb - L.memAvailableMb : null;
  const memTxt = memUsed !== null ? `RAM ${gb(memUsed)}/${gb(L.memTotalMb)} GB` : 'RAM —';
  const dk = L.disk;
  const diskCls = !dk ? '' : (dk.usedPct >= 95 || dk.freeGb < 2) ? 'sys-bad' : dk.usedPct >= 90 ? 'sys-warn' : '';
  const diskTxt = dk ? `<span class="${diskCls}">Disk ${dk.freeGb} GB free</span>` : 'Disk —';
  const tip = `CPU ${cpu ?? '—'} % (${L.cores} cores) · RAM used ${memUsed ?? '—'} / ${L.memTotalMb ?? '—'} MB · `
    + (L.disk ? `Disk (data dir) ${L.disk.usedPct} % used, ${L.disk.freeGb} / ${L.disk.totalGb} GB free` : 'Disk —');
  return card('System', cpu === null ? '—' : `${Math.round(cpu)} % <span class="stat-unit">CPU</span>`,
    `<div class="stat-bar"><div class="stat-bar-fill ${cls}" style="width:${Math.min(cpu ?? 0, 100)}%"></div></div>${memTxt}<br>${diskTxt}`,
    cls, tip);
}
function renderStats(cap) {
  const el = $('#statsRow');
  if (!el) return;
  const all = STATE.preset.services || [];
  const enabled = all.filter((s) => s.enabled);
  const st = (s) => String(s.runtime?.status || 'UNKNOWN').toUpperCase();
  const running = enabled.filter((s) => st(s) === 'RUNNING').length;
  const warn = enabled.filter((s) => st(s) === 'WARNING').length;
  const err = STATE.muxRunning ? enabled.filter((s) => st(s) === 'ERROR' || st(s) === 'RESTARTING').length : 0;
  // ZMQ/EDI direct services carry their own DLS (external encoder): not counted here
  const isDirect = (s) => ['ZMQ', 'EDI'].includes(String(s.input?.mode || '').toUpperCase());
  const dlsBase = enabled.filter((s) => !isDirect(s));
  const dls = STATE.muxRunning ? dlsBase.filter((s) => s.runtime?.currentDls).length : 0;
  const sls = STATE.muxRunning ? dlsBase.filter((s) => s.runtime?.currentSlsUrl).length : 0;
  const ratio = cap.maxCu ? cap.totalCu / cap.maxCu : 0;
  const capCls = ratio < 0.8 ? 'cap-ok' : ratio <= 1.0 ? 'cap-warn' : 'cap-bad';
  const ens = STATE.settings.ensemble || {};
  const tx = STATE.settings.dabmux?.txMode || 'EASYDAB';
  const block = STATE.settings.dabmux?.hackrf?.dabBlock || '7A';
  const muxSub = tx === 'HACKRF'
    ? `${esc(block)} · ${((DAB_FREQ_TABLE[block] || 0) / 1e6).toFixed(3)} MHz`
    : `TX: ${esc(tx)}`;
  const bufInputs = STATE.muxRunning && MUX_STATS?.inputs ? Object.values(MUX_STATS.inputs) : [];
  // healthy = Streaming, or Unstable with no recent underrun (dabmux keeps "Unstable" long after start-up)
  const settled = bufInputs.filter((i) => !(i.starting && i.state !== 'Streaming'));
  const bufStartingN = bufInputs.length - settled.length;
  const bufStarting = bufInputs.length > 0 && bufStartingN === bufInputs.length;
  const bufOk = settled.filter((i) => i.state === 'Streaming' || (i.state === 'Unstable' && !i.recentGlitch)).length;
  const bufBad = settled.filter((i) => i.state === 'NoData' || i.state === 'Silence').length;
  const bufUnstable = settled.filter((i) => i.state === 'Unstable' && i.recentGlitch).length;
  const alarms = warn + err + bufBad;
  const card = (title, val, sub, valCls = '', tip = '', attrs = '') =>
    `<div class="stat-card"${tip ? ` title="${esc(tip)}"` : ''}${attrs}><div class="stat-title">${title}</div><div class="stat-val ${valCls}">${val}</div><div class="stat-sub">${sub}</div></div>`;
  const html = [
    card('Ensemble', esc(ens.label || '—'), `${esc(ens.idHex || '')} · ${muxSub}`, 'stat-val-sm'),
    card('Capacity', `${cap.totalCu} / ${cap.maxCu} CU`,
      `<div class="stat-bar"><div class="stat-bar-fill ${capCls}" style="width:${Math.min(ratio * 100, 100).toFixed(0)}%"></div></div>${Math.round(ratio * 100)} %`, capCls),
    card('Services', `${enabled.length}`, `enabled / ${all.length}`, ''),
    card('Encoders', STATE.muxRunning ? `${running}` : '—', STATE.muxRunning ? `running / ${enabled.length}` : 'off air', STATE.muxRunning && running === enabled.length ? 'cap-ok' : ''),
    card('Mux inputs', bufInputs.length ? `${bufOk} / ${bufInputs.length}` : '—',
      bufInputs.length ? (bufStarting ? 'starting · buffers filling' : `${bufStartingN ? `${bufStartingN} starting · ` : 'healthy · '}${bufUnstable} glitching · ${bufBad} no audio`) : (STATE.muxRunning ? (MUX_STATS?.error ? 'stats unavailable' : 'loading…') : 'off air'),
      bufInputs.length ? (bufStarting ? '' : bufBad ? 'cap-bad' : bufUnstable ? 'cap-warn' : 'cap-ok') : '',
      'Click: audio levels and gain suggestions', ' data-act="levels" role="button" tabindex="0"'),
    card('Metadata', STATE.muxRunning ? `${dls} / ${dlsBase.length}` : '—',
      STATE.muxRunning ? `DLS text · ${sls} cover art` : 'off air', STATE.muxRunning && dls === dlsBase.length ? 'cap-ok' : '',
      'DLS: enabled services currently sending a text (now playing or default text); ZMQ/EDI direct services send their own DLS and are not counted. Cover art: services currently sending a dynamic image (album cover from JSON/XML or SLS URL) — static logos are not counted.'),
    sysCard(card),
    card('Alarms', `${alarms}`, alarms ? `${warn} warning · ${err} error · ${bufBad} mux input` : 'none', alarms ? (err ? 'cap-bad' : 'cap-warn') : 'cap-ok'),
  ].join('');
  if (el._last !== html) { el.innerHTML = html; el._last = html; }
}

function render() {
  if (!STATE) return;
  if (dlgPlayer?.open) renderPlayer();
  if (dlg?.open) renderMetaLive();

  // Password change banner + lock UI
  const pwdBanner = $('#pwdBanner');
  const locked_pwd = !!STATE.mustChangePassword;
  if (pwdBanner) {
    pwdBanner.classList.toggle('hidden', !locked_pwd);
  }

  const lockableButtons = ['btnStop','btnAdd','btnMux','btnLevels','btnPlayer','btnLogs','btnTelegram',
    'btnExportConfig','btnImportAll','btnExportService','btnImportService','btnExportAllServices','btnDablin'];
  for (const id of lockableButtons) {
    const el = document.getElementById(id);
    if (el) el.disabled = locked_pwd;
  }

  // Display software name in title, config file name in subtitle
  $('#muxName').textContent = 'DABcast';
  const verEl = $('#appVersion');
  if (verEl && STATE.appVersion) verEl.textContent = `v${STATE.appVersion}`;
  // Update browser tab title
  if (STATE.appVersion) document.title = `DABcast v${STATE.appVersion}`;
  // Update badge
  const badgeEl = $('#updateBadge');
  if (badgeEl) {
    if (_updateInfo?.updateAvailable) {
      badgeEl.textContent = `↑ v${_updateInfo.latestVersion}`;
      badgeEl.classList.remove('hidden');
    } else {
      badgeEl.classList.add('hidden');
    }
  }
  const tx = (STATE.settings.dabmux?.txMode || 'EASYDAB');
  const ip = STATE.localIp || '127.0.0.1';
  const out = (tx === 'EASYDAB')
    ? `ZMQ: ${STATE.settings.dabmux.easyDabOutput?.ip || '0.0.0.0'}:${STATE.settings.dabmux.easyDabOutput?.port || 18081}`
    : (tx === 'EDI')
      ? `EDI TCP: ${STATE.settings.dabmux.ediTcpListenPort}`
      : (tx === 'HACKRF')
        ? `Block: ${STATE.settings.dabmux.hackrf?.dabBlock || '7A'} (${((DAB_FREQ_TABLE[STATE.settings.dabmux.hackrf?.dabBlock || '7A'] || 0) / 1e6).toFixed(3)} MHz)`
        : 'USRP1';
  $('#muxSubtitle').textContent = `${ip} | TX: ${tx} | ${out}`;

  // capacity hint (CU)
  const cap = STATE.preset.capacity || { totalCu: 0, maxCu: 864 };
  const ratio = cap.maxCu ? (cap.totalCu / cap.maxCu) : 0;

  const capEl = $('#capHint');
  if (capEl) {
    capEl.textContent = ratio > 1.0 ? `Capacity exceeded: ${cap.totalCu}/${cap.maxCu} CU — Start disabled` : '';
    capEl.classList.remove('cap-ok','cap-warn','cap-bad');
    if (ratio < 0.8) capEl.classList.add('cap-ok');
    else if (ratio <= 1.0) capEl.classList.add('cap-warn');
    else capEl.classList.add('cap-bad');
  }

  // top bar CU gauge
  const gaugeText = $('#cuGaugeText');
  const gaugeFill = $('#cuGaugeFill');
  if (gaugeText) {
    gaugeText.textContent = `CU: ${cap.totalCu} / ${cap.maxCu}`;
    gaugeText.classList.remove('cap-ok','cap-warn','cap-bad');
    if (ratio < 0.8) gaugeText.classList.add('cap-ok');
    else if (ratio <= 1.0) gaugeText.classList.add('cap-warn');
    else gaugeText.classList.add('cap-bad');
  }
  if (gaugeFill) {
    gaugeFill.style.width = `${Math.min(ratio * 100, 100)}%`;
    gaugeFill.classList.remove('warn','bad');
    if (ratio >= 0.8 && ratio <= 1.0) gaugeFill.classList.add('warn');
    else if (ratio > 1.0) gaugeFill.classList.add('bad');
  }

  const on = STATE.muxRunning;
  const startBtn = $('#btnStart');
  if (startBtn) {
    const exceeded = cap.totalCu > cap.maxCu;
    const noneOn = !(STATE.preset.services || []).some((s) => s.enabled !== false);
    startBtn.disabled = on || exceeded || locked_pwd || noneOn;
    if (locked_pwd) startBtn.title = 'Change password first';
    else if (exceeded) startBtn.title = 'CU capacity exceeded';
    else if (noneOn) startBtn.title = 'All services are OFF';
    else startBtn.title = '';
  }
  // Show async errors (e.g. HackRF not connected)
  if (STATE.lastError) {
    showToast(STATE.lastError);
    STATE.lastError = null;
  }

  const isFail = STATE.muxStatus === 'fail';
  const onAir = $('#onAir');
  onAir.textContent = isFail ? 'FAIL' : (on ? 'ON AIR' : 'OFF AIR');
  onAir.classList.toggle('on', on && !isFail);
  onAir.classList.toggle('fail', isFail);

  // Duration counter
  const durEl = $('#onAirDuration');
  if (durEl) {
    durEl.classList.toggle('on', on && !isFail);
    durEl.classList.toggle('fail', isFail);
    durEl.classList.toggle('off', !on && !isFail);
    updateDuration();
  }
  if (!durationTimer) {
    durationTimer = setInterval(updateDuration, 1000);
  }

  renderStats(cap);

  const services = viewSort([...STATE.preset.services].sort((a,b) => (a.ui?.order ?? 0) - (b.ui?.order ?? 0)));
  const viewActive = VIEW.sort !== 'order' || VIEW.q.trim() !== '';
  $('#svcTable')?.classList.toggle('compact', VIEW.compact);
  const viewHint = $('#svcViewHint');
  if (viewHint) viewHint.textContent = viewActive ? 'Drag & drop reordering disabled while sorted or filtered' : '';
  if (!services.length) {
    svcTableBody.innerHTML = `<tr><td class="muted" colspan="18">No service found.</td></tr>`;
    return;
  }

  // Index existing rows by service ID for reuse (prevents image flicker)
  const oldRows = new Map();
  for (const r of [...svcTableBody.querySelectorAll('tr[data-service-id]')]) {
    oldRows.set(r.dataset.serviceId, r);
  }

  const orderedRows = [];
  for (const svc of services) {
    let tr = oldRows.get(svc.id);
    const isNew = !tr;
    if (isNew) {
      tr = document.createElement('tr');
      tr.dataset.serviceId = svc.id;
    }
    oldRows.delete(svc.id);

    tr.dataset.order = svc.ui?.order ?? 0;
    tr.draggable = !STATE.muxRunning && !viewActive;
    tr.style.cursor = tr.draggable ? 'grab' : 'default';
    tr.style.display = viewMatch(svc) ? '' : 'none';
    tr.classList.toggle('selected', selectedServiceId === svc.id);
    tr.classList.toggle('svc-off', svc.enabled === false);

    const status = svc.runtime?.status || 'UNKNOWN';
    const dlsPreview = svc.runtime?.currentDls || (svc.metadata?.defaultDlsAllowed !== false ? (svc.metadata?.defaultDls || '') : '');
    // ON AIR: thumbnails show what odr-padenc really sends (runtime.airSlides: the cover alone, or a
    // logo during its turn, or the logos), not every image of slide/
    const airFiles = STATE.muxRunning && Array.isArray(svc.runtime?.airSlides) && svc.runtime.airSlides.length ? svc.runtime.airSlides : null;
    const trackKey = `${dlsPreview || ''}${airFiles ? `|${airFiles.join(',')}` : ''}`;
    const svcKey = encodeURIComponent(svc.pad?.fifoName || svc.id);
    const backupUri = svc.input?.backupUri || '';
    const isDirectInput = ['ZMQ', 'EDI'].includes(String(svc.input?.mode || '').toUpperCase());
    const activeUri = svc.runtime?.activeUri || '';
    const isHealthy = status === 'RUNNING';
    const isWarning = status === 'WARNING';
    const isActive = isHealthy || isWarning;
    const activeIsMain = isActive && Boolean(activeUri && svc.input?.uri && activeUri === svc.input.uri);
    const activeIsBackup = isActive && !activeIsMain && Boolean(activeUri && backupUri && activeUri === backupUri);

    const ps8 = svc.identity.ps8 || '';
    const ps16 = svc.identity.ps16 || '';
    const hasMismatch = shortLabelMismatch(ps8, ps16);
    const ps8Title = hasMismatch
      ? `Short label "${ps8}" is not subset of label "${ps16}"`
      : '';

    // Cell definitions: [cssClass, innerHTML]
    const cells = [
      ['', badge(status) + (STATE.muxRunning ? bufTag(MUX_STATS?.inputs?.[svc.id]) + pendingTag(svc.runtime) : '')],
      ['', `<div class="ps"${ps8Title ? ` title="${esc(ps8Title)}"` : ''}>${esc(ps8)}</div><div class="muted">${esc(ps16)}</div>`],
      ['col-pid hide-mobile', esc(svc.id)],
      ['col-pty hide-mobile', ptyCell(svc.identity?.pty)],
      ['col-bitrate', `${svc.dab.bitrateKbps} kbps`],
      ['col-cu', `${svc.cu ?? ''}`],
      ['col-prot', esc(String(svc.dab.protectionLevel ?? 3))],
      ['col-codec', esc(svc.audio?.codec || 'HE-AAC v1')],
      ['col-ch', (svc.audio?.channels ?? 2) === 1 ? 'Mono' : 'Stereo'],
      ['col-sr', `${esc(String((svc.audio?.sampleRateHz ?? 48000) / 1000))} kHz`],
      ['col-port', `${svc.network.ediOutputTcp.port}`],
      // ZMQ/EDI direct (external encoder): no main/backup stream, even if old URLs are still stored
      ['col-main', streamDot(activeIsMain, !isDirectInput && Boolean(svc.input?.uri), on && svc.enabled !== false, isWarning && activeIsMain)],
      ['col-bkp', streamDot(activeIsBackup, !isDirectInput && Boolean(backupUri), false, isWarning && activeIsBackup)],
      ['', vuMeter(!STATE.muxRunning ? null
        : ['ZMQ', 'EDI'].includes(String(svc.input?.mode || '').toUpperCase()) ? muxPeakLevels(MUX_STATS?.inputs?.[svc.id])
        : svc.runtime?.audioLevels)],
      // ZMQ/EDI direct: DLS / DL+ travel in the external encoder's PAD — DABcast's own DLS is not broadcast
      ['muted col-dls', isDirectInput
        ? '<div class="dls-text" title="DLS and DL+ are sent by the external encoder (PAD of the ZMQ/EDI input)">from encoder</div>'
        : `<div class="dls-text" title="${esc(dlsPreview)}">${esc(dlsPreview)}</div>`],
      ['col-dlplus', svc.runtime?.dlplusActive && !isDirectInput ? '<span class="dlplus-icon" title="DL+ active">DL+</span>' : ''],
      ['muted sls-cell', ''],  // placeholder — image handled separately
      ['row-actions col-actions', `<button class="btn btn-mini svc-toggle ${svc.enabled === false ? 'off' : 'on'}" data-act="toggle" data-id="${svc.id}" title="${svc.enabled === false ? 'Service OFF (not in the multiplex) — click to put it back on air' : 'Service ON — click to take it off the multiplex'}">${svc.enabled === false ? 'OFF' : 'ON'}</button><button class="btn btn-mini" data-act="edit" data-id="${svc.id}">Edit</button><button class="btn btn-mini" data-act="del" data-id="${svc.id}">Del</button>`],
    ];

    const SLS_COL = 16;

    if (isNew) {
      tr.innerHTML = cells.map(([cls, html]) => `<td${cls ? ` class="${cls}"` : ''}>${html}</td>`).join('');
      // Create persistent img element for SLS thumbnail
      const td = tr.children[SLS_COL];
      const img = document.createElement('img');
      img.className = 'sls-thumb';
      img.draggable = false;
      img.style.display = 'none';
      img.onerror = function() { this.style.display = 'none'; };
      td.appendChild(img);
      td._svcKey = svcKey;
      td._trackKey = trackKey;
    } else {
      // Update only changed cells (prevents image flicker)
      const tds = tr.children;
      for (let i = 0; i < cells.length && i < tds.length; i++) {
        if (i === SLS_COL) continue; // skip — handled below
        const html = cells[i][1];
        if (tds[i]._last !== html) {
          tds[i].innerHTML = html;
          tds[i]._last = html;
        }
      }
      const td = tds[SLS_COL];
      td._svcKey = svcKey;
      td._trackKey = trackKey;
    }

    // Refresh slide list when track changes
    _refreshSlideList(svc.id, svcKey, trackKey, false, airFiles);

    orderedRows.push(tr);
  }

  // Remove deleted service rows
  for (const stale of oldRows.values()) stale.remove();

  // Ensure correct DOM order
  for (let i = 0; i < orderedRows.length; i++) {
    if (svcTableBody.children[i] !== orderedRows[i]) {
      svcTableBody.insertBefore(orderedRows[i], svcTableBody.children[i] || null);
    }
  }
  // Remove extra children (e.g. stale "no services" placeholder)
  while (svcTableBody.children.length > orderedRows.length) {
    svcTableBody.lastChild.remove();
  }

  // ON AIR: only OFF services (not in the running mux) can be deleted
  document.querySelectorAll('[data-act="del"]').forEach((b) => {
    const s = STATE.preset.services.find((x) => x.id === b.dataset.id);
    b.disabled = STATE.muxRunning && s?.enabled !== false;
    b.title = b.disabled ? 'ON AIR: turn the service OFF first, then delete it' : 'Delete this service';
  });

  // Setup drag & drop for service reordering
  setupDragAndDrop();
}

// --- Slide preview popup ---
let slidePreviewSvcId = null;

svcTableBody.addEventListener('click', (e) => {
  const img = e.target.closest('.sls-thumb');
  if (!img) return;
  const tr = img.closest('tr[data-service-id]');
  if (!tr) return;
  const svcId = tr.dataset.serviceId;
  const rot = slideRotation.get(svcId);
  if (!rot || !rot.files.length) return;
  slidePreviewSvcId = svcId;
  const dlg = $('#dlgSlidePreview');
  const previewImg = $('#slidePreviewImg');
  previewImg.src = img.src;
  dlg.showModal();
  dlg.addEventListener('close', () => { slidePreviewSvcId = null; }, { once: true });
});

// Click on backdrop closes preview
$('#dlgSlidePreview')?.addEventListener('click', function(e) {
  if (e.target === this) this.close();
});

// --- Slide rotation for thumbnails ---

/** Fetch slide list for a service and update rotation state */
async function _refreshSlideList(svcId, svcKey, trackKey, force = false, airFiles = null) {
  let rot = slideRotation.get(svcId);
  if (!force && rot && rot.key === trackKey) return; // already up-to-date
  try {
    let files = airFiles ? [...airFiles] : await api(`/api/mot/${svcKey}/slides`);
    if (!Array.isArray(files)) return;
    // Not on air (mux stopped or service OFF): logos only — the last track cover stays in slide/
    // after a stop but is not sent any more
    if (!airFiles && files.some((f) => f !== 'cover.jpg')) files = files.filter((f) => f !== 'cover.jpg');
    // Preserve current index if forcing refresh (logo added/deleted)
    const currentIndex = force && rot ? rot.index : 0;
    slideRotation.set(svcId, { files, index: currentIndex, key: trackKey, svcKey });
    // Show first slide immediately
    _showSlide(svcId);
  } catch { /* ignore */ }
}

/** Force refresh slide list for a service (e.g., after uploading/deleting logo) */
async function _forceRefreshSlides(svcId) {
  const svc = STATE?.preset?.services?.find(s => s.id === svcId);
  if (!svc) return;
  const svcKey = encodeURIComponent(svc.pad?.fifoName || svc.id);
  const dlsPreview = svc.runtime?.currentDls || (svc.metadata?.defaultDlsAllowed !== false ? (svc.metadata?.defaultDls || '') : '');
  const airFiles = STATE.muxRunning && Array.isArray(svc.runtime?.airSlides) && svc.runtime.airSlides.length ? svc.runtime.airSlides : null;
  const trackKey = `${dlsPreview || ''}${airFiles ? `|${airFiles.join(',')}` : ''}`;
  await _refreshSlideList(svcId, svcKey, trackKey, true, airFiles);
}

/** Preload and display current slide for a service */
function _showSlide(svcId) {
  const rot = slideRotation.get(svcId);
  if (!rot || !rot.files.length) return;
  const tr = svcTableBody.querySelector(`tr[data-service-id="${svcId}"]`);
  if (!tr) return;
  const td = tr.children[16];   // SLS column
  const img = td?.querySelector('img');
  if (!img) return;
  const file = rot.files[rot.index % rot.files.length];
  // Add timestamp for cache-busting (especially important for single-slide services where cover updates)
  const url = `/api/mot/${rot.svcKey}/slide/${encodeURIComponent(file)}?v=${encodeURIComponent(rot.key)}&t=${Date.now()}`;
  const tmp = new Image();
  tmp.onload = () => {
    img.src = url; img.style.display = '';
    // Also update preview popup if open for this service
    if (slidePreviewSvcId === svcId) {
      const previewImg = $('#slidePreviewImg');
      if (previewImg) previewImg.src = url;
    }
  };
  tmp.onerror = () => {
    img.style.display = 'none';
    // Remove failed file from rotation so we don't keep trying to load it
    rot.files = rot.files.filter(f => f !== file);
    if (rot.files.length && rot.index >= rot.files.length) rot.index = 0;
  };
  tmp.src = url;
}

// Rotate all thumbnails every 5 seconds
setInterval(() => {
  for (const [svcId, rot] of slideRotation) {
    if (rot.files.length > 1) {
      // Multiple slides: rotate to next
      rot.index = (rot.index + 1) % rot.files.length;
    }
    // Always refresh display (even single slide) to catch cover updates
    _showSlide(svcId);
  }
}, 5000);

// Drag & drop for service reordering
function setupDragAndDrop() {
  const rows = svcTableBody.querySelectorAll('tr[draggable="true"]');

  rows.forEach(row => {
    if (row.dataset.dragSetup === 'true') return;
    row.dataset.dragSetup = 'true';

    row.addEventListener('dragstart', (e) => {
      draggedRow = row;
      row.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });

    row.addEventListener('dragend', async () => {
      const moved = draggedRow;
      draggedRow = null;
      if (moved) moved.style.opacity = '';

      // Persist order from current DOM
      const current = Array.from(svcTableBody.querySelectorAll('tr[data-service-id]'));
      const newOrder = current.map(r => r.dataset.serviceId);
      try {
        await api('/api/services/reorder', {
          method: 'POST',
          body: JSON.stringify({ order: newOrder })
        });
      } catch { /* refresh will restore */ }
      await refresh();
    });

    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!draggedRow || draggedRow === row) return;
      // Guard: don't insert a detached node (periodic refresh rebuilt DOM)
      if (draggedRow.parentNode !== row.parentNode) return;

      const rect = row.getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;

      if (e.clientY < midpoint) {
        row.parentNode.insertBefore(draggedRow, row);
      } else {
        row.parentNode.insertBefore(draggedRow, row.nextSibling);
      }
    });

    row.addEventListener('drop', (e) => { e.preventDefault(); });
  });
}

function fillBitrates(selectEl, allowed, value) {
  selectEl.innerHTML = '';
  for (const br of allowed) {
    const opt = document.createElement('option');
    opt.value = String(br);
    opt.textContent = String(br);
    if (br === value) opt.selected = true;
    selectEl.appendChild(opt);
  }
}

function openDialogFor(service) {
  editingId = service?.id || null;
  const locked = STATE.muxRunning;
  showServiceError('');

  $('#dlgTitle').textContent = editingId ? `Edit: ${service?.identity?.ps8}` : 'Add service';
  $('#dlgLockHint').textContent = !locked ? ''
    : editingId ? 'ON AIR: changing identity, bitrate, protection or audio format restarts the whole multiplex on save · audio gain restarts only this service’s encoder (2–3 s) · encoder buffer alone applies at the next mux Start'
    : 'ON AIR: the new service is added OFF — press its ON button to put it on air (restarts the multiplex)';

  // --- General tab ---
  $('#f_pi').value = (service?.identity?.pi || '').replace(/^0x/i, '');
  $('#f_ps8').value = service?.identity?.ps8 || '';
  $('#f_ps16').value = service?.identity?.ps16 || '';
  $('#f_pty').value = service?.identity?.pty ?? 10;

  $('#f_lang').value = service?.identity?.languageHex || '0x0F';

  fillBitrates($('#f_bitrate'), STATE.allowedBitratesKbps || [], service?.dab?.bitrateKbps ?? 88);
  $('#f_prot').value = String(service?.dab?.protectionLevel ?? 3);

  $('#f_sr').value = String(service?.audio?.sampleRateHz ?? 48000);
  $('#f_ch').value = String(service?.audio?.channels ?? 2);
  $('#f_cu').value = String(service?.cu ?? estimateCu($('#f_bitrate').value, $('#f_prot').value, 'A'));

  $('#f_zbuf').value = service?.input?.zmqBuffer ?? 40;
  $('#f_zpre').value = service?.input?.zmqPrebuffering ?? 20;

  $('#f_encbuf').value = service?.input?.encoderBufferMs ?? 200;
  $('#f_gain').value = service?.audio?.gainDb ?? 0;
  $('#f_codec').value = service?.audio?.codec || 'HE-AAC v1 (SBR)';
  $('#f_padsize').value = service?.dab?.padSize ?? 58;

  // PS (Parametric Stereo) requires stereo
  const chSel = $('#f_ch');
  if ($('#f_codec').value === 'HE-AAC v2 (PS)') {
    chSel.value = '2';
    chSel.disabled = true;
  } else {
    chSel.disabled = false;
  }

  // --- Audio tab ---
  const _rawMode = (service?.input?.mode || 'GSTREAMER').toUpperCase();
  if (_rawMode === 'ZMQ' || _rawMode === 'EDI') {
    $('#f_src').value = _rawMode;
  } else {
    $('#f_src').value = _rawMode.includes('GST') ? 'GSTREAMER' : 'VLC';
  }
  const _port = service?.network?.ediOutputTcp?.port;
  const _portEl = document.getElementById('f_direct_port');
  if (_portEl) _portEl.value = _port ? String(_port) : '';
  fillBitrates($('#f_direct_bitrate'), STATE.allowedBitratesKbps || [], service?.dab?.bitrateKbps ?? 88);
  const _dprotEl = document.getElementById('f_direct_prot');
  if (_dprotEl) _dprotEl.value = String(service?.dab?.protectionLevel ?? 3);
  updateSourceVisibility();
  $('#f_uri').value = service?.input?.uri || '';
  $('#f_backup').value = service?.input?.backupUri || '';

  $('#f_thresh').value = service?.watchdog?.silenceThresholdSec ?? 10;
  $('#f_return').value = service?.watchdog?.returnToMainAfterSec ?? 60;
  $('#f_switch').value = service?.watchdog?.switchToBackupOnSilence ? '1' : '0';

  // --- Metadata tab ---
  $('#f_meta_mode').value = service?.metadata?.mode || 'STREAM';
  $('#f_default_dls').value = service?.metadata?.defaultDls || '';
  updateDlsCount();
  $('#f_sls_url').value = service?.metadata?.slsUrl || '';

  // JSON mode fields
  $('#f_json_url').value = service?.metadata?.url || '';
  $('#f_json_interval').value = service?.metadata?.intervalSec ?? 10;
  // new service: keys empty (grey 'e.g.' hint; empty = default key on save) until typed or detected
  // a key saved empty stays empty; a key never saved (old preset) shows the default
  $('#f_json_artist').value = service ? (service.metadata?.artistKey ?? 'artist') : '';
  $('#f_json_title').value = service ? (service.metadata?.titleKey ?? 'title') : '';
  $('#f_json_sls').value = service ? (service.metadata?.slsKey ?? 'slide') : '';
  $('#f_json_start').value = service?.metadata?.startKey || '';
  $('#f_json_duration').value = service?.metadata?.durationKey || '';
  $('#f_json_trackmax').value = service?.metadata?.trackMaxMin ?? 8;
  $('#f_json_logoevery').value = service?.metadata?.logoEverySec ?? 40;
  $('#f_dlplus_enabled').value = service?.dlplus?.enabled !== false ? 'yes' : 'no';
  $('#f_json_default_dls').value = service?.metadata?.defaultDlsAllowed !== false ? 'yes' : 'no';
  $('#jsonTestStatus').textContent = '';
  $('#jsonTestStatus').className = 'json-status';
  const cpb = $('#coverPreviewBox'); if (cpb) cpb.style.display = 'none';
  $('#btnMetaApply')?.classList.toggle('hidden', !editingId);   // new service: saved by OK only
  updateMetaModeVisibility();
  renderMetaLive();
  applyMetaFold();
  updatePsCounts();
  updatePadHelp();
  updateCuImpact();
  ['f_uri_test', 'f_backup_test'].forEach((id) => { const el = document.getElementById(id); if (el) el.textContent = ''; });

  // SLS preview (logo or slsUrl)
  const img = $('#slsImg');
  const slsWrap = $('#slsImgWrap');
  const hint = $('#slsHint');
  if (img) {
    const slsUrlVal = service?.metadata?.slsUrl || '';
    if (slsUrlVal) {
      // SLS URL is set — show it as preview (may be data: or http:)
      img.src = slsUrlVal;
      img.style.display = 'block';
      if (slsWrap) slsWrap.classList.remove('no-logo');
      if (hint) hint.textContent = 'SLS via URL';
      img.onerror = () => {
        img.removeAttribute('src');
        img.style.display = 'none';
        if (slsWrap) slsWrap.classList.add('no-logo');
        if (hint) hint.textContent = 'Invalid SLS URL';
      };
    } else if (editingId) {
      const key = (service?.pad?.fifoName || service?.identity?.ps8 || service?.id || '').toString();
      img.src = `/api/mot/${encodeURIComponent(key)}/logo?ts=${Date.now()}`;
      img.style.display = 'block';
      if (slsWrap) slsWrap.classList.remove('no-logo');
      if (hint) hint.textContent = `Logo: data/mot/${key.toUpperCase()}/slide/logo.*`;
      img.onerror = () => {
        img.removeAttribute('src');
        img.style.display = 'none';
        if (slsWrap) slsWrap.classList.add('no-logo');
        if (hint) hint.textContent = 'No default logo';
      };
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
      if (slsWrap) slsWrap.classList.add('no-logo');
      if (hint) hint.textContent = '';
    }
  }

  // ON AIR: fields stay editable — edit restarts the mux on save, a new service is added OFF
  MUX_RESTART_FIELDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = id === 'f_ch' && $('#f_codec').value === 'HE-AAC v2 (PS)';
  });
  restartSnapshot = locked && editingId ? restartFieldValues() : null;
  updateRestartWarn();

  // reset tabs
  setActiveTab('general');

  dlg.showModal();
  // Same dialog height on the three tabs (the tallest one at opening); unfolding Metadata blocks still grows it
  const panels = [...document.querySelectorAll('#dlgService .tabpanel')];
  panels.forEach((p) => { p.style.minHeight = ''; });
  const tallest = Math.max(...panels.map((p) => {
    const hidden = p.classList.contains('hidden');
    p.classList.remove('hidden');
    const h = p.offsetHeight;
    if (hidden) p.classList.add('hidden');
    return h;
  }));
  panels.forEach((p) => { p.style.minHeight = `${tallest}px`; });
  svcSnapshot = new Map();
  snapshotSvcForm();
}

function setActiveTab(tab) {
  activeTab = tab;
  document.querySelectorAll('#dlgService .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('#dlgService .tabpanel').forEach((p) => {
    p.classList.toggle('hidden', p.dataset.panel !== tab);
  });
  $('#btnPrev').disabled = (TAB_ORDER.indexOf(activeTab) <= 0);
  $('#btnNext').disabled = (TAB_ORDER.indexOf(activeTab) >= TAB_ORDER.length - 1);
}

let refreshAbort = null;

async function checkForUpdate() {
  try {
    const data = await api('/api/update/check');
    if (!data?.latestVersion || !STATE?.appVersion) return;
    const toNums = s => s.replace(/^v/, '').split('.').map(Number);
    const latest = toNums(data.latestVersion);
    const current = toNums(STATE.appVersion);
    let newer = false;
    for (let i = 0; i < 3; i++) {
      if ((latest[i] || 0) > (current[i] || 0)) { newer = true; break; }
      if ((latest[i] || 0) < (current[i] || 0)) break;
    }
    _updateInfo = { updateAvailable: newer, latestVersion: data.latestVersion, releaseUrl: data.releaseUrl, releaseNotes: data.releaseNotes || null };
    if (newer) render();
  } catch (_) { /* non-critical */ }
}

async function refresh() {
  // Abort any previous in-flight refresh
  if (refreshAbort) refreshAbort.abort();
  refreshAbort = new AbortController();
  try {
    STATE = await api('/api/state', { signal: refreshAbort.signal });
    render();
    maybeFetchMuxStats();
    maybeFetchSysLoad();
    if (STATE.mustChangePassword && !pwdDialogShown) {
      pwdDialogShown = true;
      showAuth();
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // intentionally cancelled
    const capEl = $('#capHint');
    if (capEl) {
      capEl.textContent = `API Error: ${err.message || String(err)}`;
      capEl.classList.remove('cap-ok','cap-warn','cap-bad');
      capEl.classList.add('cap-bad');
    }
  }
}


async function start() {
  try {
    await api('/api/mux/start', { method: 'POST', body: '{}' });
  } catch (err) {
    const onAir = $('#onAir');
    onAir.textContent = 'FAIL';
    onAir.classList.remove('on');
    onAir.classList.add('fail');
    showToast(err.message || String(err));
    return;
  }
  await refresh();
}

async function stop() {
  if (STATE?.muxRunning && !confirm('Stop the multiplex? This interrupts the broadcast.')) return;
  await api('/api/mux/stop', { method: 'POST', body: '{}' });
  await refresh();
}

async function startDablin() {
  const h = window.location.hostname;
  const isLocal = (h === 'localhost' || h === '127.0.0.1' || h === '::1');
  if (!isLocal) {
    showToast(`Dablin opens on the server's own screen — open DABcast on the server machine at localhost:${window.location.port || 80}.`, 'error');
    return;
  }

  try {
    await api('/api/dablin/start', { method: 'POST', body: '{}' });
  } catch (err) {
    showToast(err.message || String(err), 'error');
  }
}

let _logRefreshTimer = null;

async function _refreshLogContent() {
  const level = showRawOutput ? 'DEBUG' : 'INFO';
  const text = await api(`/api/logs?level=${level}`);
  LOGS_TEXT = String(text || '');
  renderLogs();
}

async function showLogs() {
  await _refreshLogContent();

  // Populate service filter select
  const sel = $('#selLogService');
  if (sel && STATE?.preset?.services) {
    const prev = sel.value;
    sel.innerHTML = '<option value="">All services</option>';
    for (const svc of STATE.preset.services) {
      const opt = document.createElement('option');
      opt.value = svc.id;
      opt.textContent = svc.identity?.ps8 || svc.id;
      sel.appendChild(opt);
    }
    sel.value = prev || '';
    activeServiceFilter = sel.value;
  }

  renderLogs();
  dlgLogs.showModal();

  // Auto-refresh every 3s while dialog is open
  clearInterval(_logRefreshTimer);
  _logRefreshTimer = setInterval(_refreshLogContent, 3000);
}

dlgLogs.addEventListener('close', () => {
  clearInterval(_logRefreshTimer);
  _logRefreshTimer = null;
});

// Config export file name: ensemble (mux) label made filename-safe; falls back to the preset id
function configExportBaseName(payload) {
  const label = String(payload?.settings?.ensemble?.label || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return label || (payload?.preset?.id ? payload.preset.id.replace(/\s+/g, '_') : 'dabcast');
}

async function exportAllConfig() {
  const payload = await api('/api/export/full');
  downloadJson(`dabcast_config_${configExportBaseName(payload)}.json`, payload);
}

async function importAllConfig(file) {
  let payload = await readConfigFile(file);

  // Support raw preset files ({ id, services, ... } without settings/preset wrapper)
  if (!payload.preset && Array.isArray(payload.services)) {
    payload = { preset: payload };
  }

  if (!payload.preset) {
    throw new Error('Format de fichier invalide (preset manquant)');
  }

  await api('/api/import/full', { method: 'POST', body: JSON.stringify(payload) });
  await refresh();
}

async function exportService(id) {
  const payload = await api(`/api/export/service/${encodeURIComponent(id)}`);
  const name = payload?.service?.identity?.ps8 || id;
  downloadJson(`dabcast_service_${name}.dct`, payload);  // Changed extension to .dct
}

async function importService(file) {
  const payload = await readConfigFile(file);

  // Check if service with this ID already exists
  const serviceId = payload?.service?.id;
  const serviceName = payload?.service?.identity?.ps8 || serviceId;

  const existing = serviceId && STATE.preset.services.find(s => s.id === serviceId);
  if (existing && STATE.muxRunning && existing.enabled !== false) {
    throw new Error(`"${serviceName}" is ON AIR — turn it OFF first to replace it`);
  }
  if (existing) {
    const overwrite = confirm(`Service "${serviceName}" already exists. Do you want to overwrite it?`);
    if (!overwrite) {
      throw new Error('Import cancelled');
    }

    // Delete existing service first
    await api(`/api/services/${serviceId}`, { method: 'DELETE' });
  }

  const res = await api('/api/import/service', { method: 'POST', body: JSON.stringify(payload) });
  await refresh();
  // Port already used here (e.g. service exported from another mux): the server assigned a free one
  const wanted = payload?.service?.network?.ediOutputTcp?.port;
  const got = res?.service?.network?.ediOutputTcp?.port;
  return wanted && got && wanted !== got ? `${serviceName}: input port ${wanted} → ${got}` : null;
}

function logLineScope(line) {
  // New format: [ISO] [LEVEL] [scope] msg  — Old format: [ISO] [scope] msg
  const m = line.match(/^\[[^\]]+\]\s+(?:\[[A-Z]+\]\s+)?\[([^\]]+)\]\s/);
  return m ? m[1] : '';
}

function logLineLevel(line) {
  const m = line.match(/^\[[^\]]+\]\s+\[([A-Z]+)\]\s+\[/);
  return m ? m[1] : 'INFO'; // old format without level → treat as INFO
}

function filterLogsByTab(tab) {
  if (!LOGS_TEXT) return '';

  let lines = LOGS_TEXT.split('\n');

  // Pre-filter by service if active
  if (activeServiceFilter) {
    lines = lines.filter((line) => {
      const scope = logLineScope(line);
      return scope.includes(`svc:${activeServiceFilter}`) || scope === 'mux' || scope === 'watchdog' || scope === 'metadata' || scope === 'web' || !scope;
    });
  }

  if (tab === 'all') return lines.join('\n');

  if (tab === 'dabmux') {
    return lines.filter((line) => {
      const scope = logLineScope(line);
      return scope === 'mux' || scope.startsWith('mux:odr-dabmux');
    }).join('\n');
  }

  if (tab === 'audio') {
    return lines.filter((line) => {
      const scope = logLineScope(line);
      return scope.includes(':audioenc') || scope.includes(':padenc');
    }).join('\n');
  }

  if (tab === 'proc') {
    return lines.filter((line) => (
      line.includes('spawn:') || line.includes('stop:') || line.includes('exit:')
    )).join('\n');
  }

  if (tab === 'errors') {
    return lines.filter((line) => {
      const lvl = logLineLevel(line);
      return lvl === 'ERROR' || lvl === 'WARN' || line.includes('exit: code=');
    }).join('\n');
  }

  return lines.join('\n');
}

function renderLogs() {
  document.querySelectorAll('.logs-tabs .tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.logtab === activeLogTab);
  });
  $('#logsPre').textContent = filterLogsByTab(activeLogTab);
}

function showMuxError(message) {
  const el = $('#muxError');
  if (!el) return;
  if (!message) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  el.textContent = message;
  el.classList.remove('hidden');
}

function normalizeHex(raw, expectedLen) {
  const hex = String(raw || '').trim().replace(/^0x/i, '').toUpperCase();
  if (hex.length !== expectedLen) return null;
  if (!/^[0-9A-F]+$/.test(hex)) return null;
  return hex;
}

// Multiplex settings read by odr-dabmux/dabmod at start. Editing them ON AIR = Stop → save → Start.
const MUX_DLG_RESTART_FIELDS = ['m_ens_id','m_ecc','m_label','m_short','m_txmode','m_easydab_ip','m_easydab_port','m_edi_port','m_edi_pft','m_edi_fec','m_edi_tist_offset','m_mgmt','m_telnet',
  'm_hackrf_block','m_hackrf_txgain','m_hackrf_maxframes','m_hackrf_gainmode','m_hackrf_diggain','m_hackrf_rate'];
let muxRestartSnapshot = null;  // field values when the Multiplex dialog opened ON AIR (null otherwise)
const muxDlgFieldValues = () => [...MUX_DLG_RESTART_FIELDS.map((id) => {
  const el = document.getElementById(id);
  return !el ? '' : el.type === 'checkbox' ? String(el.checked) : el.value;
}), JSON.stringify(NET_OUTPUTS), String($('#m_net_pft')?.checked), $('#m_net_fec')?.value, $('#m_net_tist')?.value];   // NETWORK outputs too
const muxDlgFieldsChanged = () => Boolean(muxRestartSnapshot && STATE?.muxRunning
  && muxDlgFieldValues().some((v, i) => v !== muxRestartSnapshot[i]));
function updateMuxRestartWarn() {
  document.getElementById('muxRestartWarn')?.classList.toggle('hidden', !muxDlgFieldsChanged());
}

function openMuxDialog() {
  const locked = STATE.muxRunning;
  $('#muxLockHint').textContent = locked ? 'ON AIR: changing ensemble or output settings restarts the multiplex on save' : '';
  showMuxError('');

  // ensemble (afficher sans préfixe 0x)
  $('#m_ens_id').value = (STATE.settings.ensemble.idHex || '').replace(/^0x/i, '');
  $('#m_ecc').value = (STATE.settings.ensemble.eccHex || '').replace(/^0x/i, '');
  $('#m_label').value = STATE.settings.ensemble.label || '';
  $('#m_short').value = STATE.settings.ensemble.shortlabel || '';

  // ports / tx
  $('#m_txmode').value = (STATE.settings.dabmux.txMode || 'EASYDAB');
  $('#m_easydab_ip').value = STATE.settings.dabmux.easyDabOutput?.ip || '0.0.0.0';
  $('#m_easydab_port').value = STATE.settings.dabmux.easyDabOutput?.port || 18081;
  $('#m_edi_port').value = STATE.settings.dabmux.ediTcpListenPort || 13000;
  $('#m_edi_pft').checked = STATE.settings.dabmux.ediPftEnabled === true;
  $('#m_edi_fec').value = STATE.settings.dabmux.ediFec ?? 2;
  $('#m_edi_tist_offset').value = STATE.settings.dabmux.ediTistOffsetSec ?? 0;
  $('#m_mgmt').value = STATE.settings.dabmux.managementPort || 12720;
  $('#m_telnet').value = STATE.settings.dabmux.telnetPort || 12721;
  $('#m_autostart').checked = STATE.settings.autoStart ?? false;
  // NETWORK mode: outputs list (empty = pre-filled from the current mode when NETWORK is chosen)
  NET_OUTPUTS = (STATE.settings.dabmux.outputs || []).map((o) => ({ ...o }));
  $('#m_net_pft').checked = STATE.settings.dabmux.ediOptions?.pft === true;
  $('#m_net_fec').value = STATE.settings.dabmux.ediOptions?.fec ?? 2;
  $('#m_net_tist').value = STATE.settings.dabmux.tistOffsetSec ?? 0;
  renderNetOutputs();

  // HackRF fields
  const hackrf = STATE.settings.dabmux?.hackrf || {};
  const blockSel = $('#m_hackrf_block');
  if (blockSel) {
    blockSel.innerHTML = '';
    for (const ch of Object.keys(DAB_FREQ_TABLE)) {
      const freqMHz = (DAB_FREQ_TABLE[ch] / 1e6).toFixed(3);
      const opt = document.createElement('option');
      opt.value = ch;
      opt.textContent = `${ch} (${freqMHz} MHz)`;
      if (ch === (hackrf.dabBlock || '7A')) opt.selected = true;
      blockSel.appendChild(opt);
    }
  }
  $('#m_hackrf_txgain').value = hackrf.txGain ?? 47;
  $('#m_hackrf_maxframes').value = hackrf.maxFramesQueued ?? 580;
  $('#m_hackrf_gainmode').value = String(hackrf.gainmode ?? 2);
  $('#m_hackrf_diggain').value = hackrf.digitalGain ?? 1;
  $('#m_hackrf_rate').value = String(hackrf.rate || 4096000);

  // ON AIR: fields stay editable; saving a change restarts the mux (see saveMuxSettings)
  MUX_DLG_RESTART_FIELDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = false;
  });
  muxRestartSnapshot = locked ? muxDlgFieldValues() : null;
  updateMuxRestartWarn();

  updateTxModeVisibility();
  dlgMux.showModal();
  netStartStatus();
}

function updateTxModeVisibility() {
  const mode = ($('#m_txmode')?.value || 'EASYDAB').toUpperCase();
  document.querySelectorAll('.network-only').forEach((el) => el.classList.toggle('hidden', mode !== 'NETWORK'));
  // first switch to "Network outputs": start from what the current mode sends (same ports)
  if (mode === 'NETWORK' && !NET_OUTPUTS.length) { NET_OUTPUTS = netOutputsFromLegacy(); renderNetOutputs(); }
  document.querySelectorAll('.easydab-only').forEach((el) => el.classList.toggle('hidden', mode !== 'EASYDAB'));
  document.querySelectorAll('.edi-only').forEach((el) => el.classList.toggle('hidden', mode !== 'EDI'));
  document.querySelectorAll('.usrp1-only').forEach((el) => el.classList.toggle('hidden', mode !== 'USRP1'));
  document.querySelectorAll('.hackrf-only').forEach((el) => el.classList.toggle('hidden', mode !== 'HACKRF'));
}

// ── Multiplex dialog: transmitter outputs of the NETWORK mode (server: odr/outputs.js) ──
let NET_OUTPUTS = [];          // outputs being edited (saved as settings.dabmux.outputs)
let netStatusTimer = null;     // connection state polling while the dialog is open
const NET_TYPE_LABEL = { 'edi-udp': 'EDI/UDP', 'edi-tcp': 'EDI/TCP', zmq: 'ZMQ', 'eti-tcp': 'ETI/TCP' };
const NET_HELP = {
  'edi-udp': 'DABcast sends EDI to the transmitter: set its EDI input to UDP, port below (multicast: join the group). Use PFT / FEC.',
  'edi-tcp': 'The transmitter, a digris-edi-tcp-converter or a remote odr-dabmod connects to this server on this port (EDI over TCP).',
  zmq: 'The EasyDAB (or ODR-DabMod) connects to this server on this port (ZMQ client).',
  'eti-tcp': 'The receiver connects to this server on this port and reads raw ETI.',
};
const serverHost = () => location.hostname || 'this server';
function netNextPort(from) {
  const used = new Set(NET_OUTPUTS.filter((o) => o.type !== 'edi-udp').map((o) => Number(o.port)));
  let p = from;
  while (used.has(p)) p++;
  return p;
}
function netNewId(type) {
  const base = type.replace(/[^a-z]/g, '');
  let i = 1;
  while (NET_OUTPUTS.some((o) => o.id === `${base}${i}`)) i++;
  return `${base}${i}`;
}
// same as outputsFromLegacy() on the server, from the values shown in the dialog
function netOutputsFromLegacy() {
  const dm = STATE.settings.dabmux || {};
  const was = String(dm.txMode || 'EASYDAB').toUpperCase();
  if (was === 'EDI') return [{ id: 'edi', name: 'EDI', enabled: true, type: 'edi-tcp', port: Number($('#m_edi_port').value) || 13000 }];
  if (was === 'EASYDAB') return [{ id: 'easydab', name: 'EasyDAB', enabled: true, type: 'zmq', ip: $('#m_easydab_ip').value.trim() || '0.0.0.0', port: Number($('#m_easydab_port').value) || 18081, allowMetadata: false }];
  return [];
}
function netAdd(kind) {
  const presets = {
    'edi-udp': () => ({ type: 'edi-udp', name: 'Modulator', destination: '', port: 12000, sourcePort: netNextPort(13000), source: '', ttl: 1 }),
    'edi-udp-mc': () => ({ type: 'edi-udp', name: 'Multicast', destination: '239.20.10.1', port: 12000, sourcePort: netNextPort(13000), source: '', ttl: 1 }),
    'edi-tcp': () => ({ type: 'edi-tcp', name: 'EDI/TCP', port: netNextPort(13000) }),
    zmq: () => ({ type: 'zmq', name: 'EasyDAB', ip: '0.0.0.0', port: netNextPort(18081), allowMetadata: false }),
    'zmq-v2': () => ({ type: 'zmq', name: 'EasyDAB V2', ip: '0.0.0.0', port: netNextPort(18081), allowMetadata: true }),
    'eti-tcp': () => ({ type: 'eti-tcp', name: 'ETI/TCP', ip: '0.0.0.0', port: netNextPort(9902) }),
  };
  const o = { enabled: true, ...presets[kind]() };
  o.id = netNewId(o.type);
  if (kind === 'edi-udp' || kind === 'edi-udp-mc') $('#m_net_pft').checked = true;                 // usual for UDP
  if (kind === 'zmq-v2' && !(Number($('#m_net_tist').value) > 0)) $('#m_net_tist').value = 2;   // EasyDAB V2 buffer
  NET_OUTPUTS.push(o);
  renderNetOutputs();
  updateMuxRestartWarn();
}
function netField(o, i, key, label, attrs = '') {
  const v = o[key] ?? '';
  return `<label class="net-inline"><span>${label}</span><input data-net="${i}" data-key="${key}" value="${esc(String(v))}" ${attrs} /></label>`;
}
function renderNetOutputs() {
  const box = $('#netOutputs');
  if (!box) return;
  // PFT / FEC only concerns EDI outputs: hidden when the list has none (EasyDAB / ETI only)
  const hasEdi = NET_OUTPUTS.some((o) => o.type === 'edi-udp' || o.type === 'edi-tcp');
  document.querySelectorAll('.net-edi-only').forEach((el) => el.classList.toggle('hidden', !hasEdi));
  if (!NET_OUTPUTS.length) { box.innerHTML = '<div class="muted net-empty">No output yet: choose a type and press + Add.</div>'; return; }
  box.innerHTML = NET_OUTPUTS.map((o, i) => {
    const mc = o.type === 'edi-udp' && /^(22[4-9]|23\d)\./.test(o.destination || '');
    let fields = '';
    if (o.type === 'edi-udp') {
      fields = netField(o, i, 'destination', mc ? 'Multicast group' : 'Transmitter IP', 'placeholder="192.168.1.50" class="net-ip"')
        + netField(o, i, 'port', 'Port', 'type="number" min="1" max="65535"')
        + netField(o, i, 'sourcePort', 'Source port', 'type="number" min="1" max="65535"')
        + (mc ? netField(o, i, 'source', 'Interface IP', 'placeholder="this server" class="net-ip"') + netField(o, i, 'ttl', 'TTL', 'type="number" min="1" max="255"') : '');
    } else if (o.type === 'edi-tcp') {
      fields = netField(o, i, 'port', 'Listen port', 'type="number" min="1024" max="65535"');
    } else {
      fields = netField(o, i, 'ip', 'Listen IP', 'placeholder="0.0.0.0" class="net-ip"') + netField(o, i, 'port', 'Port', 'type="number" min="1024" max="65535"')
        + (o.type === 'zmq' ? `<label class="check-row net-inline"><input type="checkbox" data-net="${i}" data-key="allowMetadata" ${o.allowMetadata ? 'checked' : ''} /> metadata (EasyDAB V2)</label>` : '');
    }
    const help = o.type === 'edi-udp' ? NET_HELP['edi-udp'] : `${NET_HELP[o.type]} Address: ${serverHost()}:${o.port}`;
    return `<div class="net-row${o.enabled ? '' : ' off'}">
      <div class="net-row-head">
        <label class="check-row" title="ON = fed by the multiplex"><input type="checkbox" data-net="${i}" data-key="enabled" ${o.enabled ? 'checked' : ''} /></label>
        <input class="net-name" data-net="${i}" data-key="name" value="${esc(o.name || '')}" maxlength="40" aria-label="Output name" />
        <span class="buf-tag">${NET_TYPE_LABEL[o.type]}</span>
        <span class="net-status" id="netSt_${esc(o.id)}"></span>
        <div class="spacer"></div>
        <button type="button" class="btn btn-mini" data-net-del="${i}" title="Remove this output">✕</button>
      </div>
      <div class="net-fields">${fields}</div>
      <div class="net-help">${esc(help)}</div>
    </div>`;
  }).join('');
}
// edits in the list → NET_OUTPUTS (numbers kept as numbers)
$('#netOutputs')?.addEventListener('input', (e) => {
  const el = e.target.closest('[data-net]');
  if (!el) return;
  const o = NET_OUTPUTS[Number(el.dataset.net)];
  const k = el.dataset.key;
  o[k] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value);
  if (k === 'enabled') el.closest('.net-row').classList.toggle('off', !el.checked);
  if (k === 'destination' || k === 'port') {   // multicast fields / help address follow
    const pos = el.selectionStart;
    renderNetOutputs();
    const again = document.querySelector(`[data-net="${el.dataset.net}"][data-key="${k}"]`);
    if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* number input */ } }
  }
  updateMuxRestartWarn();
});
$('#netOutputs')?.addEventListener('change', (e) => { if (e.target.matches('[data-net]')) updateMuxRestartWarn(); });
$('#netOutputs')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-net-del]');
  if (!b) return;
  NET_OUTPUTS.splice(Number(b.dataset.netDel), 1);
  renderNetOutputs();
  updateMuxRestartWarn();
});
$('#netAdd')?.addEventListener('click', () => netAdd($('#netAddType').value));
['m_net_pft', 'm_net_fec', 'm_net_tist'].forEach((id) => document.getElementById(id)?.addEventListener('input', updateMuxRestartWarn));
// connection state of each output (read-only, every 5 s while the dialog is open ON AIR)
async function refreshNetStatus() {
  if (!dlgMux.open || ($('#m_txmode').value || '') !== 'NETWORK') return;
  let st = null;
  try { st = await api('/api/mux/outputs'); } catch { return; }
  const saved = (STATE.settings.dabmux?.txMode || '') === 'NETWORK';
  for (const o of NET_OUTPUTS) {
    const el = document.getElementById(`netSt_${o.id}`);
    if (!el) continue;
    const s = (st.outputs || []).find((x) => x.id === o.id);
    let txt = '', cls = '';
    if (!st.running || !saved) txt = st.running ? 'saved settings not applied yet' : 'off air';
    else if (!o.enabled) txt = 'OFF';
    else if (o.type === 'edi-udp') { txt = `sending to ${o.destination}:${o.port}`; cls = 'ok'; }
    else if (!s) txt = 'not applied yet (save to apply)';
    else if (s.connected?.length) { txt = `${s.connected.length} connected: ${s.connected.join(', ')}`; cls = 'ok'; }
    else { txt = 'no transmitter connected'; cls = 'warn'; }
    el.textContent = txt;
    el.className = `net-status ${cls}`;
  }
}
function netStartStatus() {
  clearInterval(netStatusTimer);
  refreshNetStatus();
  netStatusTimer = setInterval(() => { if (dlgMux.open) refreshNetStatus(); else clearInterval(netStatusTimer); }, 5000);
}
function netCollect() {
  return NET_OUTPUTS.map((o) => ({ ...o }));
}

// DLS length: DAB carries at most 128 characters (odr-padenc cuts longer texts)
const DLS_MAX_CHARS = 128;
function updateDlsCount() {
  const el = $('#dlsCount');
  const n = ($('#f_default_dls')?.value || '').length;
  if (!el) return;
  el.textContent = `${n} / ${DLS_MAX_CHARS}${n > DLS_MAX_CHARS ? ' — too long, cut on air' : ''}`;
  el.classList.toggle('over', n > DLS_MAX_CHARS);
}
$('#f_default_dls')?.addEventListener('input', updateDlsCount);
const META_MODE_HELP = {
  STREAM: 'Titles come from the audio stream (ICY StreamTitle), read every 5 s. The default text is sent when the stream gives no title.',
  JSON: 'Titles and covers come from a now-playing API, read every “Refresh” seconds. A track cover is sent alone while it plays.',
  NONE: 'No title source: the text below is sent as is.',
};
function updateMetaModeVisibility() {
  const mode = ($('#f_meta_mode')?.value || 'STREAM').toUpperCase();
  document.querySelectorAll('.json-only').forEach((el) => el.classList.toggle('hidden', mode !== 'JSON'));
  document.querySelectorAll('#metaModeSeg button').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.disabled = Boolean($('#f_meta_mode')?.disabled);
  });
  const help = $('#metaModeHelp');
  if (help) help.textContent = META_MODE_HELP[mode] || '';
  const manual = mode === 'NONE';
  if ($('#dlsTextLabel')) $('#dlsTextLabel').textContent = manual ? 'Text sent on air' : 'Default text (when there is no title)';
  if ($('#dlsAllowedLabel')) $('#dlsAllowedLabel').textContent = manual ? 'Send this text' : 'Send default text';
}
$('#metaModeSeg')?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  const sel = $('#f_meta_mode');
  if (!b || !sel || sel.disabled) return;
  sel.value = b.dataset.mode;
  sel.dispatchEvent(new Event('change'));
});

// ── Metadata tab: foldable blocks. Default: only 'Titles source' open; the viewer's choice is kept
// in this browser. A folded block shows a one-line summary in its title. ──
const META_FOLD_DEFAULT = { source: false, text: true, logo: true, advanced: true };   // true = folded
function metaFoldState() {
  try { return { ...META_FOLD_DEFAULT, ...JSON.parse(localStorage.getItem('dabcast.metaFold') || '{}') }; } catch { return { ...META_FOLD_DEFAULT }; }
}
function updateMetaSummaries() {
  const modeBtn = document.querySelector('#metaModeSeg button.active');
  if ($('#metaSumSource')) $('#metaSumSource').textContent = modeBtn ? modeBtn.textContent : '';
  const txt = ($('#f_default_dls')?.value || '').trim();
  if ($('#metaSumText')) $('#metaSumText').textContent = `${txt ? `“${txt}”` : 'no text'} · DL+ ${$('#f_dlplus_enabled')?.value === 'no' ? 'off' : 'on'}`;
  const size = ($('#slsSize')?.textContent || '').split(' / ')[0];
  const every = $('#f_json_logoevery')?.value;
  const json = ($('#f_meta_mode')?.value || '').toUpperCase() === 'JSON';
  if ($('#metaSumAdv')) $('#metaSumAdv').textContent = `ZMQ ${$('#f_zbuf')?.value || '—'} / ${$('#f_zpre')?.value || '—'} · encoder ${$('#f_encbuf')?.value || '—'} ms`;
  if ($('#metaSumLogo')) $('#metaSumLogo').textContent = [size ? `logo ${size}` : 'no logo', json ? (Number(every) > 0 ? `logo every ${every} s` : 'cover only') : ''].filter(Boolean).join(' · ');
}
function applyMetaFold() {
  const st = metaFoldState();
  document.querySelectorAll('.meta-card[data-fold]').forEach((card) => {
    const folded = Boolean(st[card.dataset.fold]);
    card.classList.toggle('folded', folded);
    card.querySelector('.meta-card-title')?.setAttribute('aria-expanded', folded ? 'false' : 'true');
  });
  updateMetaSummaries();
}
function toggleMetaFold(card) {
  const st = metaFoldState();
  st[card.dataset.fold] = !card.classList.contains('folded');
  try { localStorage.setItem('dabcast.metaFold', JSON.stringify(st)); } catch { /* ignore */ }
  applyMetaFold();
}
document.querySelectorAll('.meta-card[data-fold] > .meta-card-title').forEach((t) => {
  t.addEventListener('click', () => toggleMetaFold(t.parentElement));
  t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMetaFold(t.parentElement); } });
});
['f_default_dls', 'f_dlplus_enabled', 'f_json_logoevery', 'f_meta_mode'].forEach((id) => document.getElementById(id)?.addEventListener('input', updateMetaSummaries));
['f_dlplus_enabled', 'f_meta_mode'].forEach((id) => document.getElementById(id)?.addEventListener('change', updateMetaSummaries));
['f_zbuf', 'f_zpre', 'f_encbuf'].forEach((id) => document.getElementById(id)?.addEventListener('input', updateMetaSummaries));

// ── Metadata tab: what is on air now for the edited service (refreshed with /api/state) ──
const _liveSlideSizes = new Map();
function renderMetaLive() {
  if (!dlg?.open || !$('#metaLive')) return;
  const svc = editingId ? STATE?.preset?.services?.find((x) => x.id === editingId) : null;
  const img = $('#metaLiveImg'), imgTxt = $('#metaLiveImgTxt'), slideEl = $('#metaLiveSlide');
  const dlsEl = $('#metaLiveDls'), dlpEl = $('#metaLiveDlplus'), stEl = $('#metaLiveStatus'), dot = $('#metaLiveDot');
  const setImg = (src, txt) => {
    if (src) { if (img.getAttribute('src') !== src) img.src = src; img.style.display = 'block'; imgTxt.textContent = ''; }
    else { img.removeAttribute('src'); img.style.display = 'none'; imgTxt.textContent = txt; }
  };
  const blank = (txt) => { setImg('', txt); slideEl.textContent = ''; dlsEl.textContent = '—'; dlpEl.innerHTML = ''; stEl.textContent = ''; dot.className = 'meta-live-dot'; };
  if (!svc) return blank('Save the service first');
  if (!STATE.muxRunning) return blank('Off air — press Start to see what is sent');
  if (svc.enabled === false) return blank('Service OFF (not in the multiplex)');
  if (['ZMQ', 'EDI'].includes(String(svc.input?.mode || '').toUpperCase())) return blank('Sent by the remote encoder (not visible here)');
  const rt = svc.runtime || {};
  // slide: the one shown by the services table (it follows runtime.airSlides)
  const thumb = svcTableBody.querySelector(`tr[data-service-id="${CSS.escape(svc.id)}"] img.sls-thumb`);
  const src = thumb && thumb.style.display !== 'none' && thumb.src ? thumb.src : '';
  setImg(src, 'No slide');
  if (src) {
    const u = new URL(src, location.href);
    const name = decodeURIComponent(u.pathname.split('/').pop());
    const key = `${u.pathname}|${u.searchParams.get('v') || ''}`;
    const show = (n) => {
      const kind = name === 'cover.jpg' ? 'track cover' : 'station logo';
      if (!Number.isFinite(n)) { slideEl.textContent = `${name} · ${kind}`; return; }
      const { text, over } = slideSizeLabel(n);
      slideEl.textContent = `${name} · ${kind} · ${text}`;
      slideEl.className = `meta-live-slide${over ? ' over' : ''}`;
    };
    if (_liveSlideSizes.has(key)) show(_liveSlideSizes.get(key));
    else {
      _liveSlideSizes.set(key, NaN);
      show(NaN);
      fetch(u.pathname, { method: 'HEAD', cache: 'no-store' }).then((r) => { _liveSlideSizes.set(key, Number(r.headers.get('content-length'))); renderMetaLive(); }).catch(() => {});
    }
  } else slideEl.textContent = '';
  // DLS and DL+
  const dls = rt.currentDls || '';
  dlsEl.textContent = dls || '(empty)';
  if (rt.dlplusActive && dls.includes(' - ')) {
    const i = dls.indexOf(' - ');
    dlpEl.innerHTML = `<div class="meta-live-dlp-on"><span class="pl-tag" title="DL+ active: artist and title tags sent with the DLS">DL+</span></div><div><span class="tag">ARTIST</span>${esc(dls.slice(0, i))}</div><div><span class="tag">TITLE</span>${esc(dls.slice(i + 3))}</div>`;
  } else dlpEl.innerHTML = dls ? '<div class="muted">DL+: not sent (no “Artist - Title”)</div>' : '';
  // last update
  const ms = rt.metaStatus;
  const ago = (t) => { const sec = Math.max(0, Math.round((Date.now() - t) / 1000)); return sec < 60 ? `${sec} s ago` : `${Math.round(sec / 60)} min ago`; };
  if (ms) {
    stEl.textContent = `${ms.ok ? '✓' : '⚠'} ${ms.msg} · updated ${ago(ms.at)}`;
    stEl.className = `meta-live-status${ms.ok ? '' : ' err'}`;
    dot.className = `meta-live-dot ${ms.ok ? 'ok' : 'warn'}`;
  } else {
    stEl.textContent = 'Waiting for the first update…';
    stEl.className = 'meta-live-status';
    dot.className = 'meta-live-dot';
  }
}

async function saveMuxSettings() {
  const errors = [];
  const ediFec = Number($('#m_edi_fec').value);
  const ediTistOffsetSec = Number($('#m_edi_tist_offset').value);
  const ensId = normalizeHex($('#m_ens_id').value, 4);
  const ecc = $('#m_ecc').value.toUpperCase();
  if (!ensId) errors.push('Ensemble ID must be 4 hexadecimal characters (ex: F401).');
  const muxLabel = $('#m_label').value.trim();
  const muxShort = $('#m_short').value.trim();
  if (muxShort.length > 8) errors.push('Shortlabel must contain at most 8 characters.');
  if (muxLabel.length > 16) errors.push('Label must contain at most 16 characters.');
  if (muxShort && muxLabel && shortLabelMismatch(muxShort, muxLabel)) {
    errors.push('Label must contain all characters from Shortlabel.');
  }
  if ($('#m_edi_pft').checked && (!Number.isInteger(ediFec) || ediFec < 0 || ediFec > 5)) {
    errors.push('EDI FEC must be an integer between 0 and 5.');
  }
  if (!Number.isFinite(ediTistOffsetSec) || ediTistOffsetSec < 0 || ediTistOffsetSec > 60) {
    errors.push('EDI TIST offset must be between 0 and 60 seconds.');
  }
  const network = $('#m_txmode').value === 'NETWORK';
  if (network) {   // first checks here; the server checks everything (ports in use…) before saving
    if (!NET_OUTPUTS.some((o) => o.enabled)) errors.push('Network outputs: at least one output must be ON.');
    for (const o of NET_OUTPUTS) {
      if (o.type === 'edi-udp' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(o.destination || '').trim())) errors.push(`"${o.name}": enter the transmitter IP address.`);
    }
    const tist = Number($('#m_net_tist').value);
    if (!Number.isFinite(tist) || tist < 0 || tist > 60) errors.push('TIST offset must be between 0 and 60 seconds.');
  }
  if (errors.length) {
    showMuxError(errors.join(' '));
    return false;
  }
  const patch = {
    autoStart: $('#m_autostart').checked,
    ensemble: {
      idHex: `0x${ensId}`,
      eccHex: `0x${ecc}`,
      label: $('#m_label').value.trim(),
      shortlabel: $('#m_short').value.trim(),
    },
    dabmux: {
      txMode: $('#m_txmode').value,
      managementPort: Number($('#m_mgmt').value),
      telnetPort: Number($('#m_telnet').value),
      ediTcpListenPort: Number($('#m_edi_port').value),
      ediPftEnabled: $('#m_edi_pft').checked,
      ediFec,
      ediTistOffsetSec,
      ...(network ? {
        outputs: netCollect(),
        ediOptions: { pft: $('#m_net_pft').checked, fec: Number($('#m_net_fec').value) },
        tistOffsetSec: Number($('#m_net_tist').value) || 0,
      } : {}),
      easyDabOutput: {
        ip: $('#m_easydab_ip').value.trim(),
        port: Number($('#m_easydab_port').value)
      },
      hackrf: {
        dabBlock: $('#m_hackrf_block')?.value || '7A',
        maxFramesQueued: Number($('#m_hackrf_maxframes')?.value || 580),
        gainmode: Number($('#m_hackrf_gainmode')?.value ?? 2),
        digitalGain: Number($('#m_hackrf_diggain')?.value ?? 1),
        rate: Number($('#m_hackrf_rate')?.value || 4096000),
        txGain: Number($('#m_hackrf_txgain')?.value ?? 47)
      }
    }
  };
  if (!muxDlgFieldsChanged()) {
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) });
    await refresh();
    return;
  }
  // check the outputs first: a refused setting must not cost a stop / start
  try {
    await api('/api/settings?check=1', { method: 'PATCH', body: JSON.stringify(patch) });
  } catch (err) {
    showMuxError(err.message || String(err));
    return false;
  }
  if (!confirm('These changes require restarting the multiplex.\nALL services go off air for a few seconds.\n\nApply and restart now?')) return false;
  // Stop first (with the current ports / TX mode), save, then start with the new settings
  await api('/api/mux/stop', { method: 'POST', body: '{}' });
  let saveErr = null;
  try {
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) });
  } catch (err) { saveErr = err; }
  if (!saveErr) dlgMux.close();
  try {
    await api('/api/mux/start', { method: 'POST', body: '{}' });
  } catch (err) {
    await refresh();
    throw new Error(`Multiplex restart FAILED — press Start: ${err.message || err}${saveErr ? ` (changes not saved: ${saveErr.message})` : ''}`);
  }
  await refresh();
  if (saveErr) throw new Error(`Changes not saved, multiplex restarted with the previous settings: ${saveErr.message || saveErr}`);
}

// ── Web player: one service of the mux, decoded server-side (dablin → ffmpeg MP3) ──
// Metadata shown = what DABcast sends (runtime state); ZMQ/EDI direct inputs carry their own.
const dlgPlayer = $('#dlgPlayer');
const PL_DB_FLOOR = -60;
const PL = { svcId: null, bufTimer: 0, key: '', useServer: false, lvTimer: 0, lv: [], lvSince: 0, lastDbs: null, flatSince: 0, audio: null, ctx: null, gain: null, an: [], buf: null, raf: 0, playing: false, peaks: [{ v: -99, hold: -99, at: 0 }, { v: -99, hold: -99, at: 0 }] };
const plDirect = (svc) => ['ZMQ', 'EDI'].includes(String(svc?.input?.mode || '').toUpperCase());
function plStatus(msg, err = false) {
  const el = $('#plStatus');
  if (el) { el.textContent = msg; el.classList.toggle('err', err); }
}
function plServices() {
  return [...(STATE?.preset?.services || [])].filter((s) => s.enabled !== false)
    .sort((a, b) => (a.ui?.order ?? 0) - (b.ui?.order ?? 0));
}
function renderPlayer() {
  if (!dlgPlayer?.open || !STATE) return;
  const list = plServices();
  if (!list.some((s) => s.id === PL.svcId)) PL.svcId = list[0]?.id || null;
  const listHtml = list.map((s) => `<button type="button" data-pl="${esc(s.id)}" class="${s.id === PL.svcId ? 'active' : ''}">${esc(s.identity?.ps8 || s.id)}${s.id === PL.svcId && PL.playing ? '<span class="pl-live">▶</span>' : ''}</button>`).join('')
    || '<span class="lv-note">No service on air</span>';
  const box = $('#plList');
  if (box._last !== listHtml) { box.innerHTML = listHtml; box._last = listHtml; }
  const ens = STATE.settings?.ensemble || {};
  $('#plSub').textContent = STATE.muxRunning ? `${ens.label || 'Ensemble'} · decoded from the multiplex output` : 'Multiplex off air';
  const svc = list.find((s) => s.id === PL.svcId);
  if (!svc) { $('#plName').textContent = '—'; return; }
  $('#plName').textContent = svc.identity?.ps16 || svc.identity?.ps8 || svc.id;
  const ptyOpt = $(`#f_pty option[value="${svc.identity?.pty}"]`);
  $('#plInfo').textContent = [`PI ${String(svc.identity?.pi || svc.id).replace(/^0x/i, '').toUpperCase()}`,
    `${svc.dab?.bitrateKbps ?? '?'} kbps`, plDirect(svc) ? `${svc.input.mode} input` : (svc.audio?.codec || 'HE-AAC v1'),
    ptyOpt ? ptyOpt.textContent : ''].filter(Boolean).join(' · ');
  // DLS / DL+ (same text as the services table)
  const dls = plDirect(svc) ? '' : (svc.runtime?.currentDls || (svc.metadata?.defaultDlsAllowed !== false ? (svc.metadata?.defaultDls || '') : ''));
  let dlp = '';
  if (svc.runtime?.dlplusActive && dls.includes(' - ')) {
    const i = dls.indexOf(' - ');
    dlp = `<span class="pl-tag">DL+</span><b>${esc(dls.slice(i + 3))}</b> — ${esc(dls.slice(0, i))}`;
  }
  const dlpEl = $('#plDlplus');
  if (dlpEl._last !== dlp) { dlpEl.innerHTML = dlp; dlpEl._last = dlp; }
  $('#plDls').textContent = plDirect(svc) ? 'DLS, DL+ and slides are sent by the remote encoder (not shown here).' : (dls ? `DLS: ${dls}` : 'No DLS text');
  // Slide: the one shown in the services table (rotation + covers), else the logo
  const thumb = svcTableBody.querySelector(`tr[data-service-id="${CSS.escape(svc.id)}"] img.sls-thumb`);
  const src = thumb && thumb.style.display !== 'none' && thumb.src ? thumb.src : '';
  const art = $('#plArt');
  if (src) { if (art.getAttribute('src') !== src) art.src = src; art.style.display = ''; $('#plArtTxt').textContent = ''; }
  else { art.style.display = 'none'; $('#plArtTxt').textContent = svc.identity?.ps8 || ''; }
  plSlideInfo(src);
  art.parentElement.classList.toggle('empty', !src);   // frame = slide size; fixed 4:3 placeholder without slide
  $('#plPlay').textContent = PL.playing ? '■ Stop' : '▶ Play';
  $('#plPlay').disabled = !STATE.muxRunning && !PL.playing;
}
// Weight of the slide shown, against the ODR limit: odr-padenc's default --max-slide-size is
// 51200 bytes (SlideShow "Simple profile", TS 101 499); above it, odr-padenc recompresses the slide.
const SLS_MAX_BYTES = 51200;
const _slideSizes = new Map();   // slide path + track -> bytes (HEAD request, once per file/track)
const fmtKb = (b) => (b / 1024).toFixed(1);
// "6.3 kB / 50.0 kB max" + over flag, shared by the Player and the service dialog
function slideSizeLabel(bytes) {
  return { text: `${fmtKb(bytes)} kB / ${fmtKb(SLS_MAX_BYTES)} kB max`, over: bytes > SLS_MAX_BYTES };
}
// Service dialog (Metadata tab): weight of the logo file shown under its preview, when it is a
// slide served by DABcast (/api/mot/...); nothing for an external SLS URL preview.
$('#slsImg')?.addEventListener('load', (e) => {
  const el = $('#slsSize');
  if (!el) return;
  const u = new URL(e.target.src, location.href);
  if (u.origin !== location.origin || !u.pathname.startsWith('/api/mot/')) { el.textContent = ''; return; }
  fetch(u.pathname, { method: 'HEAD', cache: 'no-store' }).then((r) => {
    const n = Number(r.headers.get('content-length'));
    if (!r.ok || !Number.isFinite(n)) { el.textContent = ''; return; }
    const { text, over } = slideSizeLabel(n);
    el.textContent = over ? `${text} — too heavy` : text;
    el.className = `sls-size${over ? ' over' : ''}`;
    updateMetaSummaries();
    el.title = 'Recommended maximum = odr-padenc default --max-slide-size (51200 bytes, SlideShow Simple profile). Above it, odr-padenc recompresses the slide.';
  }).catch(() => { el.textContent = ''; });
});
$('#slsImg')?.addEventListener('error', () => { const el = $('#slsSize'); if (el) el.textContent = ''; });
function plSlideInfo(src) {
  const el = $('#plSlideInfo');
  if (!el) return;
  if (!src) { el.textContent = ''; return; }
  const u = new URL(src, location.href);
  const name = decodeURIComponent(u.pathname.split('/').pop());
  const key = `${u.pathname}|${u.searchParams.get('v') || ''}`;   // v = current track: cover.jpg changes with it
  const show = (bytes) => {
    if (!Number.isFinite(bytes)) { el.textContent = ''; return; }
    const over = bytes > SLS_MAX_BYTES;
    el.className = `pl-slide-info${over ? ' over' : ''}`;
    el.textContent = `Slide ${name}: ${fmtKb(bytes)} kB · max ${fmtKb(SLS_MAX_BYTES)} kB (ODR)${over ? ' — too heavy, odr-padenc recompresses it' : ''}`;
    el.title = 'Recommended maximum = odr-padenc default --max-slide-size (51200 bytes, SlideShow Simple profile). Smaller slides reach receivers faster.';
  };
  if (_slideSizes.has(key)) { show(_slideSizes.get(key)); return; }
  _slideSizes.set(key, NaN);   // one request per file
  fetch(u.pathname, { method: 'HEAD', cache: 'no-store' })
    .then((r) => { const n = Number(r.headers.get('content-length')); _slideSizes.set(key, n); if (dlgPlayer.open) renderPlayer(); })
    .catch(() => { _slideSizes.delete(key); });
}
function plEnsureAudio() {
  if (PL.audio) return;
  PL.audio = new Audio();
  PL.audio.preload = 'auto';
  PL.audio.addEventListener('playing', () => plStatus('Playing'));
  // buffer ran dry: refill a full cushion instead of restarting on a few ms (repeated micro-cuts)
  PL.audio.addEventListener('waiting', () => { if (PL.playing && !PL.bufTimer) plPrebuffer(); });
  // stream failed or ended: show the reason recorded by the server for this listener (also in the logs)
  const onFail = async (fallback) => {
    if (!PL.playing) return;
    const key = PL.key;
    plStop();
    let why = fallback;
    try {
      const info = await api(`/api/player/info?k=${encodeURIComponent(key)}`);
      if (info.missing?.length) why = `Not installed on the server: ${info.missing.join(', ')} (sudo apt install ${info.missing.join(' ')})`;
      else if (!info.supported) why = `Player not available in ${info.txMode} mode`;
      else if (!STATE?.muxRunning) why = 'Multiplex off air';
      else if (info.lastError) why = `Stream failed: ${info.lastError} (details in Logs)`;
      else if (info.listeners >= info.maxListeners) why = `Player busy (max ${info.maxListeners} listeners)`;
    } catch { /* keep the fallback message */ }
    plStatus(why, true);
  };
  PL.audio.addEventListener('ended', () => onFail('Stream ended (multiplex stopped or restarted)'));
  PL.audio.addEventListener('error', () => onFail('Stream unavailable'));
  try {
    PL.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = PL.ctx.createMediaElementSource(PL.audio);
    const split = PL.ctx.createChannelSplitter(2);
    PL.an = [PL.ctx.createAnalyser(), PL.ctx.createAnalyser()];
    PL.an.forEach((a, i) => { a.fftSize = 2048; split.connect(a, i); });
    PL.buf = new Float32Array(2048);
    PL.gain = PL.ctx.createGain();
    src.connect(split);
    src.connect(PL.gain).connect(PL.ctx.destination);   // meters read the signal before the volume
  } catch { PL.ctx = null; }   // no Web Audio: sound still plays, without meters
  plSetVolume();
}
// The stream arrives exactly in real time, so the browser's cushion never grows by itself:
// start (or resume) only once PL_PREBUFFER_S seconds are buffered ahead, to absorb network jitter.
const PL_PREBUFFER_S = 2;   // Chrome stops downloading a paused stream at ~2.3 s ahead
function plAhead() {
  const b = PL.audio.buffered;
  return b.length ? b.end(b.length - 1) - PL.audio.currentTime : 0;
}
function plPrebuffer() {
  clearInterval(PL.bufTimer);
  const started = Date.now();
  PL.audio.pause();
  PL.bufTimer = setInterval(() => {
    if (!PL.playing) { clearInterval(PL.bufTimer); PL.bufTimer = 0; return; }
    const ahead = plAhead();
    if (ahead >= PL_PREBUFFER_S || (Date.now() - started > 8000 && ahead > 0.5)) {
      clearInterval(PL.bufTimer); PL.bufTimer = 0;
      PL.audio.play().catch((err) => { if (PL.playing && err?.name === 'NotAllowedError') plStatus('Press Play to start', true); });
    } else {
      plStatus(ahead > 0.05 ? `Buffering… ${ahead.toFixed(1)} / ${PL_PREBUFFER_S} s` : 'Connecting… (the decoder needs a few seconds)');
    }
  }, 250);
}
function plSetVolume() {
  const v = Number($('#plVol')?.value ?? 0.8);
  if (PL.gain) PL.gain.gain.value = v; else if (PL.audio) PL.audio.volume = v;
}
// Meter source: the browser's own analyser (Web Audio) when it works, else the levels measured by
// the server on the same stream (iOS Safari does not route a live stream through Web Audio: the
// analyser only sees zeros). Server levels are stamped on the stream timeline → shown in sync with
// audio.currentTime, despite the buffering delay.
function plUseServerMeter() {
  if (PL.useServer && PL.lvTimer) return;
  PL.useServer = true;
  clearInterval(PL.lvTimer);
  PL.lvTimer = setInterval(async () => {
    if (!PL.playing || !PL.key) return;
    try {
      const { levels } = await api(`/api/player/levels?k=${PL.key}&since=${PL.lvSince}`);
      if (!levels?.length) return;
      PL.lvSince = levels[levels.length - 1][0];
      PL.lv.push(...levels);
      const t = PL.audio?.currentTime || 0;
      while (PL.lv.length && PL.lv[0][0] < t - 1) PL.lv.shift();
    } catch { /* stream not started yet or gone */ }
  }, 400);
}
function plLocalDbs() {
  return PL.an.map((a) => {
    a.getFloatTimeDomainData(PL.buf);
    let m = 0;
    for (let k = 0; k < PL.buf.length; k++) { const x = Math.abs(PL.buf[k]); if (x > m) m = x; }
    return m > 0 ? Math.max(PL_DB_FLOOR - 1, 20 * Math.log10(m)) : PL_DB_FLOOR - 1;
  });
}
function plServerDbs() {
  const t = PL.audio.currentTime;
  let l = -99, r = -99, found = false;
  while (PL.lv.length && PL.lv[0][0] <= t + 0.02) {
    const [, a, b] = PL.lv.shift();
    l = Math.max(l, a); r = Math.max(r, b); found = true;
  }
  return found ? [Math.max(PL_DB_FLOOR - 1, l), Math.max(PL_DB_FLOOR - 1, r)] : null;
}
function plMeterLoop() {
  PL.raf = 0;
  if (!PL.playing || !dlgPlayer.open) return;
  const now = performance.now();
  const audible = !PL.audio.paused && PL.audio.currentTime > 0;
  let dbs = null;
  if (!PL.useServer && PL.ctx) {
    dbs = plLocalDbs();
    // sound plays but the analyser stays flat for 1.5 s → it cannot see this stream: use server levels
    if (audible && dbs.every((d) => d < PL_DB_FLOOR)) {
      if (!PL.flatSince) PL.flatSince = now;
      else if (now - PL.flatSince > 1500) plUseServerMeter();
    } else PL.flatSince = 0;
  } else if (PL.useServer) {
    dbs = audible ? plServerDbs() : null;
  }
  if (dbs) PL.lastDbs = dbs;
  (PL.lastDbs || [PL_DB_FLOOR - 1, PL_DB_FLOOR - 1]).forEach((db, i) => {
    const p = PL.peaks[i];
    p.v = db > p.v ? db : Math.max(db, p.v - 0.4);            // fast attack, ~24 dB/s release
    if (db >= p.hold || now - p.at > 1500) { p.hold = db; p.at = now; }   // 1.5 s peak hold
    const pct = (x) => Math.min(100, Math.max(0, (x - PL_DB_FLOOR) / -PL_DB_FLOOR * 100));
    const ch = i ? 'R' : 'L';
    $(`#plVuMask${ch}`).style.width = `${100 - pct(p.v)}%`;
    const pk = $(`#plVuPeak${ch}`);
    pk.style.left = `calc(${pct(p.hold)}% - 2px)`;
    pk.style.opacity = p.hold > PL_DB_FLOOR ? '1' : '0';
    pk.style.background = p.hold >= -1 ? 'var(--red)' : '#fff';
    $(`#plVuDb${ch}`).textContent = p.hold > PL_DB_FLOOR ? `${p.hold.toFixed(1)}` : '—';
  });
  PL.raf = requestAnimationFrame(plMeterLoop);
}
function plResetMeters() {
  for (const ch of ['L', 'R']) {
    $(`#plVuMask${ch}`).style.width = '100%';
    $(`#plVuPeak${ch}`).style.opacity = '0';
    $(`#plVuDb${ch}`).textContent = '—';
  }
  PL.peaks.forEach((p) => { p.v = -99; p.hold = -99; p.at = 0; });
  PL.lastDbs = null; PL.flatSince = 0; PL.lv = []; PL.lvSince = 0;
}
function plPlay(id) {
  plEnsureAudio();
  PL.svcId = id || PL.svcId;
  if (!PL.svcId) return;
  PL.ctx?.resume?.();
  PL.playing = true;
  plResetMeters();
  plStatus('Connecting… (the decoder needs a few seconds)');
  PL.key = Math.random().toString(36).slice(2, 12);
  PL.audio.src = `/api/player/stream?id=${encodeURIComponent(PL.svcId)}&k=${PL.key}`;
  PL.audio.load();
  plPrebuffer();
  if (!PL.ctx || PL.useServer) plUseServerMeter();   // no Web Audio, or already known not to work here
  if (!PL.raf) PL.raf = requestAnimationFrame(plMeterLoop);
  renderPlayer();
}
function plStop() {
  PL.playing = false;
  clearInterval(PL.bufTimer); PL.bufTimer = 0;
  clearInterval(PL.lvTimer); PL.lvTimer = 0;
  if (PL.audio) { PL.audio.pause(); PL.audio.removeAttribute('src'); PL.audio.load(); }   // closes the stream → server stops dablin/ffmpeg
  if (PL.raf) { cancelAnimationFrame(PL.raf); PL.raf = 0; }
  plResetMeters();
  plStatus('');
  renderPlayer();
}
$('#btnPlayer')?.addEventListener('click', async () => {
  PL.svcId = PL.svcId || null;
  dlgPlayer.showModal();
  plStatus('');
  renderPlayer();
  try {
    const info = await api('/api/player/info');
    if (info.missing?.length) plStatus(`Not installed on the server: ${info.missing.join(', ')} (sudo apt install ${info.missing.join(' ')})`, true);
    else if (!info.supported) plStatus(`Player not available in ${info.txMode} mode`, true);
    else if (!STATE?.muxRunning) plStatus('Multiplex off air — press Start first');
  } catch { /* ignore */ }
});
$('#plList')?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-pl]');
  if (!b) return;
  if (PL.playing) plPlay(b.dataset.pl); else { PL.svcId = b.dataset.pl; renderPlayer(); }
});
$('#plPlay')?.addEventListener('click', () => { if (PL.playing) plStop(); else plPlay(); });
$('#plVol')?.addEventListener('input', plSetVolume);
dlgPlayer?.addEventListener('close', () => { if (PL.playing) plStop(); });

// ── Audio levels dialog (opened from the "Mux inputs" card) ──
const dlgLevels = $('#dlgLevels');
let LEVEL_TARGET = -6;
try { LEVEL_TARGET = Number(localStorage.getItem('dabcast.levelTarget')) || -6; } catch { /* ignore */ }
let _levelSuggestions = [];   // [{ id, name, from, to }] from the last renderLevels()
const fmtDb = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');
function renderLevels() {
  const box = $('#lvTable');
  if (!box || !STATE) return;
  _levelSuggestions = [];
  if (!STATE.muxRunning) {
    box.innerHTML = '<div class="mux-stats-off">Off air — start the multiplex to measure audio levels.</div>';
    $('#lvApplyAll').disabled = true;
    return;
  }
  const svcs = viewSort(STATE.preset.services.filter((s) => s.enabled !== false));
  const rows = svcs.map((svc) => {
    const name = esc(svc.identity?.ps8 || svc.id);
    const gain = svc.audio?.gainDb ?? 0;
    const direct = ['ZMQ', 'EDI'].includes(String(svc.input?.mode || '').toUpperCase());
    const pending = svc.runtime?.pendingRestart?.includes('gainDb');
    const st = pending ? { n: 0 } : levelStats(svc);
    let sug, act = '';
    if (direct) sug = '<span class="lv-note">remote encoder — adjust at the source</span>';
    else if (pending) sug = `<span class="buf-tag pend">PENDING</span> <span class="lv-note">encoder not running — ${gain} dB applies at the next mux Start</span>`;
    else if (st.n < LEVEL_MIN_SAMPLES) sug = `<span class="lv-note">measuring… ${st.n}/${LEVEL_MIN_SAMPLES}</span>`;
    else {
      const g = suggestGain(gain, st, LEVEL_TARGET);
      if (g === null) {
        sug = LEVEL_TARGET - st.median >= 1
          ? `<span class="buf-tag ok">OK</span> <span class="lv-note">below target, but peaks already near ${LEVEL_MAX_PEAK_DB} dBFS</span>`
          : '<span class="buf-tag ok">OK</span>';
      }
      else {
        _levelSuggestions.push({ id: svc.id, name: svc.identity?.ps8 || svc.id, from: gain, to: g });
        sug = `<b>${g} dB</b> <span class="lv-note">(${g > gain ? '+' : '−'}${Math.abs(g - gain)})${st.clips ? ' — encoder clipping' : st.max > LEVEL_MAX_PEAK_DB ? ' — too close to 0 dBFS' : ''}</span>`;
        act = `<button type="button" class="btn btn-sm" data-act="lv-apply" data-id="${esc(svc.id)}" data-gain="${g}">Apply</button>`;
      }
    }
    const meas = st.n ? `${fmtDb(st.median)}` : '—';
    const tip = st.n ? `${st.n} samples over ${st.minutes.toFixed(1)} min · 95% of peaks below ${fmtDb(st.p95)} dBFS · highest peak ${fmtDb(st.max)} dBFS` : 'no audio measured yet';
    const clip = st.clips ? ` <span class="buf-tag err" title="odr-audioenc reported clipping ${st.clips}× in the window: crackles likely">CLIP ×${st.clips}</span>` : '';
    return `<tr><td>${name}</td><td class="num" title="${esc(tip)}">${meas}</td><td class="num${st.n && (st.max > LEVEL_MAX_PEAK_DB || st.clips) ? ' lv-clip' : ''}">${st.n ? fmtDb(st.max) : '—'}${clip}</td>`
      + `<td class="num">${direct ? '—' : `${gain} dB`}</td><td>${sug}</td><td class="lv-act">${act}</td></tr>`;
  }).join('');
  box.innerHTML = `<table class="lv-table"><thead><tr><th>Service</th><th class="num">Typical peak</th><th class="num">Max</th><th class="num">Gain</th><th>Suggestion</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  $('#lvApplyAll').disabled = !_levelSuggestions.length;
}
function openLevels() {
  if (!dlgLevels) return;
  $('#lvTarget').value = String(LEVEL_TARGET);
  $('#lvWindow').value = String(LEVEL_WINDOW_MS / 60000);
  renderLevels();
  dlgLevels.showModal();
}
$('#statsRow')?.addEventListener('click', (e) => { if (e.target.closest('[data-act="levels"]')) openLevels(); });
$('#statsRow')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('[data-act="levels"]')) openLevels(); });
$('#lvTarget')?.addEventListener('change', (e) => {
  LEVEL_TARGET = Number(e.target.value) || -6;
  try { localStorage.setItem('dabcast.levelTarget', String(LEVEL_TARGET)); } catch { /* ignore */ }
  renderLevels();
});
$('#lvWindow')?.addEventListener('change', (e) => {
  LEVEL_WINDOW_MS = (Number(e.target.value) || 5) * 60000;   // longer window: older samples are kept from now on
  try { localStorage.setItem('dabcast.levelWindowMin', String(LEVEL_WINDOW_MS / 60000)); } catch { /* ignore */ }
  renderLevels();
});
$('#btnLevels')?.addEventListener('click', openLevels);
$('#lvReset')?.addEventListener('click', () => { _levelSamples.clear(); renderLevels(); });
const saveGain = (id, gainDb) => api(`/api/services/${id}`, { method: 'PATCH', body: JSON.stringify({ audio: { gainDb } }) });
$('#lvTable')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act="lv-apply"]');
  if (!btn) return;
  btn.disabled = true;
  try {
    await saveGain(btn.dataset.id, Number(btn.dataset.gain));
    await refresh();
  } catch (err) {
    showToast(err.message || String(err));
  }
  renderLevels();
});
$('#lvApplyAll')?.addEventListener('click', async (e) => {
  const list = [..._levelSuggestions];
  if (!list.length) return;
  if (!confirm(`Apply ${list.length} suggested gain(s)?\n\n${list.map((x) => `${x.name}: ${x.from} → ${x.to} dB`).join('\n')}\n\nEach encoder restarts (2–3 s gap on that service only).`)) return;
  e.target.disabled = true;
  const failed = [];
  for (const x of list) {
    try { await saveGain(x.id, x.to); } catch (err) { failed.push(`${x.name}: ${err.message || err}`); }
  }
  if (failed.length) showToast(`Not saved — ${failed.join(' · ')}`);
  await refresh();
  renderLevels();
});

// ── About dialog ──
const dlgAbout = $('#dlgAbout');
let aboutTimer = null;

function renderAboutGrid(grid, info) {
  const row = (l, v) => `<span class="about-label">${esc(l)}</span><span class="about-value">${esc(v)}</span>`;
  let html = '';
  html += row('Available memory', info.memAvailableMb != null ? `${info.memAvailableMb} MB` : 'N/A');
  html += row('CPU', info.cpuLoadPct != null ? `${info.cpuLoadPct} %` : 'N/A');
  html += row('Disk', info.diskUsedPct != null ? `${info.diskUsedPct} %` : 'N/A');
  if (info.versions) {
    html += '<hr class="about-sep">';
    for (const [name, ver] of Object.entries(info.versions)) {
      html += row(name, ver ? `v${ver}` : 'N/A');
    }
  }
  grid.innerHTML = html;
}

function renderAboutUpdateRow(container) {
  if (!container) return;
  if (!_updateInfo) {
    container.innerHTML = '';
    return;
  }
  if (_updateInfo.updateAvailable) {
    container.innerHTML = `<button type="button" class="about-update-badge new" id="btnAboutUpdate">↑ v${esc(_updateInfo.latestVersion)} available — click to update</button>`;
    container.querySelector('#btnAboutUpdate')?.addEventListener('click', () => {
      dlgAbout.close();
      showUpdateDialog();
    });
  } else {
    container.innerHTML = `<span class="about-update-badge ok">✓ Up to date</span>`;
  }
}

function renderMuxStats(container, stats) {
  if (!container) return;
  if (!stats?.running) {
    container.innerHTML = '';
    return;
  }
  let html = '<hr class="about-sep"><div class="mux-stats-title">Mux input buffers (odr-dabmux)</div>';
  if (stats.error) {
    html += `<div class="mux-stats-off">Stats unavailable: ${esc(stats.error)}</div>`;
    container.innerHTML = html;
    return;
  }
  const entries = Object.values(stats.inputs || {});
  if (!entries.length) {
    html += '<div class="mux-stats-off">No subchannel data</div>';
    container.innerHTML = html;
    return;
  }
  html += '<div class="mux-stats-grid">';
  for (const inp of entries) {
    html += `<span class="mux-stat-label">${esc(inp.name)}</span>`;
    html += `<span>${bufTag(inp, true)}</span>`;
    html += `<span class="mux-stat-pct">U ${inp.underruns ?? 0} · O ${inp.overruns ?? 0} · ${inp.peakLeft ?? '—'}/${inp.peakRight ?? '—'} dB</span>`;
  }
  html += '</div>';
  container.innerHTML = html;
}

async function _refreshAbout(grid, statsEl) {
  const [info, stats] = await Promise.allSettled([
    api('/api/system/info'),
    api('/api/mux/stats')
  ]);
  if (info.status === 'fulfilled') renderAboutGrid(grid, info.value);
  if (stats.status === 'fulfilled') renderMuxStats(statsEl, stats.value);
}

async function showAbout() {
  const grid = $('#aboutGrid');
  const statsEl = $('#aboutMuxStats');
  const verEl = $('#aboutVersion');
  if (!grid) return;
  grid.innerHTML = '<span class="about-label">Loading…</span><span></span>';
  if (statsEl) statsEl.innerHTML = '';
  if (verEl && STATE?.appVersion) verEl.textContent = `DABcast v${STATE.appVersion}`;
  renderAboutUpdateRow($('#aboutUpdateRow'));
  dlgAbout.showModal();
  try {
    await _refreshAbout(grid, statsEl);
  } catch (e) {
    grid.innerHTML = `<span class="about-label">Error</span><span class="about-value">${esc(String(e.message || e))}</span>`;
  }
  // Live refresh every 2s
  clearInterval(aboutTimer);
  aboutTimer = setInterval(() => _refreshAbout(grid, statsEl).catch(() => {}), 2000);
}

dlgAbout.addEventListener('close', () => {
  clearInterval(aboutTimer);
  aboutTimer = null;
});

$('#btnCheckUpdate')?.addEventListener('click', async () => {
  const btn = $('#btnCheckUpdate');
  const row = $('#aboutUpdateRow');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  try {
    const data = await api('/api/update/check?force=true');
    if (data?.latestVersion && STATE?.appVersion) {
      const toNums = s => s.replace(/^v/, '').split('.').map(Number);
      const latest = toNums(data.latestVersion);
      const current = toNums(STATE.appVersion);
      let newer = false;
      for (let i = 0; i < 3; i++) {
        if (latest[i] > current[i]) { newer = true; break; }
        if (latest[i] < current[i]) break;
      }
      _updateInfo = { updateAvailable: newer, latestVersion: data.latestVersion, releaseUrl: data.releaseUrl, releaseNotes: data.releaseNotes || null };
      renderAboutUpdateRow(row);
      render();
    }
  } catch (_) {
    if (row) row.innerHTML = '<span class="about-update-badge error">Check failed</span>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Check for updates'; }
  }
});

// Logo management functions
async function openLogosDialog(serviceId) {
  logoManagingServiceId = serviceId;
  const svc = STATE.preset.services.find(s => s.id === serviceId);
  if (!svc) return;

  $('#logoManageServiceName').textContent = svc.identity.ps8 || serviceId;
  await refreshLogosList();
  dlgManageLogos.showModal();
}

async function refreshLogosList() {
  const list = $('#logosList');
  if (!logoManagingServiceId) {
    list.innerHTML = '<p class="muted">No service selected.</p>';
    return;
  }

  try {
    const slides = await api(`/api/mot/${logoManagingServiceId}/slides`);
    // Filter logo.jpg and logo_N.jpg files (exclude cover.jpg and other files)
    const logos = slides.filter(f => /^logo(_\d+)?\.jpg$/i.test(f)).sort();

    if (logos.length === 0) {
      list.innerHTML = '<p class="muted">No logos found. Click "Upload Logo" to add one.</p>';
      return;
    }

    list.innerHTML = logos.map(filename => {
      const url = `/api/mot/${logoManagingServiceId}/slide/${encodeURIComponent(filename)}?t=${Date.now()}`;
      const isMainLogo = filename === 'logo.jpg';
      const deleteBtn = isMainLogo
        ? '<span class="muted" style="font-size: 11px;">Main logo</span>'
        : `<button type="button" class="btn btn-del" data-filename="${esc(filename)}">Delete</button>`;
      return `
        <div class="logo-item">
          <img src="${url}" alt="${esc(filename)}" />
          <span class="logo-item-name">${esc(filename)}</span>
          ${deleteBtn}
        </div>
      `;
    }).join('');

    // Add delete event listeners
    list.querySelectorAll('.btn-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const filename = btn.dataset.filename;
        if (!confirm(`Delete ${filename}?`)) return;
        try {
          await api(`/api/mot/${logoManagingServiceId}/logo/${filename}`, { method: 'DELETE' });
          await refreshLogosList();
          await _forceRefreshSlides(logoManagingServiceId); // Update thumbnail rotation
          showToast('Logo deleted successfully', 'success');
        } catch (err) {
          showToast(String(err.message || err), 'error');
        }
      });
    });
  } catch (err) {
    list.innerHTML = `<p class="muted">Error loading logos: ${esc(String(err.message || err))}</p>`;
  }
}

async function uploadAdditionalLogo() {
  if (!logoManagingServiceId) {
    showToast('No service selected', 'error');
    return;
  }

  const file = fileUploadLogo.files[0];
  if (!file) return;

  // Check file type
  if (!file.type.startsWith('image/')) {
    showToast('Please select an image file', 'error');
    return;
  }

  try {
    // Read file as data URL
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    // Upload to server
    await api(`/api/mot/${logoManagingServiceId}/upload-logo`, {
      method: 'POST',
      body: JSON.stringify({ dataUrl })
    });

    showToast('Logo uploaded successfully! (320×240 JPEG)', 'success');
    await refreshLogosList();
    await _forceRefreshSlides(logoManagingServiceId); // Update thumbnail rotation
    // Update SLS preview if the managed service is currently open in the metadata tab
    if (logoManagingServiceId === editingId) {
      const img = $('#slsImg');
      if (img) {
        img.src = `/api/mot/${encodeURIComponent(logoManagingServiceId)}/logo?ts=${Date.now()}`;
        img.style.display = 'block';
        $('#slsImgWrap')?.classList.remove('no-logo');
        img.onerror = () => {
          img.removeAttribute('src');
          img.style.display = 'none';
          $('#slsImgWrap')?.classList.add('no-logo');
        };
      }
    }
    fileUploadLogo.value = ''; // Reset file input
  } catch (err) {
    showToast(String(err.message || err), 'error');
  }
}

// ── Auth dialog ──
function showAuth() {
  const dlg = $('#dlgAuth');
  $('#a_user').value = STATE?.authUser || '';
  $('#a_pass').value = '';
  $('#a_pass2').value = '';
  $('#authError').classList.add('hidden');
  dlg.showModal();
  loadWebPort();
}

// Settings › Web server: port of the web interface (applied at the next DABcast start)
let WEB_PORT = null;   // last /api/settings/web answer
function webPortMsg(text, cls = '') {
  const el = $('#webPortMsg');
  el.textContent = text;
  el.className = `meta-help${cls ? ` json-status ${cls}` : ''}`;
}
async function loadWebPort() {
  WEB_PORT = null;
  try {
    WEB_PORT = await api('/api/settings/web');
    $('#s_port').value = WEB_PORT.savedPort;
    $('#webPortNow').textContent = `now ${WEB_PORT.port}`;
    const locked = Boolean(WEB_PORT.envPort);
    $('#s_port').disabled = locked;
    $('#btnPortSave').disabled = locked;
    $('#btnPortSave').textContent = WEB_PORT.canRestart ? 'Save & restart' : 'Save';
    if (locked) webPortMsg(`PORT=${WEB_PORT.envPort} is set in /etc/default/dabcast: change it there, then sudo systemctl restart dabcast.`, 'err');
    else if (!WEB_PORT.canRestart) webPortMsg('DABcast does not run as the systemd service here: the port is saved, restart DABcast by hand to apply it.');
    else webPortMsg('Save & restart saves the port and restarts DABcast: the interface reopens at the new port. ON AIR, the multiplex is cut for about 10 s (autoStart puts it back on air).');
  } catch (err) {
    webPortMsg(err.message || String(err), 'err');
  }
}
// Save & restart: confirm (port change + mux cut), save, restart, then open the new address
$('#btnPortSave')?.addEventListener('click', async () => {
  if (!WEB_PORT) return;   // settings not loaded yet
  const port = Number($('#s_port').value);
  const cur = WEB_PORT.port;
  if (port === cur) {   // current port: nothing to restart (also cancels a port saved earlier without restart)
    try { if (WEB_PORT?.savedPort !== cur) await api('/api/settings/web', { method: 'POST', body: JSON.stringify({ port }) }); } catch (err) { webPortMsg(err.message || String(err), 'err'); return; }
    WEB_PORT = { ...WEB_PORT, savedPort: cur };
    webPortMsg(`DABcast already uses port ${cur}.`, 'ok');
    return;
  }
  const url = `${location.protocol}//${location.hostname}:${port}/`;
  // check the port first (range, broadcast chain, already in use): an error shows here, before any question
  try {
    await api('/api/settings/web', { method: 'POST', body: JSON.stringify({ port, dryRun: true }) });
  } catch (err) {
    webPortMsg(err.message || String(err), 'err');
    return;
  }
  if (WEB_PORT?.canRestart && !confirm(`Change the web interface port from ${cur} to ${port} and restart DABcast now?\n\n`
    + `• The interface reopens at ${url} (update your bookmarks).\n`
    + (STATE?.muxRunning
      ? '• ON AIR: the multiplex is cut and ALL services go off air for about 10 s; autoStart puts it back on air.'
      : '• The multiplex is off air: no broadcast is interrupted.'))) return;
  try {
    await api('/api/settings/web', { method: 'POST', body: JSON.stringify({ port }) });
  } catch (err) {
    webPortMsg(err.message || String(err), 'err');
    return;
  }
  if (!WEB_PORT?.canRestart) { webPortMsg(`Port ${port} saved — restart DABcast to apply it.`, 'ok'); return; }
  try {
    clearInterval(refreshTimer);
    await api('/api/system/restart', { method: 'POST', body: '{}' });
  } catch (err) {
    webPortMsg(err.message || String(err), 'err');
    return;
  }
  // wait for the new server, then open it (the session cookie is not tied to the port)
  $('#btnPortSave').disabled = true;
  webPortMsg(`Restarting… the interface reopens at ${url}`, 'ok');
  const t0 = Date.now();
  const tryOpen = async () => {
    try { await fetch(`${url}login.html`, { mode: 'no-cors', cache: 'no-store' }); location.href = url; return; } catch { /* not up yet */ }
    if (Date.now() - t0 < 60000) setTimeout(tryOpen, 2000);
    else webPortMsg(`DABcast did not answer at ${url} — check the service (sudo systemctl status dabcast).`, 'err');
  };
  setTimeout(tryOpen, 6000);
});
$('#btnAuth').addEventListener('click', showAuth);
$('#btnPwdBanner')?.addEventListener('click', showAuth);

$('#dlgAuth').querySelectorAll('[data-action="auth-cancel"]').forEach((b) => b.addEventListener('click', () => {
  $('#dlgAuth').close();
}));

$('#btnAuthSave').addEventListener('click', async () => {
  const errEl = $('#authError');
  errEl.classList.add('hidden');
  const username = $('#a_user').value.trim();
  const password = $('#a_pass').value;
  const password2 = $('#a_pass2').value;

  if (!username || !password) {
    errEl.textContent = 'Username and password required';
    errEl.classList.remove('hidden');
    return;
  }
  if (password !== password2) {
    errEl.textContent = 'Passwords do not match';
    errEl.classList.remove('hidden');
    return;
  }
  if (password.length < 10) {
    errEl.textContent = 'Password must be at least 10 characters';
    errEl.classList.remove('hidden');
    return;
  }
  const weak = ['dabcast','password','admin','administrator','1234567890','12345678901','123456789012','qwerty1234','letmein1234','changeme123'];
  if (weak.includes(password.toLowerCase())) {
    errEl.textContent = 'This password is too common, please choose a stronger one';
    errEl.classList.remove('hidden');
    return;
  }
  try {
    // Stop periodic refresh AND abort any in-flight request
    clearInterval(refreshTimer);
    if (refreshAbort) refreshAbort.abort();
    await api('/api/auth', {
      method: 'PATCH',
      body: JSON.stringify({ username, password })
    });
    $('#dlgAuth').close();
    showToast('Password changed!', 'success');
    pwdDialogShown = false;
    // The server refreshes the signed session cookie with the new credentials.
    refreshTimer = setInterval(refresh, 2500);
    await refresh();
  } catch (err) {
    // Restart periodic refresh on failure
    refreshTimer = setInterval(refresh, 2500);
    errEl.textContent = String(err.message || err);
    errEl.classList.remove('hidden');
  }
});

async function signOut() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } finally {
    window.location.replace('/login.html');
  }
}
$('#btnLogout')?.addEventListener('click', signOut);
$('#btnSignOut')?.addEventListener('click', signOut);

// ── Telegram dialog ──
const dlgTelegram = $('#dlgTelegram');

function renderTelegramStatus(config) {
  const status = $('#telegramStatus');
  if (!config.configured) {
    status.innerHTML = '<div class="info-row"><span class="pill off">NOT CONFIGURED</span></div>';
  } else if (config.enabled) {
    status.innerHTML = '<div class="info-row"><span class="pill ok">ACTIVE</span> Alerts are being sent.</div>';
  } else {
    status.innerHTML = '<div class="info-row"><span class="pill warn">DISABLED</span> Configuration is preserved.</div>';
  }
}

async function showTelegram() {
  const errEl = $('#telegramError');
  errEl.classList.add('hidden');
  $('#tg_token').value = '';
  $('#tg_token').type = 'password';

  try {
    const config = await api('/api/telegram');
    $('#tg_enabled').checked = Boolean(config.enabled);
    $('#tg_chat_id').value = config.chatId || '';
    $('#tg_min_level').value = config.minLevel || 'ERROR';
    $('#tg_silent').checked = Boolean(config.silent);
    $('#telegramTokenHint').textContent = config.tokenConfigured
      ? `Token saved (${config.tokenHint}). Leave blank to keep it.`
      : 'No token saved.';
    renderTelegramStatus(config);
    dlgTelegram.showModal();
  } catch (err) {
    showToast(err.message || String(err));
  }
}

async function saveTelegramConfig({ close = true } = {}) {
  const errEl = $('#telegramError');
  errEl.classList.add('hidden');
  try {
    const payload = {
      enabled: $('#tg_enabled').checked,
      token: $('#tg_token').value.trim(),
      chatId: $('#tg_chat_id').value.trim(),
      minLevel: $('#tg_min_level').value,
      silent: $('#tg_silent').checked
    };
    const result = await api('/api/telegram', {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    $('#tg_token').value = '';
    $('#telegramTokenHint').textContent = result.configured
      ? 'Token saved. Leave blank to keep it.'
      : 'No token saved.';
    renderTelegramStatus(result);
    showToast('Telegram configuration saved', 'success');
    if (close) dlgTelegram.close();
    return true;
  } catch (err) {
    errEl.textContent = String(err.message || err);
    errEl.classList.remove('hidden');
    return false;
  }
}

$('#btnTelegram')?.addEventListener('click', showTelegram);
dlgTelegram?.querySelector('[data-action="telegram-cancel"]')?.addEventListener('click', () => dlgTelegram.close());
$('#btnToggleTelegramToken')?.addEventListener('click', () => {
  const input = $('#tg_token');
  input.type = input.type === 'password' ? 'text' : 'password';
});
$('#btnTelegramSave')?.addEventListener('click', () => saveTelegramConfig());
$('#btnTelegramTest')?.addEventListener('click', async () => {
  if (!await saveTelegramConfig({ close: false })) return;
  try {
    await api('/api/telegram/test', { method: 'POST', body: '{}' });
    showToast('Test message sent to Telegram', 'success');
  } catch (err) {
    const errEl = $('#telegramError');
    errEl.textContent = String(err.message || err);
    errEl.classList.remove('hidden');
  }
});

// events
$('#btnAbout').addEventListener('click', showAbout);
$('#btnLegal')?.addEventListener('click', () => {
  const ver = $('#legalVersion');
  if (ver && STATE?.appVersion) ver.textContent = `v${STATE.appVersion}`;
  $('#dlgLegal').showModal();
});

// ── Update dialog ──────────────────────────────────────────────────────────
const dlgUpdate = $('#dlgUpdate');
let _updatePollingTimer = null;

function showUpdateDialog() {
  if (!dlgUpdate || !_updateInfo?.updateAvailable) return;
  $('#updateCurrentVer').textContent = STATE?.appVersion ? `v${STATE.appVersion}` : '—';
  $('#updateNewVer').textContent = `v${_updateInfo.latestVersion}`;
  const warn = $('#updateOnAirWarning');
  const onAir = !!STATE?.muxRunning;
  if (warn) warn.classList.toggle('hidden', !onAir);
  $('#btnUpdateStart').disabled = onAir;
  const changelogEl = $('#updateChangelog');
  if (changelogEl) {
    if (_updateInfo.releaseNotes) {
      changelogEl.textContent = _updateInfo.releaseNotes;
      changelogEl.classList.remove('hidden');
    } else {
      changelogEl.classList.add('hidden');
    }
  }
  $('#updateProgressWrap')?.classList.add('hidden');
  $('#updateErrorMsg')?.classList.add('hidden');
  $('#btnUpdateStart').disabled = false;
  $('#btnUpdateStart').textContent = 'Download & Install';
  dlgUpdate.showModal();
}

function _setUpdateProgress(label, pct) {
  const wrap = $('#updateProgressWrap');
  if (!wrap) return;
  wrap.classList.remove('hidden');
  $('#updateProgressLabel').textContent = label;
  $('#updateProgressFill').style.width = `${pct}%`;
  $('#updateProgressPct').textContent = `${pct}%`;
}

$('#updateBadge')?.addEventListener('click', showUpdateDialog);

$('#btnUpdateCancel')?.addEventListener('click', () => {
  dlgUpdate?.close();
  clearInterval(_updatePollingTimer);
});

$('#btnUpdateClose')?.addEventListener('click', () => {
  clearInterval(_updatePollingTimer);
});

$('#btnUpdateStart')?.addEventListener('click', async () => {
  const startBtn = $('#btnUpdateStart');
  const cancelBtn = $('#btnUpdateCancel');
  const errEl = $('#updateErrorMsg');
  errEl?.classList.add('hidden');
  startBtn.disabled = true;
  startBtn.textContent = 'Starting…';
  cancelBtn.disabled = true;
  $('#btnUpdateClose').disabled = true;

  try {
    await api('/api/update/apply', { method: 'POST', body: '{}' });
  } catch (err) {
    errEl.textContent = err.message || String(err);
    errEl.classList.remove('hidden');
    startBtn.disabled = false;
    startBtn.textContent = 'Download & Install';
    cancelBtn.disabled = false;
    $('#btnUpdateClose').disabled = false;
    return;
  }

  // Poll progress until restarting or error
  let _netErrCount = 0;
  let _sawInstalling = false;
  _updatePollingTimer = setInterval(async () => {
    try {
      const prog = await api('/api/update/progress');
      _netErrCount = 0;
      if (prog.status === 'downloading') {
        _setUpdateProgress(`Downloading… (${prog.progress}%)`, prog.progress);
      } else if (prog.status === 'installing') {
        _sawInstalling = true;
        _setUpdateProgress('Installing…', 100);
      } else if (prog.status === 'idle' && _sawInstalling) {
        // New server already up — restart was fast
        clearInterval(_updatePollingTimer);
        dlgUpdate?.close(); _updateInfo = null; refresh();
      } else if (prog.status === 'restarting') {
        _setUpdateProgress('Restarting service…', 100);
        clearInterval(_updatePollingTimer);
        // Wait for service to come back
        setTimeout(() => {
          dlgUpdate?.close();
          _updateInfo = null;
          refresh();
        }, 6000);
      } else if (prog.status === 'error') {
        clearInterval(_updatePollingTimer);
        errEl.textContent = prog.error || 'Unknown error';
        errEl.classList.remove('hidden');
        startBtn.disabled = false;
        startBtn.textContent = 'Retry';
        cancelBtn.disabled = false;
        $('#btnUpdateClose').disabled = false;
      }
    } catch (_) {
      // Server went down during install — treat as restart
      if (++_netErrCount >= 2) {
        clearInterval(_updatePollingTimer);
        _setUpdateProgress('Restarting service…', 100);
        setTimeout(() => { dlgUpdate?.close(); _updateInfo = null; refresh(); }, 6000);
      }
    }
  }, 800);
});

$('#btnStart').addEventListener('click', start);
$('#btnStop').addEventListener('click', stop);
$('#btnLogs').addEventListener('click', showLogs);
const btnDablin = $('#btnDablin');
if (btnDablin) {
  btnDablin.addEventListener('click', startDablin);

  const h = window.location.hostname;
  const isLocal = (h === 'localhost' || h === '127.0.0.1' || h === '::1');

  if (!isLocal) {
    btnDablin.title = 'Local only';
    btnDablin.classList.add('local-only');
  } else {
    btnDablin.title = '';
    btnDablin.classList.remove('local-only');
  }
}

$('#btnMux').addEventListener('click', openMuxDialog);
$('#btnAdd').addEventListener('click', () => openDialogFor(null));
$('#svcSearch')?.addEventListener('input', (e) => { VIEW.q = e.target.value; render(); });
$('#svcSearch')?.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; VIEW.q = ''; render(); e.target.blur(); } });
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('dialog[open]') || e.target.closest?.('input, select, textarea, [contenteditable]')) return;
  e.preventDefault();
  $('#svcSearch')?.focus();
});
svcTableBody.addEventListener('dblclick', (e) => {
  if (e.target.closest('button, .sls-thumb')) return;
  const row = e.target.closest('tr[data-service-id]');
  const svc = row && STATE?.preset.services.find((s) => s.id === row.dataset.serviceId);
  if (svc) openDialogFor(svc);
});
$('#ioMenu')?.addEventListener('click', (e) => { if (e.target.closest('.menu-list button')) $('#ioMenu').open = false; });
document.addEventListener('click', (e) => { const m = $('#ioMenu'); if (m?.open && !m.contains(e.target)) m.open = false; });
if ($('#svcSort')) $('#svcSort').value = VIEW.sort;
$('#svcSort')?.addEventListener('change', (e) => { VIEW.sort = e.target.value; saveView(); render(); });
function syncViewButtons() {
  document.querySelectorAll('.seg-btn[data-view]').forEach((b) => {
    const on = (b.dataset.view === 'compact') === VIEW.compact;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}
syncViewButtons();
document.querySelectorAll('.seg-btn[data-view]').forEach((b) => b.addEventListener('click', () => {
  VIEW.compact = b.dataset.view === 'compact';
  syncViewButtons(); saveView(); render();
}));

document.querySelectorAll('.logs-tabs .tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeLogTab = btn.dataset.logtab || 'all';
    renderLogs();
  });
});

$('#chkRawOutput')?.addEventListener('change', async (e) => {
  showRawOutput = e.target.checked;
  await _refreshLogContent();
});

$('#selLogService')?.addEventListener('change', (e) => {
  activeServiceFilter = e.target.value;
  renderLogs();
});

$('#btnDownloadLogs')?.addEventListener('click', () => {
  window.open('/api/logs/download', '_blank');
});

$('#btnClearLogs')?.addEventListener('click', async () => {
  if (!confirm('Clear all logs?')) return;
  try {
    await api('/api/logs', { method: 'DELETE' });
    renderLogs();
  } catch (err) {
    alert(err.message || String(err));
  }
});

['f_bitrate', 'f_prot'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', updateCuPreview);
});

$('#f_src')?.addEventListener('change', updateSourceVisibility);

// Sync direct-mode bitrate/prot selects → canonical selects (submit always reads f_bitrate/f_prot)
// Live "mux restart required" banner (bubbling: runs after field-specific handlers such as direct→f_bitrate sync)
$('#svcForm')?.addEventListener('input', updateRestartWarn);
$('#svcForm')?.addEventListener('change', updateRestartWarn);

$('#f_direct_bitrate')?.addEventListener('change', () => {
  const el = $('#f_bitrate');
  if (el) el.value = $('#f_direct_bitrate').value;
  updateCuPreview();
});
$('#f_direct_prot')?.addEventListener('change', () => {
  const el = $('#f_prot');
  if (el) el.value = $('#f_direct_prot').value;
  updateCuPreview();
});

$('#f_codec')?.addEventListener('change', () => {
  const codec = $('#f_codec').value;
  const chSel = $('#f_ch');
  if (codec === 'HE-AAC v2 (PS)') {
    chSel.value = '2';
    chSel.disabled = true;
  } else {
    chSel.disabled = false;
  }
});

$('#m_txmode')?.addEventListener('change', updateTxModeVisibility);
$('#f_meta_mode')?.addEventListener('change', updateMetaModeVisibility);

// Unsaved changes: Cancel / ✕ / Escape ask before closing the service dialog
let svcSnapshot = new Map();
const svcFields = () => [...$('#svcForm').querySelectorAll('input[id], select[id], textarea[id]')].filter((e) => e.type !== 'file');
const svcFieldValue = (e) => (e.type === 'checkbox' ? String(e.checked) : e.value);
function snapshotSvcForm(ids) {
  for (const e of svcFields()) if (!ids || ids.includes(e.id)) svcSnapshot.set(e.id, svcFieldValue(e));
}
function svcFormChanged() {
  return svcFields().some((e) => svcSnapshot.has(e.id) && svcSnapshot.get(e.id) !== svcFieldValue(e));
}
function confirmDiscardSvc() {
  return !svcFormChanged() || confirm('Discard the unsaved changes?');
}
document.querySelectorAll('[data-action="svc-cancel"]').forEach((btn) => {
  btn.addEventListener('click', () => { if (confirmDiscardSvc()) dlg.close(); });
});
dlg.addEventListener('cancel', (e) => { if (!confirmDiscardSvc()) e.preventDefault(); });
document.querySelectorAll('[data-action="mux-cancel"]').forEach((btn) => {
  btn.addEventListener('click', () => dlgMux.close());
});

// service tabs + wizard buttons
document.querySelectorAll('#dlgService .tab').forEach((b) => {
  b.addEventListener('click', () => setActiveTab(b.dataset.tab));
});

$('#btnPrev').addEventListener('click', () => {
  const i = TAB_ORDER.indexOf(activeTab);
  if (i > 0) setActiveTab(TAB_ORDER[i - 1]);
});
$('#btnNext').addEventListener('click', () => {
  const i = TAB_ORDER.indexOf(activeTab);
  if (i < TAB_ORDER.length - 1) setActiveTab(TAB_ORDER[i + 1]);
});

$('#btnSwap').addEventListener('click', () => {
  const a = $('#f_uri').value;
  const b = $('#f_backup').value;
  $('#f_uri').value = b;
  $('#f_backup').value = a;
});

// Logo management event listeners
$('#btnUploadNewLogo')?.addEventListener('click', () => {
  fileUploadLogo.click();
});

fileUploadLogo?.addEventListener('change', () => {
  uploadAdditionalLogo();
});

async function downloadLogo() {
  if (!editingId) return alert('Save the service before downloading a logo.');
  const statusEl = $('#slsTestStatus');
  if (statusEl) statusEl.textContent = 'Downloading...';

  try {
    await api(`/api/services/${encodeURIComponent(editingId)}/logo/download`, {
      method: 'POST',
      body: '{}'
    });

    // refresh preview
    const svc = STATE.preset.services.find((s) => s.id === editingId);
    const key = svc?.pad?.fifoName || svc?.identity?.ps8 || editingId;
    const img = $('#slsImg');
    img.src = `/api/mot/${encodeURIComponent(String(key))}/logo?ts=${Date.now()}`;
    img.style.display = 'block';
    $('#slsImgWrap')?.classList.remove('no-logo');
    if (statusEl) statusEl.textContent = '✓ Downloaded';
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Error';
    throw err;
  }
}

async function uploadLogo() {
  if (!editingId) return alert('Save the service before uploading a logo.');
  const file = $('#f_logo')?.files?.[0];
  if (!file) return;

  const statusEl = $('#slsTestStatus');
  if (statusEl) statusEl.textContent = 'Upload...';

  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('read error'));
    r.readAsDataURL(file);
  });

  try {
    await api(`/api/services/${encodeURIComponent(editingId)}/logo/upload`, {
      method: 'POST',
      body: JSON.stringify({ dataUrl })
    });

    // refresh preview
    const svc = STATE.preset.services.find((s) => s.id === editingId);
    const key = svc?.pad?.fifoName || svc?.identity?.ps8 || editingId;
    const img = $('#slsImg');
    img.src = `/api/mot/${encodeURIComponent(String(key))}/logo?ts=${Date.now()}`;
    img.style.display = 'block';
    $('#slsImgWrap')?.classList.remove('no-logo');
    if (statusEl) statusEl.textContent = '✓ Uploaded';
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Error';
    throw err;
  }
}

async function clearLogo() {
  if (!editingId) return;
  const key = (STATE.preset.services.find((s) => s.id === editingId)?.pad?.fifoName ||
    STATE.preset.services.find((s) => s.id === editingId)?.identity?.ps8 || editingId);
  await api(`/api/mot/${encodeURIComponent(String(key))}/logo`, { method: 'DELETE', body: '{}' });
  const img = $('#slsImg');
  img.removeAttribute('src');
  img.style.display = 'none';
  $('#slsImgWrap')?.classList.add('no-logo');
}

$('#btnDownloadSls').addEventListener('click', () => downloadLogo().catch((e) => alert(e.message || String(e))));
$('#btnClearLogo').addEventListener('click', () => clearLogo().catch((e) => alert(e.message || String(e))));
$('#btnManageLogos')?.addEventListener('click', () => {
  if (editingId) {
    openLogosDialog(editingId);
  }
});
// Auto-upload when file is selected
$('#f_logo').addEventListener('change', () => {
  if ($('#f_logo')?.files?.[0]) {
    uploadLogo().catch((e) => alert(e.message || String(e)));
  }
});


async function testSlsUrl() {
  const statusEl = $('#slsTestStatus');
  if (statusEl) statusEl.textContent = 'Test...';
  const url = $('#f_sls_url').value.trim();
  if (!url) {
    if (statusEl) statusEl.textContent = 'URL manquante';
    return;
  }
  try {
    const res = await api('/api/metadata/test/sls', {
      method: 'POST',
      body: JSON.stringify({ url })
    });
    if (statusEl) statusEl.textContent = res?.ok ? 'OK' : (res?.error || 'Failed');
    if (res?.dataUrl) {
      const img = $('#slsImg');
      const hint = $('#slsHint');
      if (img) {
        img.src = res.dataUrl;
        img.style.display = 'block';
        $('#slsImgWrap')?.classList.remove('no-logo');
      }
      if (hint) hint.textContent = 'SLS via URL';
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Error';
    alert(err.message || String(err));
  }
}

$('#btnTestSls').addEventListener('click', () => testSlsUrl().catch((e) => alert(e.message || String(e))));

// 'Label: value' of the JSON test results: label in the status colour, value (from the API) in white
const jsonPart = (label, value) => `${label}: <span class="json-val">${esc(value)}</span>`;
// 'Detect keys': the server reads the JSON and suggests the keys; they are filled in (not saved)
$('#btnDetectJson')?.addEventListener('click', async () => {
  const statusEl = $('#jsonTestStatus');
  const url = $('#f_json_url').value.trim();
  statusEl.className = 'json-status';
  if (!url) { statusEl.textContent = 'JSON URL required'; return; }
  statusEl.textContent = 'Reading the JSON…';
  try {
    const r = await api('/api/metadata/detect/json', { method: 'POST', body: JSON.stringify({ url }) });
    if (!r?.ok) { statusEl.className = 'json-status err'; statusEl.textContent = `⚠ ${r?.error || 'Failed'}`; return; }
    // fill in (even an unchanged value flashes green, so it is visible that the field was checked);
    // a key not found leaves artist / title as they are, and empties the cover key
    const set = (id, v, clearIfMissing = false) => {
      const el = $(id);
      if (!v && !clearIfMissing) return;
      if (el.value !== (v || '')) { el.value = v || ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
      el.classList.remove('just-filled'); void el.offsetWidth; el.classList.add('just-filled');
      setTimeout(() => el.classList.remove('just-filled'), 2000);
    };
    set('#f_json_artist', r.artistKey);
    set('#f_json_title', r.titleKey);
    set('#f_json_sls', r.slsKey, true);
    const found = [r.artistKey && jsonPart('Artist', r.artist), r.titleKey && jsonPart('Title', r.title), r.slsKey && jsonPart('Cover', 'found')].filter(Boolean);
    const missing = [!r.artistKey && 'artist', !r.titleKey && 'title', !r.slsKey && 'cover'].filter(Boolean);
    statusEl.className = found.length ? 'json-status ok' : 'json-status err';
    statusEl.innerHTML = (found.length ? `✓ ${found.join(' | ')}` : '⚠ No artist / title / cover key found')
      + (missing.length && found.length ? ` · not found: ${missing.join(', ')}` : '') + (found.length ? ' — check, then Validate or OK' : '');
  } catch (err) {
    statusEl.textContent = `⚠ ${err.message || err}`;
  }
});
$('#btnTestJson')?.addEventListener('click', async () => {
  const statusEl = $('#jsonTestStatus');
  const url = $('#f_json_url').value.trim();
  if (statusEl) statusEl.className = 'json-status';
  if (!url) { if (statusEl) statusEl.textContent = 'JSON URL required'; return; }
  if (statusEl) statusEl.textContent = 'Test...';
  try {
    const res = await api('/api/metadata/test/json', {
      method: 'POST',
      body: JSON.stringify({
        url,
        artistKey: $('#f_json_artist').value.trim() || 'artist',
        titleKey: $('#f_json_title').value.trim() || 'title',
        slsKey: $('#f_json_sls').value.trim() || 'slide'
      })
    });
    if (res?.ok) {
      const parts = [];
      if (res.artist) parts.push(jsonPart('Artist', res.artist));
      if (res.title) parts.push(jsonPart('Title', res.title));
      if (res.coverUrl) parts.push(jsonPart('Cover', 'OK'));
      statusEl.className = `json-status ${res.artist || res.title ? 'ok' : 'err'}`;
      statusEl.innerHTML = parts.length ? `✓ ${parts.join(' | ')}` : '⚠ Nothing found with these keys';
    } else {
      statusEl.className = 'json-status err';
      statusEl.textContent = `⚠ ${res?.error || 'Failed'}`;
    }
  } catch (err) {
    if (statusEl) { statusEl.className = 'json-status err'; statusEl.textContent = '⚠ Error'; }
    alert(err.message || String(err));
  }
});

$('#btnTestCover')?.addEventListener('click', async () => {
  const statusEl = $('#jsonTestStatus');
  const previewBox = $('#coverPreviewBox');
  const previewImg = $('#coverPreviewImg');
  const previewInfo = $('#coverPreviewInfo');
  if (previewBox) previewBox.style.display = 'none';
  if (statusEl) statusEl.className = 'json-status';

  // Step 1: get cover URL from JSON
  const url = $('#f_json_url').value.trim();
  const say = (cls, txt) => { if (statusEl) { statusEl.className = `json-status ${cls}`; statusEl.textContent = txt; } };
  if (!url) { say('err', '⚠ JSON URL required'); return; }
  say('', 'Fetching JSON...');
  try {
    const jsonRes = await api('/api/metadata/test/json', {
      method: 'POST',
      body: JSON.stringify({
        url,
        artistKey: $('#f_json_artist').value.trim() || 'artist',
        titleKey: $('#f_json_title').value.trim() || 'title',
        slsKey: $('#f_json_sls').value.trim() || 'slide'
      })
    });
    if (!jsonRes?.ok || !jsonRes.coverUrl) {
      say('err', jsonRes?.ok ? '⚠ No cover URL in the JSON with this key' : `⚠ ${jsonRes?.error || 'JSON error'}`);
      return;
    }
    // Step 2: test cover download via backend proxy
    say('', 'Downloading cover...');
    const slsRes = await api('/api/metadata/test/sls', {
      method: 'POST',
      body: JSON.stringify({ url: jsonRes.coverUrl })
    });
    if (slsRes?.ok && slsRes.dataUrl) {
      const kb = slsRes.bytes ? `${Math.round(slsRes.bytes / 1024)} KB` : '';
      say('ok', `✓ Cover OK ${kb} (${slsRes.contentType || 'image'})`);
      if (previewImg) previewImg.src = slsRes.dataUrl;
      if (previewBox) previewBox.style.display = 'flex';
      if (previewInfo) previewInfo.textContent = `${jsonRes.coverUrl.slice(0, 60)}...`;
    } else {
      say('err', `⚠ Cover FAIL: ${slsRes?.error || 'download error'}`);
    }
  } catch (err) {
    say('err', '⚠ Error');
    alert(err.message || String(err));
  }
});

// ON/OFF button: OFF = service left out of the .mux (off air). ON AIR, the change needs Stop → save → Start.
let toggleBusy = false;
async function toggleService(svc, btn) {
  if (!svc || toggleBusy) return;
  const turnOn = svc.enabled === false;
  const name = svc.identity?.ps8 || svc.id;
  const othersOn = STATE.preset.services.filter((s) => s.id !== svc.id && s.enabled !== false).length;
  if (!turnOn && STATE.muxRunning && othersOn === 0) {
    showToast('At least one service must stay ON while ON AIR — use Stop instead.');
    return;
  }
  const cap = STATE.preset.capacity || { totalCu: 0, maxCu: 864 };
  if (turnOn && cap.totalCu + (svc.cu ?? 0) > cap.maxCu) {
    showToast(`Not enough capacity: ${cap.totalCu + (svc.cu ?? 0)}/${cap.maxCu} CU`);
    return;
  }
  const save = () => api(`/api/services/${svc.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: turnOn }) });
  toggleBusy = true;
  if (btn) btn.disabled = true;
  try {
    if (!STATE.muxRunning) {
      await save();
      return;
    }
    if (!confirm(`${turnOn ? 'Put' : 'Take'} ${name} ${turnOn ? 'on air' : 'off air'}?\n\nThe multiplex restarts: ALL services go off air for a few seconds.`)) return;
    await api('/api/mux/stop', { method: 'POST', body: '{}' });
    let saveErr = null;
    try { await save(); } catch (err) { saveErr = err; }
    try {
      await api('/api/mux/start', { method: 'POST', body: '{}' });
    } catch (err) {
      showToast(`Multiplex restart FAILED — press Start: ${err.message || err}`);
      return;
    }
    if (saveErr) showToast(`Change not saved, multiplex restarted with the previous settings: ${saveErr.message || saveErr}`);
  } catch (err) {
    showToast(err.message || String(err));
  } finally {
    toggleBusy = false;
    if (btn) btn.disabled = false;   // render() keeps the same button element when its HTML is unchanged
    await refresh();
  }
}

svcTableBody.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  const row = e.target.closest('tr');

  // Handle button clicks (edit/delete)
  if (btn) {
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    const svc = STATE.preset.services.find((s) => s.id === id);

    if (act === 'edit') {
      openDialogFor(svc);
    }
    if (act === 'toggle') {
      await toggleService(svc, btn);
    }
    if (act === 'del') {
      if (STATE.muxRunning && svc?.enabled !== false) return;
      if (!confirm('Delete this service?')) return;
      await api(`/api/services/${id}`, { method: 'DELETE' });
      await refresh();
    }
    return;
  }

  // Handle row selection (if not clicking a button)
  if (row && row.dataset.serviceId) {
    selectedServiceId = row.dataset.serviceId;
    render();  // Re-render to highlight selected row
  }
});

const META_FIELD_IDS = ['f_meta_mode', 'f_default_dls', 'f_sls_url', 'f_json_url', 'f_json_interval', 'f_json_artist', 'f_json_title', 'f_json_sls', 'f_json_start', 'f_json_duration', 'f_json_trackmax', 'f_json_logoevery', 'f_json_default_dls', 'f_dlplus_enabled'];
// Metadata part of the service payload (used by OK and by the Metadata 'Validate' button)
function metaPayload() {
  return {
    metadata: {
      mode: $('#f_meta_mode').value,
      defaultDls: $('#f_default_dls').value.trim() || null,
      slsUrl: $('#f_sls_url').value.trim() || null,
      url: $('#f_json_url').value.trim() || null,
      intervalSec: Number($('#f_json_interval').value || 10),
      // empty = default key on the server (artist / title / slide), kept empty so the field reopens empty
      artistKey: $('#f_json_artist').value.trim(),
      titleKey: $('#f_json_title').value.trim(),
      slsKey: $('#f_json_sls').value.trim(),
      startKey: $('#f_json_start').value.trim() || null,
      durationKey: $('#f_json_duration').value.trim() || null,
      trackMaxMin: Math.max(0, Math.min(60, Math.round(Number($('#f_json_trackmax').value)))) || 0,
      logoEverySec: $('#f_json_logoevery').value === '' ? 40 : Math.max(0, Math.min(3600, Math.round(Number($('#f_json_logoevery').value)))) || 0,
      dlsIncluded: true,
      defaultDlsAllowed: $('#f_json_default_dls').value === 'yes'
    },
    dlplus: {
      enabled: $('#f_dlplus_enabled').value !== 'no'
    }
  };
}

// Metadata 'Validate': saves only the metadata (no encoder restart, applied at the next
// metadata tick ≤ 1 s) and keeps the dialog open so the result shows in "On air now"
$('#btnMetaApply')?.addEventListener('click', async (e) => {
  if (!editingId) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await api(`/api/services/${editingId}`, { method: 'PATCH', body: JSON.stringify(metaPayload()) });
    snapshotSvcForm(META_FIELD_IDS);   // these are saved now: no 'unsaved changes' prompt for them
    await refresh();
    btn.textContent = '✓ Applied';
  } catch (err) {
    btn.textContent = 'Error';
    alert(err.message || String(err));
  }
  setTimeout(() => { btn.textContent = 'Validate'; btn.disabled = false; }, 1500);
});

$('#svcForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showServiceError('');
  const requiredFields = [];
  if (!$('#f_ps8').value.trim()) requiredFields.push('PS8');
  if (!$('#f_pi').value.trim()) requiredFields.push('PI');
  if (!$('#f_lang').value.trim()) requiredFields.push('Language');
  if (requiredFields.length) {
    showServiceError(`Required fields: ${requiredFields.join(', ')}`);
    return;
  }

  const { errors, normalizedPi } = validateServiceForm();
  if (errors.length) {
    showServiceError(errors.join(' '));
    return;
  }

  const payload = {
    identity: {
      pi: normalizedPi || undefined,
      ps8: $('#f_ps8').value.trim(),
      ps16: $('#f_ps16').value.trim() || null,
      pty: Number($('#f_pty').value || 10),
      languageHex: $('#f_lang').value.trim() || undefined
    },
    dab: {
      bitrateKbps: Number($('#f_bitrate').value),
      protectionLevel: Number($('#f_prot').value || 3),
      eepMode: 'A',
      padSize: Number($('#f_padsize').value || 58)
    },
    input: {
      mode: $('#f_src').value,
      uri: $('#f_uri').value.trim() || null,
      backupUri: $('#f_backup').value.trim() || null
      ,
      encoderBufferMs: Number($('#f_encbuf').value || 200),
      zmqBuffer: Number($('#f_zbuf').value || 40),
      zmqPrebuffering: Number($('#f_zpre').value || 20)
    },
    audio: {
      gainDb: Number($('#f_gain').value || 0),
      sampleRateHz: Number($('#f_sr').value || 48000),
      channels: Number($('#f_ch').value || 2),
      codec: $('#f_codec').value
    },
    watchdog: {
      enabled: true,
      silenceThresholdSec: Number($('#f_thresh').value || 10),
      switchToBackupOnSilence: $('#f_switch').value === '1',
      returnToMainAfterSec: Number($('#f_return').value || 60)
    },
    ...metaPayload()
  };

  // ZMQ/EDI direct: input port chosen by the user (empty on a new service = automatic)
  if (['ZMQ', 'EDI'].includes($('#f_src').value)) {
    const rawPort = String($('#f_direct_port').value || '').trim();
    if (rawPort) {
      const port = Number(rawPort);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        showServiceError('Input port must be a number between 1024 and 65535.');
        return;
      }
      const other = STATE.preset.services.find((s) => s.id !== editingId && s.network?.ediOutputTcp?.port === port);
      if (other) {
        showServiceError(`Port ${port} is already used by ${other.identity?.ps8 || other.id}.`);
        return;
      }
      payload.network = { ediOutputTcp: { port } };
    }
  }

  const needMuxRestart = Boolean(editingId && restartFieldsChanged());
  if (needMuxRestart) {
    // Refuse before stopping anything if the new bitrate/protection would not fit (Start would fail)
    const cur = STATE.preset.services.find((s) => s.id === editingId);
    const cap = STATE.preset.capacity || { totalCu: 0, maxCu: 864 };
    const newTotal = cap.totalCu + (cur?.enabled ? estimateCu(payload.dab.bitrateKbps, payload.dab.protectionLevel, payload.dab.eepMode) - (cur.cu ?? 0) : 0);
    if (newTotal > cap.maxCu) {
      showServiceError(`Capacity exceeded: ${newTotal}/${cap.maxCu} CU — the multiplex could not restart.`);
      return;
    }
    if (!confirm('These changes require restarting the multiplex.\nALL services go off air for a few seconds.\n\nApply and restart now?')) return;
  }

  try {
    if (needMuxRestart) {
      await api('/api/mux/stop', { method: 'POST', body: '{}' });
      let saveErr = null;
      try {
        await api(`/api/services/${editingId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } catch (err) { saveErr = err; }
      if (!saveErr) dlg.close();
      try {
        await api('/api/mux/start', { method: 'POST', body: '{}' });
      } catch (err) {
        await refresh();
        throw new Error(`Multiplex restart FAILED — press Start: ${err.message || err}${saveErr ? ` (changes not saved: ${saveErr.message})` : ''}`);
      }
      if (saveErr) {
        await refresh();
        throw new Error(`Changes not saved, multiplex restarted with the previous settings: ${saveErr.message || saveErr}`);
      }
    } else if (editingId) {
      await api(`/api/services/${editingId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      const created = await api('/api/services', { method: 'POST', body: JSON.stringify(payload) });
      if (created?.enabled === false) {   // added while ON AIR
        showToast(`${payload.identity?.ps8 || 'Service'} added OFF — press ON to put it on air`, 'success');
      }
    }
    dlg.close();
    await refresh();
  } catch (err) {
    alert(err.message || String(err));
  }
});

$('#btnExportConfig')?.addEventListener('click', async () => {
  try {
    const payload = await api('/api/export/full');
    const defaultName = configExportBaseName(payload);
    const fileName = prompt('Configuration file name:', defaultName);
    if (!fileName) return; // User cancelled
    const sanitized = fileName.trim().replace(/\.json$/i, ''); // Remove .json if present
    downloadJson(`${sanitized}.json`, payload);
  } catch (err) {
    alert(err.message || String(err));
  }
});

$('#btnImportAll')?.addEventListener('click', () => {
  fileImportAll?.click();
});

$('#btnExportService')?.addEventListener('click', async () => {
  try {
    if (!selectedServiceId) {
      alert('Please select a service from the list by clicking on a row.');
      return;
    }
    await exportService(selectedServiceId);
  } catch (err) {
    alert(err.message || String(err));
  }
});

$('#btnImportService')?.addEventListener('click', () => {
  fileImportService?.click();
});

$('#btnExportAllServices')?.addEventListener('click', async () => {
  try {
    // Download ZIP file directly from endpoint
    const link = document.createElement('a');
    link.href = '/api/export/all-services';
    link.download = `all-services-${configExportBaseName({ settings: STATE?.settings, preset: STATE?.preset })}.zip`;   // e.g. all-services-DABcast_WebUI.zip
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (err) {
    alert(err.message || String(err));
  }
});

fileImportAll?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    await importAllConfig(file);
  } catch (err) {
    alert(err.message || String(err));
  } finally {
    e.target.value = '';
  }
});

fileImportService?.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;

  let imported = 0;
  let failed = 0;
  const errors = [];
  const portNotes = [];

  for (const file of files) {
    try {
      const note = await importService(file);
      if (note) portNotes.push(note);
      imported++;
    } catch (err) {
      failed++;
      errors.push(`${file.name}: ${err.message || String(err)}`);
    }
  }

  e.target.value = '';

  // Show summary
  const offNote = (STATE?.muxRunning && imported ? '\n\nON AIR: imported services are OFF — press ON to put them on air.' : '')
    + (portNotes.length ? `\n\nInput port already used, a free one was assigned:\n${portNotes.join('\n')}` : '');
  if (failed === 0) {
    alert(`✓ ${imported} service(s) imported successfully!${offNote}`);
  } else if (imported === 0) {
    alert(`✗ Import failed:\n\n${errors.join('\n')}`);
  } else {
    alert(`Import completed:\n✓ ${imported} service(s) imported\n✗ ${failed} failed\n\n${errors.join('\n')}${offNote}`);
  }
});

// periodic refresh for live status
refresh();
let refreshTimer = setInterval(refresh, 2500);

// Update check: once at startup (after first state load), then every hour
setTimeout(checkForUpdate, 5000);
setInterval(checkForUpdate, 3600000);

// mux form
$('#muxForm').addEventListener('input', updateMuxRestartWarn);
$('#muxForm').addEventListener('change', updateMuxRestartWarn);
$('#muxForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const ok = await saveMuxSettings();
    if (ok !== false) dlgMux.close();
  } catch (err) {
    alert(err.message || String(err));
  }
});

// ═══════════════════════════════════════════════
// ═══════════════════════════════════════════════


// Drop-down lists of the dialogs (mouse only): browsers keep the native list inside the page, so a
// long list (bitrate, PTY, language) with no room above nor below is drawn over the field itself
// and the button release picks whatever option is under the cursor. Our own list is always placed
// beside the field (scrolls when needed); the <select> stays the source of truth (value, keyboard,
// change events). Touch keeps the native picker.
let _selPop = null;
let _lastPointer = 'mouse';
document.addEventListener('pointerdown', (e) => { _lastPointer = e.pointerType; }, true);
function closeSelPop() { _selPop?.el.remove(); _selPop = null; }
document.addEventListener('mousedown', (e) => {
  if (_selPop && !_selPop.el.contains(e.target)) { const same = e.target === _selPop.sel; closeSelPop(); if (same) { e.preventDefault(); return; } }
  const sel = e.target;
  if (e.button !== 0 || _lastPointer !== 'mouse' || sel.tagName !== 'SELECT' || sel.multiple || sel.disabled) return;
  const host = sel.closest('dialog');
  if (!host) return;
  e.preventDefault();
  sel.focus();
  const el = document.createElement('div');
  el.className = 'sel-pop';
  for (const node of sel.children) {
    const opts = node.tagName === 'OPTGROUP' ? [...node.children] : [node];
    if (node.tagName === 'OPTGROUP') { const g = document.createElement('div'); g.className = 'sel-pop-group'; g.textContent = node.label; el.appendChild(g); }
    for (const o of opts) {
      if (o.hidden || o.style.display === 'none') continue;
      const it = document.createElement('div');
      it.className = 'sel-pop-item' + (o.selected ? ' selected' : '') + (o.disabled ? ' disabled' : '');
      it.textContent = o.textContent;
      if (!o.disabled) it.addEventListener('click', () => {
        closeSelPop();
        if (sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      el.appendChild(it);
    }
  }
  host.appendChild(el);
  const r = sel.getBoundingClientRect();
  const below = innerHeight - r.bottom - 8, above = r.top - 8;
  const down = below >= Math.min(el.scrollHeight, 240) || below >= above;
  el.style.left = `${Math.max(4, Math.min(r.left, innerWidth - Math.max(r.width, el.offsetWidth) - 4))}px`;
  el.style.minWidth = `${r.width}px`;
  el.style.maxHeight = `${Math.max(120, down ? below : above)}px`;
  el.style.top = down ? `${r.bottom + 2}px` : `${Math.max(4, r.top - 2 - el.offsetHeight)}px`;
  el.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  _selPop = { el, sel };
}, true);
document.addEventListener('keydown', (e) => { if (_selPop) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } closeSelPop(); } }, true);
document.addEventListener('scroll', (e) => { if (_selPop && !_selPop.el.contains(e.target)) closeSelPop(); }, true);
addEventListener('resize', closeSelPop);
document.addEventListener('close', closeSelPop, true);
