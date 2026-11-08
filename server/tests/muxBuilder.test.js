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
});
