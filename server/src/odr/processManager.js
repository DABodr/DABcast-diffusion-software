import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export class OdrProcessManager {
  constructor({ logger, odrBinDir, runtimeDir }) {
    this.logger = logger;
    this.odrBinDir = odrBinDir || '';
    this.runtimeDir = runtimeDir;
    this.pidsPath = path.resolve(runtimeDir, 'pids.json');
    /** @type {Map<string, import('node:child_process').ChildProcess>} */
    this.procs = new Map();

    // CRITICAL FIX: Serialize pids.json access to prevent race conditions
    this._pidsLock = Promise.resolve();
  }

  _resolveBin(bin) {
    if (!this.odrBinDir) return bin;
    if (path.isAbsolute(bin)) return bin;
    return path.join(this.odrBinDir, bin);
  }

  // CRITICAL FIX: Serialize pids.json access with promise chain
  async _withPidsLock(fn) {
    this._pidsLock = this._pidsLock.then(() => fn()).catch(() => {});
    return this._pidsLock;
  }

  _loadPids() {
    if (!fs.existsSync(this.pidsPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.pidsPath, 'utf8'));
    } catch {
      return {};
    }
  }

  _savePids(pids) {
    // CRITICAL FIX: Atomic write (temp file + rename)
    const tempPath = `${this.pidsPath}.tmp.${randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(pids, null, 2), { encoding: 'utf8', mode: 0o644 });
      fs.renameSync(tempPath, this.pidsPath);
    } catch (err) {
      // Cleanup temp file if rename failed
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
      throw err;
    }
  }

  _setPid(key, pid) {
    // CRITICAL FIX: Serialize access to pids.json
    return this._withPidsLock(() => {
      const pids = this._loadPids();
      if (pid) pids[key] = pid;
      else delete pids[key];
      this._savePids(pids);
    });
  }

  _pidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  isRunning(key) {
    const p = this.procs.get(key);
    return Boolean(p && !p.killed);
  }

  binaryExists(bin) {
    const resolved = this._resolveBin(bin);
    const r = spawnSync('which', [resolved], { encoding: 'utf8', timeout: 3000 });
    return r.status === 0;
  }

  // Check if a PID's cmdline matches an ODR process (anti PID-reuse)
  _isOdrProcess(pid) {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return /odr[-_]?(dabmux|audioenc|padenc|dabmod)|hackrf_transfer/i.test(cmdline);
    } catch {
      return false; // process gone or /proc not available
    }
  }

  // Kill orphan processes from a previous crash (stale pids.json)
  cleanupOrphans() {
    // Remove stale atomic-write temp files left by a previous crash
    // (pids.json.tmp.XXXXXXXX accumulate when the process dies mid-rename)
    try {
      for (const f of fs.readdirSync(this.runtimeDir)) {
        if (f.includes('.tmp.')) {
          try { fs.unlinkSync(path.resolve(this.runtimeDir, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore — runtimeDir may not exist yet */ }

    const pids = this._loadPids();
    const entries = Object.entries(pids);
    if (!entries.length) return;

    this.logger.line('cleanup', `checking ${entries.length} stale PID(s)`);
    for (const [key, pid] of entries) {
      if (!this._pidAlive(pid)) {
        this.logger.line('cleanup', `stale PID ${pid} (${key}) already gone`);
        continue;
      }
      // Verify cmdline before killing — prevents PID reuse attacks
      if (!this._isOdrProcess(pid)) {
        this.logger.line('cleanup', `PID ${pid} (${key}) alive but NOT an ODR process — skipping (PID reuse)`);
        continue;
      }
      this.logger.line('cleanup', `killing orphan ${key} (PID ${pid})`);
      try { process.kill(-pid, 'SIGKILL'); } catch {
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      }
    }
    // Clear pids file
    this._savePids({});
  }

  spawn(key, bin, args, opts = {}) {
    if (this.procs.has(key)) {
      throw new Error(`Process already running: ${key}`);
    }

    const resolved = this._resolveBin(bin);
    // Hide command-line args for ODR tools (contain config details)
    const logBin = path.basename(resolved);
    const hideArgs = ['odr-audioenc', 'odr-padenc', 'odr-dabmux'].includes(logBin);
    if (!hideArgs) {
      this.logger.line(key, `spawn: ${resolved} ${args.join(' ')}`);
    }

    const child = spawn(resolved, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      ...opts
    });

    if (child.pid) {
      this._setPid(key, child.pid);
      if (hideArgs) {
        this.logger.line(key, `spawn: ${logBin} Ok`);
      }
    }

    // Line-buffered stdout/stderr.
    // NOTE: odr-audioenc prints its VU meter using carriage returns (\r) without newlines.
    // If we split only on \n, the VU updates never reach the parser/UI.
    const stdoutPending = { buf: '' };
    const stderrPending = { buf: '' };

    /**
     * Drain a stream buffer into logical "lines".
     * Splits on: \n, \r, and treats \r\n as a single delimiter.
     * Keeps the last partial segment in `pending.buf`.
     */
    const drain = (pending, chunk, onLine) => {
      pending.buf += chunk.toString('utf8');
      const s = pending.buf;
      let start = 0;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch !== '\n' && ch !== '\r') continue;

        const line = s.slice(start, i);
        if (line) onLine(line);

        // Consume delimiter(s)
        if (ch === '\r' && s[i + 1] === '\n') i++;
        start = i + 1;
      }
      pending.buf = s.slice(start);
    };

    child.stdout?.on('data', (chunk) => {
      drain(stdoutPending, chunk, (line) => {
        this.logger.line(key, `[stdout] ${line}`, 'DEBUG');
        // Some builds/configs may send VU updates to stdout.
        if (opts.onStderr) opts.onStderr(line);
      });
    });
    child.stdout?.on('close', () => {
      const rest = stdoutPending.buf.trimEnd();
      if (rest) {
        this.logger.line(key, `[stdout] ${rest}`, 'DEBUG');
        if (opts.onStderr) opts.onStderr(rest);
      }
    });

    child.stderr?.on('data', (chunk) => {
      drain(stderrPending, chunk, (line) => {
        this.logger.line(key, `[stderr] ${line}`, 'DEBUG');
        if (opts.onStderr) opts.onStderr(line);
      });
    });
    child.stderr?.on('close', () => {
      const rest = stderrPending.buf.trimEnd();
      if (rest) {
        this.logger.line(key, `[stderr] ${rest}`, 'DEBUG');
        if (opts.onStderr) opts.onStderr(rest);
      }
    });

    child.on('error', (err) => {
      this.logger.line(key, `spawn error: ${err.message}`, 'ERROR');
      this.procs.delete(key);
      this._setPid(key, null);
      if (opts.onExit) opts.onExit(-1, null);
    });

    child.on('exit', (code, signal) => {
      if (child._stoppedIntentionally) {
        this.logger.line(key, 'stopped', 'DEBUG');
      } else {
        this.logger.line(key, `exit: code=${code} signal=${signal}`, code === 0 ? 'DEBUG' : 'ERROR');
      }
      this.procs.delete(key);
      this._setPid(key, null);
      if (opts.onExit) opts.onExit(code, signal);
    });

    // Detached but we still track it; unref so it doesn't keep Node alive on shutdown
    child.unref();

    this.procs.set(key, child);
    return child;
  }

  async stop(key, { signal = 'SIGTERM', timeoutMs = 1500 } = {}) {
    const child = this.procs.get(key);
    if (!child) return; // idempotent

    child._stoppedIntentionally = true;
    this.logger.line(key, `stop: sending ${signal}`, 'DEBUG');
    // Kill the entire process group (negative PID) to catch child processes (e.g. GStreamer)
    try { process.kill(-child.pid, signal); } catch {
      try { child.kill(signal); } catch { /* ignore */ }
    }

    // Wait for exit event OR timeout
    const exited = await new Promise((resolve) => {
      if (!this.procs.has(key)) return resolve(true);
      const timer = setTimeout(() => resolve(false), timeoutMs);
      child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });

    if (!exited && this.procs.has(key)) {
      this.logger.line(key, 'stop: force SIGKILL', 'WARN');
      try { process.kill(-child.pid, 'SIGKILL'); } catch {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }
  }

  async stopAll(prefix = '') {
    const keys = [...this.procs.keys()].filter((k) => k.startsWith(prefix));
    for (const k of keys) {
      await this.stop(k);
    }
  }
}
