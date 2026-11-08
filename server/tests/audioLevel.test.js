import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAudioLevel } from '../src/appState.js';

describe('parseAudioLevel', () => {
  it('parses full level both channels', () => {
    const r = parseAudioLevel('In: [======|======] P');
    assert.deepEqual(r, { left: 6, right: 6, clipLeft: false, clipRight: false });
  });

  it('parses silence', () => {
    const r = parseAudioLevel('In: [      |      ] P');
    assert.deepEqual(r, { left: 0, right: 0, clipLeft: false, clipRight: false });
  });

  it('parses partial levels', () => {
    const r = parseAudioLevel('In: [  -===|===-  ] P');
    assert.deepEqual(r, { left: 4, right: 4, clipLeft: false, clipRight: false });
  });

  it('detects clipping on both channels', () => {
    const r = parseAudioLevel('In: [!=====|=====!] P');
    assert.deepEqual(r, { left: 6, right: 6, clipLeft: true, clipRight: true });
  });

  it('detects clipping on left only', () => {
    const r = parseAudioLevel('In: [!=====|====- ] P');
    assert.equal(r.clipLeft, true);
    assert.equal(r.clipRight, false);
  });

  it('returns null for non-level lines', () => {
    assert.equal(parseAudioLevel('Welcome to ODR-AudioEnc v3.5.0'), null);
    assert.equal(parseAudioLevel(''), null);
  });

  it('parses asymmetric levels', () => {
    const r = parseAudioLevel('In: [ -====|====  ] P');
    assert.equal(r.left, 5);
    assert.equal(r.right, 4);
  });
});
