// SPI service logos (spi.js): the 4 PNG sizes made from the slideshow logo (never a cover), settings defaults.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SPI_SIZES, normalizeSpiSettings, spiSid, spiFileName, isSpiFileName, spiSourceLogo, makeSpiLogos, spiLogoInfo, deleteSpiLogos } from '../src/spi.js';

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
