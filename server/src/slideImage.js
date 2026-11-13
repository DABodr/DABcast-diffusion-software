// SLS slide conversion: any picture → JPEG 320x240 for odr-padenc.
//
// Covers and logos are often square: fitted into 320x240 they leave side bands. Instead of black,
// each band row takes the colour of the picture's edge on that row, as the per-channel median of
// the neighbouring rows (±EDGE_WINDOW): a plain background or a vertical gradient continues
// seamlessly, while a small shape touching the border (a ring, a letter) does not streak the band.
// Same for top / bottom bands of wide pictures. Nothing is cropped. Transparency is flattened on
// black, as before.
//
// Two ImageMagick calls: resize + flatten to PPM, then (after Node composed the 320x240 picture)
// PPM → JPEG.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SLIDE_W = 320;
export const SLIDE_H = 240;

// Input formats, recognised from the first bytes of the file and given explicitly to ImageMagick
// ("JPEG:file[0]"). Otherwise ImageMagick guesses the format from the content and also reads script
// formats (MVG, MSL, SVG, TEXT…) that the Debian policy still allows: a cover sent by a third-party
// metadata API must never be read as one (security review). null = not an accepted picture.
export function imageCoder(file) {
  const b = Buffer.alloc(12);
  let n = 0;
  try {
    const fd = fs.openSync(file, 'r');
    try { n = fs.readSync(fd, b, 0, 12, 0); } finally { fs.closeSync(fd); }
  } catch { return null; }
  if (n >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'JPEG';
  if (n >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'PNG';
  if (n >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'GIF';
  if (n >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'WEBP';
  return null;
}
// "<FORMAT>:<file>[0]" for ImageMagick, or throws (callers keep their fallback / logging)
function imageInput(file) {
  const coder = imageCoder(file);
  if (!coder) throw new Error('not a JPEG / PNG / GIF / WebP picture');
  return `${coder}:${file}[0]`;
}

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

const EDGE_WINDOW = 60;   // rows (or columns) on each side taken into the running median

// Pixel (x, y) of a parsed PPM → offset in its buffer
const at = (img, x, y) => img.offset + (y * img.w + x) * 3;

// Running per-channel median along an edge line of n pixels (pixel i read by get(i) → [r, g, b])
function runningMedian(n, get, win = EDGE_WINDOW) {
  const px = Array.from({ length: n }, (_, i) => get(i));
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - win), hi = Math.min(n - 1, i + win);
    const c = [[], [], []];
    for (let j = lo; j <= hi; j++) for (let k = 0; k < 3; k++) c[k].push(px[j][k]);
    out[i] = c.map((v) => v.sort((a, b2) => a - b2)[v.length >> 1]);
  }
  return out;
}

// Compose the 320x240 slide (binary PPM) from the fitted picture: picture centred, bands filled
// with the running median of its edges.
export function composeSlide(img) {
  const W = SLIDE_W, H = SLIDE_H;
  const head = Buffer.from(`P6\n${W} ${H}\n255\n`, 'latin1');
  const out = Buffer.alloc(W * H * 3);
  const ox = Math.floor((W - img.w) / 2), oy = Math.floor((H - img.h) / 2);
  const pix = (x, y) => { const o = at(img, x, y); return [img.data[o], img.data[o + 1], img.data[o + 2]]; };
  let left = null, right = null, top = null, bottom = null;
  if (img.w < W) {
    left = runningMedian(img.h, (y) => pix(0, y));
    right = runningMedian(img.h, (y) => pix(img.w - 1, y));
  } else if (img.h < H) {
    top = runningMedian(img.w, (x) => pix(x, 0));
    bottom = runningMedian(img.w, (x) => pix(x, img.h - 1));
  }
  for (let y = 0; y < H; y++) {
    const cy = Math.min(img.h - 1, Math.max(0, y - oy));
    for (let x = 0; x < W; x++) {
      const cx = x - ox;
      let c;
      if (cx >= 0 && cx < img.w && y - oy >= 0 && y - oy < img.h) c = pix(cx, y - oy);
      else if (left) c = cx < 0 ? left[cy] : right[cy];
      else if (top) c = y - oy < 0 ? top[Math.min(img.w - 1, Math.max(0, cx))] : bottom[Math.min(img.w - 1, Math.max(0, cx))];
      else c = [0, 0, 0];
      out.set(c, (y * W + x) * 3);
    }
  }
  return Buffer.concat([head, out]);
}

// Throws on failure (callers keep their own fallback / logging).
export function convertToSlide(srcPath, destPath, { quality = 85, exec = execFileSync } = {}) {
  const ppm = exec('convert', [imageInput(srcPath), '-background', 'black', '-alpha', 'remove', '-alpha', 'off',
    '-resize', `${SLIDE_W}x${SLIDE_H}`, '-depth', '8', 'ppm:-'], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 });   // 8-bit: Q16 builds may write 16-bit PPM
  exec('convert', ['ppm:-', '-quality', String(quality), destPath], { input: composeSlide(parsePpm(ppm)), timeout: 10000 });
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
  const img = parsePpm(exec('convert', [imageInput(file), '-depth', '8', 'ppm:-'], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 }));
  const bands = blackBandWidths(img);
  if (!bands) return false;
  // 8 more pixels on each side (one JPEG block): JPEG blended the old black band into the first
  // content columns, which would give a darkened band colour (2 px was not enough)
  const inset = 8;
  const w = img.w - bands.left - bands.right - 2 * inset;
  const tmp = path.join(tmpDir, `.bands_${process.pid}_${Date.now()}.png`);
  try {
    exec('convert', [imageInput(file), '-crop', `${w}x${img.h}+${bands.left + inset}+0`, '+repage', tmp], { timeout: 10000 });
    convertToSlide(tmp, outFile, { exec });
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
  return true;
}
