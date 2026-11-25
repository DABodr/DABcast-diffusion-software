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
  if (ps8.length > 8) errors.push('PS8 must be at most 8 characters.');
  if (ps16.length > 16) errors.push('PS16 must be at most 16 characters.');
  if (ps8 && ps16 && shortLabelMismatch(ps8, ps16)) {
    errors.push('PS16 must contain all the characters of PS8, in the same order.');
  }

  if (!allowedBitrates.includes(Number(service.dab?.bitrateKbps))) {
    errors.push('Bitrate not allowed.');
  }

  // HE-AAC v2 (PS) requires stereo
  const codec = String(service.audio?.codec || '');
  const channels = Number(service.audio?.channels);
  if (codec === 'HE-AAC v2 (PS)' && channels !== 2) {
    errors.push('HE-AAC v2 (PS) requires stereo (2 channels).');
  }

  const port = Number(service.network?.ediOutputTcp?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('Invalid input port (1-65535).');
  }

  // Warning: VLC mode with HTTP/HTTPS streams (GStreamer recommended)
  const mode = String(service.input?.mode || '').toUpperCase();
  const uri = String(service.input?.uri || '');
  if (mode === 'VLC' && /^https?:\/\//i.test(uri)) {
    warnings.push('VLC input with an HTTP/HTTPS stream: GStreamer is recommended for stability.');
  }
  const backupMode = String(service.input?.backupMode || '').toUpperCase();
  if (backupMode && !['GSTREAMER', 'VLC'].includes(backupMode)) errors.push('Backup player must be GStreamer or VLC.');
  // ALSA (local sound card): input.uri = ALSA capture device, passed to odr-audioenc -d
  if (mode === 'ALSA') {
    if (!/^[A-Za-z][A-Za-z0-9_]*(:[A-Za-z0-9_=,.-]+)?$/.test(uri)) {
      errors.push('Sound card: enter an ALSA capture device, e.g. plughw:1,0 or plughw:CARD=Device,DEV=0.');
    } else if (service.input?.backupUri && !/^https?:\/\//i.test(String(service.input.backupUri))) {
      errors.push('Sound card source: the backup must be a web stream (http:// or https://).');
    } else if (/^hw:/i.test(uri)) {
      warnings.push('hw: opens the card as it is: the encoder fails if the card does not support the sample rate. plughw: converts it.');
    }
  }

  return { errors, warnings, normalized };
}
