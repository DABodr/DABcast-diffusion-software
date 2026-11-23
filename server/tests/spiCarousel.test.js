// SPI carousel encoder in Node (spiCarousel.js). Checked byte for byte against the Python libraries used
// by the ODR SPI generators (python-hybridspi, python-dabmot, python-mot-epg, python-dabmsc) when they are
// installed (skipped otherwise, e.g. in CI), and decoded back (packets → data groups → MOT) in any case.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { crc16, encodeSpiCarousel, encodeServiceInformation, encodePackets } from '../src/spiCarousel.js';

const fixedTid = (name) => (name === null ? 999 : parseInt(name, 16) + 100);
const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(n, n & 0xff)]);   // fake bodies
const cfg = {
  ecc: 0xe1, eid: 0xffff, label: 'DABcast Demo', shortlabel: 'DABcast', address: 1, packetSize: 48,
  services: [
    { sid: 0xf9a3, label: 'Fréquence 3 Gold', shortlabel: 'F3 Gold', logos: [
      { body: png(1500), width: 320, height: 240 }, { body: png(600), width: 128, height: 128 },
      { body: png(200), width: 112, height: 32 }, { body: png(90), width: 32, height: 32 }] },
    { sid: 0x42f1, label: 'Swiss Pop', shortlabel: 'SwissPop', logos: [{ body: png(9000), width: 320, height: 240 }] },
  ],
};

let python = false;
try { execFileSync('python3', ['-c', 'import spi, mot, mot.epg, msc.datagroups, msc.packets'], { stdio: 'pipe' }); python = true; } catch { /* not installed */ }

describe('SPI carousel encoder (Node)', () => {
  it('CRC-16 as DAB (python-dabmsc check value)', () => {
    assert.equal(crc16(Buffer.from('123456789')), 0xd64e);
  });

  it('packets: right size and address, valid CRC, continuity 0..3, first / last flags', () => {
    const { data } = encodeSpiCarousel(cfg, { nextTid: fixedTid });
    assert.equal(data.length % 48, 0);
    const groups = [];
    let cur = null;
    for (let off = 0, n = 0; off < data.length; off += 48, n++) {
      const p = data.subarray(off, off + 48);
      assert.equal(p.readUInt16BE(46), crc16(p.subarray(0, 46)), `packet ${n} CRC`);
      assert.equal(p[0] >> 6, 1, 'size 48');
      assert.equal(((p[0] & 3) << 8) | p[1], 1, 'address 1');
      assert.equal((p[0] >> 4) & 3, n % 4, 'continuity');
      if (p[0] & 0x08) cur = [];
      cur.push(p.subarray(3, 3 + (p[2] & 0x7f)));
      if (p[0] & 0x04) { groups.push(Buffer.concat(cur)); cur = null; }
    }
    // data groups: CRC, type 6 (directory) first, then 4 (bodies)
    for (const g of groups) assert.equal(g.readUInt16BE(g.length - 2), crc16(g.subarray(0, g.length - 2)));
    assert.equal(groups[0][0] & 0x0f, 6);
    assert.ok(groups.slice(1).every((g) => (g[0] & 0x0f) === 4));
    // 6 objects (SI + 5 logos); the 9000-byte logo needs 2 segments (max 8189)
    assert.equal(groups.length, 1 + 1 + 4 + 2);
  });

  it('read in loop: packet count multiple of 4, continuity unbroken at the wrap, same data groups', () => {
    // packets → data groups (reassembled from the useful data, first / last flags)
    const decode = (data, size) => {
      const groups = []; let cur = null;
      for (let off = 0; off < data.length; off += size) {
        const p = data.subarray(off, off + size);
        assert.equal(p.readUInt16BE(size - 2), crc16(p.subarray(0, size - 2)));
        if (p[0] & 0x08) cur = [];
        cur.push(p.subarray(3, 3 + (p[2] & 0x7f)));
        if (p[0] & 0x04) { groups.push(Buffer.concat(cur)); cur = null; }
      }
      return groups;
    };
    for (const size of [24, 48, 72, 96]) {
      for (let n = 1; n <= 8; n++) {   // every remainder modulo 4
        const groups = Array.from({ length: n }, (_, i) => Buffer.alloc(9 + i * 37, i + 1));
        const plain = encodePackets(groups, { size });
        const looped = encodePackets(groups, { size, loop: true });
        const count = looped.length / size;
        assert.equal(count % 4, 0, `size ${size}, ${n} groups: ${count} packets`);
        assert.ok(count - plain.length / size < 4);
        for (let k = 0; k < count; k++) assert.equal((looped[k * size] >> 4) & 3, k % 4, 'continuity, the last packet ends at 3');
        assert.deepEqual(decode(looped, size), decode(plain, size));
      }
    }
    const { data } = encodeSpiCarousel(cfg, { nextTid: fixedTid });
    assert.equal((data.length / 48) % 4, 0, 'the carousel file');
  });

  it('SI document: root 0x03, ensemble 0x26 with ECC/EId, services 0x28 with DAB bearer and logos', () => {
    const si = encodeServiceInformation({ ...cfg, services: [{ sid: 0xf9a3, label: 'F3', shortlabel: 'F3', logos: [{ url: '1', width: 32, height: 32 }] }] });
    assert.equal(si[0], 0x03);
    assert.ok(si.includes(Buffer.from([0x80, 3, 0xe1, 0xff, 0xff])), 'ensemble id attribute');
    assert.ok(si.includes(Buffer.from([0x40, 0xe1, 0xff, 0xff, 0xf9, 0xa3])), 'DAB bearer');
    assert.ok(si.includes(Buffer.from([0x83, 1, 0x04])), 'colour square logo');
  });

  it('multiplex logos: in the ensemble after its names, objects "1".. before the service logos; none = unchanged', () => {
    const si = encodeServiceInformation({ ...cfg, logos: [{ url: '1', width: 32, height: 32 }], services: [] });
    const ens = si.indexOf(0x26);
    assert.ok(si.indexOf(Buffer.from([0x83, 1, 0x04])) > ens, 'logo inside the ensemble');
    assert.ok(encodeSpiCarousel({ ...cfg, logos: [] }, { nextTid: fixedTid }).data.equals(encodeSpiCarousel(cfg, { nextTid: fixedTid }).data));
    assert.equal(encodeSpiCarousel({ ...cfg, logos: [{ body: png(50), width: 32, height: 32 }] }, { nextTid: fixedTid }).objects, 7);
  });

  it('programme guide (EPG) identical to the Python ODR SPI libraries, byte for byte', { skip: python ? false : 'python SPI libraries not installed' }, () => {
    const t = (x) => Date.parse(x);
    const c = { ecc: 0xe1, eid: 0xffff, label: 'DABcast Demo', shortlabel: 'DABcast', address: 1, packetSize: 48,
      services: [{ sid: 0xf9a3, label: 'Fréquence 3 Gold', shortlabel: 'F3 Gold', logos: [{ body: Buffer.alloc(300, 7), width: 32, height: 32 }] }],
      schedules: [{ sid: 0xf9a3, created: t('2026-11-23T08:00:00Z'), start: t('2026-11-22T23:00:00Z'), end: t('2026-11-23T23:00:00Z'), programmes: [
        { crid: 'crid://dabcast/f9a3/202611230500', shortId: 123456, start: t('2026-11-23T05:00:00Z'), end: t('2026-11-23T08:00:00Z'), title: 'Le Réveil de la Gold', description: 'Les tubes du matin' },
        { crid: 'crid://dabcast/f9a3/202611231130', shortId: 99, start: t('2026-11-23T11:30:30Z'), end: t('2026-11-23T13:00:00Z'), title: 'Midi' }] }] };
    const ref = String.raw`
import json, sys, datetime
import mot, msc.datagroups
mot.generate_transport_id = lambda name=None: int(getattr(name, 'name', name), 16) + 100
msc.datagroups.generate_transport_id = lambda name=None: 999
from spi import *
from spi import binary
from mot import MotObject, ContentType, ContentName
from mot.epg import EpgContentType, ScopeId, ScopeStart, ScopeEnd
from msc.datagroups import encode_directorymode
from msc.packets import encode_packets
c = json.load(sys.stdin)
U = datetime.timezone.utc
T = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, U)
EB = ContentName.EBU_LATIN
objects = []
info = ServiceInfo(created=None, originator='DABcast')
for s in c['services']:
    svc = Service(); svc.names = [MediumName(s['label']), ShortName(s['shortlabel'])]
    svc.bearers = [DabBearer(c['ecc'], c['eid'], s['sid'], 0)]; svc.media = []
    for lg in s['logos']:
        name = '%x' % (len(objects) + 1)
        objects.append(MotObject(ContentName(name, EB), bytes(lg['body']), ContentType.IMAGE_PNG))
        svc.media.append(Multimedia(url=name, type=Multimedia.LOGO_COLOUR_SQUARE, width=32, height=32, content='image/png'))
    info.services.append(svc)
for sc in c['schedules']:
    sched = Schedule(Scope(T(sc['start']), T(sc['end']), bearers=[DabBearer(c['ecc'], c['eid'], sc['sid'], 0)]), created=T(sc['created']), originator='DABcast')
    for p in sc['programmes']:
        pr = Programme(p['crid'], p['shortId'])
        pr.names = [ShortName(p['title'][:8]), MediumName(p['title'][:16]), LongName(p['title'][:128])]
        if p.get('description'): pr.descriptions = [ShortDescription(p['description'])]
        pr.locations = [Location(times=[Time(T(p['start']), datetime.timedelta(seconds=(p['end'] - p['start']) // 1000))])]
        sched.programmes.append(pr)
    pi = ProgrammeInfo(); pi.schedules = [sched]
    o = MotObject(ContentName('%x' % (len(objects) + 1), EB), binary.marshall(pi).tobytes(), EpgContentType.PROGRAMME_INFORMATION)
    o.add_parameter(ScopeStart(T(sc['start']))); o.add_parameter(ScopeEnd(T(sc['end']))); o.add_parameter(ScopeId(c['ecc'], c['eid'], sc['sid'], 0))
    objects.append(o)
si = binary.marshall(info, ensemble=binary.Ensemble(c['ecc'], c['eid'], names=[MediumName(c['label']), ShortName(c['shortlabel'])])).tobytes()
o = MotObject(ContentName('0', EB), si, EpgContentType.SERVICE_INFORMATION); o.add_parameter(ScopeId(c['ecc'], c['eid'])); objects.insert(0, o)
for p in encode_packets(encode_directorymode(objects, directory_parameters=[]), address=1, size=48): sys.stdout.buffer.write(p.tobytes())
`;
    const input = JSON.stringify({ ...c, services: c.services.map((x) => ({ ...x, logos: x.logos.map((l) => ({ ...l, body: [...l.body] })) })) });
    const expected = execFileSync('python3', ['-c', ref], { input, maxBuffer: 1 << 26 });
    const { data } = encodeSpiCarousel(c, { nextTid: fixedTid, loop: false });
    assert.ok(data.equals(expected), `first difference at byte ${data.findIndex((b, i) => b !== expected[i])}`);
  });

  for (const withEns of [false, true]) it(`identical to the Python ODR SPI libraries, byte for byte${withEns ? ' (multiplex logos)' : ''}`, { skip: python ? false : 'python SPI libraries not installed' }, () => {
    const cfg2 = withEns ? { ...cfg, logos: [{ body: png(700), width: 128, height: 128 }, { body: png(80), width: 32, height: 32 }] } : cfg;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-spiref-'));
    const ensLogos = (cfg2.logos || []).map((lg, i) => { const f = path.join(dir, `ens-${i}.png`); fs.writeFileSync(f, lg.body); return { path: f, width: lg.width, height: lg.height }; });
    const services = cfg.services.map((s) => ({ ...s, logos: s.logos.map((lg, i) => {
      const f = path.join(dir, `${s.sid.toString(16)}-${i}.png`);
      fs.writeFileSync(f, lg.body);
      return { path: f, width: lg.width, height: lg.height };
    }) }));
    const ref = String.raw`
import json, sys
import mot, msc.datagroups
mot.generate_transport_id = lambda name=None: int(getattr(name, 'name', name), 16) + 100
msc.datagroups.generate_transport_id = lambda name=None: 999
from spi import Service, DabBearer, ServiceInfo, Multimedia, ShortName, MediumName, binary
from mot import MotObject, ContentType, ContentName
from mot.epg import EpgContentType, ScopeId
from msc.datagroups import encode_directorymode
from msc.packets import encode_packets
cfg = json.load(sys.stdin)
objects = []
def media(lg):
    name = '%x' % (len(objects) + 1)
    objects.append(MotObject(ContentName(name, ContentName.EBU_LATIN), open(lg['path'], 'rb').read(), ContentType.IMAGE_PNG))
    w, h = lg['width'], lg['height']
    t = Multimedia.LOGO_COLOUR_SQUARE if (w, h) == (32, 32) else Multimedia.LOGO_COLOUR_RECTANGLE if (w, h) == (112, 32) else Multimedia.LOGO_UNRESTRICTED
    return Multimedia(url=name, type=t, width=w, height=h, content='image/png')
ens = binary.Ensemble(cfg['ecc'], cfg['eid'], names=[MediumName(cfg['label']), ShortName(cfg['shortlabel'])])
ens.media = [media(lg) for lg in cfg.get('logos', [])]
info = ServiceInfo(created=None, originator='DABcast')
for s in cfg['services']:
    svc = Service()
    svc.names = [MediumName(s['label']), ShortName(s['shortlabel'])]
    svc.bearers = [DabBearer(cfg['ecc'], cfg['eid'], s['sid'], 0)]
    svc.media = [media(lg) for lg in s['logos']]
    info.services.append(svc)
si = binary.marshall(info, ensemble=ens).tobytes()
o = MotObject(ContentName('0', ContentName.EBU_LATIN), si, EpgContentType.SERVICE_INFORMATION)
o.add_parameter(ScopeId(cfg['ecc'], cfg['eid']))
objects.insert(0, o)
for p in encode_packets(encode_directorymode(objects, directory_parameters=[]), address=cfg['address'], size=cfg['packetSize']):
    sys.stdout.buffer.write(p.tobytes())
`;
    const expected = execFileSync('python3', ['-c', ref], { input: JSON.stringify({ ...cfg2, logos: ensLogos, services }), maxBuffer: 64 * 1024 * 1024 });
    const { data } = encodeSpiCarousel(cfg2, { nextTid: fixedTid, loop: false });   // the Python encoder does not align the loop
    assert.equal(data.length, expected.length, 'same length');
    assert.ok(data.equals(expected), `first difference at byte ${data.findIndex((b, i) => b !== expected[i])}`);
  });
});
