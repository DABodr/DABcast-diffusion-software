import path from 'node:path';
import { spawn } from 'node:child_process';

export class ProcessManager {
  constructor({ logger, odrBinDir }) {
    this.logger = logger;
    this.odrBinDir = odrBinDir || '';
    /** @type {Map<string, import('node:child_process').ChildProcess>} */
    this.procs = new Map();
  }

  _resolveBin(bin) {
    if (!this.odrBinDir) return bin;
    if (path.isAbsolute(bin)) return bin;
    return path.join(this.odrBinDir, bin);
  }

  isRunning(key) {
    const p = this.procs.get(key);
    return Boolean(p && !p.killed);
  }

  spawn(key, bin, args, opts = {}) {
    if (this.procs.has(key)) {
      throw new Error(`Process already running: ${key}`);
    }

    const resolved = this._resolveBin(bin);
    this.logger.line(key, `spawn: ${resolved} ${args.join(' ')}`);

    const child = spawn(resolved, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts
    });

    child.stdout?.on('data', (buf) => {
      this.logger.line(key, buf.toString('utf8').trimEnd());
    });
    child.stderr?.on('data', (buf) => {
      this.logger.line(key, buf.toString('utf8').trimEnd());
    });

    child.on('exit', (code, signal) => {
      this.logger.line(key, `exit: code=${code} signal=${signal}`);
      this.procs.delete(key);
    });

    this.procs.set(key, child);
    return child;
  }

  async stop(key, { signal = 'SIGTERM', timeoutMs = 1500 } = {}) {
    const child = this.procs.get(key);
    if (!child) return;

    this.logger.line(key, `stop: sending ${signal}`);
    try { child.kill(signal); } catch { /* ignore */ }

    await new Promise((resolve) => setTimeout(resolve, timeoutMs));

    if (this.procs.has(key)) {
      this.logger.line(key, 'stop: force SIGKILL');
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }

  async stopAll(prefix = '') {
    const keys = [...this.procs.keys()].filter((k) => k.startsWith(prefix));
    for (const k of keys) {
      await this.stop(k);
    }
  }
}
