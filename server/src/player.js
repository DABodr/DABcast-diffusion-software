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

// Server-side meter: per-listener peak levels of the decoded PCM, time-stamped on the stream
// timeline (seconds of audio fed to ffmpeg = position in the MP3). Used by browsers whose Web Audio
// cannot analyse a live stream (iOS Safari): the page shows the level matching audio.currentTime.
const METER_WINDOWS_PER_S = 20;
const METER_KEEP = 30 * METER_WINDOWS_PER_S;   // ~30 s of history
const meters = new Map();                     // listener key -> [[t, dbL, dbR], ...]
const toDb = (x) => (x > 0 ? Math.max(-99, Math.round(200 * Math.log10(x)) / 10) : -99);
export function makeMeter(rate, channels, out) {
  const win = Math.max(1, Math.round(rate / METER_WINDOWS_PER_S));
  const frameBytes = 4 * channels;
  let rest = Buffer.alloc(0), n = 0, frames = 0, pl = 0, pr = 0;
  return (chunk) => {
    const b = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const usable = b.length - (b.length % frameBytes);
    for (let off = 0; off < usable; off += frameBytes) {
      const l = Math.abs(b.readFloatLE(off));
      const r = channels > 1 ? Math.abs(b.readFloatLE(off + 4)) : l;
      if (l > pl) pl = l;
      if (r > pr) pr = r;
      if (++n === win) {
        frames += n;
        out.push([Math.round(frames / rate * 1000) / 1000, toDb(pl), toDb(pr)]);
        n = 0; pl = 0; pr = 0;
      }
    }
    rest = Buffer.from(b.subarray(usable));
    if (out.length > METER_KEEP) out.splice(0, out.length - METER_KEEP);
  };
}
// Last failure reason per listener key, so the page can show it (an <audio> element cannot read
// the HTTP error body). Kept 5 min.
const lastErrors = new Map();   // key -> { reason, at }
export function playerLastError(key) {
  const e = lastErrors.get(String(key || ''));
  return e && Date.now() - e.at < 300000 ? e.reason : null;
}
const STALL_MS = 15000;   // no MP3 output for this long while the browser waits for data = stalled
const tail = (txt, n = 3) => String(txt || '').replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, '')
  .split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ');

export function playerLevels(key, since = 0) {
  const lv = meters.get(String(key || ''));
  return lv ? lv.filter((x) => x[0] > since) : null;
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
export function streamService({ port, subchId, dabPlus = true, key = '', req, res, log }) {
  listeners++;
  let done = false;
  let sock = null, dablin = null, ffmpeg = null, formatTimer = null;

  // byte counters per stage: tell which step stalls (mux output → dablin → ffmpeg)
  const bytes = { eti: 0, pcm: 0, mp3: 0 };
  let dablinErr = '', ffmpegErr = '', stallTimer = null;
  const counters = () => `mux ${bytes.eti} B, decoded ${bytes.pcm} B, MP3 ${bytes.mp3} B`;

  // normal = the listener closed the player; anything else is a failure → WARN in the logs
  const cleanup = (why, normal = false) => {
    if (done) return;
    done = true;
    listeners--;
    clearTimeout(formatTimer);
    clearInterval(stallTimer);
    if (key) meters.delete(key);
    try { sock?.destroy(); } catch { /* ignore */ }
    try { dablin?.kill('SIGTERM'); } catch { /* ignore */ }
    try { ffmpeg?.kill('SIGTERM'); } catch { /* ignore */ }
    if (!res.headersSent) res.status(502).json({ error: why });
    else res.end();
    if (normal) {
      log(`player: stopped sub-channel ${subchId} (${why})`, 'DEBUG');
      return;
    }
    if (key) lastErrors.set(key, { reason: why, at: Date.now() });
    const details = [tail(dablinErr) && `dablin: ${tail(dablinErr)}`, tail(ffmpegErr) && `ffmpeg: ${tail(ffmpegErr)}`].filter(Boolean).join(' · ');
    log(`player: sub-channel ${subchId} FAILED — ${why} [${counters()}]${details ? ` — ${details}` : ''}`, 'WARN');
  };
  // listener left: normal if audio was flowing; if no audio was ever produced, the browser gave up
  // waiting → that is the failure to report (stage counters show where it blocked)
  req.on('close', () => (bytes.mp3 > 0
    ? cleanup('listener disconnected', true)
    : cleanup(ffmpeg ? 'no audio produced (the browser gave up waiting)' : 'decoder found no audio before the browser gave up')));

  dablin = spawn('dablin', [dabPlus ? '-R' : '-r', String(subchId), '-p'], { stdio: ['pipe', 'pipe', 'pipe'] });
  dablin.on('error', (e) => cleanup(`dablin: ${e.message}`));
  dablin.on('exit', (code, sig) => cleanup(`decoder (dablin) stopped${code != null ? `, exit code ${code}` : ''}${sig ? `, ${sig}` : ''}`));
  dablin.stdin.on('error', () => { /* dablin gone: handled by exit */ });

  sock = net.connect({ host: '127.0.0.1', port });
  sock.on('error', (e) => cleanup(`mux monitoring output (port ${port}): ${e.message}`));
  sock.on('close', () => cleanup('mux monitoring output closed'));
  // Never slow down the mux output: always read it, drop data if the decoder lags behind
  sock.on('data', (b) => { bytes.eti += b.length; feed(dablin.stdin, b); });

  // Wait for the PCM format (sample rate depends on the service) before starting ffmpeg
  let stderrBuf = '';
  const pending = [];
  formatTimer = setTimeout(() => cleanup(`sub-channel ${subchId} not found or no audio after ${FORMAT_TIMEOUT_MS / 1000} s`), FORMAT_TIMEOUT_MS);
  dablin.stdout.on('data', (b) => { bytes.pcm += b.length; });
  const early = (b) => { pending.push(b); while (pending.length > 100) pending.shift(); };   // PCM before ffmpeg starts (~1 s kept)
  dablin.stdout.on('data', early);
  const onStderr = (chunk) => {
    stderrBuf = (stderrBuf + chunk.toString()).slice(-4000);
    dablinErr = stderrBuf;
    const fmt = parsePcmFormat(stderrBuf);
    if (!fmt || ffmpeg || done) return;
    clearTimeout(formatTimer);
    dablin.stderr.off('data', onStderr);
    dablin.stderr.on('data', (c) => { dablinErr = (dablinErr + c.toString()).slice(-2000); });   // keep draining, keep the tail for the logs
    ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
      '-f', 'f32le', '-ar', String(fmt.rate), '-ac', String(fmt.channels), '-i', 'pipe:0',
      '-c:a', 'libmp3lame', '-b:a', '160k', '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    ffmpeg.on('error', (e) => cleanup(`ffmpeg: ${e.message}`));
    ffmpeg.on('exit', (code, sig) => cleanup(`encoder (ffmpeg) stopped${code != null ? `, exit code ${code}` : ''}${sig ? `, ${sig}` : ''}`));
    ffmpeg.stdin.on('error', () => { /* ffmpeg gone: handled by exit */ });
    ffmpeg.stderr.on('data', (c) => { ffmpegErr = (ffmpegErr + c.toString()).slice(-2000); });
    ffmpeg.stdout.on('data', (b) => { bytes.mp3 += b.length; });
    // stall watchdog: no MP3 for STALL_MS while the browser is not the one holding back (no back-pressure)
    let lastMp3 = 0, lastMoveAt = Date.now();
    stallTimer = setInterval(() => {
      if (bytes.mp3 !== lastMp3 || res.writableNeedDrain) { lastMp3 = bytes.mp3; lastMoveAt = Date.now(); return; }
      if (Date.now() - lastMoveAt >= STALL_MS) cleanup(`stalled: no audio for ${STALL_MS / 1000} s`);
    }, 2500);
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    dablin.stdout.off('data', early);
    // meter sees exactly the PCM fed to ffmpeg, in the same order → same timeline as the MP3
    const levels = [];
    const meter = makeMeter(fmt.rate, fmt.channels, levels);
    if (key) meters.set(key, levels);
    for (const b of pending) meter(b);
    dablin.stdout.on('data', meter);
    for (const b of pending.splice(0)) feed(ffmpeg.stdin, b);
    // Downstream of the decoder, normal piping: a slow browser slows ffmpeg and dablin, and the
    // excess is dropped at the decoder input (feed above) — never at the mux side.
    dablin.stdout.pipe(ffmpeg.stdin);
    ffmpeg.stdout.pipe(res, { end: false });   // only cleanup() ends the response, after logging why
    log(`player: playing sub-channel ${subchId} (${fmt.rate} Hz, ${fmt.channels} ch)`);
  };
  dablin.stderr.on('data', onStderr);
}

export function acquireListenerSlot() {
  return listeners < PLAYER_MAX_LISTENERS;
}
