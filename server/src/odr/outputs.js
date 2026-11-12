// Transmitter outputs of odr-dabmux for the "NETWORK" transmission mode (settings.dabmux.outputs).
// One list, any number of outputs, each feeding one transmitter / modulator / converter:
//   zmq      ETI over ZeroMQ, dabmux listens (EasyDAB, ODR-DabMod, digris-zmq-converter)
//   eti-tcp  raw ETI over TCP, dabmux listens
//   edi-tcp  EDI over TCP, dabmux listens (transmitters / digris-edi-tcp-converter connect to it)
//   edi-udp  EDI over UDP, dabmux sends to the transmitter (unicast or multicast)
// PFT / FEC is ONE setting for all EDI outputs (ediOptions): odr-dabmux 5.1.0 reads enable_pft / fec
// only at the level of the edi block (DabMux.cpp), a per-destination value would be ignored.
// Only one ZMQ output can carry metadata: its block name "zeromq" must be unique in the config.
// The legacy modes (EASYDAB / EDI / HACKRF / USRP1) do not use this list and are unchanged.
// Pure functions: no I/O, used by muxBuilder (config text), the settings route and the UI.

export const OUTPUT_TYPES = ['zmq', 'eti-tcp', 'edi-tcp', 'edi-udp'];

const DEFAULTS = {
  zmq: { ip: '0.0.0.0', port: 18081, allowMetadata: false },
  'eti-tcp': { ip: '0.0.0.0', port: 9902 },
  'edi-tcp': { port: 13000 },
  'edi-udp': { destination: '', port: 12000, sourcePort: 13000, source: '', ttl: 1 },
};

const isPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;
const isIpv4 = (s) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((n) => Number(n) <= 255);
const isMulticast = (s) => isIpv4(s) && Number(s.split('.')[0]) >= 224 && Number(s.split('.')[0]) <= 239;

// One output with its defaults, unknown fields dropped, numbers coerced. Never throws.
export function normalizeOutput(o, index = 0) {
  const type = OUTPUT_TYPES.includes(o?.type) ? o.type : 'edi-tcp';
  const d = DEFAULTS[type];
  const out = {
    id: String(o?.id || `out${index + 1}`).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || `out${index + 1}`,
    name: String(o?.name ?? '').trim().slice(0, 40) || `Output ${index + 1}`,
    enabled: o?.enabled !== false,
    type,
  };
  for (const [k, v] of Object.entries(d)) {
    const given = o?.[k];
    if (typeof v === 'number') out[k] = given === undefined || given === '' ? v : Number(given);
    else if (typeof v === 'boolean') out[k] = given === undefined ? v : given === true || given === 'true';
    else out[k] = given === undefined || given === null ? v : String(given).trim();
  }
  return out;
}

export function normalizeOutputs(list) {
  return (Array.isArray(list) ? list : []).map(normalizeOutput);
}

// Pre-filled list for the NETWORK mode from the current (legacy) settings: what the user had.
export function outputsFromLegacy(dabmux = {}) {
  const mode = String(dabmux.txMode || 'EASYDAB').toUpperCase();
  if (mode === 'EDI') {
    return normalizeOutputs([{
      id: 'edi', name: 'EDI', type: 'edi-tcp', port: Number(dabmux.ediTcpListenPort) || 13000,
    }]);
  }
  if (mode === 'EASYDAB') {
    return normalizeOutputs([{
      id: 'easydab', name: 'EasyDAB', type: 'zmq',
      ip: dabmux.easyDabOutput?.ip || '0.0.0.0', port: Number(dabmux.easyDabOutput?.port) || 18081,
    }]);
  }
  return [];   // HACKRF / USRP1: local modulator chain, no network output
}

// Errors (array of strings, empty = valid). reserved: Map port -> what uses it (service inputs,
// management ports, web UI, ETI monitor) — a listening output must not take one of them.
export const normalizeEdiOptions = (e) => ({ pft: e?.pft === true || e?.pft === 'true', fec: e?.fec === undefined || e?.fec === '' ? 2 : Number(e.fec) });

export function validateOutputs(list, { reserved = new Map(), ediOptions = normalizeEdiOptions() } = {}) {
  const errors = [];
  const listening = new Map();   // port -> output name (outputs where dabmux listens)
  const ids = new Set();
  for (const o of list) {
    const label = `"${o.name}"`;
    if (ids.has(o.id)) errors.push(`${label}: duplicate id ${o.id}`);
    ids.add(o.id);
    if (!isPort(o.port)) { errors.push(`${label}: port must be 1-65535`); continue; }
    if (o.type === 'edi-udp') {
      if (!isIpv4(o.destination)) errors.push(`${label}: destination must be an IPv4 address (transmitter or multicast group)`);
      if (!isPort(o.sourcePort)) errors.push(`${label}: source port must be 1-65535`);
      if (o.source && !isIpv4(o.source)) errors.push(`${label}: source interface must be an IPv4 address of this machine`);
      if (isMulticast(o.destination) && !(Number.isInteger(o.ttl) && o.ttl >= 1 && o.ttl <= 255)) errors.push(`${label}: multicast TTL must be 1-255`);
      continue;   // dabmux sends: the port is on the transmitter, not on this machine
    }
    if (o.type === 'zmq' || o.type === 'eti-tcp') {
      if (!isIpv4(o.ip)) errors.push(`${label}: listen address must be an IPv4 address (0.0.0.0 = all interfaces)`);
    }
    if (o.enabled) {
      if (listening.has(o.port)) errors.push(`${label}: port ${o.port} already used by "${listening.get(o.port)}"`);
      else if (reserved.has(o.port)) errors.push(`${label}: port ${o.port} is used by ${reserved.get(o.port)}`);
      listening.set(o.port, o.name);
    }
  }
  if (!list.some((o) => o.enabled)) errors.push('At least one output must be ON');
  if (list.filter((o) => o.enabled && o.type === 'zmq' && o.allowMetadata).length > 1) {
    errors.push('Only one ZMQ output can send timestamps (metadata): untick it on the others');
  }
  if (!(Number.isInteger(ediOptions.fec) && ediOptions.fec >= 0 && ediOptions.fec <= 5)) errors.push('EDI FEC must be 0-5');
  return errors;
}

// Lines of the .mux "outputs { }" block for the NETWORK mode. The raw ETI monitoring output
// (Player / Dablin, easyDabOutput.netPort) is always added, as in the legacy modes, and
// "throttle simul://" is the single output that paces dabmux in real time (none of the network
// outputs applies back-pressure).
export function buildOutputLines(list, { monitorIp = '0.0.0.0', monitorPort = 9901, ediOptions = {} } = {}) {
  const edio = normalizeEdiOptions(ediOptions);
  const on = normalizeOutputs(list).filter((o) => o.enabled);
  const lines = ['    throttle "simul://"'];
  // one-line outputs: "out_" prefix so that an id never collides with edi / zeromq / throttle / dablin
  for (const o of on.filter((x) => x.type === 'zmq')) {
    if (o.allowMetadata) {
      // new ZMQ format: metadata (EDI time, UTC offset) read by the EasyDAB — needs leap-second info, like EDI
      lines.push('    zeromq {');
      lines.push(`        endpoint "tcp://${o.ip === '0.0.0.0' ? '*' : o.ip}:${o.port}"`);
      lines.push('        allowmetadata true');
      lines.push('    }');
    } else {
      lines.push(`    out_${o.id} "zmq+tcp://${o.ip}:${o.port}"`);   // legacy format = allowmetadata false
    }
  }
  for (const o of on.filter((x) => x.type === 'eti-tcp')) {
    lines.push(`    out_${o.id} "tcp://${o.ip}:${o.port}"`);
  }
  const edi = on.filter((x) => x.type === 'edi-tcp' || x.type === 'edi-udp');
  if (edi.length) {
    lines.push('    edi {');
    lines.push('        destinations {');
    for (const o of edi) {
      lines.push(`            ${o.id} {`);
      if (o.type === 'edi-tcp') {
        lines.push('                protocol tcp');
        lines.push(`                listenport ${o.port}`);
      } else {
        lines.push('                protocol udp');
        lines.push(`                destination "${o.destination}"`);
        lines.push(`                port ${o.port}`);
        lines.push(`                sourceport ${o.sourcePort}`);
        if (o.source) lines.push(`                source "${o.source}"`);
        if (isMulticast(o.destination)) lines.push(`                ttl ${o.ttl}`);
      }
      lines.push('            }');
    }
    lines.push('        }');
    // common to every EDI output (see above); PFT is usual for UDP, useless (but harmless) on TCP
    lines.push(`        enable_pft ${edio.pft ? 'true' : 'false'}`);
    if (edio.pft) lines.push(`        fec ${edio.fec}`);
    lines.push('    }');
  }
  lines.push(`    dablin "tcp://${monitorIp}:${monitorPort}"`);
  return lines;
}

