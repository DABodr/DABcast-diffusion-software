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
const BUF_GLITCH_WINDOW_MS = 60000;
const BUF_STATES = {
  Streaming: ['ok', 'BUF OK'], Unstable: ['warn', 'UNSTABLE'], Silence: ['warn', 'SILENCE'], NoData: ['err', 'NO DATA'],
};
function bufTag(inp, always = false) {
  if (!inp) return '';
  let [cls, label] = BUF_STATES[inp.state] || ['', String(inp.state || '?').toUpperCase()];
  // dabmux keeps "Unstable" long after old glitches (e.g. start-up prebuffering): only warn on recent ones
  if (inp.state === 'Unstable' && !inp.recentGlitch) cls = '';
  if (!always && !label) return '';
  const d = inp.underrunsDelta > 0 ? ` (+${inp.underrunsDelta})` : '';
  const note = inp.state === 'Unstable' && !inp.recentGlitch ? ' (past glitches, no new underruns in the last minute)' : '';
  const tip = `Mux input: ${inp.state}${note} · fill ${inp.minFill}–${inp.maxFill} · underruns ${inp.underruns}${d} · overruns ${inp.overruns} · peak ${inp.peakLeft}/${inp.peakRight} dBFS`;
  return `<span class="buf-tag ${cls}" title="${esc(tip)}">${label}${d ? ' ▲' : ''}</span>`;
}
function maybeFetchMuxStats() {
  if (!STATE?.muxRunning) { MUX_STATS = null; return; }
  if (Date.now() - _muxStatsAt < 5000) return;
  _muxStatsAt = Date.now();
  api('/api/mux/stats').then((st) => {
    const prev = MUX_STATS?.inputs || {};
    for (const [id, inp] of Object.entries(st.inputs || {})) {
      if (prev[id] && Number.isFinite(inp.underruns)) inp.underrunsDelta = inp.underruns - prev[id].underruns;
      if (inp.underrunsDelta > 0) _bufLastGlitchAt.set(id, Date.now());
      inp.recentGlitch = Date.now() - (_bufLastGlitchAt.get(id) || 0) < BUF_GLITCH_WINDOW_MS;
    }
    MUX_STATS = st;
    render();
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
}

function updateSourceVisibility() {
  const mode = $('#f_src')?.value;
  const isDirect = mode === 'ZMQ' || mode === 'EDI';
  const encoderRowIds = ['f_gain_row', 'f_uri_row', 'f_thresh_row', 'f_return_row', 'f_switch_row', 'f_backup_row', 'f_swap_row'];
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

function streamDot(isActive, hasUri, isOnAir, isWarn = false) {
  if (!hasUri) return '';
  const cls = isActive ? (isWarn ? 'dot warn' : 'dot ok') : (isOnAir ? 'dot err' : 'dot');
  const title = isActive ? (isWarn ? 'Instable' : 'En lecture') : (isOnAir ? 'Hors ligne' : 'En attente');
  return `<span class="${cls}" title="${title}"></span>`;
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
function renderStats(cap) {
  const el = $('#statsRow');
  if (!el) return;
  const all = STATE.preset.services || [];
  const enabled = all.filter((s) => s.enabled);
  const st = (s) => String(s.runtime?.status || 'UNKNOWN').toUpperCase();
  const running = enabled.filter((s) => st(s) === 'RUNNING').length;
  const warn = enabled.filter((s) => st(s) === 'WARNING').length;
  const err = STATE.muxRunning ? enabled.filter((s) => st(s) === 'ERROR' || st(s) === 'RESTARTING').length : 0;
  const dls = STATE.muxRunning ? enabled.filter((s) => s.runtime?.currentDls).length : 0;
  const sls = STATE.muxRunning ? enabled.filter((s) => s.runtime?.currentSlsUrl).length : 0;
  const ratio = cap.maxCu ? cap.totalCu / cap.maxCu : 0;
  const capCls = ratio < 0.8 ? 'cap-ok' : ratio <= 1.0 ? 'cap-warn' : 'cap-bad';
  const ens = STATE.settings.ensemble || {};
  const tx = STATE.settings.dabmux?.txMode || 'EASYDAB';
  const block = STATE.settings.dabmux?.hackrf?.dabBlock || '7A';
  const muxSub = tx === 'HACKRF'
    ? `${esc(block)} · ${((DAB_FREQ_TABLE[block] || 0) / 1e6).toFixed(3)} MHz`
    : `TX: ${esc(tx)}`;
  const bufInputs = STATE.muxRunning && MUX_STATS?.inputs ? Object.values(MUX_STATS.inputs) : [];
  const bufOk = bufInputs.filter((i) => i.state === 'Streaming').length;
  const bufBad = bufInputs.filter((i) => i.state === 'NoData' || i.state === 'Silence').length;
  const bufUnstable = bufInputs.filter((i) => i.state === 'Unstable' && i.recentGlitch).length;
  const alarms = warn + err + bufBad;
  const card = (title, val, sub, valCls = '') =>
    `<div class="stat-card"><div class="stat-title">${title}</div><div class="stat-val ${valCls}">${val}</div><div class="stat-sub">${sub}</div></div>`;
  const html = [
    card('Ensemble', esc(ens.label || '—'), `${esc(ens.idHex || '')} · ${muxSub}`, 'stat-val-sm'),
    card('Capacity', `${cap.totalCu} / ${cap.maxCu} CU`,
      `<div class="stat-bar"><div class="stat-bar-fill ${capCls}" style="width:${Math.min(ratio * 100, 100).toFixed(0)}%"></div></div>${Math.round(ratio * 100)} %`, capCls),
    card('Services', `${enabled.length}`, `enabled / ${all.length}`),
    card('Encoders', STATE.muxRunning ? `${running}` : '—', STATE.muxRunning ? `running / ${enabled.length}` : 'off air', STATE.muxRunning && running === enabled.length ? 'cap-ok' : ''),
    card('Mux inputs', bufInputs.length ? `${bufOk} / ${bufInputs.length}` : '—',
      bufInputs.length ? `streaming · ${bufUnstable} glitching · ${bufBad} no audio` : (STATE.muxRunning ? (MUX_STATS?.error ? 'stats unavailable' : 'loading…') : 'off air'),
      bufInputs.length ? (bufBad ? 'cap-bad' : bufUnstable ? 'cap-warn' : 'cap-ok') : ''),
    card('Metadata', STATE.muxRunning ? `${dls} · ${sls}` : '—', 'DLS · SLS active'),
    card('Alarms', `${alarms}`, alarms ? `${warn} warning · ${err} error · ${bufBad} mux input` : 'none', alarms ? (err ? 'cap-bad' : 'cap-warn') : 'cap-ok'),
  ].join('');
  if (el._last !== html) { el.innerHTML = html; el._last = html; }
}

function render() {
  if (!STATE) return;

  // Password change banner + lock UI
  const pwdBanner = $('#pwdBanner');
  const locked_pwd = !!STATE.mustChangePassword;
  if (pwdBanner) {
    pwdBanner.classList.toggle('hidden', !locked_pwd);
  }

  const lockableButtons = ['btnStop','btnAdd','btnMux','btnLogs','btnTelegram',
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
    startBtn.disabled = on || exceeded || locked_pwd;
    if (locked_pwd) startBtn.title = 'Change password first';
    else if (exceeded) startBtn.title = 'CU capacity exceeded';
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
    svcTableBody.innerHTML = `<tr><td class="muted" colspan="17">No service found.</td></tr>`;
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

    const status = svc.runtime?.status || 'UNKNOWN';
    const dlsPreview = svc.runtime?.currentDls || (svc.metadata?.defaultDlsAllowed !== false ? (svc.metadata?.defaultDls || '') : '');
    const trackKey = dlsPreview || '';
    const svcKey = encodeURIComponent(svc.pad?.fifoName || svc.id);
    const backupUri = svc.input?.backupUri || '';
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
      ['', badge(status) + (STATE.muxRunning ? bufTag(MUX_STATS?.inputs?.[svc.id]) : '')],
      ['', `<div class="ps"${ps8Title ? ` title="${esc(ps8Title)}"` : ''}>${esc(ps8)}</div><div class="muted">${esc(ps16)}</div>`],
      ['col-pid hide-mobile', esc(svc.id)],
      ['col-bitrate', `${svc.dab.bitrateKbps} kbps`],
      ['col-cu', `${svc.cu ?? ''}`],
      ['col-prot', esc(String(svc.dab.protectionLevel ?? 3))],
      ['col-codec', esc(svc.audio?.codec || 'HE-AAC v1')],
      ['col-ch', (svc.audio?.channels ?? 2) === 1 ? 'Mono' : 'Stereo'],
      ['col-sr', `${esc(String((svc.audio?.sampleRateHz ?? 48000) / 1000))} kHz`],
      ['col-port', `${svc.network.ediOutputTcp.port}`],
      ['col-main', streamDot(activeIsMain, Boolean(svc.input?.uri), on, isWarning && activeIsMain)],
      ['col-bkp', streamDot(activeIsBackup, Boolean(backupUri), false, isWarning && activeIsBackup)],
      ['', vuMeter(STATE.muxRunning ? svc.runtime?.audioLevels : null)],
      ['muted', esc(dlsPreview)],
      ['col-dlplus', svc.runtime?.dlplusActive ? '<span class="dlplus-icon" title="DL+ active">DL+</span>' : ''],
      ['muted sls-cell', ''],  // placeholder — image handled separately
      ['row-actions col-actions', `<button class="btn btn-mini" data-act="edit" data-id="${svc.id}">Edit</button><button class="btn btn-mini" data-act="del" data-id="${svc.id}">Del</button>`],
    ];

    const SLS_COL = 15;

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
    _refreshSlideList(svc.id, svcKey, trackKey);

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

  // lock delete while on air
  document.querySelectorAll('[data-act="del"]').forEach((b) => {
    b.disabled = STATE.muxRunning;
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
async function _refreshSlideList(svcId, svcKey, trackKey, force = false) {
  let rot = slideRotation.get(svcId);
  if (!force && rot && rot.key === trackKey) return; // already up-to-date
  try {
    const files = await api(`/api/mot/${svcKey}/slides`);
    if (!Array.isArray(files)) return;
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
  const trackKey = dlsPreview || '';
  await _refreshSlideList(svcId, svcKey, trackKey, true);
}

/** Preload and display current slide for a service */
function _showSlide(svcId) {
  const rot = slideRotation.get(svcId);
  if (!rot || !rot.files.length) return;
  const tr = svcTableBody.querySelector(`tr[data-service-id="${svcId}"]`);
  if (!tr) return;
  const td = tr.children[15];
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
  $('#dlgLockHint').textContent = locked ? 'ON AIR: identity/bitrate/protection locked' : '';

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
  } else if (!locked) {
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
  $('#f_sls_url').value = service?.metadata?.slsUrl || '';

  // JSON mode fields
  $('#f_json_url').value = service?.metadata?.url || '';
  $('#f_json_interval').value = service?.metadata?.intervalSec ?? 10;
  $('#f_json_artist').value = service?.metadata?.artistKey || 'artist';
  $('#f_json_title').value = service?.metadata?.titleKey || 'title';
  $('#f_json_sls').value = service?.metadata?.slsKey || 'slide';
  $('#f_dlplus_enabled').value = service?.dlplus?.enabled !== false ? 'yes' : 'no';
  $('#f_json_default_dls').value = service?.metadata?.defaultDlsAllowed !== false ? 'yes' : 'no';
  $('#jsonTestStatus').textContent = '';
  const cpb = $('#coverPreviewBox'); if (cpb) cpb.style.display = 'none';
  updateMetaModeVisibility();

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

  // lock fields when ON AIR (identity + dab + audio encoding params)
  ['f_pi','f_ps8','f_ps16','f_bitrate','f_prot','f_sr','f_zbuf','f_zpre','f_codec','f_lang','f_pty','f_ch','f_padsize'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = locked;
  });

  // reset tabs
  setActiveTab('general');

  dlg.showModal();
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

async function exportAllConfig() {
  const payload = await api('/api/export/full');
  // File named after the ensemble (mux) label; falls back to the preset id
  const label = String(payload?.settings?.ensemble?.label || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  const name = label || (payload?.preset?.id ? payload.preset.id.replace(/\s+/g, '_') : 'dabcast');
  downloadJson(`dabcast_config_${name}.json`, payload);
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

  if (serviceId && STATE.preset.services.some(s => s.id === serviceId)) {
    const overwrite = confirm(`Service "${serviceName}" already exists. Do you want to overwrite it?`);
    if (!overwrite) {
      throw new Error('Import cancelled');
    }

    // Delete existing service first
    await api(`/api/services/${serviceId}`, { method: 'DELETE' });
  }

  await api('/api/import/service', { method: 'POST', body: JSON.stringify(payload) });
  await refresh();
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

function openMuxDialog() {
  const locked = STATE.muxRunning;
  $('#muxLockHint').textContent = locked ? 'ON AIR: some fields are locked' : '';
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

  // lock key fields when ON AIR
  ['m_ens_id','m_ecc','m_label','m_short','m_txmode','m_easydab_ip','m_easydab_port','m_edi_port','m_edi_pft','m_edi_fec','m_edi_tist_offset','m_mgmt','m_telnet',
   'm_hackrf_block','m_hackrf_txgain','m_hackrf_maxframes','m_hackrf_gainmode','m_hackrf_diggain','m_hackrf_rate'
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = locked;
  });

  updateTxModeVisibility();
  dlgMux.showModal();
}

function updateTxModeVisibility() {
  const mode = ($('#m_txmode')?.value || 'EASYDAB').toUpperCase();
  document.querySelectorAll('.easydab-only').forEach((el) => el.classList.toggle('hidden', mode !== 'EASYDAB'));
  document.querySelectorAll('.edi-only').forEach((el) => el.classList.toggle('hidden', mode !== 'EDI'));
  document.querySelectorAll('.usrp1-only').forEach((el) => el.classList.toggle('hidden', mode !== 'USRP1'));
  document.querySelectorAll('.hackrf-only').forEach((el) => el.classList.toggle('hidden', mode !== 'HACKRF'));
}

function updateMetaModeVisibility() {
  const mode = ($('#f_meta_mode')?.value || 'STREAM').toUpperCase();
  document.querySelectorAll('.json-only').forEach((el) => el.classList.toggle('hidden', mode !== 'JSON'));
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
  await api('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) });
  await refresh();
}

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
}

$('#btnAuth').addEventListener('click', showAuth);
$('#btnPwdBanner')?.addEventListener('click', showAuth);

$('#dlgAuth').querySelector('[data-action="auth-cancel"]').addEventListener('click', () => {
  $('#dlgAuth').close();
});

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

$('#btnLogout')?.addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } finally {
    window.location.replace('/login.html');
  }
});

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
$('#btnCompact')?.classList.toggle('active', VIEW.compact);
$('#btnCompact')?.addEventListener('click', (e) => { VIEW.compact = !VIEW.compact; e.currentTarget.classList.toggle('active', VIEW.compact); saveView(); render(); });

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
  } else if (!STATE?.muxRunning) {
    chSel.disabled = false;
  }
});

$('#m_txmode')?.addEventListener('change', updateTxModeVisibility);
$('#f_meta_mode')?.addEventListener('change', updateMetaModeVisibility);

document.querySelectorAll('[data-action="svc-cancel"]').forEach((btn) => {
  btn.addEventListener('click', () => dlg.close());
});
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

$('#btnTestJson')?.addEventListener('click', async () => {
  const statusEl = $('#jsonTestStatus');
  const url = $('#f_json_url').value.trim();
  if (!url) { if (statusEl) statusEl.textContent = 'URL manquante'; return; }
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
      if (res.artist) parts.push(`Artist: ${res.artist}`);
      if (res.title) parts.push(`Title: ${res.title}`);
      if (res.coverUrl) parts.push('Cover: OK');
      statusEl.textContent = parts.length ? parts.join(' | ') : 'OK (empty)';
    } else {
      statusEl.textContent = res?.error || 'Failed';
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Error';
    alert(err.message || String(err));
  }
});

$('#btnTestCover')?.addEventListener('click', async () => {
  const statusEl = $('#jsonTestStatus');
  const previewBox = $('#coverPreviewBox');
  const previewImg = $('#coverPreviewImg');
  const previewInfo = $('#coverPreviewInfo');
  if (previewBox) previewBox.style.display = 'none';

  // Step 1: get cover URL from JSON
  const url = $('#f_json_url').value.trim();
  if (!url) { if (statusEl) statusEl.textContent = 'JSON URL manquante'; return; }
  if (statusEl) statusEl.textContent = 'Fetching JSON...';
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
      if (statusEl) statusEl.textContent = jsonRes?.coverUrl ? 'Error' : 'No cover URL in JSON';
      return;
    }
    // Step 2: test cover download via backend proxy
    if (statusEl) statusEl.textContent = 'Downloading cover...';
    const slsRes = await api('/api/metadata/test/sls', {
      method: 'POST',
      body: JSON.stringify({ url: jsonRes.coverUrl })
    });
    if (slsRes?.ok && slsRes.dataUrl) {
      const kb = slsRes.bytes ? `${Math.round(slsRes.bytes / 1024)} KB` : '';
      if (statusEl) statusEl.textContent = `Cover OK ${kb} (${slsRes.contentType || 'image'})`;
      if (previewImg) previewImg.src = slsRes.dataUrl;
      if (previewBox) previewBox.style.display = 'flex';
      if (previewInfo) previewInfo.textContent = `${jsonRes.coverUrl.slice(0, 60)}...`;
    } else {
      if (statusEl) statusEl.textContent = `Cover FAIL: ${slsRes?.error || 'download error'}`;
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Error';
    alert(err.message || String(err));
  }
});

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
    if (act === 'del') {
      if (STATE.muxRunning) return;
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
    metadata: {
      mode: $('#f_meta_mode').value,
      defaultDls: $('#f_default_dls').value.trim() || null,
      slsUrl: $('#f_sls_url').value.trim() || null,
      url: $('#f_json_url').value.trim() || null,
      intervalSec: Number($('#f_json_interval').value || 10),
      artistKey: $('#f_json_artist').value.trim() || 'artist',
      titleKey: $('#f_json_title').value.trim() || 'title',
      slsKey: $('#f_json_sls').value.trim() || 'slide',
      dlsIncluded: true,
      defaultDlsAllowed: $('#f_json_default_dls').value === 'yes'
    },
    dlplus: {
      enabled: $('#f_dlplus_enabled').value !== 'no'
    }
  };

  try {
    if (editingId) {
      await api(`/api/services/${editingId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      await api('/api/services', { method: 'POST', body: JSON.stringify(payload) });
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
    const defaultName = payload?.preset?.id ? payload.preset.id.replace(/\s+/g, '_') : 'dabcast';
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
    link.download = 'all-services.zip';
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

  for (const file of files) {
    try {
      await importService(file);
      imported++;
    } catch (err) {
      failed++;
      errors.push(`${file.name}: ${err.message || String(err)}`);
    }
  }

  e.target.value = '';

  // Show summary
  if (failed === 0) {
    alert(`✓ ${imported} service(s) imported successfully!`);
  } else if (imported === 0) {
    alert(`✗ Import failed:\n\n${errors.join('\n')}`);
  } else {
    alert(`Import completed:\n✓ ${imported} service(s) imported\n✗ ${failed} failed\n\n${errors.join('\n')}`);
  }
});

// periodic refresh for live status
refresh();
let refreshTimer = setInterval(refresh, 2500);

// Update check: once at startup (after first state load), then every hour
setTimeout(checkForUpdate, 5000);
setInterval(checkForUpdate, 3600000);

// mux form
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

