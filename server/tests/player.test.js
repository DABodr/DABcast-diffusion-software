// Tests for the web player helpers (no process is spawned here)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePcmFormat, findBin, missingPlayerTools, acquireListenerSlot, playerListeners, makeMeter, playerLevels } from '../src/player.js';

describe('player — parsePcmFormat', () => {
  it('reads the PCM format printed by dablin', () => {
    const line = 'PCMOutput: format set; samplerate: 48000, channels: 2, output: 32bit float';
    assert.deepEqual(parsePcmFormat(line), { rate: 48000, channels: 2 });
  });

  it('handles 32 kHz mono services', () => {
    assert.deepEqual(parsePcmFormat('samplerate: 32000, channels: 1'), { rate: 32000, channels: 1 });
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
