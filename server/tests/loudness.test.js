// Loudness page (loudness.js): ffmpeg ebur128 summary parsing and the suggested gain (target, true-peak ceiling).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseEbur128Summary, suggestLoudnessGain } from '../src/loudness.js';

const SUMMARY = `[Parsed_ebur128_0 @ 0x55] t: 59.9  M: -14.1 S: -14.3  I: -14.6 LUFS
[Parsed_ebur128_0 @ 0x55] Summary:

  Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.3 LUFS

  Loudness range:
    LRA:         5.4 LU
    Threshold: -34.4 LUFS

  True peak:
    Peak:       -0.3 dBFS`;

let ffmpeg = false;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' }); ffmpeg = true; } catch { /* not installed */ }

describe('loudness (LUFS)', () => {
  it('reads the summary, not the running values', () => {
    assert.deepEqual(parseEbur128Summary(SUMMARY), { lufs: -14.2, lra: 5.4, truePeak: -0.3 });
    assert.equal(parseEbur128Summary('I: -14 LUFS'), null, 'no summary');
    assert.equal(parseEbur128Summary('Summary:\n I: -inf LUFS'), null, 'silence');
  });

  it('real ffmpeg output', { skip: ffmpeg ? false : 'ffmpeg not installed' }, () => {
    const err = execFileSync('sh', ['-c', 'ffmpeg -hide_banner -nostats -f lavfi -i sine=f=1000:d=4 -af ebur128=peak=true -f null - 2>&1']).toString();
    const m = parseEbur128Summary(err);
    assert.ok(m && Math.abs(m.lufs + 21.1) < 0.5, JSON.stringify(m));
    assert.ok(Math.abs(m.truePeak + 18.1) < 0.5);
  });

  it('suggested gain: to the target, in 0.5 dB steps, nothing within 1 dB', () => {
    assert.deepEqual(suggestLoudnessGain(0, { lufs: -14, truePeak: -1 }, -18), { gain: -4, limited: false, peak: false }, 'too loud → lower');
    assert.deepEqual(suggestLoudnessGain(2, { lufs: -20.3, truePeak: -9 }, -18), { gain: 4.5, limited: false, peak: false }, 'too quiet → raise');
    assert.equal(suggestLoudnessGain(0, { lufs: -18.6, truePeak: -3 }, -18).gain, null, 'within 1 dB');
  });

  it('a boost never pushes the true peak above -1 dBTP', () => {
    assert.deepEqual(suggestLoudnessGain(0, { lufs: -24, truePeak: -4 }, -18), { gain: 3, limited: true, peak: false }, '+6 wanted, +3 allowed');
    assert.deepEqual(suggestLoudnessGain(0, { lufs: -24, truePeak: -0.2 }, -18), { gain: null, limited: true, peak: false }, 'no room at all');
    assert.deepEqual(suggestLoudnessGain(0, { lufs: -12, truePeak: -3 }, -18), { gain: -6, limited: false, peak: false }, 'lowering to the target');
  });

  it('a true peak above -1 dBTP forces a reduction, even below the target (measured on the test mux)', () => {
    // F3 Gold: -12.2 LUFS, +3.7 dBTP at -4 dB, target -11.5 → lowered by 4.7 dB for the peaks
    assert.deepEqual(suggestLoudnessGain(-4, { lufs: -12.2, truePeak: 3.7 }, -11.5), { gain: -8.5, limited: true, peak: true });
    // FG Dance: -7.7 LUFS, +3.9 dBTP → the peaks need more than the target (-3.8): -4.9
    assert.deepEqual(suggestLoudnessGain(0, { lufs: -7.7, truePeak: 3.9 }, -11.5), { gain: -5, limited: true, peak: true });
  });

  it('kept within the gain range', () => {
    assert.equal(suggestLoudnessGain(18, { lufs: -40, truePeak: -30 }, -18).gain, 20);
  });
});
