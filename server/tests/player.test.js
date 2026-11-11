// Tests for the web player helpers (no process is spawned here)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePcmFormat, findBin, missingPlayerTools, acquireListenerSlot, playerListeners } from '../src/player.js';

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
