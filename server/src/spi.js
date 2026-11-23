// SPI service logos (ETSI TS 102 818): every service gets PNG logos in the four DAB sizes, in one folder
// (data/spi/logos/<sid>-<w>x<h>.png, the naming read by the ODR SPI generators). Made from the
// service's slideshow logo (never a track cover) or from an uploaded picture: the picture is fitted
// in each size and centred on the colour of its own edges. When the SPI service is activated, the
// logos of the services ON are encoded into data/spi/spi.dat (spiCarousel.js), read in loop by
// odr-dabmux through the packet sub-channel that muxBuilder adds.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { imageCoder, parsePpm } from './slideImage.js';
import { encodeSpiCarousel } from './spiCarousel.js';
import { writeJson } from './fsutil.js';
import { loadEpgConfig, epgProgrammes, epgSchedules, parseXml, fetchBuffer, saveEpgEntry } from './spiEpg.js';

export const SPI_SIZES = [[320, 240], [128, 128], [112, 32], [32, 32]];
export const SPI_BITRATES = [8, 16, 24, 32];
export const DEFAULT_SPI = { enabled: false, bitrate: 16, protection: 3 };

export const spiLogosDir = (dataDir) => path.join(dataDir, 'spi', 'logos');
// Service ID of an audio service = its PI, lower case without 0x ("f9a3")
export const spiSid = (svc) => String(svc?.identity?.pi || svc?.id || '').replace(/^0x/i, '').toLowerCase();
export const spiFileName = (sid, w, h) => `${sid}-${w}x${h}.png`;
export const isSpiFileName = (name) => /^(?:[0-9a-f]{4,8}|ensemble)-\d{2,3}x\d{2,3}\.png$/.test(String(name));
// The multiplex (ensemble) logos: same folder and sizes, under this name (ensemble-320x240.png…)
export const SPI_ENSEMBLE = 'ensemble';

// Settings saved in settings.json (spi), with safe defaults
export function normalizeSpiSettings(s = {}) {
  const bitrate = SPI_BITRATES.includes(Number(s.bitrate)) ? Number(s.bitrate) : DEFAULT_SPI.bitrate;
  const protection = [1, 2, 3, 4].includes(Number(s.protection)) ? Number(s.protection) : DEFAULT_SPI.protection;
  return { enabled: s.enabled === true, bitrate, protection };
}

// Source picture of a service: its slideshow logo, never the cover. The original (before the 320x240
// conversion, no bands) is preferred; the "bands_" copies kept by the band repair are not originals.
export function spiSourceLogo(motDir) {
  const pick = (dir, ok) => {
    try {
      return fs.readdirSync(dir).filter((f) => /^logo(_\d+)?\.(jpe?g|png|webp)$/i.test(f) && ok(f)).sort()
        .map((f) => path.join(dir, f)).find((f) => imageCoder(f));
    } catch { return undefined; }
  };
  return pick(path.join(motDir, 'original'), () => true) || pick(path.join(motDir, 'slide'), () => true) || null;
}

// Average colour of the outer pixels → '#rrggbb' (the background of the logo)
function edgeColour(img) {
  let r = 0, g = 0, b = 0, n = 0;
  const add = (x, y) => { const o = img.offset + (y * img.w + x) * 3; r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; n++; };
  for (let x = 0; x < img.w; x++) { add(x, 0); add(x, img.h - 1); }
  for (let y = 1; y < img.h - 1; y++) { add(0, y); add(img.w - 1, y); }
  const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// Writes the four sizes of `sid` from `src` into `outDir` (temp files then rename). Returns the sizes written.
// 256-colour PNG (as the ODR SPI generators): half the weight of 24-bit PNG for the same look, so the
// SPI carousel turns twice as fast (all logos of a 19-service multiplex: ~500 kB instead of ~1 MB).
export function makeSpiLogos(src, outDir, sid, { exec = execFileSync, sizes = SPI_SIZES } = {}) {
  const coder = imageCoder(src);
  if (!coder) throw new Error('not a JPEG / PNG / GIF / WebP picture');
  const input = `${coder}:${src}[0]`;
  const img = parsePpm(exec('convert', [input, '-background', 'black', '-flatten', '-depth', '8', 'ppm:-'], { timeout: 10000, maxBuffer: 16 * 1024 * 1024 }));
  const bg = edgeColour(img);
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [w, h] of sizes) {
    const dest = path.join(outDir, spiFileName(sid, w, h));
    const tmp = path.join(outDir, `.tmp_${process.pid}_${w}x${h}.png`);
    try {
      exec('convert', [input, '-background', bg, '-flatten', '-resize', `${w}x${h}`, '-gravity', 'center',
        '-extent', `${w}x${h}`, '-strip', '-colors', '256', '-define', 'png:compression-level=9', `PNG8:${tmp}`], { timeout: 10000 });
      fs.renameSync(tmp, dest);
      written.push(`${w}x${h}`);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* moved */ }
    }
  }
  return written;
}

// ── Logos from the web: a picture URL, or the SI.xml of the station (RadioDNS / ETSI TS 102 818) ──
// Services of an SI.xml: [{ name, bearers: ['dab:ce1.c221.c479.0', 'fm:ce1.c479.09580', …], logos: [{ url, width, height }] }]
const SI_TYPE_SIZE = { logo_colour_square: [32, 32], logo_colour_rectangle: [112, 32] };   // SPI v1 types without width / height
export function parseSiXml(text, base = '') {
  const out = [];
  const walk = (el) => {
    if (el.name === 'service') {
      const name = ['longName', 'mediumName', 'shortName'].map((n) => el.children.find((c) => c.name === n)?.text.trim()).find(Boolean) || '';
      const bearers = el.children.filter((c) => c.name === 'bearer').map((b) => String(b.attrs.id || '').toLowerCase()).filter(Boolean);
      const logos = el.children.filter((c) => c.name === 'mediaDescription').flatMap((m) => m.children.filter((c) => c.name === 'multimedia')).map((m) => {
        const [tw, th] = SI_TYPE_SIZE[m.attrs.type] || [];
        let url = m.attrs.url || '';
        try { url = new URL(url, base || undefined).href; } catch { /* kept as is */ }
        return { url, width: Number(m.attrs.width) || tw || 0, height: Number(m.attrs.height) || th || 0 };
      }).filter((l) => l.url && l.width && l.height);
      out.push({ name, bearers, logos });
      return;
    }
    el.children.forEach(walk);
  };
  walk(parseXml(text));
  return out;
}
// Does an SI.xml service carry this PI? (DAB bearer dab:<gcc>.<eid>.<sid>.<scids>, FM bearer fm:<gcc>.<pi>.<freq>)
export function siServiceHasPi(svc, sid) {
  const pi = String(sid).toLowerCase();
  return svc.bearers.some((b) => { const p = b.split(/[:.]/); return (p[0] === 'dab' && p[3] === pi) || (p[0] === 'fm' && p[2] === pi); });
}

// Logos of one service from a URL (a picture, or an SI.xml). pick = index of the SI.xml service when its PI is not
// in the file. Returns { ok, from: 'picture' | 'si', sizes, exact } or { choices: [{ index, name, bearers }] }.
// dryRun: nothing written — what the address is (picture: format, size; SI.xml: station found, sizes it
// provides) with a small preview (data: URL), for the Test button of the page.
const PREVIEW_MAX = 300 * 1024;
const preview = (buf, coder) => (buf.length <= PREVIEW_MAX ? `data:image/${String(coder).toLowerCase()};base64,${buf.toString('base64')}` : null);
export async function importSpiLogos(url, outDir, sid, { pick = null, fetchImpl, exec = execFileSync, dryRun = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const tmpFile = (tag) => path.join(outDir, `.web_${process.pid}_${Date.now()}_${tag}`);
  const download = async (u, tag) => {
    const f = tmpFile(tag);
    fs.writeFileSync(f, await fetchBuffer(u, { fetchImpl, maxBytes: 10 * 1024 * 1024 }));
    return f;
  };
  const first = await fetchBuffer(url, { fetchImpl, maxBytes: 10 * 1024 * 1024 });
  const head = first.subarray(0, 200).toString('utf8').trimStart();
  if (!head.startsWith('<')) {   // a picture
    const f = tmpFile('pic');
    try {
      fs.writeFileSync(f, first);
      if (dryRun) {
        const coder = imageCoder(f);
        if (!coder) throw new Error('not a JPEG / PNG / GIF / WebP picture, nor an SI.xml');
        const [width, height] = String(exec('identify', ['-format', '%w %h', `${coder}:${f}[0]`], { encoding: 'utf8', timeout: 10000 })).trim().split(/\s+/).map(Number);
        return { ok: true, dryRun: true, from: 'picture', format: coder, width, height, bytes: first.length, preview: preview(first, coder) };
      }
      return { ok: true, from: 'picture', sizes: makeSpiLogos(f, outDir, sid, { exec }), exact: [] };
    } finally { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  }
  const services = parseSiXml(first.toString('utf8'), url);
  if (!services.length) throw new Error('not a picture, nor an SI.xml with services');
  let svc = services.find((x) => siServiceHasPi(x, sid));
  if (!svc && pick !== null && services[pick]) svc = services[pick];
  if (!svc) return { choices: services.map((x, index) => ({ index, name: x.name, bearers: x.bearers.filter((b) => /^(dab|fm):/.test(b)) })) };
  if (!svc.logos.length) throw new Error(`no logo for ${svc.name} in this SI.xml`);
  if (dryRun) {
    const exact = SPI_SIZES.filter(([w, h]) => svc.logos.some((l) => l.width === w && l.height === h)).map(([w, h]) => `${w}x${h}`);
    const big = [...svc.logos].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const show = svc.logos.find((l) => l.width === 128 && l.height === 128) || big;
    let pv = null;
    try { const b = await fetchBuffer(show.url, { fetchImpl, maxBytes: PREVIEW_MAX }); const f = tmpFile('pv'); fs.writeFileSync(f, b); const c = imageCoder(f); fs.unlinkSync(f); pv = c ? preview(b, c) : null; } catch { /* no preview */ }
    return { ok: true, dryRun: true, from: 'si', service: svc.name, matched: siServiceHasPi(svc, sid), exact, biggest: `${big.width}x${big.height}`, preview: pv };
  }
  const files = [];
  try {
    // the station's own picture for each DAB size, converted as is (no resize); the others from its biggest logo
    const exact = [];
    for (const [w, h] of SPI_SIZES) {
      const lg = svc.logos.find((l) => l.width === w && l.height === h);
      if (!lg) continue;
      try {
        const f = await download(lg.url, `${w}x${h}`);
        files.push(f);
        if (imageCoder(f)) { makeSpiLogos(f, outDir, sid, { exec, sizes: [[w, h]] }); exact.push(`${w}x${h}`); }
      } catch { /* this size from the biggest logo */ }
    }
    const missing = SPI_SIZES.filter(([w, h]) => !exact.includes(`${w}x${h}`));
    if (missing.length) {
      const big = [...svc.logos].sort((a, b) => b.width * b.height - a.width * a.height).find((l) => l.width * l.height >= 128 * 128) || svc.logos[0];
      const f = await download(big.url, 'big');
      files.push(f);
      if (!imageCoder(f)) throw new Error('the logos of this SI.xml are not JPEG / PNG / WebP pictures');
      makeSpiLogos(f, outDir, sid, { exec, sizes: missing });
    }
    return { ok: true, from: 'si', service: svc.name, sizes: SPI_SIZES.map(([w, h]) => `${w}x${h}`), exact };
  } finally {
    for (const f of files) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  }
}

// { '320x240': { bytes, mtime } | null, … } for one service
export function spiLogoInfo(outDir, sid) {
  const out = {};
  for (const [w, h] of SPI_SIZES) {
    try {
      const st = fs.statSync(path.join(outDir, spiFileName(sid, w, h)));
      out[`${w}x${h}`] = { bytes: st.size, mtime: Math.round(st.mtimeMs) };
    } catch { out[`${w}x${h}`] = null; }
  }
  return out;
}

export function deleteSpiLogos(outDir, sid) {
  for (const [w, h] of SPI_SIZES) { try { fs.unlinkSync(path.join(outDir, spiFileName(sid, w, h))); } catch { /* none */ } }
}

// Last address used for the logos from the web, per service id ('ensemble' = the multiplex): shown again in
// the From web… dialog, kept in the configuration and service files
export const spiWebFile = (dataDir) => path.join(dataDir, 'spi', 'web-sources.json');
export function loadSpiWebUrls(dataDir) {
  try { return JSON.parse(fs.readFileSync(spiWebFile(dataDir), 'utf8')) || {}; } catch { return {}; }
}
const validWebUrl = (u) => typeof u === 'string' && u.length <= 1000 && /^https?:\/\//i.test(u);
export function saveSpiWebUrl(dataDir, id, url) {
  if (!validWebUrl(url)) return;
  writeJson(spiWebFile(dataDir), { ...loadSpiWebUrls(dataDir), [id]: url });
}

// ── Export / import of the SPI logos and the programme guide sources (configuration and service files) ──
// services: [{ id, sid }] ; ensemble: also the multiplex logos. Fetched web guides are not exported (fetched again).
// → { logos: { '<sid>-<w>x<h>.png': 'data:image/png;base64,…' }, epg: { '<service id>': entry }, webUrls: { '<id>': url } } (empty parts left out)
export function exportSpiBundle(dataDir, services, { ensemble = false } = {}) {
  const dir = spiLogosDir(dataDir);
  const logos = {};
  for (const sid of [...services.map((s) => s.sid), ...(ensemble ? [SPI_ENSEMBLE] : [])]) {
    for (const [w, h] of SPI_SIZES) {
      try { logos[spiFileName(sid, w, h)] = `data:image/png;base64,${fs.readFileSync(path.join(dir, spiFileName(sid, w, h))).toString('base64')}`; } catch { /* no logo of this size */ }
    }
  }
  const all = loadEpgConfig(dataDir);
  const epg = {};
  for (const s of services) if (all[s.id] && all[s.id].source !== 'none') epg[s.id] = all[s.id];
  const urls = loadSpiWebUrls(dataDir);
  const webUrls = {};
  for (const id of [...services.map((s) => s.id), ...(ensemble ? [SPI_ENSEMBLE] : [])]) if (validWebUrl(urls[id])) webUrls[id] = urls[id];
  return { ...(Object.keys(logos).length ? { logos } : {}), ...(Object.keys(epg).length ? { epg } : {}), ...(Object.keys(webUrls).length ? { webUrls } : {}) };
}

// Restores a bundle. map: [{ from: { id, sid } of the file, to: { id, sid } here }] — only these services
// (and the multiplex logos when ensemble is true) are written; anything else in the file is ignored.
// Logos: SPI file names only, PNG only, at most 1 MB each. Returns { logos, epg } counts.
const MAX_IMPORTED_LOGO = 1024 * 1024;
export function importSpiBundle(dataDir, bundle, map, { ensemble = false } = {}) {
  const dir = spiLogosDir(dataDir);
  let logos = 0, epg = 0;
  const sidTo = new Map(map.map((m) => [m.from.sid, m.to.sid]));
  if (ensemble) sidTo.set(SPI_ENSEMBLE, SPI_ENSEMBLE);
  for (const [name, dataUrl] of Object.entries(bundle?.logos || {})) {
    const m = /^(.+)-(\d{2,3})x(\d{2,3})\.png$/.exec(name);
    if (!isSpiFileName(name) || !m || !sidTo.has(m[1]) || !SPI_SIZES.some(([w, h]) => w === +m[2] && h === +m[3])) continue;
    const buf = Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64');
    if (buf.length < 8 || buf.length > MAX_IMPORTED_LOGO || buf.readUInt32BE(0) !== 0x89504e47) continue;   // PNG signature
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, spiFileName(sidTo.get(m[1]), +m[2], +m[3]));
    const tmp = `${dest}.tmp${process.pid}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    logos++;
  }
  for (const { from, to } of map) {
    const entry = bundle?.epg?.[from.id];
    if (entry && typeof entry === 'object') { saveEpgEntry(dataDir, to.id, entry); epg++; }
  }
  // addresses of the logos from the web (shown again in the From web… dialog)
  const urls = bundle?.webUrls && typeof bundle.webUrls === 'object' ? bundle.webUrls : {};
  const pairs = [...map.map((m) => [m.from.id, m.to.id]), ...(ensemble ? [[SPI_ENSEMBLE, SPI_ENSEMBLE]] : [])].filter(([f]) => validWebUrl(urls[f]));
  if (pairs.length) writeJson(spiWebFile(dataDir), { ...loadSpiWebUrls(dataDir), ...Object.fromEntries(pairs.map(([f, t]) => [t, urls[f]])) });
  return { logos, epg, webUrls: pairs.length };
}

// ── Step 2: the SPI data service (packet mode) ──
// Packet size for the bit rate (one packet per 24 ms frame, as the ODR SPI generators)
export const SPI_PACKET_SIZE = { 8: 24, 16: 48, 24: 72, 32: 96 };
export const SPI_PACKET_ADDRESS = 1;
export const SPI_SUBCHANNEL_ID = 63;   // audio sub-channels are numbered 1..N
export const spiCarouselFile = (dataDir) => path.join(dataDir, 'spi', 'spi.dat');
// Data service ID (32 bits): ECC + EId + 0xF1 (first digits = ECC, then the EId, as the ODR SPI generators)
export function spiDataServiceId(ensemble) {
  const ecc = String(ensemble?.eccHex || '0xE1').replace(/^0x/i, '').padStart(2, '0').slice(-2);
  const eid = String(ensemble?.idHex || '0x0000').replace(/^0x/i, '').padStart(4, '0').slice(-4);
  return `0x${ecc}${eid}f1`.toLowerCase();
}

// The generator is built in (spiCarousel.js): always available, nothing to install
export function spiGeneratorStatus() { return { ok: true }; }

// Builds data/spi/spi.dat from the SPI logos of the services ON (in multiplex order).
// Returns { ok, stats | error }. odr-dabmux preloads the file (load_entire_file): replacing it is safe.
// bitrate: packet size to use instead of the saved one — the bit rate of the SPI sub-channel the running
// odr-dabmux was started with (a carousel with another packet size would not match it until the next Start)
export function buildSpiCarousel({ dataDir, settings, services, nextTid, now = Date.now(), bitrate = null }) {
  const saved = normalizeSpiSettings(settings.spi);
  const spi = { ...saved, bitrate: SPI_BITRATES.includes(bitrate) ? bitrate : saved.bitrate };
  const e = settings.ensemble || {};
  const hex = (v) => parseInt(String(v).replace(/^0x/i, ''), 16);
  const dir = spiLogosDir(dataDir);
  const read = (sid) => SPI_SIZES.filter(([w, h]) => fs.existsSync(path.join(dir, spiFileName(sid, w, h))))
    .map(([w, h]) => ({ body: fs.readFileSync(path.join(dir, spiFileName(sid, w, h))), width: w, height: h }));
  try {
    const list = services.filter((s) => s.enabled !== false).map((svc) => {
      const sid = spiSid(svc);
      return { sid: hex(sid), label: svc.identity?.ps16 || svc.identity?.ps8 || sid, shortlabel: svc.identity?.ps8 || sid, logos: read(sid) };
    }).filter((s) => s.logos.length);
    const ensLogos = read(SPI_ENSEMBLE);
    // programme guide (EPG): one PI document per service ON and per day, from its source (spiEpg.js)
    const epg = loadEpgConfig(dataDir);
    const schedules = services.filter((svc) => svc.enabled !== false && epg[svc.id])
      .flatMap((svc) => epgSchedules(spiSid(svc), epgProgrammes(dataDir, spiSid(svc), epg[svc.id], now), now));
    if (!list.length && !ensLogos.length && !schedules.length) return { ok: false, error: 'No SPI logo nor programme guide for the multiplex or the services ON' };
    const { data, siBytes, piBytes } = encodeSpiCarousel({ ecc: hex(e.eccHex || '0xE1'), eid: hex(e.idHex || '0x0000'), label: e.label || '',
      shortlabel: e.shortlabel || '', address: SPI_PACKET_ADDRESS, packetSize: SPI_PACKET_SIZE[spi.bitrate], logos: ensLogos, services: list, schedules }, { nextTid });
    const output = spiCarouselFile(dataDir);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const tmp = `${output}.tmp${process.pid}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, output);   // odr-dabmux preloads the file (load_entire_file): replacing it is safe
    const logos = list.reduce((a, s) => a + s.logos.length, ensLogos.length);
    // carousel period: whole file at the sub-channel bit rate
    return { ok: true, file: output, stats: { services: list.length, logos, siBytes, epgDocs: schedules.length,
      epgServices: new Set(schedules.map((x) => x.sid)).size, epgBytes: piBytes, packets: data.length / SPI_PACKET_SIZE[spi.bitrate],
      bytes: data.length, cycleSec: Math.round(data.length * 8 / (spi.bitrate * 1000)) } };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}
