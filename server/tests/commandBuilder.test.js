import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPadEncCommand, buildAudioEncCommand, buildDabMuxCommand, buildDabModConfig, buildHackrfTransferCommand } from '../src/odr/commandBuilder.js';

const makeSvc = (overrides = {}) => ({
  id: 'test1',
  identity: { pi: 'F408', ps8: 'TEST', ps16: 'TESTRADIO', pty: 10, languageHex: '0x0F' },
  dab: { bitrateKbps: 88, protectionLevel: 3 },
  input: { mode: 'VLC', uri: 'http://stream.example.com:8000/live', encoderBufferMs: 200 },
  audio: { channels: 2, sampleRateHz: 48000, gainDb: 0, codec: 'HE-AAC v1 (SBR)', codecArgs: ['--sbr'] },
  pad: { fifoName: 'TEST1', dlsFile: 'TEST1.dls', slideDir: 'slide' },
  network: { ediOutputTcp: { host: '127.0.0.1', port: 9001 } },
  ...overrides
});

describe('buildPadEncCommand', () => {
  it('does not include -e flag (preserve logo.jpg)', () => {
    const cmd = buildPadEncCommand(makeSvc(), '/data/mot/TEST1/slide', '/data/runtime/TEST1.dls');
    assert.ok(!cmd.args.includes('-e'));
  });

  it('includes -s 1 (1 sec between slides)', () => {
    const cmd = buildPadEncCommand(makeSvc(), '/data/mot/TEST1/slide', '/data/runtime/TEST1.dls');
    const idx = cmd.args.indexOf('-s');
    assert.ok(idx >= 0);
    assert.equal(cmd.args[idx + 1], '1');
  });

  it('uses slide directory', () => {
    const cmd = buildPadEncCommand(makeSvc(), '/data/mot/TEST1/slide', '/data/runtime/TEST1.dls');
    const idx = cmd.args.indexOf('-d');
    assert.equal(cmd.args[idx + 1], '/data/mot/TEST1/slide');
  });

  it('uses absolute DLS runtime path when provided', () => {
    const cmd = buildPadEncCommand(makeSvc(), '/data/mot/TEST1/slide', '/data/runtime/F124.dls');
    const idx = cmd.args.indexOf('-t');
    assert.ok(idx >= 0);
    assert.equal(cmd.args[idx + 1], '/data/runtime/F124.dls');
  });
});

describe('buildAudioEncCommand', () => {
  it('uses -p 58 (PAD size)', () => {
    const cmd = buildAudioEncCommand({ svc: makeSvc(), activeUri: 'http://stream.example.com:8000/live', mtaPath: '/tmp/F408.mta' });
    const idx = cmd.args.indexOf('-p');
    assert.ok(idx >= 0);
    assert.equal(cmd.args[idx + 1], '58');
  });

  it('uses speex-resampler for VLC mode (non-HTTP source)', () => {
    const cmd = buildAudioEncCommand({ svc: makeSvc(), activeUri: 'alsa://hw:0,0', mtaPath: '/tmp/F408.mta' });
    assert.ok(cmd.args.includes('--audio-resampler=speex-resampler'));
  });

  it('does NOT include speex-resampler for GStreamer mode', () => {
    const svc = makeSvc({ input: { mode: 'GST', uri: 'http://stream.example.com:8000/live' } });
    const cmd = buildAudioEncCommand({ svc, activeUri: svc.input.uri, mtaPath: '/tmp/F408.mta' });
    assert.ok(!cmd.args.includes('--audio-resampler=speex-resampler'));
    assert.ok(!cmd.args.includes('-L'));
    assert.ok(!cmd.args.includes('-C'));
  });

  it('includes -C (buffer) for VLC mode (non-HTTP source)', () => {
    const cmd = buildAudioEncCommand({ svc: makeSvc(), activeUri: 'alsa://hw:0,0', mtaPath: '/tmp/F408.mta' });
    const idx = cmd.args.indexOf('-C');
    assert.ok(idx >= 0);
    assert.equal(cmd.args[idx + 1], '200');
  });

  it('uses -s 180 (silence timeout)', () => {
    const cmd = buildAudioEncCommand({ svc: makeSvc(), activeUri: 'http://stream.example.com:8000/live', mtaPath: '/tmp/F408.mta' });
    const idx = cmd.args.indexOf('-s');
    assert.ok(idx >= 0);
    assert.equal(cmd.args[idx + 1], '180');
  });

  it('uses -G for GStreamer mode', () => {
    const svc = makeSvc({ input: { mode: 'GST', uri: 'http://stream.example.com:8000/live' } });
    const cmd = buildAudioEncCommand({ svc, activeUri: svc.input.uri, mtaPath: '/tmp/F408.mta' });
    assert.ok(cmd.args.includes('-G'));
    assert.ok(!cmd.args.includes('-v'));
  });

  it('uses -v for VLC mode even with HTTP source', () => {
    const svc = makeSvc({ input: { mode: 'VLC', uri: 'http://stream.example.com:8000/live' } });
    const cmd = buildAudioEncCommand({ svc, activeUri: svc.input.uri, mtaPath: '/tmp/F408.mta' });
    assert.ok(cmd.args.includes('-v'));
    assert.ok(!cmd.args.includes('-G'));
  });

  it('does NOT include -D for HTTP streams', () => {
    const cmd = buildAudioEncCommand({ svc: makeSvc(), activeUri: 'http://stream.example.com:8000/live', mtaPath: '/tmp/F408.mta' });
    assert.ok(!cmd.args.includes('-D'));
  });

  it('includes -D for non-HTTP sources', () => {
    const cmd = buildAudioEncCommand({ svc: makeSvc(), activeUri: '/dev/audio0', mtaPath: '/tmp/F408.mta' });
    assert.ok(cmd.args.includes('-D'));
  });

  it('includes -l (level indicator)', () => {
    const cmd = buildAudioEncCommand({ svc: makeSvc(), activeUri: 'http://stream.example.com:8000/live', mtaPath: '/tmp/F408.mta' });
    assert.ok(cmd.args.includes('-l'));
  });

  it('HE-AAC v1 passes --sbr only', () => {
    const svc = makeSvc({ audio: { channels: 2, sampleRateHz: 48000, gainDb: 0, codec: 'HE-AAC v1 (SBR)', codecArgs: ['--sbr'] } });
    const cmd = buildAudioEncCommand({ svc, activeUri: 'http://stream.example.com:8000/live', mtaPath: '/tmp/F408.mta' });
    assert.ok(cmd.args.includes('--sbr'));
    assert.ok(!cmd.args.includes('--ps'));
  });

  it('HE-AAC v2 passes --ps only (not --sbr)', () => {
    const svc = makeSvc({ audio: { channels: 2, sampleRateHz: 48000, gainDb: 0, codec: 'HE-AAC v2 (PS)', codecArgs: ['--ps'] } });
    const cmd = buildAudioEncCommand({ svc, activeUri: 'http://stream.example.com:8000/live', mtaPath: '/tmp/F408.mta' });
    assert.ok(cmd.args.includes('--ps'));
    assert.ok(!cmd.args.includes('--sbr'));
  });

  it('AAC-LC passes no codec flags', () => {
    const svc = makeSvc({ audio: { channels: 2, sampleRateHz: 48000, gainDb: 0, codec: 'AAC-LC', codecArgs: [] } });
    const cmd = buildAudioEncCommand({ svc, activeUri: 'http://stream.example.com:8000/live', mtaPath: '/tmp/F408.mta' });
    assert.ok(!cmd.args.includes('--sbr'));
    assert.ok(!cmd.args.includes('--ps'));
  });

  it('uses configurable PAD size', () => {
    const svc = makeSvc({ dab: { bitrateKbps: 88, protectionLevel: 3, padSize: 82 } });
    const cmd = buildAudioEncCommand({ svc, activeUri: 'http://stream.example.com:8000/live', mtaPath: '/tmp/F408.mta' });
    const idx = cmd.args.indexOf('-p');
    assert.equal(cmd.args[idx + 1], '82');
  });

  it('uses activeUri (backup) not svc.input.uri (main) when failover', () => {
    const svc = makeSvc();
    const backupUri = 'http://backup.example.com:9000/fallback';
    const cmd = buildAudioEncCommand({ svc, activeUri: backupUri, mtaPath: '/tmp/test.mta' });
    // The args must contain the BACKUP uri, not the main one
    assert.ok(cmd.args.includes(backupUri), 'args must contain backup URI');
    assert.ok(!cmd.args.includes(svc.input.uri), 'args must NOT contain main URI');
  });
});

describe('buildDabMuxCommand', () => {
  it('uses -e flag with mux path', () => {
    const cmd = buildDabMuxCommand('/tmp/current.mux');
    assert.deepEqual(cmd.args, ['-e', '/tmp/current.mux']);
  });
});

describe('buildDabModConfig', () => {
  it('generates valid INI with all parameters', () => {
    const config = buildDabModConfig({
      source: 'tcp://localhost:13000',
      maxFramesQueued: 580,
      gainmode: 2,
      digitalGain: 1,
      rate: 4096000,
      filtertapsPath: '/data/runtime/filtertaps.txt',
      fifoPath: '/data/runtime/ofdm.fifo'
    });
    assert.ok(config.includes('transport=edi'));
    assert.ok(config.includes('source=tcp://localhost:13000'));
    assert.ok(config.includes('max_frames_queued=580'));
    assert.ok(config.includes('gainmode=2'));
    assert.ok(config.includes('digital_gain=1'));
    assert.ok(config.includes('rate=4096000'));
    assert.ok(config.includes('filtertapsfile=/data/runtime/filtertaps.txt'));
    assert.ok(config.includes('format=s8'));
    assert.ok(config.includes('filename=/data/runtime/ofdm.fifo'));
  });
});

describe('buildHackrfTransferCommand', () => {
  it('builds correct command with all args', () => {
    const cmd = buildHackrfTransferCommand({
      fifoPath: '/data/runtime/ofdm.fifo',
      freqHz: 188928000,
      txGain: 47,
      rate: 4096000
    });
    assert.equal(cmd.bin, 'hackrf_transfer');
    assert.deepEqual(cmd.args, [
      '-t', '/data/runtime/ofdm.fifo',
      '-f', '188928000',
      '-x', '47',
      '-a', '1',
      '-s', '4096000',
      '-b', '1750000'
    ]);
  });
});
