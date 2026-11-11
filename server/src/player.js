// Web player: decodes one service of the running multiplex for listening in the browser.
//
// ETI monitoring output of odr-dabmux (TCP, same source as the Dablin button)
//   → dablin -p (decodes one sub-channel, raw float32 PCM on stdout)
//   → ffmpeg (MP3 encoding)
//   → HTTP response (audio/mpeg)
//
// Read-only for the broadcast chain: it is a client of the monitoring output, like Dablin.
// Processes run only while a browser is listening and are killed when it disconnects.
// They are NOT ODR chain processes: they are not tracked by processManager / pids.json.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const PLAYER_MAX_LISTENERS = 2;
const FORMAT_TIMEOUT_MS = 15000;   // dablin must find the service and report its PCM format

let listeners = 0;

export function findBin(name) {
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

export function missingPlayerTools() {
  return ['dablin', 'ffmpeg'].filter((b) => !findBin(b));
}

export function playerListeners() { return listeners; }

// Write without back-pressure: a slow consumer (paused browser, busy CPU) loses data instead of
// pausing the producer. Used for the mux monitoring socket, which is always read at full speed
// (dablin resyncs on the next ETI frame).
const MAX_QUEUED = 1 << 20;
function feed(stream, chunk) {
  if (stream.writable && stream.writableLength < MAX_QUEUED) stream.write(chunk);
}

// dablin prints "PCMOutput: format set; samplerate: 48000, channels: 2, output: 32bit float"
export function parsePcmFormat(text) {
  const m = /samplerate:\s*(\d+),\s*channels:\s*(\d+)/.exec(text);
  return m ? { rate: Number(m[1]), channels: Number(m[2]) } : null;
}

/**
 * Stream one sub-channel as MP3 into an HTTP response.
 * @param {object} o
 * @param {number} o.port      ETI monitoring TCP port of odr-dabmux (127.0.0.1)
 * @param {number} o.subchId   sub-channel id in the .mux (1-based, mux order)
 * @param {boolean} o.dabPlus  true = DAB+ (-R), false = DAB/MP2 (-r)
 * @param {object} o.req / o.res  Express request / response
 * @param {function} o.log     (msg, level) => void
 */
export function streamService({ port, subchId, dabPlus = true, req, res, log }) {
  listeners++;
  let done = false;
  let sock = null, dablin = null, ffmpeg = null, formatTimer = null;

  const cleanup = (why) => {
    if (done) return;
    done = true;
    listeners--;
    clearTimeout(formatTimer);
    try { sock?.destroy(); } catch { /* ignore */ }
    try { dablin?.kill('SIGTERM'); } catch { /* ignore */ }
    try { ffmpeg?.kill('SIGTERM'); } catch { /* ignore */ }
    if (!res.headersSent) res.status(502).json({ error: why });
    else res.end();
    log(`player: stopped sub-channel ${subchId} (${why})`, 'DEBUG');
  };
  req.on('close', () => cleanup('listener disconnected'));

  dablin = spawn('dablin', [dabPlus ? '-R' : '-r', String(subchId), '-p'], { stdio: ['pipe', 'pipe', 'pipe'] });
  dablin.on('error', (e) => cleanup(`dablin: ${e.message}`));
  dablin.on('exit', () => cleanup('decoder stopped'));
  dablin.stdin.on('error', () => { /* dablin gone: handled by exit */ });

  sock = net.connect({ host: '127.0.0.1', port });
  sock.on('error', (e) => cleanup(`mux monitoring output (port ${port}): ${e.message}`));
  sock.on('close', () => cleanup('mux monitoring output closed'));
  // Never slow down the mux output: always read it, drop data if the decoder lags behind
  sock.on('data', (b) => feed(dablin.stdin, b));

  // Wait for the PCM format (sample rate depends on the service) before starting ffmpeg
  let stderrBuf = '';
  const pending = [];
  formatTimer = setTimeout(() => cleanup(`sub-channel ${subchId} not found or no audio`), FORMAT_TIMEOUT_MS);
  const early = (b) => { pending.push(b); while (pending.length > 100) pending.shift(); };   // PCM before ffmpeg starts (~1 s kept)
  dablin.stdout.on('data', early);
  const onStderr = (chunk) => {
    stderrBuf = (stderrBuf + chunk.toString()).slice(-4000);
    const fmt = parsePcmFormat(stderrBuf);
    if (!fmt || ffmpeg || done) return;
    clearTimeout(formatTimer);
    dablin.stderr.off('data', onStderr);
    dablin.stderr.resume();   // keep draining dablin's stderr
    ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
      '-f', 'f32le', '-ar', String(fmt.rate), '-ac', String(fmt.channels), '-i', 'pipe:0',
      '-c:a', 'libmp3lame', '-b:a', '160k', '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    ffmpeg.on('error', (e) => cleanup(`ffmpeg: ${e.message}`));
    ffmpeg.on('exit', () => cleanup('encoder stopped'));
    ffmpeg.stdin.on('error', () => { /* ffmpeg gone: handled by exit */ });
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    dablin.stdout.off('data', early);
    for (const b of pending.splice(0)) feed(ffmpeg.stdin, b);
    // Downstream of the decoder, normal piping: a slow browser slows ffmpeg and dablin, and the
    // excess is dropped at the decoder input (feed above) — never at the mux side.
    dablin.stdout.pipe(ffmpeg.stdin);
    ffmpeg.stdout.pipe(res);
    log(`player: playing sub-channel ${subchId} (${fmt.rate} Hz, ${fmt.channels} ch)`);
  };
  dablin.stderr.on('data', onStderr);
}

export function acquireListenerSlot() {
  return listeners < PLAYER_MAX_LISTENERS;
}
