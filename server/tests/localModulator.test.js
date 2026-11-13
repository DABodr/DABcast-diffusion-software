// Watchdog supervision of the local modulator (SDR / HackRF): broken or stalled chain → reported once,
// restarted every 30 s, "transmitting again" when it sends frames again. Fake process manager and a fake
// odr-dabmod remote control (telnet) server: nothing is spawned, nothing is transmitted.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { AppState } from '../src/appState.js';
import { parseRcReply, getDabmodValue } from '../src/odr/dabmodRc.js';

describe('odr-dabmod remote control client', () => {
  it('reads the value between the prompts', () => {
    assert.equal(parseRcReply("ODR-DabMod Remote Control CLI\nWrite 'help' for help.\n**********\n> 1499> "), '1499');
    assert.equal(parseRcReply('ODR-DabMod Remote Control CLI\n**********\n> '), null, 'reply not received yet');
  });
});

describe('local modulator supervision (watchdog)', () => {
  let server;
  let frames = '0';
  before(async () => {
    server = net.createServer((sock) => {
      sock.write("ODR-DabMod Remote Control CLI\nWrite 'help' for help.\n**********\n> ");
      sock.on('data', () => sock.write(`${frames}> `));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
  });
  after(() => server.close());

  // a fake AppState: only what _superviseLocalModulator uses
  function fake({ type = 'sdr', alive = { 'mux:odr-dabmod': true } } = {}) {
    const lines = [];
    const spawned = [];
    const f = {
      muxRunning: true,
      muxStatus: 'on',
      lastError: null,
      _modState: null,
      dabmodRcPort: server.address().port,
      logger: {
        line: (scope, msg, lvl = 'INFO') => lines.push(`${lvl} ${msg}`),
        recovery: (kind, scope, msg) => lines.push(`INFO ${msg}`, `RECOVERY ${kind}`),   // Telegram ✅ RESOLVED (option)
      },
      _logRecovery: AppState.prototype._logRecovery,
      pm: {
        alive,
        isRunning: (k) => Boolean(alive[k]),
        stop: async (k) => { delete alive[k]; },
      },
      _localHackrf: () => ({ hk: { type, dabBlock: '7A' }, ediPort: 13090 }),
      _localSoapy: () => type === 'sdr',
      _otherOutputsOn: () => f.others === true,
      _spawnLocalModulator: () => { spawned.push(Date.now()); alive['mux:odr-dabmod'] = true; if (type !== 'sdr') alive['mux:hackrf_transfer'] = true; },
      lines,
      spawned,
    };
    f.tick = () => AppState.prototype._superviseLocalModulator.call(f);
    return f;
  }

  it('the remote control client reads the fake server', async () => {
    frames = '42';
    assert.equal(await getDabmodValue('sdr', 'frames', { port: server.address().port }), '42');
    assert.equal(await getDabmodValue('sdr', 'frames', { port: 1 }), null, 'not reachable = null');
  });

  it('SDR stalled (frames stop): reported once, restarted, back on air when frames move again', async () => {
    const f = fake();
    frames = '100';
    await f.tick();
    assert.equal(f._modState.lastFrames, 100);
    assert.equal(f.lines.length, 0, 'sending frames: nothing logged');
    // 16 s without a new frame
    f._modState.lastProgressMs -= 16000;
    await f.tick();
    assert.equal(f.muxStatus, 'fail');
    assert.match(f.lastError, /SDR stalled: no frame sent/);
    assert.equal(f.lines.filter((l) => l.startsWith('ERROR')).length, 1, 'one ERROR per incident');
    assert.equal(f.spawned.length, 1, 'odr-dabmod restarted at once');
    // still stuck (counter restarted at 0 and stays there): no new ERROR, next restart only after 30 s
    frames = '0';
    await f.tick();
    f._modState.lastProgressMs -= 16000;
    await f.tick();
    assert.equal(f.spawned.length, 1, 'retry waits 30 s');
    assert.equal(f.lines.filter((l) => l.startsWith('ERROR')).length, 1);
    f._modState.restartAfterMs = 0;
    await f.tick();
    assert.equal(f.spawned.length, 2, 'retried after 30 s');
    // device back: frames move again
    frames = '25';
    await f.tick();
    assert.equal(f.muxStatus, 'on');
    assert.ok(f.lines.some((l) => /^INFO SDR transmitting again/.test(l)));
    assert.ok(f.lines.includes('RECOVERY outputs'), 'sent as a recovery (Telegram ✅ RESOLVED when its option is on)');
    assert.equal(f._modState.failing, false);
  });

  it('other outputs on air (EasyDAB…): the mux stays ON AIR, no popup; restarted all the same', async () => {
    const f = fake({ alive: {} });   // odr-dabmod dead
    f.others = true;
    await f.tick();
    assert.equal(f.muxStatus, 'on');
    assert.equal(f.lastError, null);
    assert.equal(f._modState.failing, true, 'shown on the SDR output (/api/mux/outputs local.failing)');
    assert.equal(f.lines.filter((l) => l.startsWith('ERROR')).length, 1, 'still logged (Telegram)');
    assert.equal(f.spawned.length, 1);
  });

  it('remote control not reachable: no verdict, nothing restarted', async () => {
    const f = fake();
    f.dabmodRcPort = 1;
    f._modState = { lastFrames: 5, lastProgressMs: Date.now() - 60000, failing: false, failingSinceMs: 0, restartAfterMs: 0, attempts: 0 };
    await f.tick();
    assert.equal(f.spawned.length, 0);
    assert.equal(f.muxStatus, 'on');
  });

  it('hackrf_transfer chain broken: restarted, back on air after 10 s alive', async () => {
    const f = fake({ type: 'hackrf', alive: { 'mux:odr-dabmod': true } });   // hackrf_transfer died
    await f.tick();
    assert.match(f.lastError, /HACKRF chain broken: dabmod=true hackrf=false/);
    assert.equal(f.spawned.length, 1);
    assert.ok(!f.pm.alive['mux:odr-dabmod'] || f.spawned.length === 1, 'odr-dabmod stopped then respawned with hackrf_transfer');
    await f.tick();
    assert.equal(f._modState.failing, true, 'not yet 10 s alive');
    f._modState.restartedMs -= 11000;
    await f.tick();
    assert.equal(f._modState.failing, false);
    assert.equal(f.muxStatus, 'on');
  });

  it('Stop pressed during the supervision: never spawns', async () => {
    const f = fake({ alive: {} });   // odr-dabmod dead
    f.pm.stop = async () => { f.muxRunning = false; };   // stopMux happened while stopping
    await f.tick();
    assert.equal(f.spawned.length, 0);
  });
});
