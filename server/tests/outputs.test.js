// Tests for the transmitter outputs of the NETWORK mode (odr/outputs.js)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOutput, normalizeOutputs, normalizeEdiOptions, outputsFromLegacy, validateOutputs, buildOutputLines, sdrDeviceString, localHackrfOutput, clampImportedGains, validateBaseSettings } from '../src/odr/outputs.js';

describe('outputs — normalize', () => {
  it('fills the defaults of each type and coerces numbers', () => {
    const o = normalizeOutput({ type: 'edi-udp', name: ' TX Nancy ', destination: '192.168.10.20', port: '12000' }, 0);
    assert.deepEqual(o, {
      id: 'out1', name: 'TX Nancy', enabled: true, type: 'edi-udp',
      destination: '192.168.10.20', port: 12000, sourcePort: 13000, source: '', ttl: 1,
    });
    assert.equal(normalizeOutput({ type: 'zmq' }).allowMetadata, false);
    const u = normalizeOutput({ type: 'bogus', name: 'Future', dabBlock: '5A' });
    assert.deepEqual([u.type, u.unknown, u.dabBlock], ['bogus', true, '5A'], 'unknown type kept as it is, never turned into EDI/TCP');
    assert.match(validateOutputs([u]).join(), /unknown output type "bogus"/);
    assert.doesNotMatch(buildOutputLines([u]).join('\n'), /Future|bogus/, 'not written to the .mux');
    assert.equal(normalizeOutput({ type: 'zmq', id: 'a b/c' }).id, 'a_b_c', 'safe id');
  });
});

describe('outputs — from the legacy modes (pre-filled list, nothing converted on disk)', () => {
  it('EASYDAB → one ZMQ output with the same address and port', () => {
    const l = outputsFromLegacy({ txMode: 'EASYDAB', easyDabOutput: { ip: '0.0.0.0', port: 18081, netPort: 9901 } });
    assert.equal(l.length, 1);
    assert.deepEqual([l[0].type, l[0].ip, l[0].port, l[0].allowMetadata], ['zmq', '0.0.0.0', 18081, false]);
  });
  it('EDI → one EDI/TCP output on the same listen port', () => {
    const l = outputsFromLegacy({ txMode: 'EDI', ediTcpListenPort: 13001 });
    assert.deepEqual([l[0].type, l[0].port], ['edi-tcp', 13001]);
  });
  it('HACKRF → one HackRF output with the same settings and internal port; USRP1 → none', () => {
    const l = outputsFromLegacy({ txMode: 'HACKRF', ediTcpListenPort: 13000, hackrf: { dabBlock: '5A', txGain: 30 } });
    assert.deepEqual([l[0].type, l[0].port, l[0].dabBlock, l[0].txGain, l[0].rate], ['hackrf', 13000, '5A', 30, 4096000]);
    assert.deepEqual(outputsFromLegacy({ txMode: 'USRP1' }), []);
  });
});

describe('outputs — validation', () => {
  const ok = normalizeOutputs([
    { id: 'easydab', name: 'EasyDAB', type: 'zmq', port: 18081 },
    { id: 'tx1', name: 'TX1', type: 'edi-udp', destination: '192.168.1.50', port: 12000 },
    { id: 'tx2', name: 'TX2', type: 'edi-udp', destination: '192.168.1.51', port: 12000 },   // same remote port: fine
    { id: 'conv', name: 'Converter', type: 'edi-tcp', port: 13000 },
  ]);
  it('a valid list has no error', () => assert.deepEqual(validateOutputs(ok), []));

  it('two listening outputs on one port, or on a reserved port, are refused', () => {
    const dup = normalizeOutputs([{ name: 'A', type: 'zmq', port: 18081 }, { name: 'B', type: 'edi-tcp', port: 18081 }]);
    assert.match(validateOutputs(dup).join(), /port 18081 already used by "A"/);
    const res = normalizeOutputs([{ name: 'A', type: 'edi-tcp', port: 9001 }]);
    assert.match(validateOutputs(res, { reserved: new Map([[9001, 'input port of MaXXima']]) }).join(), /input port of MaXXima/);
  });

  it('EDI/UDP needs a valid destination; multicast a TTL; EDI FEC 0-5', () => {
    assert.match(validateOutputs(normalizeOutputs([{ name: 'X', type: 'edi-udp', destination: 'tx.local' }])).join(), /IPv4/);
    assert.match(validateOutputs(normalizeOutputs([{ name: 'M', type: 'edi-udp', destination: '239.1.1.1', ttl: 0 }])).join(), /TTL/);
    const one = normalizeOutputs([{ name: 'F', type: 'edi-udp', destination: '10.0.0.1' }]);
    assert.match(validateOutputs(one, { ediOptions: normalizeEdiOptions({ pft: true, fec: 9 }) }).join(), /FEC/);
  });

  it('only one ZMQ output with metadata (zeromq block name must be unique in dabmux)', () => {
    const l = normalizeOutputs([{ name: 'A', type: 'zmq', port: 18081, allowMetadata: true }, { name: 'B', type: 'zmq', port: 18082, allowMetadata: true }]);
    assert.match(validateOutputs(l).join(), /Only one ZMQ output can send timestamps/);
  });

  it('at least one output ON; an OFF output does not reserve its port', () => {
    assert.match(validateOutputs(normalizeOutputs([{ name: 'A', type: 'zmq', enabled: false }])).join(), /At least one/);
    const l = normalizeOutputs([{ name: 'A', type: 'zmq', port: 18081, enabled: false }, { name: 'B', type: 'zmq', port: 18081 }]);
    assert.deepEqual(validateOutputs(l), []);
  });
});

describe('outputs — .mux lines', () => {
  const text = (l, ediOptions) => buildOutputLines(normalizeOutputs(l), { monitorPort: 9901, ediOptions }).join('\n');

  it('always the real-time throttle and the ETI monitoring output (Player / Dablin)', () => {
    const t = text([{ id: 'c', type: 'edi-tcp', port: 13000 }]);
    assert.match(t, /^ {4}throttle "simul:\/\/"$/m);
    assert.match(t, /^ {4}dablin "tcp:\/\/0\.0\.0\.0:9901"$/m);
  });

  it('ZMQ: legacy one-line format, or the zeromq block with allowmetadata', () => {
    assert.match(text([{ id: 'easydab', type: 'zmq', port: 18081 }]), /^ {4}out_easydab "zmq\+tcp:\/\/0\.0\.0\.0:18081"$/m);
    const t = text([{ id: 'v2', type: 'zmq', port: 18082, allowMetadata: true }]);
    assert.match(t, /zeromq \{\n {8}endpoint "tcp:\/\/\*:18082"\n {8}allowmetadata true\n {4}\}/);
  });

  it('EDI: one edi block, one destination per output (TCP listen, UDP unicast, multicast with TTL)', () => {
    const outs = [
      { id: 'conv', type: 'edi-tcp', port: 13000 },
      { id: 'tx1', type: 'edi-udp', destination: '192.168.1.50', port: 12000 },
      { id: 'sfn', type: 'edi-udp', destination: '239.20.10.1', port: 12000, source: '192.168.1.10', ttl: 4 },
    ];
    const t = text(outs, { pft: true, fec: 3 });
    assert.equal((t.match(/^ {4}edi \{/mg) || []).length, 1);
    assert.match(t, /conv \{\n {16}protocol tcp\n {16}listenport 13000\n {12}\}/);
    assert.match(t, /tx1 \{\n {16}protocol udp\n {16}destination "192\.168\.1\.50"\n {16}port 12000\n {16}sourceport 13000\n {12}\}/);
    assert.match(t, /sfn \{[^}]*source "192\.168\.1\.10"\n {16}ttl 4\n {12}\}/);
    // PFT / FEC once, at the level of the edi block (the only place dabmux 5.1.0 reads it)
    assert.match(t, /^ {8}\}\n {8}enable_pft true\n {8}fec 3\n {4}\}$/m);
    assert.match(text(outs, { pft: false }), /^ {8}enable_pft false\n {4}\}$/m);
    assert.doesNotMatch(text(outs, { pft: false }), /fec/);
  });

  it('OFF outputs are left out; no edi block without EDI output', () => {
    const t = text([{ id: 'a', type: 'zmq', port: 18081 }, { id: 'b', type: 'edi-udp', destination: '10.0.0.1', enabled: false }]);
    assert.doesNotMatch(t, /edi \{/);
    assert.doesNotMatch(t, /10\.0\.0\.1/);
  });
});

describe('outputs — HackRF (local SDR)', () => {
  it('defaults = the HACKRF mode settings; internal EDI/TCP port for odr-dabmod', () => {
    const o = normalizeOutput({ type: 'hackrf' });
    assert.deepEqual([o.port, o.dabBlock, o.txGain, o.maxFramesQueued, o.gainmode, o.digitalGain, o.rate], [13090, '7A', 47, 580, 2, 1, 4096000]);
    const t = buildOutputLines([o]).join('\n');
    assert.match(t, /protocol tcp\n {16}listenport 13090\n/);
  });
  it('validation: one HackRF ON at most, known DAB block, TX gain 0-47', () => {
    const two = normalizeOutputs([{ type: 'hackrf', port: 13090 }, { type: 'hackrf', port: 13091 }]);
    assert.match(validateOutputs(two).join(), /Only one HackRF output/);
    assert.match(validateOutputs(normalizeOutputs([{ type: 'hackrf', dabBlock: '99Z' }])).join(), /unknown DAB block/);
    assert.match(validateOutputs(normalizeOutputs([{ type: 'hackrf', txGain: 60 }])).join(), /TX gain/);
    assert.deepEqual(validateOutputs(normalizeOutputs([{ type: 'hackrf' }, { type: 'zmq', port: 18081 }])), []);
  });
  it('PFT never applied for a HackRF alone (field hidden; HACKRF mode feeds odr-dabmod without PFT)', () => {
    const alone = buildOutputLines(normalizeOutputs([{ type: 'hackrf' }]), { ediOptions: { pft: true, fec: 2 } }).join('\n');
    assert.match(alone, /enable_pft false/);
    const withUdp = buildOutputLines(normalizeOutputs([{ type: 'hackrf' }, { type: 'edi-udp', destination: '10.0.0.1' }]), { ediOptions: { pft: true, fec: 2 } }).join('\n');
    assert.match(withUdp, /enable_pft true\n {8}fec 2/);
  });
});

describe('outputs — SDR (SoapySDR, local)', () => {
  it('defaults (HackRF), device string, internal EDI/TCP port, no PFT for an SDR alone', () => {
    const o = normalizeOutput({ type: 'sdr', port: 13091 });
    assert.deepEqual([o.device, o.txGain, o.masterClockRate, o.bandwidth, o.rate], ['hackrf', 61, 0, 1750000, 2048000], 'same level / bandwidth as hackrf_transfer -x 47 -a 1 -b 1750000');
    assert.equal(sdrDeviceString(o), 'driver=hackrf');
    assert.equal(sdrDeviceString({ ...o, device: 'lime' }), 'driver=lime');
    assert.equal(sdrDeviceString({ ...o, device: 'bladerf', deviceArgs: 'serial=12ab' }), 'driver=bladerf,serial=12ab');
    assert.equal(sdrDeviceString({ ...o, device: 'custom', deviceArgs: 'driver=uhd,type=b200' }), 'driver=uhd,type=b200');
    const t = buildOutputLines([o], { ediOptions: { pft: true, fec: 2 } }).join('\n');
    assert.match(t, /protocol tcp\n {16}listenport 13091\n/);
    assert.match(t, /enable_pft false/);
    assert.equal(localHackrfOutput([o]).type, 'sdr');
  });
  it('validation: one local modulator, safe args (written to dabmod.ini), custom needs args', () => {
    assert.deepEqual(validateOutputs(normalizeOutputs([{ type: 'sdr' }, { type: 'zmq', port: 18081 }])), []);
    assert.match(validateOutputs(normalizeOutputs([{ type: 'sdr' }, { type: 'hackrf' }])).join(), /Only one local SDR output/);
    assert.match(validateOutputs(normalizeOutputs([{ type: 'sdr', deviceArgs: 'serial=1\noutput=file' }])).join(), /device args/);
    assert.match(validateOutputs(normalizeOutputs([{ type: 'sdr', txAntenna: 'A;B' }])).join(), /device args \/ antenna/);
    assert.match(validateOutputs(normalizeOutputs([{ type: 'sdr', device: 'custom' }])).join(), /SoapySDR device args/);
    assert.match(validateOutputs(normalizeOutputs([{ type: 'sdr', device: 'usrp9' }])).join(), /unknown SDR device/);
  });
});

describe('outputs — SDR gain limits', () => {
  it('HackRF: TX gain 0-61 (above, the device refuses it and transmits at gain 0); other devices unchanged', () => {
    const v = (x) => validateOutputs(normalizeOutputs([{ type: 'sdr', ...x }])).join();
    assert.equal(v({ device: 'hackrf', txGain: 61 }), '');
    assert.match(v({ device: 'hackrf', txGain: 70 }), /TX gain must be 0-61/);
    assert.match(v({ device: 'hackrf', txGain: -3 }), /TX gain must be 0-61/);
    assert.equal(v({ device: 'lime', txGain: 70 }), '');
  });
  it('digital gain above 0 and at most 1 (above 1 the signal is clipped)', () => {
    const v = (x) => validateOutputs(normalizeOutputs([{ type: 'sdr', device: 'hackrf', ...x }])).join();
    assert.equal(v({ digitalGain: 1 }), '');
    assert.equal(v({ digitalGain: 0.8 }), '');
    assert.match(v({ digitalGain: 1.5 }), /digital gain must be above 0 and at most 1/);
    assert.match(v({ digitalGain: 0 }), /digital gain/);
  });
});

describe('outputs — imported file: gains brought back to the limits', () => {
  it('clamps a HackRF sdr output saved before 1.10.7 (TX gain 63, digital gain 2), even when OFF', () => {
    const dm = { outputs: normalizeOutputs([{ id: 'sdr1', name: 'HackRF', enabled: false, type: 'sdr', device: 'hackrf', txGain: 63, digitalGain: 2 }]) };
    const notes = clampImportedGains(dm);
    assert.equal(dm.outputs[0].txGain, 61);
    assert.equal(dm.outputs[0].digitalGain, 1);
    assert.equal(notes.length, 2);
    assert.deepEqual(validateOutputs([...dm.outputs, normalizeOutput({ type: 'zmq', port: 18081 })]), []);
  });
  it('clamps the hackrf output and the HACKRF mode settings; leaves valid values and non-numbers alone', () => {
    const dm = { outputs: normalizeOutputs([{ type: 'hackrf', txGain: 60, maxFramesQueued: 5000 }]), hackrf: { txGain: 99, digitalGain: 0.8 } };
    clampImportedGains(dm);
    assert.equal(dm.outputs[0].txGain, 47);
    assert.equal(dm.outputs[0].maxFramesQueued, 2000);
    assert.equal(dm.hackrf.txGain, 47);
    assert.equal(dm.hackrf.digitalGain, 0.8);
    const s = { hackrf: { txGain: 'abc' } };
    assert.deepEqual(clampImportedGains(s), []);
    assert.equal(s.hackrf.txGain, 'abc');
  });
});

describe('outputs — multiplex settings written as they are into the .mux', () => {
  const defaults = {
    ensemble: { idHex: '0xFFFF', eccHex: '0xE1', label: 'DABcast Demo', shortlabel: 'DABcast', internationalTable: 1, localTimeOffset: 'auto' },
    dabmux: { telnetPort: 12721, managementPort: 12720, zmqEndpoint: 'tcp://lo:12722', txMode: 'EASYDAB', easyDabOutput: { ip: '0.0.0.0', port: 18081, netPort: 9901 }, ediTcpListenPort: 13000, hackrf: { dabBlock: '7A', maxFramesQueued: 580, gainmode: 2, digitalGain: 1, rate: 4096000, txGain: 47 } },
  };
  it('accepts the defaults, an empty patch and what the Settings screen sends (empty port field = 0)', () => {
    assert.deepEqual(validateBaseSettings(defaults), []);
    assert.deepEqual(validateBaseSettings({}), []);
    assert.deepEqual(validateBaseSettings({ dabmux: { managementPort: 0, telnetPort: 12721, ediTcpListenPort: 13000, easyDabOutput: { ip: '', port: 18081 }, hackrf: { txGain: 0, digitalGain: 0, rate: 2048000, gainmode: 0 } } }), []);
    assert.deepEqual(validateBaseSettings({ ensemble: { localTimeOffset: 1.5 } }), []);
  });
  it('refuses the values of a hand-edited file (ports > 65535, bad endpoint, sample rate)', () => {
    const errors = validateBaseSettings({ dabmux: { telnetPort: 1272771, managementPort: 1275520, zmqEndpoint: 'tcp://lo:12789722', hackrf: { rate: 40964857000 } } });
    assert.equal(errors.length, 4);
    assert.match(errors.join(' '), /telnetPort.*managementPort.*zmqEndpoint.*sample rate/);
  });
  it('refuses anything that would add a line to the .mux', () => {
    assert.equal(validateBaseSettings({ dabmux: { telnetPort: '12721\n}\ninputs {' } }).length, 1);
    assert.equal(validateBaseSettings({ dabmux: { zmqEndpoint: 'tcp://lo:12722\n}' } }).length, 1);
    assert.equal(validateBaseSettings({ ensemble: { eccHex: '0xE1\n' } }).length, 1);
    assert.equal(validateBaseSettings({ dabmux: { easyDabOutput: { ip: '0.0.0.0 x' } } }).length, 1);
    assert.equal(validateBaseSettings({ dabmux: { hackrf: { txGain: '47\n-a 1' } } }).length, 1);
  });
  it('refuses a bad ensemble ID / ECC / mode / DAB block', () => {
    assert.equal(validateBaseSettings({ ensemble: { idHex: 'F001' } }).length, 1);    // dabmux would read it as decimal
    assert.equal(validateBaseSettings({ ensemble: { eccHex: '0x' } }).length, 1);
    assert.equal(validateBaseSettings({ ensemble: { localTimeOffset: 'tomorrow' } }).length, 1);
    assert.equal(validateBaseSettings({ dabmux: { txMode: 'FM' } }).length, 1);
    assert.equal(validateBaseSettings({ dabmux: { hackrf: { dabBlock: '99Z' } } }).length, 1);
  });
});
