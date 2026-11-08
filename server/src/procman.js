import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { appendLog, ensureDir } from "./fsutil.js";

function nowIso() {
  return new Date().toISOString();
}

export class ProcessManager {
  constructor({ settings }) {
    this.settings = settings;
    this.processes = new Map(); // key -> ChildProcess
  }

  _bin(cmd) {
    const binDir = this.settings.odr.binDir || "";
    return binDir ? path.join(binDir, cmd) : cmd;
  }

  isRunning(key) {
    const p = this.processes.get(key);
    return !!(p && !p.killed);
  }

  list() {
    return Array.from(this.processes.entries()).map(([key, p]) => ({
      key,
      pid: p.pid,
      exitCode: p.exitCode,
      killed: p.killed
    }));
  }

  spawnLogged(key, cmd, args, opts = {}) {
    if (this.processes.has(key) && this.isRunning(key)) {
      throw new Error(`${key} already running`);
    }

    const fullCmd = this._bin(cmd);
    const child = spawn(fullCmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...opts
    });

    this.processes.set(key, child);

    const logFile = this.settings.paths.logsFile;
    appendLog(logFile, `[${nowIso()}] [START] ${key}: ${fullCmd} ${args.join(" ")}`);

    child.stdout.on("data", (buf) => appendLog(logFile, `[${nowIso()}] [${key}] ${buf.toString().trimEnd()}`));
    child.stderr.on("data", (buf) => appendLog(logFile, `[${nowIso()}] [${key}] ${buf.toString().trimEnd()}`));

    child.on("exit", (code, sig) => {
      appendLog(logFile, `[${nowIso()}] [EXIT] ${key}: code=${code} sig=${sig}`);
    });

    child.on("error", (err) => {
      appendLog(logFile, `[${nowIso()}] [ERROR] ${key}: ${err.message}`);
    });

    return child;
  }

  async stop(key, { signal = "SIGTERM", timeoutMs = 2000 } = {}) {
    const p = this.processes.get(key);
    if (!p) return;

    try {
      p.kill(signal);
    } catch {
      // ignore
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (p.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    if (p.exitCode === null) {
      try { p.kill("SIGKILL"); } catch {}
    }

    this.processes.delete(key);
  }

  async stopAll(prefix = "") {
    const keys = Array.from(this.processes.keys()).filter((k) => k.startsWith(prefix));
    for (const k of keys) {
      await this.stop(k);
    }
  }

  ensureFifo(dir, fifoName) {
    ensureDir(dir);
    const fifoPath = path.join(dir, fifoName);
    try {
      const st = fs.statSync(fifoPath);
      if (!st.isFIFO?.()) {
        // If exists but not FIFO, replace
        fs.unlinkSync(fifoPath);
        throw new Error("not fifo");
      }
    } catch {
      // Create FIFO
      // Node doesn't create FIFOs directly; use mkfifo.
      // This is acceptable on Linux (Raspberry Pi OS/Debian).
      const mk = spawn("mkfifo", [fifoPath]);
      // best-effort wait
      // eslint-disable-next-line no-unused-vars
      mk.on("exit", (_c) => {});
    }
    return fifoPath;
  }
}
