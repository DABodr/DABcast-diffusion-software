// SPI carousel encoder in Node (spiCarousel.js). Checked byte for byte against the Python libraries used
// by the ODR SPI generators (python-hybridspi, python-dabmot, python-mot-epg, python-dabmsc) when they are
// installed (skipped otherwise, e.g. in CI), and decoded back (packets → data groups → MOT) in any case.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { crc16, encodeSpiCarousel, encodeServiceInformation } from '../src/spiCarousel.js';

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

  it('SI document: root 0x03, ensemble 0x26 with ECC/EId, services 0x28 with DAB bearer and logos', () => {
    const si = encodeServiceInformation({ ...cfg, services: [{ sid: 0xf9a3, label: 'F3', shortlabel: 'F3', logos: [{ url: '1', width: 32, height: 32 }] }] });
    assert.equal(si[0], 0x03);
    assert.ok(si.includes(Buffer.from([0x80, 3, 0xe1, 0xff, 0xff])), 'ensemble id attribute');
    assert.ok(si.includes(Buffer.from([0x40, 0xe1, 0xff, 0xff, 0xf9, 0xa3])), 'DAB bearer');
    assert.ok(si.includes(Buffer.from([0x83, 1, 0x04])), 'colour square logo');
  });

  it('identical to the Python ODR SPI libraries, byte for byte', { skip: python ? false : 'python SPI libraries not installed' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-spiref-'));
    const services = cfg.services.map((s) => ({ ...s, logos: s.logos.map((lg, i) => {
      const f = path.join(dir, `${s.sid.toString(16)}-${i}.png`);
      fs.writeFileSync(f, lg.body);
      return { path: f, width: lg.width, height: lg.height };
    }) }));
    const ref = String.raw`
import json, sys
import mot, msc.datagroups
mot.generate_transport_id = lambda name=None: int(name, 16) + 100
msc.datagroups.generate_transport_id = lambda name=None: 999
from spi import Service, DabBearer, ServiceInfo, Multimedia, ShortName, MediumName, binary
from mot import MotObject, ContentType
from mot.epg import EpgContentType, ScopeId
from msc.datagroups import encode_directorymode
from msc.packets import encode_packets
cfg = json.load(sys.stdin)
objects = []
info = ServiceInfo(created=None, originator='DABcast')
for s in cfg['services']:
    svc = Service()
    svc.names = [MediumName(s['label']), ShortName(s['shortlabel'])]
    svc.bearers = [DabBearer(cfg['ecc'], cfg['eid'], s['sid'], 0)]
    svc.media = []
    for lg in s['logos']:
        name = '%x' % (len(objects) + 1)
        objects.append(MotObject(name, open(lg['path'], 'rb').read(), ContentType.IMAGE_PNG))
        w, h = lg['width'], lg['height']
        t = Multimedia.LOGO_COLOUR_SQUARE if (w, h) == (32, 32) else Multimedia.LOGO_COLOUR_RECTANGLE if (w, h) == (112, 32) else Multimedia.LOGO_UNRESTRICTED
        svc.media.append(Multimedia(url=name, type=t, width=w, height=h, content='image/png'))
    info.services.append(svc)
si = binary.marshall(info, ensemble=binary.Ensemble(cfg['ecc'], cfg['eid'], names=[MediumName(cfg['label']), ShortName(cfg['shortlabel'])])).tobytes()
o = MotObject('0', si, EpgContentType.SERVICE_INFORMATION)
o.add_parameter(ScopeId(cfg['ecc'], cfg['eid']))
objects.insert(0, o)
for p in encode_packets(encode_directorymode(objects, directory_parameters=[]), address=cfg['address'], size=cfg['packetSize']):
    sys.stdout.buffer.write(p.tobytes())
`;
    const expected = execFileSync('python3', ['-c', ref], { input: JSON.stringify({ ...cfg, services }), maxBuffer: 64 * 1024 * 1024 });
    const { data } = encodeSpiCarousel(cfg, { nextTid: fixedTid });
    assert.equal(data.length, expected.length, 'same length');
    assert.ok(data.equals(expected), `first difference at byte ${data.findIndex((b, i) => b !== expected[i])}`);
  });
});
