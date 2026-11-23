// Perceived loudness (EBU R128 / ITU-R BS.1770) of the services ON AIR, for the "Audio levels" page.
//
// ETI monitoring output of odr-dabmux (TCP, same source as the web player and Dablin)
//   → dablin -p (decodes one sub-channel)
//   → ffmpeg -af ebur128 (integrated loudness, loudness range, true peak)
//
// Measures what receivers get (after the encoder gain and the AAC encoding). Read-only for the
// broadcast chain: a client of the monitoring output, read without back-pressure (excess dropped,
// dabmux is never slowed down). One service at a time (CPU on a Raspberry Pi), queued on request.
// Not ODR chain processes: not tracked by processManager / pids.json, killed at the end of a
// measurement or on cancel. Results are kept in memory only.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { parsePcmFormat, makePcmSanitizer } from './player.js';

export const LOUDNESS_DURATIONS = [30, 60, 120, 300];   // seconds of audio per service
const FORMAT_TIMEOUT_MS = 15000;
const MAX_QUEUED = 1 << 20;

// ffmpeg ebur128 summary → { lufs, lra, truePeak } (null when the integrated loudness is missing)
export function parseEbur128Summary(text) {
  const s = String(text);
  const at = s.lastIndexOf('Summary:');
  if (at < 0) return null;
  const sum = s.slice(at);
  const num = (re) => { const m = re.exec(sum); return m ? Number(m[1]) : null; };
  const lufs = num(/I:\s*(-?[\d.]+|-inf)\s*LUFS/);
  if (lufs === null || !Number.isFinite(lufs)) return null;
  return { lufs, lra: num(/LRA:\s*(-?[\d.]+)\s*LU/), truePeak: num(/Peak:\s*(-?[\d.]+)\s*dBFS/) };
}

// Gain giving `target` LUFS, with the true peak kept under the ceiling: a boost never pushes it above,
// and a true peak already above forces a reduction (`peak`: it crackles in receivers), even below the target.
// Returns { gain, limited, peak } — gain null when within 1 dB. gainAt = gain during the measurement.
export const LOUDNESS_TP_CEILING = -1;
export function suggestLoudnessGain(gainAt, m, target, { min = -20, max = 20 } = {}) {
  if (!m || !Number.isFinite(m.lufs) || !Number.isFinite(target)) return null;
  let delta = target - m.lufs;
  let limited = false, peak = false;
  const room = Number.isFinite(m.truePeak) ? LOUDNESS_TP_CEILING - m.truePeak : Infinity;
  if (delta > room) { delta = room; limited = true; peak = room < 0; }
  if (Math.abs(delta) < 1) return { gain: null, limited, peak: false };
  const gain = Math.max(min, Math.min(max, Math.round((gainAt + delta) * 2) / 2));
  return { gain: gain === gainAt ? null : gain, limited, peak };
}

// One measurement. Calls done({ ok, lufs, lra, truePeak, seconds } | { ok: false, error }) once.
// Returns cancel().
export function measureLoudness({ port, subchId, seconds, dabPlus = true }, done) {
  let finished = false, sock = null, dablin = null, ffmpeg = null, timer = null, ffErr = '';
  const end = (r) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { sock?.destroy(); } catch { /* ignore */ }
    try { dablin?.kill('SIGTERM'); } catch { /* ignore */ }
    try { ffmpeg?.kill('SIGTERM'); } catch { /* ignore */ }
    done(r);
  };
  const fail = (error) => end({ ok: false, error });
  timer = setTimeout(() => fail(`sub-channel ${subchId} not found or no audio after ${FORMAT_TIMEOUT_MS / 1000} s`), FORMAT_TIMEOUT_MS);

  dablin = spawn('dablin', [dabPlus ? '-R' : '-r', String(subchId), '-p'], { stdio: ['pipe', 'pipe', 'pipe'] });
  dablin.on('error', (e) => fail(`dablin: ${e.message}`));
  dablin.on('exit', () => { if (!ffmpeg) fail('decoder (dablin) stopped'); else ffmpeg.stdin.end(); });   // partial audio still measured
  dablin.stdin.on('error', () => { /* handled by exit */ });
  sock = net.connect({ host: '127.0.0.1', port });
  sock.on('error', (e) => fail(`mux monitoring output (port ${port}): ${e.message}`));
  sock.on('close', () => { try { dablin.stdin.end(); } catch { /* ignore */ } });   // mux stopped → dablin ends
  sock.on('data', (b) => { if (dablin.stdin.writable && dablin.stdin.writableLength < MAX_QUEUED) dablin.stdin.write(b); });

  let errBuf = '';
  dablin.stderr.on('data', (c) => {
    if (ffmpeg || finished) return;
    errBuf = (errBuf + c.toString()).slice(-4000);
    const fmt = parsePcmFormat(errBuf);
    if (!fmt) return;
    clearTimeout(timer);
    const need = seconds * fmt.rate * fmt.channels * fmt.bytes;   // bytes of PCM to analyse
    let fed = 0;
    ffmpeg = spawn('ffmpeg', ['-hide_banner', '-nostats', '-f', fmt.ffmpegFormat, '-ar', String(fmt.rate), '-ac', String(fmt.channels),
      '-i', 'pipe:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    ffmpeg.on('error', (e) => fail(`ffmpeg: ${e.message}`));
    ffmpeg.stdin.on('error', () => { /* handled by exit */ });
    ffmpeg.stderr.on('data', (d) => { ffErr = (ffErr + d.toString()).slice(-6000); });
    ffmpeg.on('exit', () => {
      const m = parseEbur128Summary(ffErr);
      if (m) end({ ok: true, ...m, seconds: Math.round(fed / (fmt.rate * fmt.channels * fmt.bytes)) });
      else fail('no loudness measured (silence?)');
    });
    const clean = makePcmSanitizer(fmt.channels, () => {}, fmt);
    dablin.stdout.on('data', (b) => {
      if (fed >= need) return;
      const pcm = clean(b);
      const part = pcm.subarray(0, Math.min(pcm.length, need - fed));
      fed += part.length;
      ffmpeg.stdin.write(part);
      if (fed >= need) {   // enough audio: stop decoding, let ffmpeg print its summary
        try { sock.destroy(); } catch { /* ignore */ }
        try { dablin.kill('SIGTERM'); } catch { /* ignore */ }
        ffmpeg.stdin.end();
      }
    });
    timer = setTimeout(() => fail('measurement too slow (no audio from the mux?)'), (seconds * 2 + 20) * 1000);
  });
  return () => fail('cancelled');
}

// Queue: one measurement at a time. getTarget(id) → { port, subchId, gainDb } or null (no longer on air).
export function createLoudnessQueue({ getTarget, log = () => {} }) {
  const results = new Map();   // id → { ok, lufs, lra, truePeak, seconds, gainDb, at } | { ok: false, error, at }
  let queue = [], running = null, cancel = null;
  const next = () => {
    if (running || !queue.length) return;
    const { id, seconds } = queue.shift();
    const t = getTarget(id);
    if (!t) { results.set(id, { ok: false, error: 'not on air', at: Date.now() }); next(); return; }
    running = { id, seconds, startedAt: Date.now() };
    cancel = measureLoudness({ port: t.port, subchId: t.subchId, seconds }, (r) => {
      results.set(id, { ...r, gainDb: t.gainDb, at: Date.now() });
      if (r.ok) log(`${id}: loudness ${r.lufs} LUFS, true peak ${r.truePeak} dBTP, LRA ${r.lra} LU (${r.seconds} s, gain ${t.gainDb} dB)`);
      else if (r.error !== 'cancelled') log(`${id}: loudness not measured: ${r.error}`, 'WARN');
      running = null; cancel = null;
      next();
    });
  };
  return {
    add(ids, seconds) {
      for (const id of ids) if (running?.id !== id && !queue.some((q) => q.id === id)) queue.push({ id, seconds });
      next();
    },
    cancelAll() { queue = []; cancel?.(); },
    state() {
      return { running, queue: queue.map((q) => q.id), results: Object.fromEntries(results) };
    },
  };
}
