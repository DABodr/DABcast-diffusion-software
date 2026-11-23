// SPI service logos (spi.js): the 4 PNG sizes made from the slideshow logo (never a cover), settings defaults.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SPI_SIZES, normalizeSpiSettings, spiSid, spiFileName, isSpiFileName, spiSourceLogo, makeSpiLogos, spiLogoInfo, deleteSpiLogos, parseSiXml, siServiceHasPi, importSpiLogos, exportSpiBundle, importSpiBundle, spiLogosDir, saveSpiWebUrl, loadSpiWebUrls, renameSpiService, buildSpiCarousel } from '../src/spi.js';
import { saveEpgEntry, loadEpgConfig } from '../src/spiEpg.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-spi-'));

describe('SPI logos', () => {
  it('settings: safe defaults, only valid bit rates / protection levels', () => {
    assert.deepEqual(normalizeSpiSettings(), { enabled: false, bitrate: 16, protection: 3 });
    assert.deepEqual(normalizeSpiSettings({ enabled: true, bitrate: '24', protection: 2 }), { enabled: true, bitrate: 24, protection: 2 });
    assert.deepEqual(normalizeSpiSettings({ bitrate: 20, protection: 9 }), { enabled: false, bitrate: 16, protection: 3 });
  });

  it('service ID and file names (the naming of the ODR SPI generators)', () => {
    assert.equal(spiSid({ identity: { pi: '0xF9A3' } }), 'f9a3');
    assert.equal(spiFileName('f9a3', 112, 32), 'f9a3-112x32.png');
    assert.ok(isSpiFileName('f9a3-320x240.png'));
    assert.ok(isSpiFileName('ensemble-32x32.png'), 'multiplex logo');
    for (const bad of ['../x-32x32.png', 'f9a3-32x32.jpg', 'F9A3-32x32.png', 'f9a3.png']) assert.ok(!isSpiFileName(bad), bad);
  });

  it('source: the original logo first, else the slideshow logo; never the cover', () => {
    const mot = tmp();
    fs.mkdirSync(path.join(mot, 'slide'));
    execFileSync('convert', ['-size', '320x240', 'xc:red', path.join(mot, 'slide', 'cover.jpg')]);
    assert.equal(spiSourceLogo(mot), null, 'a cover alone is not a logo');
    execFileSync('convert', ['-size', '320x240', 'xc:blue', path.join(mot, 'slide', 'logo.jpg')]);
    assert.equal(spiSourceLogo(mot), path.join(mot, 'slide', 'logo.jpg'));
    fs.mkdirSync(path.join(mot, 'original'));
    execFileSync('convert', ['-size', '300x300', 'xc:green', path.join(mot, 'original', 'logo.png')]);
    assert.equal(spiSourceLogo(mot), path.join(mot, 'original', 'logo.png'), 'original preferred (no bands)');
  });

  it('makes the 4 sizes in PNG, exact dimensions, background in the edge colour', () => {
    const dir = tmp();
    const src = path.join(dir, 'src.png');
    // white square logo with a red centre: the bands added for 320x240 / 112x32 must be white, not black
    execFileSync('convert', ['-size', '300x300', 'xc:white', '-fill', 'red', '-draw', 'rectangle 100,100 200,200', src]);
    const out = path.join(dir, 'logos');
    assert.deepEqual(makeSpiLogos(src, out, 'f9a3'), SPI_SIZES.map(([w, h]) => `${w}x${h}`));
    for (const [w, h] of SPI_SIZES) {
      const f = path.join(out, spiFileName('f9a3', w, h));
      assert.equal(execFileSync('identify', ['-format', '%m %wx%h', f], { encoding: 'utf8' }), `PNG ${w}x${h}`);
    }
    const corner = execFileSync('convert', [path.join(out, 'f9a3-112x32.png'), '-format', '%[pixel:p{1,16}]', 'info:'], { encoding: 'utf8' });
    assert.match(corner, /white|rgb\(255,255,255\)|srgb\(255,255,255\)/, `band colour: ${corner}`);
    const info = spiLogoInfo(out, 'f9a3');
    assert.ok(Object.values(info).every((i) => i && i.bytes > 0));
    deleteSpiLogos(out, 'f9a3');
    assert.ok(Object.values(spiLogoInfo(out, 'f9a3')).every((i) => i === null));
  });

  it('refuses a file that is not a picture', () => {
    const dir = tmp();
    const src = path.join(dir, 'x.svg');
    fs.writeFileSync(src, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.throws(() => makeSpiLogos(src, path.join(dir, 'out'), 'f9a3'), /not a JPEG/);
  });
});

describe('SPI logos from the web', () => {
  const SI = `<?xml version="1.0"?><serviceInformation xmlns="http://www.worlddab.org/schemas/spi"><services>
    <service><mediumName>Other</mediumName><bearer id="dab:ce1.c1ce.cafc.0"/></service>
    <service><shortName>F3 Gold</shortName><longName>Fréquence 3 Gold</longName>
      <mediaDescription><multimedia url="logo/32.png" width="32" height="32" mimeValue="image/png"/></mediaDescription>
      <mediaDescription><multimedia url="/logo/112.png" type="logo_colour_rectangle"/></mediaDescription>
      <mediaDescription><multimedia url="https://cdn.example/600.jpg" width="600" height="600"/></mediaDescription>
      <bearer id="fm:fe1.f9a3.09850"/><bearer id="https://stream.example/gold"/></service></services></serviceInformation>`;
  const pic = (size, colour) => execFileSync('convert', ['-size', size, `xc:${colour}`, 'png:-']);
  const files = { 'https://st.example/spi/logo/32.png': pic('32x32', 'red'), 'https://st.example/logo/112.png': pic('112x32', 'blue'),
    'https://cdn.example/600.jpg': pic('600x600', 'green'), 'https://st.example/spi/SI.xml': Buffer.from(SI), 'https://x.example/logo.png': pic('300x300', 'yellow') };
  const fetched = [];
  const fetchImpl = async (url) => { fetched.push(url); const b = files[url];
    return b ? { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => b } : { ok: false, status: 404, headers: new Map() }; };

  it('SI.xml: names, bearers, logos (relative URLs, SPI v1 types)', () => {
    const [, gold] = parseSiXml(SI, 'https://st.example/spi/SI.xml');
    assert.equal(gold.name, 'Fréquence 3 Gold');
    assert.deepEqual(gold.logos.map((l) => [l.url, l.width, l.height]), [['https://st.example/spi/logo/32.png', 32, 32], ['https://st.example/logo/112.png', 112, 32], ['https://cdn.example/600.jpg', 600, 600]]);
    assert.ok(siServiceHasPi(gold, 'f9a3'), 'FM bearer');
    assert.ok(siServiceHasPi(parseSiXml(SI)[0], 'cafc'), 'DAB bearer');
    assert.ok(!siServiceHasPi(gold, 'cafc'));
  });

  it('SI.xml: the station sizes as they are, the others from its biggest logo', async () => {
    const dir = tmp();
    const r = await importSpiLogos('https://st.example/spi/SI.xml', dir, 'f9a3', { fetchImpl });
    assert.deepEqual(r.exact, ['112x32', '32x32']);
    assert.equal(r.service, 'Fréquence 3 Gold');
    for (const [w, h] of SPI_SIZES) assert.equal(execFileSync('identify', ['-format', '%m %wx%h', path.join(dir, spiFileName('f9a3', w, h))], { encoding: 'utf8' }), `PNG ${w}x${h}`);
    const c32 = execFileSync('convert', [path.join(dir, 'f9a3-32x32.png'), '-format', '%[pixel:p{5,5}]', 'info:'], { encoding: 'utf8' });
    assert.match(c32, /red|255,0,0/, 'the station 32x32, not a resized 600x600');
    assert.ok(fs.readdirSync(dir).every((f) => !f.startsWith('.web_')), 'temp files removed');
  });

  it('SI.xml without this PI: list of stations, then the one picked', async () => {
    const dir = tmp();
    const r = await importSpiLogos('https://st.example/spi/SI.xml', dir, 'abcd', { fetchImpl });
    assert.deepEqual(r.choices.map((c) => c.name), ['Other', 'Fréquence 3 Gold']);
    assert.deepEqual(r.choices[1].bearers, ['fm:fe1.f9a3.09850'], 'web streams not listed');
    const p = await importSpiLogos('https://st.example/spi/SI.xml', dir, 'abcd', { fetchImpl, pick: 1 });
    assert.equal(p.ok, true);
    await assert.rejects(importSpiLogos('https://st.example/spi/SI.xml', dir, 'abcd', { fetchImpl, pick: 0 }), /no logo for Other/);
  });

  it('Test (dryRun): what the address is, nothing written', async () => {
    const dir = tmp();
    const p = await importSpiLogos('https://x.example/logo.png', dir, 'f9a3', { fetchImpl, dryRun: true });
    assert.deepEqual([p.from, p.format, p.width, p.height], ['picture', 'PNG', 300, 300]);
    assert.ok(p.preview.startsWith('data:image/png;base64,'));
    const si = await importSpiLogos('https://st.example/spi/SI.xml', dir, 'f9a3', { fetchImpl, dryRun: true });
    assert.deepEqual([si.service, si.matched, si.exact, si.biggest], ['Fréquence 3 Gold', true, ['112x32', '32x32'], '600x600']);
    assert.ok(si.preview, 'preview of its biggest logo (no 128x128)');
    assert.ok((await importSpiLogos('https://st.example/spi/SI.xml', dir, 'abcd', { fetchImpl, dryRun: true })).choices, 'unknown PI: the list');
    assert.equal(fs.readdirSync(dir).length, 0, 'nothing written');
  });

  it('a picture URL: the 4 sizes from it', async () => {
    const dir = tmp();
    const r = await importSpiLogos('https://x.example/logo.png', dir, 'ensemble', { fetchImpl });
    assert.equal(r.from, 'picture');
    assert.ok(Object.values(spiLogoInfo(dir, 'ensemble')).every(Boolean));
    await assert.rejects(importSpiLogos('https://x.example/missing.png', dir, 'ensemble', { fetchImpl }), /HTTP 404/);
  });
});

describe('SPI / EPG in the configuration and service files', () => {
  const png = (size) => execFileSync('convert', ['-size', size, 'xc:red', 'png:-']);
  const setup = () => {
    const dir = tmp();
    const logos = spiLogosDir(dir);
    fs.mkdirSync(logos, { recursive: true });
    for (const [sid, sizes] of [['f9a3', SPI_SIZES], ['ensemble', [[32, 32]]], ['42f1', [[32, 32]]]]) {
      for (const [w, h] of sizes) fs.writeFileSync(path.join(logos, spiFileName(sid, w, h)), png(`${w}x${h}`));
    }
    saveEpgEntry(dir, 'F9A3', { source: 'grid', grid: [{ days: [1], start: '06:00', end: '09:00', title: 'Matin' }] });
    saveEpgEntry(dir, '42F1', { source: 'none' });
    saveSpiWebUrl(dir, 'F9A3', 'https://st.example/SI.xml');
    saveSpiWebUrl(dir, 'ensemble', 'https://mux.example/logo.png');
    saveSpiWebUrl(dir, '42F1', 'file:///etc/passwd');   // refused
    return dir;
  };

  it('export: logos of the services asked (+ multiplex), guide sources set; nothing else', () => {
    const dir = setup();
    const b = exportSpiBundle(dir, [{ id: 'F9A3', sid: 'f9a3' }, { id: '42F1', sid: '42f1' }], { ensemble: true });
    assert.deepEqual(Object.keys(b.logos).sort(), ['42f1-32x32.png', 'ensemble-32x32.png', 'f9a3-112x32.png', 'f9a3-128x128.png', 'f9a3-320x240.png', 'f9a3-32x32.png']);
    assert.ok(b.logos['f9a3-32x32.png'].startsWith('data:image/png;base64,iVBOR'));
    assert.deepEqual(Object.keys(b.epg), ['F9A3'], 'source none is not exported');
    assert.deepEqual(b.webUrls, { F9A3: 'https://st.example/SI.xml', ensemble: 'https://mux.example/logo.png' });
    assert.deepEqual(exportSpiBundle(tmp(), [{ id: 'X', sid: 'abcd' }]), {}, 'nothing → nothing added to the file');
  });

  it('import: written for the service here (new PI), only SPI PNG names, multiplex only when asked', () => {
    const b = exportSpiBundle(setup(), [{ id: 'F9A3', sid: 'f9a3' }, { id: '42F1', sid: '42f1' }], { ensemble: true });
    b.logos['../evil-32x32.png'] = b.logos['f9a3-32x32.png'];
    b.logos['f9a3-64x64.png'] = b.logos['f9a3-32x32.png'];
    b.logos['42f1-32x32.png'] = 'data:image/png;base64,' + Buffer.from('<svg/>').toString('base64');
    const dir = tmp();
    const r = importSpiBundle(dir, b, [{ from: { id: 'F9A3', sid: 'f9a3' }, to: { id: 'E001', sid: 'e001' } }, { from: { id: '42F1', sid: '42f1' }, to: { id: '42F1', sid: '42f1' } }]);
    assert.deepEqual(r, { logos: 4, epg: 1, webUrls: 1 });
    assert.deepEqual(loadSpiWebUrls(dir), { E001: 'https://st.example/SI.xml' }, 'address under the new id, multiplex not asked');
    assert.deepEqual(fs.readdirSync(spiLogosDir(dir)).sort(), ['e001-112x32.png', 'e001-128x128.png', 'e001-320x240.png', 'e001-32x32.png'], 'not a PNG / not an SPI size / path / multiplex: skipped');
    assert.equal(loadEpgConfig(dir).E001.grid[0].title, 'Matin', 'guide source under the new id');
    assert.equal(importSpiBundle(dir, b, [], { ensemble: true }).logos, 1, 'multiplex logo with ensemble: true');
    assert.equal(loadSpiWebUrls(dir).ensemble, 'https://mux.example/logo.png');
  });
});

describe('SPI data of a service whose PI changes, empty carousel', () => {
  it('logos, guide source and web address follow the new PI', () => {
    const dir = tmp();
    fs.mkdirSync(spiLogosDir(dir), { recursive: true });
    for (const [w, h] of SPI_SIZES) fs.writeFileSync(path.join(spiLogosDir(dir), spiFileName('f9a3', w, h)), 'png');
    saveEpgEntry(dir, 'F9A3', { source: 'grid', grid: [{ days: [1], start: '06:00', end: '09:00', title: 'Matin' }] });
    saveSpiWebUrl(dir, 'F9A3', 'https://st.example/SI.xml');
    assert.ok(renameSpiService(dir, { id: 'F9A3', sid: 'f9a3' }, { id: 'F9A4', sid: 'f9a4' }) >= 6);
    assert.deepEqual(fs.readdirSync(spiLogosDir(dir)).sort(), SPI_SIZES.map(([w, h]) => spiFileName('f9a4', w, h)).sort());
    assert.equal(loadEpgConfig(dir).F9A4.grid[0].title, 'Matin');
    assert.equal(loadEpgConfig(dir).F9A3, undefined);
    assert.deepEqual(loadSpiWebUrls(dir), { F9A4: 'https://st.example/SI.xml' });
  });

  it('nothing left: refused at activation, ensemble-only carousel otherwise (the removed content leaves the air)', () => {
    const dir = tmp();
    const args = { dataDir: dir, settings: { spi: { enabled: true, bitrate: 16 }, ensemble: { eccHex: '0xE1', idHex: '0xFFFF', label: 'Mux', shortlabel: 'Mux' } }, services: [{ id: 'F9A3', identity: { pi: '0xF9A3' } }] };
    assert.equal(buildSpiCarousel(args).ok, false);
    const r = buildSpiCarousel({ ...args, allowEmpty: true });
    assert.ok(r.ok);
    assert.deepEqual([r.stats.logos, r.stats.epgDocs], [0, 0]);
  });
});

describe('capacity with the SPI data service (getState)', () => {
  it('counted in totalCu (dataCu) only when activated with a built carousel', async () => {
    const { AppState } = await import('../src/appState.js');
    const { DEFAULT_SETTINGS } = await import('../src/defaults.js');
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
    fs.copyFileSync(new URL('./fixtures/preset-7-services.json', import.meta.url), path.join(dir, 'presets', 'demo.json'));
    const settings = structuredClone(DEFAULT_SETTINGS);
    const state = new AppState({ settings, dataDir: dir, logger: { line() {} }, processManager: { isRunning: () => false } });
    const audio = state.getState().preset.capacity.totalCu;
    assert.equal(state.getState().preset.capacity.dataCu, 0);
    settings.spi = { enabled: true, bitrate: 16, protection: 3 };   // activated, carousel not built yet
    assert.equal(state.getState().preset.capacity.totalCu, audio);
    settings.spi.file = '/x/spi.dat';
    const cap = state.getState().preset.capacity;
    assert.equal(cap.dataCu, 12, '16 kbps EEP-A3');
    assert.equal(cap.totalCu, audio + 12);
  });
});
