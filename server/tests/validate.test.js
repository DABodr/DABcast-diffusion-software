import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateService, normalizePi } from '../src/odr/validate.js';
import { ALLOWED_BITRATES_KBPS } from '../src/defaults.js';

describe('normalizePi', () => {
  it('normalizes bare hex', () => assert.equal(normalizePi('f408'), '0xF408'));
  it('normalizes 0x prefix', () => assert.equal(normalizePi('0xf408'), '0xF408'));
  it('rejects 3-char hex', () => assert.equal(normalizePi('F40'), null));
  it('rejects 5-char hex', () => assert.equal(normalizePi('F4080'), null));
  it('rejects non-hex', () => assert.equal(normalizePi('ZZZZ'), null));
  it('rejects empty', () => assert.equal(normalizePi(''), null));
});

describe('validateService', () => {
  const validSvc = {
    identity: { pi: 'F408', ps8: 'TEST', ps16: 'TESTRADIO' },
    dab: { bitrateKbps: 88, protectionLevel: 3 },
    network: { ediOutputTcp: { port: 9001 } }
  };

  it('accepts valid service', () => {
    const { errors } = validateService(validSvc, ALLOWED_BITRATES_KBPS);
    assert.equal(errors.length, 0);
  });

  it('rejects invalid PI', () => {
    const { errors } = validateService({ ...validSvc, identity: { ...validSvc.identity, pi: 'ZZ' } }, ALLOWED_BITRATES_KBPS);
    assert.ok(errors.some((e) => e.includes('PI')));
  });

  it('rejects PS8 > 8 chars', () => {
    const { errors } = validateService({ ...validSvc, identity: { ...validSvc.identity, ps8: 'TOOLONGPS' } }, ALLOWED_BITRATES_KBPS);
    assert.ok(errors.some((e) => e.includes('PS8')));
  });

  it('rejects invalid bitrate (e.g. 8)', () => {
    const { errors } = validateService({ ...validSvc, dab: { bitrateKbps: 8 } }, ALLOWED_BITRATES_KBPS);
    assert.ok(errors.some((e) => e.includes('Bitrate')));
  });

  it('accepts new high bitrate 384', () => {
    const { errors } = validateService({ ...validSvc, dab: { bitrateKbps: 384 } }, ALLOWED_BITRATES_KBPS);
    assert.ok(!errors.some((e) => e.includes('Bitrate')));
  });

  it('accepts PS8 subset of PS16 (RVM / Radio Val Meuse)', () => {
    const svc = { ...validSvc, identity: { ...validSvc.identity, ps8: 'RVM', ps16: 'Radio Val Meuse' } };
    const { errors } = validateService(svc, ALLOWED_BITRATES_KBPS);
    assert.ok(!errors.some((e) => e.includes('PS16')));
  });

  it('rejects PS8 not subset of PS16 (RVM / Radio Meuse)', () => {
    const svc = { ...validSvc, identity: { ...validSvc.identity, ps8: 'RVM', ps16: 'Radio Meuse' } };
    const { errors } = validateService(svc, ALLOWED_BITRATES_KBPS);
    assert.ok(errors.some((e) => e.includes('PS16')));
  });

  it('accepts PS8 with spaces (R V M / Radio Val Meuse)', () => {
    const svc = { ...validSvc, identity: { ...validSvc.identity, ps8: 'R V M', ps16: 'Radio Val Meuse' } };
    const { errors } = validateService(svc, ALLOWED_BITRATES_KBPS);
    assert.ok(!errors.some((e) => e.includes('PS16')));
  });

  it('skips PS8/PS16 check when PS16 is empty', () => {
    const svc = { ...validSvc, identity: { ...validSvc.identity, ps8: 'RVM', ps16: '' } };
    const { errors } = validateService(svc, ALLOWED_BITRATES_KBPS);
    assert.ok(!errors.some((e) => e.includes('PS16')));
  });

  it('rejects HE-AAC v2 (PS) with mono channels', () => {
    const svc = { ...validSvc, audio: { codec: 'HE-AAC v2 (PS)', channels: 1 } };
    const { errors } = validateService(svc, ALLOWED_BITRATES_KBPS);
    assert.ok(errors.some((e) => e.includes('PS') && e.includes('stéréo')));
  });

  it('accepts HE-AAC v2 (PS) with stereo channels', () => {
    const svc = { ...validSvc, audio: { codec: 'HE-AAC v2 (PS)', channels: 2 } };
    const { errors } = validateService(svc, ALLOWED_BITRATES_KBPS);
    assert.ok(!errors.some((e) => e.includes('PS')));
  });

  it('accepts HE-AAC v1 (SBR) with mono channels', () => {
    const svc = { ...validSvc, audio: { codec: 'HE-AAC v1 (SBR)', channels: 1 } };
    const { errors } = validateService(svc, ALLOWED_BITRATES_KBPS);
    assert.ok(!errors.some((e) => e.includes('PS')));
  });

  it('warns when using VLC mode with HTTP stream', () => {
    const svc = { ...validSvc, input: { mode: 'VLC', uri: 'http://stream.example.com/audio.mp3' } };
    const { errors, warnings } = validateService(svc, ALLOWED_BITRATES_KBPS);
    assert.equal(errors.length, 0);
    assert.ok(warnings?.length > 0);
    assert.ok(warnings.some((w) => w.includes('GStreamer')));
  });

  it('does not warn when using GST mode with HTTP stream', () => {
    const svc = { ...validSvc, input: { mode: 'GST', uri: 'http://stream.example.com/audio.mp3' } };
    const { warnings } = validateService(svc, ALLOWED_BITRATES_KBPS);
    assert.ok(!warnings?.length || !warnings.some((w) => w.includes('GStreamer')));
  });

  it('does not warn when using VLC mode with non-HTTP source', () => {
    const svc = { ...validSvc, input: { mode: 'VLC', uri: 'alsa://hw:0,0' } };
    const { warnings } = validateService(svc, ALLOWED_BITRATES_KBPS);
    assert.ok(!warnings?.length || !warnings.some((w) => w.includes('GStreamer')));
  });
});
