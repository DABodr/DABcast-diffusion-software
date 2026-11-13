// Transmitter outputs connection watch (EasyDAB / modulators on ZMQ, EDI/TCP, ETI/TCP)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OutputMonitor, DISCONNECT_MS } from '../src/outputMonitor.js';

function setup() {
  let t = 1000000;
  const lines = [];
  const logger = {
    line: (scope, msg, lvl = 'INFO') => lines.push(`${lvl} ${msg}`),
    recovery: (kind, scope, msg) => lines.push(`RECOVERY ${kind} ${msg}`),
  };
  const m = new OutputMonitor({ logger, now: () => t });
  const outputs = [
    { id: 'easydab', name: 'EasyDAB V2', type: 'zmq', port: 18081, enabled: true },
    { id: 'spare', name: 'Spare EDI', type: 'edi-tcp', port: 13000, enabled: true },
    { id: 'udp', name: 'TX UDP', type: 'edi-udp', port: 12000, enabled: true },
  ];
  const tick = (peers, { running = true, runKey = 1, sec = 5 } = {}) => {
    t += sec * 1000;
    m.tick({ running, runKey, outputs, peers: new Map(Object.entries(peers).map(([k, v]) => [Number(k), v])) });
  };
  return { m, lines, tick };
}

describe('OutputMonitor', () => {
  it('connected → lost for 15 s: one ERROR; connected again: one recovery', () => {
    const { lines, tick } = setup();
    tick({ 18081: ['192.168.2.4'] });
    tick({});   // 5 s: short drop (ZMQ reconnect), nothing
    tick({});   // 10 s
    assert.equal(lines.length, 0);
    tick({}, { sec: DISCONNECT_MS / 1000 - 10 + 1 });   // > 15 s since last seen
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^ERROR EasyDAB V2 disconnected: no transmitter connected on port 18081 for 16 s \(last: 192\.168\.2\.4\)/);
    tick({});
    assert.equal(lines.length, 1, 'reported once');
    tick({ 18081: ['192.168.2.4'] });
    assert.match(lines[1], /^RECOVERY outputs EasyDAB V2 connected again \(192\.168\.2\.4\) after 2\d s/);
  });

  it('never alerts for an output nobody connected to, nor for EDI/UDP (send only)', () => {
    const { lines, tick } = setup();
    for (let i = 0; i < 10; i++) tick({});
    assert.deepEqual(lines, []);
  });

  it('a Stop / new Start resets the watch (clients reconnect after a restart)', () => {
    const { lines, tick } = setup();
    tick({ 18081: ['192.168.2.4'] });
    tick({}, { running: false, sec: 60 });
    tick({}, { runKey: 2, sec: 20 });
    assert.deepEqual(lines, [], 'not connected yet after the new Start: no alert');
  });
});
