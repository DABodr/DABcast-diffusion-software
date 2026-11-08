import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCU, sumCU, EEP_A, EEP_B } from '../src/cu.js';

describe('estimateCU — ETSI EEP-A', () => {
  // ETSI EN 300 401 — protection 3: ceil(6 * br / 8)
  it('88 kbps prot 3 = 66 CU', () => assert.equal(estimateCU(88, 3), 66));
  it('96 kbps prot 3 = 72 CU', () => assert.equal(estimateCU(96, 3), 72));
  it('128 kbps prot 3 = 96 CU', () => assert.equal(estimateCU(128, 3), 96));
  it('64 kbps prot 3 = 48 CU', () => assert.equal(estimateCU(64, 3), 48));

  // Protection 1: ceil(12 * br / 8)
  it('64 kbps prot 1 = 96 CU', () => assert.equal(estimateCU(64, 1), 96));
  it('88 kbps prot 1 = 132 CU', () => assert.equal(estimateCU(88, 1), 132));

  // Protection 2: br
  it('88 kbps prot 2 = 88 CU', () => assert.equal(estimateCU(88, 2), 88));

  // Protection 4: ceil(4 * br / 8)
  it('88 kbps prot 4 = 44 CU', () => assert.equal(estimateCU(88, 4), 44));
  it('96 kbps prot 4 = 48 CU', () => assert.equal(estimateCU(96, 4), 48));

  // Edge cases
  it('0 kbps = 0 CU', () => assert.equal(estimateCU(0, 3), 0));
  it('default prot is 3', () => assert.equal(estimateCU(88), 66));
  it('explicit EEP_A mode same as default', () => assert.equal(estimateCU(88, 3, EEP_A), 66));
});

describe('estimateCU — ETSI EEP-B', () => {
  // ETSI EN 300 401 — EEP-B long form
  // prot 1: ceil(27 * br / 32)
  it('88 kbps EEP-B prot 1 = ceil(27*88/32) = 75 CU', () => assert.equal(estimateCU(88, 1, EEP_B), 75));
  it('128 kbps EEP-B prot 1 = 108 CU', () => assert.equal(estimateCU(128, 1, EEP_B), 108));

  // prot 2: ceil(21 * br / 32)
  it('88 kbps EEP-B prot 2 = ceil(21*88/32) = 58 CU', () => assert.equal(estimateCU(88, 2, EEP_B), 58));
  it('128 kbps EEP-B prot 2 = 84 CU', () => assert.equal(estimateCU(128, 2, EEP_B), 84));

  // prot 3: ceil(18 * br / 32)
  it('88 kbps EEP-B prot 3 = ceil(18*88/32) = 50 CU', () => assert.equal(estimateCU(88, 3, EEP_B), 50));
  it('128 kbps EEP-B prot 3 = 72 CU', () => assert.equal(estimateCU(128, 3, EEP_B), 72));

  // prot 4: ceil(15 * br / 32)
  it('88 kbps EEP-B prot 4 = ceil(15*88/32) = 42 CU', () => assert.equal(estimateCU(88, 4, EEP_B), 42));
  it('128 kbps EEP-B prot 4 = 60 CU', () => assert.equal(estimateCU(128, 4, EEP_B), 60));

  // Edge
  it('0 kbps EEP-B = 0', () => assert.equal(estimateCU(0, 3, EEP_B), 0));
});

describe('sumCU', () => {
  it('sums enabled services only', () => {
    const services = [
      { enabled: true, dab: { bitrateKbps: 88, protectionLevel: 3 } },
      { enabled: false, dab: { bitrateKbps: 128, protectionLevel: 3 } },
      { enabled: true, dab: { bitrateKbps: 96, protectionLevel: 3 } }
    ];
    assert.equal(sumCU(services), 66 + 72);
  });

  it('handles EEP-B services', () => {
    const services = [
      { enabled: true, dab: { bitrateKbps: 88, protectionLevel: 3, eepMode: 'B' } },
      { enabled: true, dab: { bitrateKbps: 88, protectionLevel: 3, eepMode: 'A' } }
    ];
    assert.equal(sumCU(services), 50 + 66);
  });
});
