// SPI carousel encoder in Node (no Python): service information + service logos →
// MOT directory mode (ETSI EN 301 234) → MSC data groups → MSC packets (EN 300 401 5.3.2),
// the .dat file read in loop by odr-dabmux (packet sub-channel, load_entire_file).
// Same encoding as the ODR SPI generators built on python-hybridspi / python-dabmot / python-dabmsc
// (checked byte for byte against them in tests/spiCarousel.test.js when they are installed).
// Binary SI (ETSI TS 102 371): only what a logo carousel needs — ensemble (ECC, EId, names) and, per
// service, its DAB bearer, names and logos. No "created" date (optional; the Python encoder has bugs there).

// CRC-16 CCITT as DAB uses it: poly 0x1021, register 0xFFFF, result inverted
export function crc16(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc ^ 0xffff;
}

const u16 = (v) => Buffer.from([(v >> 8) & 0xff, v & 0xff]);

// ── Binary SI document (TS 102 371): element / attribute = tag, length, data ──
function tlvLength(n) {
  if (n <= 253) return Buffer.from([n]);
  if (n <= 1 << 16) return Buffer.from([0xfe, (n >> 8) & 0xff, n & 0xff]);
  if (n <= 1 << 24) return Buffer.from([0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  throw new Error('SPI element too large');
}
const attr = (tag, data) => Buffer.concat([Buffer.from([tag]), tlvLength(data.length), data]);
function element(tag, parts) {
  const data = Buffer.concat(parts);
  if (!data.length) throw new Error(`SPI element 0x${tag.toString(16)} is empty`);
  return Buffer.concat([Buffer.from([tag]), tlvLength(data.length), data]);
}
const cdata = (text) => { const b = Buffer.from(String(text), 'utf8'); return Buffer.concat([Buffer.from([0x01]), tlvLength(b.length), b]); };
const shortName = (t) => element(0x10, [cdata(t)]);
const mediumName = (t) => element(0x11, [cdata(t)]);
const str = (s) => Buffer.from(String(s), 'utf8');

// DAB bearer (contentId): ensemble flag set, audio service (16-bit SId)
const dabBearer = (ecc, eid, sid, scids = 0) => Buffer.from([0x40 | (scids & 0x0f), ecc & 0xff, (eid >> 8) & 0xff, eid & 0xff, (sid >> 8) & 0xff, sid & 0xff]);

function logoGroup({ url, width, height }) {
  const a = [attr(0x80, str('image/png')), attr(0x82, str(url))];
  if (width === 32 && height === 32) a.push(attr(0x83, Buffer.from([0x04])));            // colour square
  else if (width === 112 && height === 32) a.push(attr(0x83, Buffer.from([0x06])));      // colour rectangle
  else a.push(attr(0x83, Buffer.from([0x02])), attr(0x84, u16(width)), attr(0x85, u16(height)));   // unrestricted
  return element(0x13, [element(0x2b, a)]);
}

// { ecc, eid, label, shortlabel, logos?, services: [{ sid, label, shortlabel, logos: [{ url, width, height }] }] }
// logos = the multiplex (ensemble) logos, after its names (TS 102 818: ensemble mediaDescription)
export function encodeServiceInformation({ ecc, eid, label, shortlabel, logos = [], services, originator = 'DABcast' }) {
  const ens = [attr(0x80, Buffer.from([ecc & 0xff, (eid >> 8) & 0xff, eid & 0xff])),
    mediumName(String(label).slice(0, 16)), shortName(String(shortlabel).slice(0, 8)), ...logos.map(logoGroup)];
  for (const s of services) {
    ens.push(element(0x28, [
      element(0x29, [attr(0x80, dabBearer(ecc, eid, s.sid))]),
      mediumName(String(s.label).slice(0, 16)), shortName(String(s.shortlabel).slice(0, 8)),
      ...s.logos.map(logoGroup),
    ]));
  }
  return element(0x03, [attr(0x82, str(originator)), element(0x06, [str('en')]), element(0x26, ens)]);
}

// ── MOT (EN 301 234) ──
export const CONTENT_PNG = [2, 3];
export const CONTENT_SPI_SI = [7, 0];
function headerParam(id, data) {
  const n = data.length;
  if (n === 0) return Buffer.from([id & 0x3f]);
  if (n === 1) return Buffer.concat([Buffer.from([0x40 | id]), data]);
  if (n === 4) return Buffer.concat([Buffer.from([0x80 | id]), data]);
  if (n <= 127) return Buffer.concat([Buffer.from([0xc0 | id, n]), data]);
  return Buffer.concat([Buffer.from([0xc0 | id, 0x80 | (n >> 8), n & 0xff]), data]);
}
const contentName = (name) => headerParam(12, Buffer.concat([Buffer.from([0x40]), str(name)]));   // ISO Latin 1
const scopeId = (ecc, eid) => headerParam(0x27, Buffer.from([ecc & 0xff, (eid >> 8) & 0xff, eid & 0xff]));

// MSB-first bit writer for the fields that are not byte aligned
class Bits {
  constructor() { this.bits = []; }
  put(value, n) { for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2); return this; }
  bytes() {
    const out = Buffer.alloc(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
    return out;
  }
}

function encodeDirectory(objects) {
  const entries = objects.map((o) => {
    const ext = Buffer.concat(o.params);
    return Buffer.concat([u16(o.tid), new Bits().put(o.body.length, 28).put(ext.length + 7, 13).put(o.type[0], 6).put(o.type[1], 9).bytes(), ext]);
  });
  const body = Buffer.concat(entries);
  const head = new Bits().put(0, 2).put(body.length + 13, 30).put(objects.length, 16).put(0, 24).put(0, 3).put(0, 13).put(0, 16).bytes();
  return Buffer.concat([head, body]);
}

const MAX_SEGMENT = 8189;
function segments(data) {
  const out = [];
  for (let i = 0; i < data.length; i += MAX_SEGMENT) {
    const seg = data.subarray(i, i + MAX_SEGMENT);
    out.push(Buffer.concat([u16(seg.length & 0x1fff), seg]));   // repetition count 0
  }
  return out;
}

function datagroup(type, tid, seg, index, last) {
  const head = Buffer.from([0x70 | type, (index % 16) << 4, (last ? 0x80 : 0) | ((index >> 8) & 0x7f), index & 0xff, 0x12, (tid >> 8) & 0xff, tid & 0xff]);
  const dg = Buffer.concat([head, seg]);
  return Buffer.concat([dg, u16(crc16(dg))]);
}

// Unique random 16-bit transport IDs (a new set for each carousel, like the ODR generators).
// nextTid(name) is called with the object name, null for the directory (tests give fixed IDs).
export function randomTransportIds() {
  const used = new Set();
  return () => { let id; do { id = Math.floor(Math.random() * 0x10000); } while (used.has(id)); used.add(id); return id; };
}

// objects: [{ name, body, type, params? }] → data groups in directory mode (directory, then bodies)
export function encodeDirectoryMode(objects, nextTid = randomTransportIds()) {
  const objs = objects.map((o) => ({ ...o, tid: nextTid(o.name), params: [contentName(o.name), ...(o.params || [])] }));
  const dirTid = nextTid(null);   // null = the directory
  const groups = [];
  const dirSegs = segments(encodeDirectory(objs));
  dirSegs.forEach((s, i) => groups.push(datagroup(6, dirTid, s, i, i === dirSegs.length - 1)));
  for (const o of objs) {
    const segs = segments(o.body);
    segs.forEach((s, i) => groups.push(datagroup(4, o.tid, s, i, i === segs.length - 1)));
  }
  return groups;
}

// data groups → MSC packets (size 24/48/72/96, padding with zeros, CRC)
export function encodePackets(groups, { address = 1, size = 48 } = {}) {
  if (![24, 48, 72, 96].includes(size)) throw new Error('packet size must be 24, 48, 72 or 96');
  const chunk = size - 5;
  const out = [];
  let ci = 0;
  for (const g of groups) {
    for (let i = 0; i < g.length; i += chunk) {
      const data = g.subarray(i, i + chunk);
      const p = Buffer.alloc(size);
      p[0] = ((size / 24 - 1) << 6) | (ci << 4) | (i === 0 ? 0x08 : 0) | (i + chunk >= g.length ? 0x04 : 0) | ((address >> 8) & 0x03);
      p[1] = address & 0xff;
      p[2] = data.length & 0x7f;
      data.copy(p, 3);
      p.writeUInt16BE(crc16(p.subarray(0, size - 2)), size - 2);
      out.push(p);
      ci = (ci + 1) % 4;
    }
  }
  return Buffer.concat(out);
}

// Whole carousel: SI (object "0", scope = the ensemble) then the logos ("1", "2"… referred to by the SI):
// the multiplex logos first (cfg.logos, optional), then those of the services
// cfg: { ecc, eid, label, shortlabel, address, packetSize, logos?, services: [{ sid, label, shortlabel, logos: [{ body, width, height }] }] }
export function encodeSpiCarousel(cfg, { nextTid } = {}) {
  const objects = [];
  const ref = (lg) => {
    const name = (objects.length + 1).toString(16);
    objects.push({ name, body: lg.body, type: CONTENT_PNG });
    return { url: name, width: lg.width, height: lg.height };
  };
  const logos = (cfg.logos || []).map(ref);
  const services = cfg.services.map((s) => ({ ...s, logos: s.logos.map(ref) }));
  const si = encodeServiceInformation({ ...cfg, logos, services });
  objects.unshift({ name: '0', body: si, type: CONTENT_SPI_SI, params: [scopeId(cfg.ecc, cfg.eid)] });
  const groups = encodeDirectoryMode(objects, nextTid);
  return { data: encodePackets(groups, { address: cfg.address, size: cfg.packetSize }), siBytes: si.length, objects: objects.length };
}
