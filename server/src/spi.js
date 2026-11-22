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
export function makeSpiLogos(src, outDir, sid, { exec = execFileSync } = {}) {
  const coder = imageCoder(src);
  if (!coder) throw new Error('not a JPEG / PNG / GIF / WebP picture');
  const input = `${coder}:${src}[0]`;
  const img = parsePpm(exec('convert', [input, '-background', 'black', '-flatten', '-depth', '8', 'ppm:-'], { timeout: 10000, maxBuffer: 16 * 1024 * 1024 }));
  const bg = edgeColour(img);
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [w, h] of SPI_SIZES) {
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
export function buildSpiCarousel({ dataDir, settings, services, nextTid }) {
  const spi = normalizeSpiSettings(settings.spi);
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
    if (!list.length && !ensLogos.length) return { ok: false, error: 'No SPI logo for the multiplex or the services ON' };
    const { data, siBytes } = encodeSpiCarousel({ ecc: hex(e.eccHex || '0xE1'), eid: hex(e.idHex || '0x0000'), label: e.label || '',
      shortlabel: e.shortlabel || '', address: SPI_PACKET_ADDRESS, packetSize: SPI_PACKET_SIZE[spi.bitrate], logos: ensLogos, services: list }, { nextTid });
    const output = spiCarouselFile(dataDir);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const tmp = `${output}.tmp${process.pid}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, output);   // odr-dabmux preloads the file (load_entire_file): replacing it is safe
    const logos = list.reduce((a, s) => a + s.logos.length, ensLogos.length);
    // carousel period: whole file at the sub-channel bit rate
    return { ok: true, file: output, stats: { services: list.length, logos, siBytes, packets: data.length / SPI_PACKET_SIZE[spi.bitrate],
      bytes: data.length, cycleSec: Math.round(data.length * 8 / (spi.bitrate * 1000)) } };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}
