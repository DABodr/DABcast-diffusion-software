// Tests for the web player helpers (no process is spawned here)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePcmFormat, findBin, missingPlayerTools, acquireListenerSlot, playerListeners, makeMeter, playerLevels, makePcmSanitizer, trimAligned } from '../src/player.js';

describe('player — parsePcmFormat', () => {
  it('reads the PCM format printed by dablin', () => {
    const line = 'PCMOutput: format set; samplerate: 48000, channels: 2, output: 32bit float';
    assert.deepEqual(parsePcmFormat(line), { rate: 48000, channels: 2, float: true, bytes: 4, ffmpegFormat: 'f32le' });
  });

  it('handles 32 kHz mono services', () => {
    assert.deepEqual(parsePcmFormat('samplerate: 32000, channels: 1'), { rate: 32000, channels: 1, float: true, bytes: 4, ffmpegFormat: 'f32le' });
  });

  it('detects the 16-bit integer output of fdk-aac builds of dablin', () => {
    const line = 'PCMOutput: format set; samplerate: 48000, channels: 2, output: 16bit integer';
    assert.deepEqual(parsePcmFormat(line), { rate: 48000, channels: 2, float: false, bytes: 2, ffmpegFormat: 's16le' });
  });

  it('returns null until the format line arrives', () => {
    assert.equal(parsePcmFormat('EnsemblePlayer: playing sub-channel 1 (DAB+)'), null);
  });
});

describe('player — tools and listeners', () => {
  it('findBin locates a binary on PATH and rejects unknown ones', () => {
    assert.ok(findBin('sh'));
    assert.equal(findBin('surely-not-a-real-binary-xyz'), null);
  });

  it('missingPlayerTools only lists dablin / ffmpeg', () => {
    for (const m of missingPlayerTools()) assert.ok(['dablin', 'ffmpeg'].includes(m));
  });

  it('starts with no listener and a free slot', () => {
    assert.equal(playerListeners(), 0);
    assert.equal(acquireListenerSlot(), true);
  });
});

describe('player — server-side meter', () => {
  // interleaved float32 stereo PCM: L at amplitude a, R at amplitude b
  const pcm = (frames, a, b) => {
    const buf = Buffer.alloc(frames * 8);
    for (let i = 0; i < frames; i++) { buf.writeFloatLE(i % 2 ? a : -a, i * 8); buf.writeFloatLE(b, i * 8 + 4); }
    return buf;
  };

  it('emits one level per 50 ms window, stamped on the stream timeline', () => {
    const out = [];
    makeMeter(48000, 2, out)(pcm(4800, 0.5, 0.1));   // 100 ms of audio
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((x) => x[0]), [0.05, 0.1]);
    assert.equal(out[0][1], -6);    // 0.5 → -6.0 dBFS
    assert.equal(out[0][2], -20);   // 0.1 → -20.0 dBFS
  });

  it('keeps frames split across chunk boundaries aligned', () => {
    const out = [];
    const meter = makeMeter(48000, 2, out);
    const b = pcm(2400, 1, 0.01);
    meter(b.subarray(0, 4803));     // cut in the middle of a sample
    meter(b.subarray(4803));
    assert.equal(out.length, 1);
    assert.equal(out[0][1], 0);
    assert.equal(out[0][2], -40);
  });

  it('reports silence as -99 dB and unknown streams as null', () => {
    const out = [];
    makeMeter(48000, 1, out)(Buffer.alloc(2400 * 4));
    assert.deepEqual(out[0], [0.05, -99, -99]);
    assert.equal(playerLevels('no-such-key'), null);
  });
});

describe('player — PCM kept aligned and valid for the MP3 encoder', () => {
  // stereo float32 test signal: sample k = k / 1e6 (finite, easy to check)
  const signal = (frames) => {
    const f = new Float32Array(frames * 2);
    for (let k = 0; k < f.length; k++) f[k] = k / 1e6;
    return Buffer.from(f.buffer);
  };
  const floats = (buf) => new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);

  it('slow start: trimming the start-up buffer never cuts inside a sample', () => {
    const src = signal(48000 * 3);                       // 3 s produced before ffmpeg starts
    let early = Buffer.alloc(0);
    for (let off = 0, n = 1; off < src.length; off += n, n = (n * 7 + 13) % 5003 + 1) {   // odd chunk sizes
      early = trimAligned(Buffer.concat([early, src.subarray(off, off + n)]), 384000);
    }
    assert.equal(early.length % 8, 0);
    assert.ok(early.length <= 384000);
    const out = floats(makePcmSanitizer(2)(early));
    const first = Math.round(out[0] * 1e6);
    for (let i = 0; i < out.length; i++) assert.equal(Math.round(out[i] * 1e6), first + i);   // contiguous, no garbage
  });

  it('chunks split mid-sample come out as whole frames, in order', () => {
    const src = signal(1000);
    const sanitize = makePcmSanitizer(2);
    const parts = [src.subarray(0, 3), src.subarray(3, 4001), src.subarray(4001)].map(sanitize);
    assert.deepEqual(parts.map((p) => p.length % 8), [0, 0, 0]);
    assert.deepEqual(Buffer.concat(parts), src);
  });

  it('replaces NaN / Infinity by 0 and reports them', () => {
    const f = new Float32Array([0.5, NaN, -0.5, Infinity, -Infinity, 0.25]);
    let reported = 0;
    const out = floats(makePcmSanitizer(2, (n) => { reported = n; })(Buffer.from(f.buffer)));
    assert.deepEqual([...out], [0.5, 0, -0.5, 0, 0, 0.25]);
    assert.equal(reported, 3);
  });
});

describe('player — 16-bit integer PCM (fdk-aac builds of dablin)', () => {
  const S16 = { float: false, bytes: 2 };
  const s16 = (vals) => { const b = Buffer.alloc(vals.length * 2); vals.forEach((v, i) => b.writeInt16LE(v, i * 2)); return b; };

  it('meter reads s16 samples (16384 = -6 dBFS)', () => {
    const out = [];
    const frames = [];
    for (let i = 0; i < 2400; i++) frames.push(16384, -3277);   // L 0.5, R ~0.1
    makeMeter(48000, 2, out, S16)(s16(frames));
    assert.equal(out.length, 1);
    assert.equal(out[0][1], -6);
    assert.equal(out[0][2], -20);
  });

  it('sanitizer keeps s16 frames whole (4 bytes in stereo) and leaves values untouched', () => {
    const src = s16([1, -2, 3, -4, 5, -6]);
    const sanitize = makePcmSanitizer(2, () => { throw new Error('no invalid sample in s16'); }, S16);
    const parts = [src.subarray(0, 5), src.subarray(5)].map(sanitize);
    assert.deepEqual(parts.map((p) => p.length), [4, 8]);
    assert.deepEqual(Buffer.concat(parts), src);
  });
});
