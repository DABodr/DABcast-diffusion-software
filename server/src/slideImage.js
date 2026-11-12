// SLS slide conversion: any picture → JPEG 320x240 for odr-padenc.
//
// Covers and logos are often square: fitted into 320x240 they leave side bands. Instead of black,
// each band takes the main colour (median) of the picture's own edge next to it (left / right, or top /
// bottom for wide pictures), so a plain background continues seamlessly and a photo gets bands
// matching its edges. Nothing is cropped. Transparency is flattened on black, as before.
//
// Two ImageMagick calls: resize + flatten to PPM (read by Node to average the edge columns),
// then composition on the two-colour canvas → JPEG.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SLIDE_W = 320;
export const SLIDE_H = 240;

// Binary PPM (P6, maxval 255) → { w, h, data, offset }
export function parsePpm(buf) {
  let pos = 0;
  const token = () => {
    for (;;) {
      while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
      if (buf[pos] === 0x23) { while (pos < buf.length && buf[pos] !== 0x0a) pos++; continue; }   // # comment
      break;
    }
    const start = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    return buf.toString('latin1', start, pos);
  };
  if (token() !== 'P6') throw new Error('not a binary PPM');
  const w = Number(token()), h = Number(token()), max = Number(token());
  if (!(w > 0 && h > 0) || max !== 255) throw new Error('unsupported PPM');
  pos++;   // single whitespace before the pixels
  if (buf.length < pos + w * h * 3) throw new Error('truncated PPM');
  return { w, h, data: buf, offset: pos };
}

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

// Colour of a column (x) or a row (y) of the image: per-channel median, so the main edge colour
// wins over a few pixels of a shape touching the border (an average would tint the band).
function avgLine(img, { x = null, y = null }) {
  const n = x != null ? img.h : img.w;
  const ch = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  for (let i = 0; i < n; i++) {
    const px = x != null ? x : i;
    const py = y != null ? y : i;
    const o = img.offset + (py * img.w + px) * 3;
    ch[0][i] = img.data[o]; ch[1][i] = img.data[o + 1]; ch[2][i] = img.data[o + 2];
  }
  return ch.map((c) => c.sort()[n >> 1]);
}

// Canvas arguments for ImageMagick: band colours taken from the picture edges
export function bandCanvasArgs(img) {
  if (img.w < SLIDE_W) {
    const left = hex(avgLine(img, { x: 0 }));
    const right = hex(avgLine(img, { x: img.w - 1 }));
    return ['-size', `${SLIDE_W}x${SLIDE_H}`, `xc:${left}`, '-fill', right, '-draw', `rectangle ${SLIDE_W / 2},0 ${SLIDE_W - 1},${SLIDE_H - 1}`];
  }
  if (img.h < SLIDE_H) {
    const top = hex(avgLine(img, { y: 0 }));
    const bottom = hex(avgLine(img, { y: img.h - 1 }));
    return ['-size', `${SLIDE_W}x${SLIDE_H}`, `xc:${top}`, '-fill', bottom, '-draw', `rectangle 0,${SLIDE_H / 2} ${SLIDE_W - 1},${SLIDE_H - 1}`];
  }
  return ['-size', `${SLIDE_W}x${SLIDE_H}`, 'xc:black'];
}

// Throws on failure (callers keep their own fallback / logging).
export function convertToSlide(srcPath, destPath, { quality = 85, exec = execFileSync } = {}) {
  const ppm = exec('convert', [`${srcPath}[0]`, '-background', 'black', '-alpha', 'remove', '-alpha', 'off',
    '-resize', `${SLIDE_W}x${SLIDE_H}`, '-depth', '8', 'ppm:-'], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 });   // 8-bit: Q16 builds may write 16-bit PPM
  const img = parsePpm(ppm);
  exec('convert', [...bandCanvasArgs(img), 'ppm:-', '-gravity', 'center', '-composite', '-quality', String(quality), destPath],
    { input: ppm, timeout: 10000 });
}

// Black side bands left by the conversion used before v1.7 (picture centred on black).
// Returns { left, right } widths in pixels, or null when the picture does not have such bands:
// both sides must be dark over their whole height, about the same width (a fitted picture is
// centred) and end on a real transition (the first content column is mostly not dark), so a
// logo with a genuinely black background is left alone.
export function blackBandWidths(img, { dark = 40, minWidth = 8 } = {}) {
  const darkRatio = (x) => {
    let n = 0;
    for (let y = 0; y < img.h; y++) {
      const o = img.offset + (y * img.w + x) * 3;
      if (Math.max(img.data[o], img.data[o + 1], img.data[o + 2]) < dark) n++;
    }
    return n / img.h;
  };
  let left = 0;
  while (left < img.w / 2 && darkRatio(left) > 0.98) left++;
  let right = 0;
  while (right < img.w / 2 && darkRatio(img.w - 1 - right) > 0.98) right++;
  if (left < minWidth || right < minWidth || Math.abs(left - right) > 3) return null;
  if (darkRatio(left) > 0.7 || darkRatio(img.w - 1 - right) > 0.7) return null;
  return { left, right };
}

// Re-convert a slide that has black side bands: crop the picture between the bands and convert it
// again (bands in the edge colours) into `outFile`. Temp file in `tmpDir` (never in the slide dir,
// whose images go on air). Returns true if `outFile` was written.
export function removeBlackBands(file, outFile, tmpDir, { exec = execFileSync } = {}) {
  const img = parsePpm(exec('convert', [`${file}[0]`, '-depth', '8', 'ppm:-'], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 }));
  const bands = blackBandWidths(img);
  if (!bands) return false;
  // 2 more pixels on each side: JPEG blended the old black band into the first content columns,
  // which would give a darkened band colour
  const inset = 2;
  const w = img.w - bands.left - bands.right - 2 * inset;
  const tmp = path.join(tmpDir, `.bands_${process.pid}_${Date.now()}.png`);
  try {
    exec('convert', [`${file}[0]`, '-crop', `${w}x${img.h}+${bands.left + inset}+0`, '+repage', tmp], { timeout: 10000 });
    convertToSlide(tmp, outFile, { exec });
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
  return true;
}
