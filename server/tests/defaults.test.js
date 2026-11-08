import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_BITRATES_KBPS, DEFAULT_BITRATE_KBPS, DEFAULT_ZMQ_BUFFER, DEFAULT_ZMQ_PREBUFFER, PTY_LIST, DAB_CHANNELS } from '../src/defaults.js';

describe('ALLOWED_BITRATES_KBPS', () => {
  it('has 22 values (ETSI EN 300 401)', () => {
    assert.equal(ALLOWED_BITRATES_KBPS.length, 22);
  });

  it('starts at 32 (no 8/16/24)', () => {
    assert.equal(ALLOWED_BITRATES_KBPS[0], 32);
  });

  it('ends at 384', () => {
    assert.equal(ALLOWED_BITRATES_KBPS[ALLOWED_BITRATES_KBPS.length - 1], 384);
  });

  it('includes 88 (default bitrate)', () => {
    assert.ok(ALLOWED_BITRATES_KBPS.includes(88));
  });

  it('includes high bitrates 224, 256, 320, 384', () => {
    assert.ok(ALLOWED_BITRATES_KBPS.includes(224));
    assert.ok(ALLOWED_BITRATES_KBPS.includes(256));
    assert.ok(ALLOWED_BITRATES_KBPS.includes(320));
    assert.ok(ALLOWED_BITRATES_KBPS.includes(384));
  });

  it('does NOT include invalid intermediates 168, 176, 184', () => {
    assert.ok(!ALLOWED_BITRATES_KBPS.includes(168));
    assert.ok(!ALLOWED_BITRATES_KBPS.includes(176));
    assert.ok(!ALLOWED_BITRATES_KBPS.includes(184));
  });
});

describe('Default constants', () => {
  it('DEFAULT_BITRATE_KBPS = 88', () => assert.equal(DEFAULT_BITRATE_KBPS, 88));
  it('DEFAULT_ZMQ_BUFFER = 40', () => assert.equal(DEFAULT_ZMQ_BUFFER, 40));
  it('DEFAULT_ZMQ_PREBUFFER = 20', () => assert.equal(DEFAULT_ZMQ_PREBUFFER, 20));
});

describe('PTY_LIST', () => {
  it('has 30 entries (0-29)', () => assert.equal(PTY_LIST.length, 30));
  it('starts with None (0)', () => assert.equal(PTY_LIST[0].value, 0));
  it('ends with Documentary (29)', () => assert.equal(PTY_LIST[29].value, 29));
});

describe('DAB_CHANNELS', () => {
  it('starts with 5A', () => assert.equal(DAB_CHANNELS[0], '5A'));
  it('ends with 13F', () => assert.equal(DAB_CHANNELS[DAB_CHANNELS.length - 1], '13F'));
  it('has 38 channels', () => assert.equal(DAB_CHANNELS.length, 38));
});
