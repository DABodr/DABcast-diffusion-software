// Tests for the SLS slide conversion (bands in the picture's own edge colours)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parsePpm, bandCanvasArgs, convertToSlide, blackBandWidths, removeBlackBands } from '../src/slideImage.js';

// w x h PPM, colour of each pixel given by fn(x, y) → [r, g, b]
const ppm = (w, h, fn) => {
  const head = Buffer.from(`P6\n# test\n${w} ${h}\n255\n`, 'latin1');
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(fn(x, y), (y * w + x) * 3);
  return Buffer.concat([head, px]);
};
const hasConvert = (() => { try { execFileSync('convert', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe('slideImage — band colours', () => {
  it('parses a binary PPM with a comment', () => {
    const img = parsePpm(ppm(3, 2, () => [1, 2, 3]));
    assert.equal(img.w, 3);
    assert.equal(img.h, 2);
    assert.deepEqual([...img.data.subarray(img.offset, img.offset + 3)], [1, 2, 3]);
  });

  it('square picture (240x240): left band = left edge colour, right band = right edge colour', () => {
    const img = parsePpm(ppm(240, 240, (x) => (x < 120 ? [255, 0, 128] : [0, 64, 255])));
    const args = bandCanvasArgs(img);
    assert.ok(args.includes('xc:#ff0080'), args.join(' '));
    assert.ok(args.includes('#0040ff'), args.join(' '));
    assert.ok(args.includes('rectangle 160,0 319,239'));
  });

  it('the main edge colour wins over a shape touching the border (median, not average)', () => {
    // white edge with a red shape over 30 % of its height
    const img = parsePpm(ppm(240, 240, (x, y) => (y > 80 && y < 152 ? [255, 0, 0] : [255, 255, 255])));
    assert.ok(bandCanvasArgs(img).includes('xc:#ffffff'));
  });

  it('wide picture (320x100): top / bottom bands from the top / bottom rows', () => {
    const img = parsePpm(ppm(320, 100, (x, y) => (y < 50 ? [255, 255, 255] : [0, 0, 0])));
    const args = bandCanvasArgs(img);
    assert.ok(args.includes('xc:#ffffff'));
    assert.ok(args.includes('#000000'));
    assert.ok(args.includes('rectangle 0,120 319,239'));
  });

  it('picture already 320x240: no band', () => {
    assert.deepEqual(bandCanvasArgs(parsePpm(ppm(320, 240, () => [9, 9, 9]))).slice(-1), ['xc:black']);
  });
});

describe('slideImage — conversion (ImageMagick)', { skip: !hasConvert && 'ImageMagick not installed' }, () => {
  it('a white-background square logo gives a 320x240 JPEG with white sides (no black band)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-slideimg-'));
    const src = path.join(dir, 'logo.png');
    const dest = path.join(dir, 'logo.jpg');
    // 300x300 white square with a blue disc in the middle
    execFileSync('convert', ['-size', '300x300', 'xc:white', '-fill', '#0040ff', '-draw', 'circle 150,150 150,40', src]);
    convertToSlide(src, dest);
    const info = execFileSync('identify', ['-format', '%m %w %h', dest], { encoding: 'utf8' });
    assert.equal(info, 'JPEG 320 240');
    const corner = (x) => execFileSync('convert', [dest, '-format', `%[fx:int(255*p{${x},120}.r)] %[fx:int(255*p{${x},120}.g)] %[fx:int(255*p{${x},120}.b)]`, 'info:'], { encoding: 'utf8' })
      .split(' ').map(Number);
    for (const x of [2, 317]) for (const v of corner(x)) assert.ok(v > 240, `pixel ${x},120 should be white, got ${corner(x)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('slideImage — black bands of old slides', () => {
  const W = 320, H = 240;
  it('detects the symmetric black bands of a picture fitted on black', () => {
    const img = parsePpm(ppm(W, H, (x) => (x < 40 || x >= 280 ? [0, 0, 0] : [250, 250, 250])));
    assert.deepEqual(blackBandWidths(img), { left: 40, right: 40 });
  });

  it('leaves a logo with a genuinely black background alone (no real transition)', () => {
    // black square logo with a blue disc, itself fitted on black bands
    const img = parsePpm(ppm(W, H, (x, y) => ((x - 160) ** 2 + (y - 120) ** 2 < 90 ** 2 ? [0, 120, 220] : [0, 0, 0])));
    assert.equal(blackBandWidths(img), null);
  });

  it('ignores asymmetric dark edges and pictures without bands', () => {
    assert.equal(blackBandWidths(parsePpm(ppm(W, H, (x) => (x < 40 ? [0, 0, 0] : [250, 250, 250])))), null);
    assert.equal(blackBandWidths(parsePpm(ppm(W, H, () => [250, 250, 250]))), null);
  });
});

describe('slideImage — removing black bands (ImageMagick)', { skip: !hasConvert && 'ImageMagick not installed' }, () => {
  it('re-converts an old banded slide with white sides, temp files outside the slide dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-bands-'));
    const slideDir = path.join(dir, 'slide');
    fs.mkdirSync(slideDir);
    const file = path.join(slideDir, 'logo.jpg');
    // old conversion: 240x240 white logo with a blue disc, centred on black
    execFileSync('convert', ['-size', '240x240', 'xc:white', '-fill', '#0040ff', '-draw', 'circle 120,120 120,30',
      '-background', 'black', '-gravity', 'center', '-extent', '320x240', '-quality', '85', file]);
    const out = path.join(dir, 'new.jpg');
    assert.equal(removeBlackBands(file, out, dir), true);
    const px = (x) => execFileSync('convert', [out, '-format', `%[fx:int(255*p{${x},120}.r)] %[fx:int(255*p{${x},120}.g)] %[fx:int(255*p{${x},120}.b)]`, 'info:'], { encoding: 'utf8' }).split(' ').map(Number);
    for (const x of [3, 316]) for (const v of px(x)) assert.ok(v > 235, `pixel ${x},120 should be white, got ${px(x)}`);
    assert.deepEqual(fs.readdirSync(slideDir), ['logo.jpg'], 'nothing else written in the slide dir');
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('.bands_')).length, 0, 'temp file removed');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
