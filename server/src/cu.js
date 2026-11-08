// ETSI EN 300 401 — EEP CU calculation
// eepMode: 'A' (default, short form) or 'B' (long form)

export const EEP_A = 'A';
export const EEP_B = 'B';

/**
 * Calculate capacity units for a DAB+ audio subchannel.
 * EEP-A (default): protection 1-4
 * EEP-B: protection 1-4, different multipliers (ETSI EN 300 401 table 9)
 */
export function estimateCU(bitrateKbps, protectionLevel = 3, eepMode = EEP_A) {
  const br = Number(bitrateKbps) || 0;
  const pl = Number(protectionLevel);

  if (eepMode === EEP_B) {
    switch (pl) {
      case 1: return Math.ceil(27 * br / 32);
      case 2: return Math.ceil(21 * br / 32);
      case 3: return Math.ceil(18 * br / 32);
      case 4: return Math.ceil(15 * br / 32);
      default: return Math.ceil(18 * br / 32);
    }
  }

  // EEP-A (default)
  switch (pl) {
    case 1: return Math.ceil(12 * br / 8);
    case 2: return br;
    case 3: return Math.ceil(6 * br / 8);
    case 4: return Math.ceil(4 * br / 8);
    default: return Math.ceil(6 * br / 8);
  }
}

export function sumCU(services) {
  let total = 0;
  for (const s of services) {
    if (s && s.enabled) {
      const eep = s.dab?.eepMode || EEP_A;
      total += estimateCU(s.dab?.bitrateKbps ?? 0, s.dab?.protectionLevel ?? 3, eep);
    }
  }
  return total;
}
