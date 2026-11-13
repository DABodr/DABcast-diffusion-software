import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMuxConfig } from '../src/odr/muxBuilder.js';

const makeConfig = (txMode = 'EASYDAB') => ({
  settings: {
    ensemble: { idHex: '0xF408', eccHex: '0xE1', label: 'TestEnsemble', shortlabel: 'TEST', internationalTable: 1, localTimeOffset: 'auto' },
    dabmux: { telnetPort: 12721, managementPort: 12720, zmqEndpoint: 'tcp://lo:12722', txMode, easyDabOutput: { ip: '0.0.0.0', port: 18081, netPort: 9901 }, ediTcpListenPort: 13000, ediPftEnabled: false, ediFec: 2, ediTistOffsetSec: 0 }
  },
  preset: {
    services: [{
      identity: { ps8: 'RADIO1', ps16: 'RadioOne', serviceIdHex: '0xF408', pi: 'F408', pty: 10, languageHex: '0x0F' },
      dab: { bitrateKbps: 88, protectionLevel: 3 },
      input: { zmqBuffer: 40, zmqPrebuffering: 20 },
      network: { ediOutputTcp: { port: 9001 } },
      pad: { sls: { enabled: true } }
    }]
  }
});

describe('buildMuxConfig', () => {
  it('contains reconfig-counter hash in ensemble', () => {
    const mux = buildMuxConfig(makeConfig());
    assert.ok(mux.includes('reconfig-counter hash'));
  });

  it('contains shortlabel in services section', () => {
    const mux = buildMuxConfig(makeConfig());
    assert.ok(mux.includes('shortlabel "RADIO1"'));
  });

  it('contains label in services section', () => {
    const mux = buildMuxConfig(makeConfig());
    assert.ok(mux.includes('label "RadioOne"'));
  });

  it('EASYDAB mode: outputs contain zmq', () => {
    const mux = buildMuxConfig(makeConfig('EASYDAB'));
    assert.ok(mux.includes('zmq "zmq+tcp://'));
    assert.ok(mux.includes('throttle "simul://"'));
  });

  it('EDI mode: outputs contain edi block', () => {
    const mux = buildMuxConfig(makeConfig('EDI'));
    assert.ok(mux.includes('edi {'));
    assert.ok(mux.includes('protocol tcp'));
    assert.ok(mux.includes('listenport 13000'));
    assert.ok(mux.includes('dablin "tcp://0.0.0.0:9901"'));
    assert.ok(!mux.includes('enable_pft'));
  });

  it('EDI mode: GatesAir compatibility enables PFT with configurable FEC', () => {
    const cfg = makeConfig('EDI');
    cfg.settings.dabmux.ediTcpListenPort = 14000;
    cfg.settings.dabmux.ediPftEnabled = true;
    cfg.settings.dabmux.ediFec = 2;
    cfg.settings.dabmux.ediTistOffsetSec = 5;
    const mux = buildMuxConfig(cfg);
    assert.ok(mux.includes('listenport 14000'));
    assert.ok(mux.includes('enable_pft true'));
    assert.ok(mux.includes('fec 2'));
    assert.ok(mux.includes('tist_offset 5'));
  });

  it('USRP1 mode: outputs contain stdout fifo', () => {
    const mux = buildMuxConfig(makeConfig('USRP1'));
    assert.ok(mux.includes('stdout "fifo:///dev/stdout?type=raw"'));
  });

  it('HACKRF mode: outputs contain EDI (not ZMQ)', () => {
    const cfg = makeConfig('HACKRF');
    cfg.settings.dabmux.ediPftEnabled = true;
    cfg.settings.dabmux.ediTistOffsetSec = 5;
    const mux = buildMuxConfig(cfg);
    assert.ok(mux.includes('throttle "simul://"'));
    assert.ok(mux.includes('protocol tcp'));
    assert.ok(mux.includes('listenport'));
    assert.ok(mux.includes('dablin "tcp://0.0.0.0:9901"'));
    assert.ok(!mux.includes('zmq "zmq+tcp://'));
    assert.ok(!mux.includes('enable_pft'));
    assert.ok(!mux.includes('tist_offset'));
  });

  it('subchannel uses zmq-buffer 40 from service', () => {
    const mux = buildMuxConfig(makeConfig());
    assert.ok(mux.includes('zmq-buffer 40'));
  });

  it('contains user-applications slideshow when SLS enabled', () => {
    const mux = buildMuxConfig(makeConfig());
    assert.ok(mux.includes('userapp "slideshow"'));
  });

  it('EEP-B service includes protection-profile EEP_B', () => {
    const cfg = makeConfig();
    cfg.preset.services[0].dab.eepMode = 'B';
    const mux = buildMuxConfig(cfg);
    assert.ok(mux.includes('protection-profile EEP_B'));
  });

  it('EEP-A service does NOT include protection-profile', () => {
    const mux = buildMuxConfig(makeConfig());
    assert.ok(!mux.includes('protection-profile'));
  });

  it('ZMQ direct mode: inputproto zmq, tcp://0.0.0.0', () => {
    const cfg = makeConfig();
    cfg.preset.services[0].input.mode = 'ZMQ';
    const mux = buildMuxConfig(cfg);
    assert.ok(mux.includes('inputproto zmq'));
    assert.ok(mux.includes('inputuri "tcp://0.0.0.0:9001"'));
    assert.ok(mux.includes('zmq-buffer 40'));
    assert.ok(mux.includes('zmq-prebuffering 20'));
    assert.ok(!mux.includes('127.0.0.1'));
  });

  it('EDI direct mode: inputproto edi, udp://, buffer-management', () => {
    const cfg = makeConfig();
    cfg.preset.services[0].input.mode = 'EDI';
    const mux = buildMuxConfig(cfg);
    assert.ok(mux.includes('inputproto edi'));
    assert.ok(mux.includes('inputuri "udp://:9001"'));
    assert.ok(mux.includes('buffer-management prebuffering'));
    assert.ok(mux.includes('buffer 40'));
    assert.ok(mux.includes('prebuffering 20'));
    assert.ok(!mux.includes('zmq-prebuffering'));
  });

  it('default (no mode): inputproto "zmq", tcp://127.0.0.1', () => {
    const cfg = makeConfig();
    // No input.mode set — defaults to local audioenc
    const mux = buildMuxConfig(cfg);
    assert.ok(mux.includes('inputproto "zmq"'));
    assert.ok(mux.includes('inputuri "tcp://127.0.0.1:9001"'));
  });

  it('GSTREAMER mode falls back to local audioenc ZMQ', () => {
    const cfg = makeConfig();
    cfg.preset.services[0].input = { ...cfg.preset.services[0].input, mode: 'GSTREAMER' };
    const mux = buildMuxConfig(cfg);
    assert.ok(mux.includes('inputuri "tcp://127.0.0.1:9001"'));
  });
  it("leaves explicitly disabled services out of the mux and renumbers sub_N", () => {
    const cfg = makeConfig();
    const base = cfg.preset.services[0];
    cfg.preset.services = [
      { ...base, enabled: false, ui: { order: 0 }, identity: { ...base.identity, ps8: "OFFSTA", serviceIdHex: "0xF401" }, network: { ediOutputTcp: { port: 9001 } } },
      { ...base, enabled: true, ui: { order: 1 }, identity: { ...base.identity, ps8: "ONSTA", serviceIdHex: "0xF402" }, network: { ediOutputTcp: { port: 9002 } } },
    ];
    const mux = buildMuxConfig(cfg);
    assert.ok(!mux.includes("OFFSTA"));
    assert.ok(!mux.includes("0xF401"));
    assert.ok(!mux.includes("127.0.0.1:9001"));
    assert.ok(mux.includes("ONSTA"));
    assert.ok(mux.includes("sub_1"));
    assert.ok(!mux.includes("sub_2"));
  });

  it("keeps services without an enabled field (backward compatible)", () => {
    const mux = buildMuxConfig(makeConfig());
    assert.ok(mux.includes("RADIO1"));
  });
  it('NETWORK mode: outputs block from the transmitter outputs list', () => {
    const cfg = makeConfig('NETWORK');
    cfg.settings.dabmux.outputs = [
      { id: 'easydab', name: 'EasyDAB', type: 'zmq', port: 18081 },
      { id: 'tx1', name: 'TX1', type: 'edi-udp', destination: '192.168.1.50', port: 12000 },
      { id: 'off', name: 'Spare', type: 'edi-udp', destination: '192.168.1.99', port: 12000, enabled: false },
    ];
    cfg.settings.dabmux.ediOptions = { pft: true, fec: 3 };
    cfg.settings.dabmux.tistOffsetSec = 2;
    const mux = buildMuxConfig(cfg);
    assert.ok(mux.includes('throttle "simul://"'));
    assert.ok(mux.includes('out_easydab "zmq+tcp://0.0.0.0:18081"'));
    assert.ok(mux.includes('destination "192.168.1.50"'));
    assert.ok(!mux.includes('192.168.1.99'), 'OFF output left out');
    assert.ok(mux.includes('enable_pft true') && mux.includes('fec 3'));
    assert.ok(mux.includes('dablin "tcp://0.0.0.0:9901"'), 'ETI monitoring output kept (Player / Dablin)');
    assert.ok(mux.includes('tist_offset 2'));
    assert.ok(!mux.includes('listenport 13000'), 'legacy EDI output not added');
  });

  it('NETWORK mode ignores the legacy EDI TIST offset, the legacy modes ignore the NETWORK one', () => {
    const net = makeConfig('NETWORK');
    net.settings.dabmux.ediTistOffsetSec = 5;
    net.settings.dabmux.outputs = [{ id: 'a', type: 'edi-tcp', port: 13001 }];
    assert.ok(!buildMuxConfig(net).includes('tist_offset'));
    const edi = makeConfig('EDI');
    edi.settings.dabmux.tistOffsetSec = 7;
    assert.ok(!buildMuxConfig(edi).includes('tist_offset'));
    const easy = makeConfig('EASYDAB');
    easy.settings.dabmux.tistOffsetSec = 7;
    easy.settings.dabmux.outputs = [{ id: 'x', type: 'edi-udp', destination: '10.0.0.1' }];
    const e = buildMuxConfig(easy);
    assert.ok(!e.includes('tist_offset') && !e.includes('10.0.0.1'), 'EASYDAB unchanged by the outputs list');
  });
});

describe('muxBuilder — labels', () => {
  it('a label never adds a line to the .mux (quotes and line breaks neutralised)', () => {
    const cfg = makeConfig();
    cfg.settings.ensemble.label = 'Evil"\n    outputs { x "file:///tmp/x" }';
    const text = buildMuxConfig(cfg);
    const line = text.split('\n').find((l) => l.trim().startsWith('label') && l.includes('Evil'));
    assert.ok(line, 'label kept on one line');
    assert.doesNotMatch(line, /"[^"]*"[^"]*"/, 'no extra quote');
    assert.doesNotMatch(text, /^\s*outputs \{ x/m, 'no injected line');
  });
});
