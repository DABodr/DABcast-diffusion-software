// Tests for the transmitter outputs of the NETWORK mode (odr/outputs.js)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOutput, normalizeOutputs, normalizeEdiOptions, outputsFromLegacy, validateOutputs, buildOutputLines, sdrDeviceString, localHackrfOutput } from '../src/odr/outputs.js';

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
