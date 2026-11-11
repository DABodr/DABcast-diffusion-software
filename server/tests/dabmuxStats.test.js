import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  buildGreeting, buildReady, encodeFrame, parseFrames, queryDabmux, normalizeValues
} from '../src/odr/dabmuxStats.js';

// Minimal fake ZMTP 3 REP peer: greets, sends READY, answers the first request with `reply`.
function fakeRep(reply) {
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let greeted = false;
    let parts = [];
    sock.write(buildGreeting());
    sock.write(buildReady('REP'));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!greeted) { if (buf.length < 64) return; greeted = true; buf = buf.subarray(64); }
      const { frames, offset } = parseFrames(buf);
      buf = buf.subarray(offset);
      for (const f of frames) {
        if (f.flags & 0x04) continue;
        parts.push(f.body.toString());
        if (!(f.flags & 0x01)) {
          srv.lastRequest = parts.filter(Boolean).join('');
          parts = [];
          sock.write(encodeFrame(Buffer.alloc(0), { more: true }));
          sock.write(encodeFrame(Buffer.from(reply)));
        }
      }
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

describe('dabmuxStats — ZMTP framing', () => {
  it('greeting is 64 bytes, ZMTP 3.0, NULL mechanism', () => {
    const g = buildGreeting();
    assert.equal(g.length, 64);
    assert.equal(g[0], 0xff);
    assert.equal(g[9], 0x7f);
    assert.equal(g[10], 3);
    assert.equal(g.subarray(12, 16).toString(), 'NULL');
  });

  it('round-trips short and long frames', () => {
    const big = Buffer.alloc(1000, 0x61);
    const buf = Buffer.concat([encodeFrame(Buffer.from('hi'), { more: true }), encodeFrame(big)]);
    const { frames, offset } = parseFrames(buf);
    assert.equal(offset, buf.length);
    assert.equal(frames.length, 2);
    assert.equal(frames[0].flags & 0x01, 1);
    assert.equal(frames[1].body.length, 1000);
  });

  it('waits for incomplete frames', () => {
    const buf = encodeFrame(Buffer.alloc(300, 1));
    const { frames, offset } = parseFrames(buf.subarray(0, 100));
    assert.equal(frames.length, 0);
    assert.equal(offset, 0);
  });
});

describe('dabmuxStats — queryDabmux', () => {
  it('sends the command and returns a long reply', async () => {
    const reply = JSON.stringify({ values: { sub_1: { inputstat: { state: 'Streaming (3)', pad: 'x'.repeat(600) } } } });
    const srv = await fakeRep(reply);
    try {
      const r = await queryDabmux(srv.address().port, 'values');
      assert.equal(srv.lastRequest, 'values');
      assert.equal(r, reply);
    } finally { srv.close(); }
  });

  it('times out on a silent peer without hanging', async () => {
    const srv = net.createServer(() => {});
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(queryDabmux(srv.address().port, 'values', { timeoutMs: 200 }), /timeout/);
    } finally { srv.close(); }
  });

  it('rejects a non-ZMTP peer', async () => {
    const srv = net.createServer((s) => s.write(Buffer.alloc(64, 0x41)));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(queryDabmux(srv.address().port, 'values', { timeoutMs: 500 }), /ZMTP/);
    } finally { srv.close(); }
  });

  it('rejects when nothing listens', async () => {
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    await new Promise((r) => srv.close(r));
    await assert.rejects(queryDabmux(port, 'values', { timeoutMs: 500 }));
  });
});

describe('dabmuxStats — normalizeValues', () => {
  it('maps sub_N to service ids and strips the state code', () => {
    const v = { values: {
      sub_1: { inputstat: { state: 'Streaming (3)', min_fill: 10, max_fill: 20, num_underruns: 1, num_overruns: 0, peak_left: -5, peak_right: -6, peak_left_slow: -1, peak_right_slow: -2 } },
      sub_2: { inputstat: { state: 'NoData (1)' } },
    } };
    const out = normalizeValues(v, { sub_1: { id: '0xF201', name: 'RADIO1' } });
    assert.equal(out['0xF201'].state, 'Streaming');
    assert.equal(out['0xF201'].name, 'RADIO1');
    assert.equal(out['0xF201'].underruns, 1);
    assert.equal(out['0xF201'].peakLeft, -5);
    assert.equal(out['0xF201'].peakLeftSlow, -1);
    assert.equal(out['0xF201'].peakRightSlow, -2);
    assert.equal(out.sub_2.state, 'NoData');
  });

  it('tolerates empty or malformed input', () => {
    assert.deepEqual(normalizeValues(null, {}), {});
    assert.deepEqual(normalizeValues({ values: { sub_1: {} } }, {}), {});
  });
});
