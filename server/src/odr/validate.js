const PI_REGEX = /^(?:0x)?[0-9a-fA-F]{4}$/;

function shortLabelMismatch(ps8, ps16) {
  const short = String(ps8 || '').toUpperCase();
  const long = String(ps16 || '').toUpperCase();
  if (!short || !long) return false;
  let pos = 0;
  for (const ch of short) {
    if (ch === ' ') continue;
    const idx = long.indexOf(ch, pos);
    if (idx === -1) return true;
    pos = idx + 1;
  }
  return false;
}

export function normalizePi(pi) {
  if (!pi) return null;
  const cleaned = String(pi).trim();
  if (!PI_REGEX.test(cleaned)) return null;
  const hex = cleaned.startsWith('0x') || cleaned.startsWith('0X')
    ? cleaned.slice(2)
    : cleaned;
  return `0x${hex.toUpperCase()}`;
}

export function validateService(service, allowedBitrates) {
  const errors = [];
  const warnings = [];
  const normalized = structuredClone(service);
  const piNormalized = normalizePi(service.identity?.pi);
  if (!piNormalized) {
    errors.push('Program identifier (PI) must be hexadecimal!');
  } else {
    normalized.identity.pi = piNormalized;
    normalized.identity.serviceIdHex = piNormalized;
  }

  const ps8 = String(service.identity?.ps8 || '');
  const ps16 = String(service.identity?.ps16 || '');
  if (ps8.length > 8) errors.push('PS8 doit contenir au maximum 8 caractères.');
  if (ps16.length > 16) errors.push('PS16 doit contenir au maximum 16 caractères.');
  if (ps8 && ps16 && shortLabelMismatch(ps8, ps16)) {
    errors.push('PS16 doit contenir tous les caractères de PS8.');
  }

  if (!allowedBitrates.includes(Number(service.dab?.bitrateKbps))) {
    errors.push('Bitrate non autorisé.');
  }

  // HE-AAC v2 (PS) requires stereo
  const codec = String(service.audio?.codec || '');
  const channels = Number(service.audio?.channels);
  if (codec === 'HE-AAC v2 (PS)' && channels !== 2) {
    errors.push('HE-AAC v2 (PS) nécessite le mode stéréo (2 canaux).');
  }

  const port = Number(service.network?.ediOutputTcp?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('Port EDI invalide.');
  }

  // Warning: VLC mode with HTTP/HTTPS streams (GStreamer recommended)
  const mode = String(service.input?.mode || '').toUpperCase();
  const uri = String(service.input?.uri || '');
  if (mode === 'VLC' && /^https?:\/\//i.test(uri)) {
    warnings.push('Mode VLC avec flux HTTP/HTTPS : GStreamer est recommandé pour plus de stabilité.');
  }

  return { errors, warnings, normalized };
}
