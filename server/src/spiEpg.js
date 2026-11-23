// SPI programme guide (EPG): where the programmes of each service come from, and the PI documents of
// the carousel (one per service and per day, today + EPG_DAYS - 1).
//
// Sources, per service (data/spi/epg.json, keyed by service id, outside the preset):
//   grid   — weekly grid typed in the page: [{ days: [1..7] (1 = Monday), start: 'HH:MM', end: 'HH:MM', title, description }]
//   xmltv  — XMLTV file on the web (.xml or .xml.gz) + channel id
//   spixml — SPI / RadioDNS programme information XML (ETSI TS 102 818), URL with {date} = YYYYMMDD for one file per day
// Fetched guides are cached in data/spi/epg/<sid>.json (last good fetch kept on error), so the carousel
// is built from local files only (synchronous, at Start / on change / at midnight).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { writeJson } from './fsutil.js';

export const EPG_DAYS = 7;
export const EPG_SOURCES = ['none', 'grid', 'xmltv', 'spixml'];
const FETCH_TIMEOUT_MS = 20000;
const FETCH_MAX_BYTES = 40 * 1024 * 1024;
const MAX_PER_DAY = 200;

export const epgConfigFile = (dataDir) => path.join(dataDir, 'spi', 'epg.json');
export const epgCacheFile = (dataDir, sid) => path.join(dataDir, 'spi', 'epg', `${sid}.json`);

// ── configuration ──
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export function normalizeEpgEntry(e = {}) {
  const source = EPG_SOURCES.includes(e.source) ? e.source : 'none';
  const grid = (Array.isArray(e.grid) ? e.grid : []).map((r) => ({
    days: [...new Set((Array.isArray(r.days) ? r.days : []).map(Number).filter((d) => d >= 1 && d <= 7))].sort(),
    start: HHMM.test(r.start) ? r.start : '',
    end: HHMM.test(r.end) ? r.end : '',
    title: String(r.title || '').trim().slice(0, 128),
    description: String(r.description || '').trim().slice(0, 180),
  })).filter((r) => r.days.length && r.start && r.end && r.title).slice(0, 500);
  return { source, grid, url: String(e.url || '').trim().slice(0, 1000), channel: String(e.channel || '').trim().slice(0, 200) };
}
export function loadEpgConfig(dataDir) {
  try { return JSON.parse(fs.readFileSync(epgConfigFile(dataDir), 'utf8')) || {}; } catch { return {}; }
}
export function saveEpgEntry(dataDir, id, entry) {
  const all = loadEpgConfig(dataDir);
  all[id] = normalizeEpgEntry(entry);
  fs.mkdirSync(path.dirname(epgConfigFile(dataDir)), { recursive: true });
  writeJson(epgConfigFile(dataDir), all);
  return all[id];
}
export function readEpgCache(dataDir, sid) {
  try { return JSON.parse(fs.readFileSync(epgCacheFile(dataDir, sid), 'utf8')); } catch { return null; }
}

// ── weekly grid → programmes (local time of the server) ──
const localDayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
const at = (dayMs, hhmm) => { const [h, m] = hhmm.split(':').map(Number); const d = new Date(dayMs); d.setHours(h, m, 0, 0); return d.getTime(); };
export function expandGrid(grid, fromMs, days = EPG_DAYS) {
  const out = [];
  const first = localDayStart(fromMs);
  for (let i = 0; i < days; i++) {
    const day = addDays(first, i);
    const dow = ((new Date(day).getDay() + 6) % 7) + 1;   // 1 = Monday … 7 = Sunday
    for (const r of grid) {
      if (!r.days.includes(dow)) continue;
      const start = at(day, r.start);
      let end = at(day, r.end);
      if (end <= start) end = at(addDays(day, 1), r.end);   // 22:00–02:00: ends the next day
      out.push({ start, end, title: r.title, description: r.description || '' });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ── tiny XML reader (XMLTV / SPI XML: elements, attributes, text; no DTD) ──
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENT[e] ?? m;
});
export function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const el = { name: m[3].replace(/^.*:/, ''), attrs: {}, children: [], text: '' };   // namespace prefix dropped
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) el.attrs[a[1].replace(/^.*:/, '')] = unescape(a[2] ?? a[3]);
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6]) top.text += unescape(m[6]);
  }
  return root;
}
const kids = (el, name) => el.children.filter((c) => c.name === name);
const kid = (el, name) => el.children.find((c) => c.name === name);
const txt = (el) => (el ? el.text.replace(/\s+/g, ' ').trim() : '');

// XMLTV time: "20261123060000 +0100" (offset optional = UTC)
export function parseXmltvTime(s) {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?\s*([+-]\d{4})?/.exec(String(s || '').trim());
  if (!m) return NaN;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (!m[7]) return utc;
  const sign = m[7][0] === '-' ? -1 : 1;
  return utc - sign * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(3))) * 60000;
}
export function parseXmltv(text) {
  const tv = kid(parseXml(text), 'tv') || { children: [] };
  const channels = kids(tv, 'channel').map((c) => ({ id: c.attrs.id || '', name: txt(kid(c, 'display-name')) || c.attrs.id || '' })).filter((c) => c.id);
  const programmes = kids(tv, 'programme').map((p) => ({
    channel: p.attrs.channel || '', start: parseXmltvTime(p.attrs.start), end: parseXmltvTime(p.attrs.stop),
    title: txt(kid(p, 'title')), description: txt(kid(p, 'sub-title')) || txt(kid(p, 'desc')),
  })).filter((p) => p.title && Number.isFinite(p.start));
  return { channels, programmes };
}

// ISO 8601 duration "PT1H30M" → ms
export function parseIsoDuration(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s || '').trim());
  if (!m) return NaN;
  return ((+(m[1] || 0) * 24 + +(m[2] || 0)) * 60 + +(m[3] || 0)) * 60000 + +(m[4] || 0) * 1000;
}
// SPI / RadioDNS PI XML: <epg><schedule><programme><mediumName/><location><time time="" duration=""/></location>
export function parseSpiXml(text) {
  const out = [];
  const walk = (el) => {
    if (el.name === 'programme') {
      const name = txt(kid(el, 'longName')) || txt(kid(el, 'mediumName')) || txt(kid(el, 'shortName'));
      const short = txt(kid(el, 'shortName')), medium = txt(kid(el, 'mediumName'));   // the station's own short names
      const md = kids(el, 'mediaDescription').map((x) => txt(kid(x, 'shortDescription'))).find(Boolean)
        || kids(el, 'mediaDescription').map((x) => txt(kid(x, 'longDescription'))).find(Boolean) || '';
      for (const loc of kids(el, 'location')) {
        for (const t of kids(loc, 'time')) {
          const start = Date.parse(t.attrs.time || t.attrs.actualTime);
          const dur = parseIsoDuration(t.attrs.duration || t.attrs.actualDuration);
          if (name && Number.isFinite(start)) out.push({ start, end: Number.isFinite(dur) ? start + dur : NaN, title: name, description: md,
            ...(short && short.length <= 8 ? { short } : {}), ...(medium && medium.length <= 16 ? { medium } : {}) });
        }
      }
      return;
    }
    el.children.forEach(walk);
  };
  walk(parseXml(text));
  return out;
}

// End missing (XMLTV without stop, SPI without duration): until the next programme, at most 4 h
function fillEnds(list) {
  const s = list.filter((p) => Number.isFinite(p.start)).sort((a, b) => a.start - b.start);
  s.forEach((p, i) => {
    if (!Number.isFinite(p.end) || p.end <= p.start) p.end = Math.min(s[i + 1]?.start ?? Infinity, p.start + 4 * 3600000);
  });
  return s.filter((p) => p.end > p.start);
}

// cut on a word, with an ellipsis (descriptions are up to 180 characters in DAB)
const clip = (t, n) => (t.length <= n ? t : `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…`);

// ── fetching ──
export async function fetchBuffer(url, { fetchImpl = fetch, maxBytes = FETCH_MAX_BYTES } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': 'DABcast EPG' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > maxBytes) throw new Error(`file too large (${Math.round(len / 1048576)} MB)`);
  let buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('file too large');
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, { maxOutputLength: maxBytes * 4 });
  return buf;
}
export async function fetchText(url, opts) {
  return (await fetchBuffer(url, opts)).toString('utf8');
}
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };

// Channels of an XMLTV file (for the channel list of the page)
export async function xmltvChannels(url, opts) {
  const { channels, programmes } = parseXmltv(await fetchText(url, opts));
  const count = new Map();
  for (const p of programmes) count.set(p.channel, (count.get(p.channel) || 0) + 1);
  return channels.map((c) => ({ ...c, programmes: count.get(c.id) || 0 }));
}

// Fetches the guide of one service → { programmes } (throws on error). now = reference time.
export async function fetchEpg(entry, { now = Date.now(), fetchImpl } = {}) {
  const from = localDayStart(now), to = addDays(from, EPG_DAYS);
  let list = [];
  if (entry.source === 'xmltv') {
    if (!entry.channel) throw new Error('no XMLTV channel chosen');
    const { programmes } = parseXmltv(await fetchText(entry.url, { fetchImpl }));
    list = programmes.filter((p) => p.channel === entry.channel);
    if (!list.length) throw new Error(`no programme for channel "${entry.channel}" in this file`);
  } else if (entry.source === 'spixml') {
    if (!entry.url.includes('{date}')) list = parseSpiXml(await fetchText(entry.url, { fetchImpl }));
    else {
      const errors = [];
      for (let i = 0; i < EPG_DAYS; i++) {
        try { list.push(...parseSpiXml(await fetchText(entry.url.replaceAll('{date}', ymd(addDays(from, i))), { fetchImpl }))); } catch (e) { errors.push(`${ymd(addDays(from, i))}: ${e.message}`); }
      }
      if (!list.length) throw new Error(errors[0] || 'no programme');
    }
    if (!list.length) throw new Error('no programme in this file');
  } else throw new Error('nothing to fetch for this source');
  list = fillEnds(list).filter((p) => p.end > from && p.start < to);
  if (!list.length) throw new Error(`no programme between today and the next ${EPG_DAYS} days`);
  return { programmes: list.map((p) => ({ start: p.start, end: p.end, title: p.title.slice(0, 128), description: clip(p.description || '', 180),
    ...(p.short ? { short: p.short } : {}), ...(p.medium ? { medium: p.medium } : {}) })) };
}

// Fetches and caches the guide of one service. Keeps the previous programmes on error.
export async function refreshEpgCache(dataDir, sid, entry, opts = {}) {
  const prev = readEpgCache(dataDir, sid);
  const base = { source: entry.source, url: entry.url, channel: entry.channel, at: Date.now() };
  let out;
  try {
    out = { ...base, ok: true, ...(await fetchEpg(entry, opts)) };
  } catch (e) {
    const same = prev && prev.source === entry.source && prev.url === entry.url && prev.channel === entry.channel;
    out = { ...base, ok: false, error: String(e.message || e), programmes: same ? prev.programmes || [] : [] };
  }
  fs.mkdirSync(path.dirname(epgCacheFile(dataDir, sid)), { recursive: true });
  writeJson(epgCacheFile(dataDir, sid), out);
  return out;
}

// Programmes of one service from now on, by source (grid typed, or the cached guide)
export function epgProgrammes(dataDir, sid, entry, now = Date.now()) {
  const e = normalizeEpgEntry(entry);
  if (e.source === 'grid') return expandGrid(e.grid, now);
  if (e.source === 'xmltv' || e.source === 'spixml') {
    const c = readEpgCache(dataDir, sid);
    if (!c || c.source !== e.source || c.url !== e.url || c.channel !== e.channel) return [];
    const from = localDayStart(now);
    return (c.programmes || []).filter((p) => p.end > from);
  }
  return [];
}

// Short CRID (24 bits, never 0) stable for the same programme
const shortId = (s) => { let h = 0x811c9dc5; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return (h % 0xffffff) + 1; };
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 12);

// PI documents for the carousel: [{ sid (number), created, start, end, programmes }] — one per day with programmes
export function epgSchedules(sidHex, programmes, now = Date.now()) {
  const first = localDayStart(now);
  const created = Math.floor(now / 60000) * 60000;
  const out = [];
  for (let i = 0; i < EPG_DAYS; i++) {
    const start = addDays(first, i), end = addDays(first, i + 1);
    const list = programmes.filter((p) => p.start >= start && p.start < end).slice(0, MAX_PER_DAY).map((p) => {
      const crid = `crid://dabcast/${sidHex}/${stamp(p.start)}`;
      return { crid, shortId: shortId(crid), start: p.start, end: p.end, title: p.title, description: p.description, short: p.short, medium: p.medium };
    });
    if (list.length) out.push({ sid: parseInt(sidHex, 16), created, start, end, programmes: list });
  }
  return out;
}
