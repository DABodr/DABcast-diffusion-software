// Transmitter outputs of odr-dabmux for the "NETWORK" transmission mode (settings.dabmux.outputs).
// One list, any number of outputs, each feeding one transmitter / modulator / converter:
//   zmq      ETI over ZeroMQ, dabmux listens (EasyDAB, ODR-DabMod, digris-zmq-converter)
//   eti-tcp  raw ETI over TCP, dabmux listens
//   edi-tcp  EDI over TCP, dabmux listens (transmitters / digris-edi-tcp-converter connect to it)
//   edi-udp  EDI over UDP, dabmux sends to the transmitter (unicast or multicast)
//   hackrf   local SDR: an internal EDI/TCP output (port) read by odr-dabmod on this machine, which
//            feeds hackrf_transfer — the chain of the HACKRF mode, same settings (started by appState).
//            Kept for the settings saved before the sdr output; the UI shows it as an sdr HackRF.
//   sdr      local SDR through SoapySDR (HackRF, LimeSDR, BladeRF, PlutoSDR, any SoapySDR device): odr-dabmod
//            on this machine reads its internal EDI/TCP output and drives the device (one local modulator)
// PFT / FEC is ONE setting for all EDI outputs (ediOptions): odr-dabmux 5.1.0 reads enable_pft / fec
// only at the level of the edi block (DabMux.cpp), a per-destination value would be ignored.
// Only one ZMQ output can carry metadata: its block name "zeromq" must be unique in the config.
// The legacy modes (EASYDAB / EDI / HACKRF / USRP1) do not use this list and are unchanged.
// Pure functions: no I/O, used by muxBuilder (config text), the settings route and the UI.

import { DAB_FREQ_TABLE } from '../defaults.js';

export const OUTPUT_TYPES = ['zmq', 'eti-tcp', 'edi-tcp', 'edi-udp', 'hackrf', 'sdr'];

// SoapySDR devices of the 'sdr' output: driver name and starting values (set by the UI when the device
// is chosen, editable). Tested on real hardware: HackRF only. txGain = SoapySDR overall TX gain in dB.
// masterClockRate 0 = not set (driver default); bandwidth 0 = automatic (odr-dabmod).
// HackRF: 61 = VGA 47 + the 14 dB amplifier (= hackrf_transfer -x 47 -a 1); no settable master clock (the
// LimeSDR value of the ODR example fails); 1.75 MHz bandwidth as hackrf_transfer -b.
export const SDR_DEVICES = {
  hackrf: { label: 'HackRF', driver: 'hackrf', txGain: 61, masterClockRate: 0, bandwidth: 1750000 },
  lime: { label: 'LimeSDR', driver: 'lime', txGain: 40, masterClockRate: 32768000, bandwidth: 0 },   // ODR example values
  bladerf: { label: 'BladeRF', driver: 'bladerf', txGain: 20, masterClockRate: 0, bandwidth: 0 },
  plutosdr: { label: 'PlutoSDR', driver: 'plutosdr', txGain: 40, masterClockRate: 0, bandwidth: 0 },
  custom: { label: 'Other (SoapySDR args)', driver: '', txGain: 20, masterClockRate: 0, bandwidth: 0 },
};
// device string given to SoapySDR (device= of dabmod.ini): driver + optional extra args (serial=…)
export const sdrDeviceString = (o) => {
  const d = SDR_DEVICES[o.device];
  if (!d || !d.driver) return o.deviceArgs;
  return o.deviceArgs ? `driver=${d.driver},${o.deviceArgs}` : `driver=${d.driver}`;
};
// characters allowed in the SoapySDR args / antenna written to dabmod.ini (no line break, no ';' comment)
const isIniSafe = (s) => /^[A-Za-z0-9_=,.:\/ -]*$/.test(s);

const DEFAULTS = {
  zmq: { ip: '0.0.0.0', port: 18081, allowMetadata: false },
  'eti-tcp': { ip: '0.0.0.0', port: 9902 },
  'edi-tcp': { port: 13000 },
  'edi-udp': { destination: '', port: 12000, sourcePort: 13000, source: '', ttl: 1 },
  hackrf: { port: 13090, dabBlock: '7A', txGain: 47, maxFramesQueued: 580, gainmode: 2, digitalGain: 1, rate: 4096000 },
  // defaults = the HackRF of SDR_DEVICES
  sdr: { port: 13090, device: 'hackrf', deviceArgs: '', dabBlock: '7A', txGain: 61, masterClockRate: 0, txAntenna: '', bandwidth: 1750000, maxFramesQueued: 580, gainmode: 2, digitalGain: 1, rate: 2048000 },
};

const isPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;
const isIpv4 = (s) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((n) => Number(n) <= 255);
const isMulticast = (s) => isIpv4(s) && Number(s.split('.')[0]) >= 224 && Number(s.split('.')[0]) <= 239;

// One output with its defaults, unknown fields dropped, numbers coerced. Never throws.
export function normalizeOutput(o, index = 0) {
  // an unknown type is KEPT as it is (with its fields) and refused by validateOutputs: never turned
  // silently into another type (an older DABcast once saved a HackRF output as an EDI/TCP one)
  if (!OUTPUT_TYPES.includes(o?.type)) {
    return { ...o, id: String(o?.id || `out${index + 1}`), name: String(o?.name ?? '').trim() || `Output ${index + 1}`, enabled: o?.enabled !== false, type: String(o?.type ?? ''), unknown: true };
  }
  const type = o.type;
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
      id: 'easydab', name: 'EasyDAB V2', type: 'zmq',
      ip: dabmux.easyDabOutput?.ip || '0.0.0.0', port: Number(dabmux.easyDabOutput?.port) || 18081,
    }]);
  }
  if (mode === 'HACKRF') {   // same chain: odr-dabmod on the same internal EDI port, same settings
    const hk = dabmux.hackrf || {};
    return normalizeOutputs([{ id: 'hackrf', name: 'HackRF', type: 'hackrf', port: Number(dabmux.ediTcpListenPort) || 13000,
      dabBlock: hk.dabBlock || '7A', txGain: hk.txGain ?? 47, maxFramesQueued: hk.maxFramesQueued ?? 580, gainmode: hk.gainmode ?? 2,
      digitalGain: hk.digitalGain ?? 1, rate: hk.rate || 4096000 }]);
  }
  return [];   // USRP1 (no longer offered): no output
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
    if (o.unknown) { errors.push(`${label}: unknown output type "${o.type}" (made by a newer DABcast?) — update DABcast or remove this output`); continue; }
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
    if (o.type === 'hackrf') {
      if (!DAB_FREQ_TABLE[o.dabBlock]) errors.push(`${label}: unknown DAB block ${o.dabBlock}`);
      if (!(Number.isFinite(o.txGain) && o.txGain >= 0 && o.txGain <= 47)) errors.push(`${label}: TX gain must be 0-47`);
      if (!(Number.isInteger(o.maxFramesQueued) && o.maxFramesQueued >= 1 && o.maxFramesQueued <= 2000)) errors.push(`${label}: max frames queued must be 1-2000`);
    }
    if (o.type === 'sdr') {
      if (!SDR_DEVICES[o.device]) errors.push(`${label}: unknown SDR device ${o.device}`);
      if (o.device === 'custom' && !o.deviceArgs) errors.push(`${label}: enter the SoapySDR device args (e.g. driver=lime,serial=…)`);
      if (!isIniSafe(o.deviceArgs) || !isIniSafe(o.txAntenna)) errors.push(`${label}: device args / antenna: letters, digits and = , . : / _ - only`);
      if (!DAB_FREQ_TABLE[o.dabBlock]) errors.push(`${label}: unknown DAB block ${o.dabBlock}`);
      if (!(Number.isFinite(o.txGain) && o.txGain >= -50 && o.txGain <= 100)) errors.push(`${label}: TX gain must be -50 to 100 dB`);
      if (!(Number.isInteger(o.masterClockRate) && o.masterClockRate >= 0)) errors.push(`${label}: master clock rate must be 0 (not set) or a rate in Hz`);
      if (!(Number.isInteger(o.bandwidth) && o.bandwidth >= 0)) errors.push(`${label}: bandwidth must be 0 (automatic) or a value in Hz`);
      if (!(Number.isInteger(o.maxFramesQueued) && o.maxFramesQueued >= 1 && o.maxFramesQueued <= 2000)) errors.push(`${label}: max frames queued must be 1-2000`);
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
  if (list.filter((o) => o.enabled && o.type === 'hackrf').length > 1) errors.push('Only one HackRF output can be ON (one local device)');
  else if (list.filter((o) => o.enabled && (o.type === 'hackrf' || o.type === 'sdr')).length > 1) errors.push('Only one local SDR output (HackRF or SDR) can be ON: one odr-dabmod on this server');
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
  const on = normalizeOutputs(list).filter((o) => o.enabled && !o.unknown);
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
  const edi = on.filter((x) => x.type === 'edi-tcp' || x.type === 'edi-udp' || x.type === 'hackrf' || x.type === 'sdr');
  if (edi.length) {
    lines.push('    edi {');
    lines.push('        destinations {');
    for (const o of edi) {
      lines.push(`            ${o.id} {`);
      if (o.type === 'edi-tcp' || o.type === 'hackrf' || o.type === 'sdr') {   // hackrf / sdr: local odr-dabmod connects here
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
    // common to every EDI output (see above); PFT is usual for UDP, useless (but harmless) on TCP.
    // Only with a real EDI output: the PFT field is not shown for a HackRF alone, and the HACKRF mode
    // feeds odr-dabmod without PFT — same here.
    const pft = edio.pft && edi.some((x) => x.type !== 'hackrf' && x.type !== 'sdr');
    lines.push(`        enable_pft ${pft ? 'true' : 'false'}`);
    if (pft) lines.push(`        fec ${edio.fec}`);
    lines.push('    }');
  }
  lines.push(`    dablin "tcp://${monitorIp}:${monitorPort}"`);
  return lines;
}


// The enabled local SDR output (HackRF or SoapySDR 'sdr') of a NETWORK outputs list (normalized), or null
export const localHackrfOutput = (list) => normalizeOutputs(list).find((o) => o.enabled && (o.type === 'hackrf' || o.type === 'sdr')) || null;
