import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './fsutil.js';

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_FILES = 5;
const DEDUP_WINDOW_MS = 5000;
const DEDUP_MAX_ENTRIES = 200;

export class FileLogger {
  constructor(logFilePath, { maxSize = DEFAULT_MAX_SIZE, maxFiles = DEFAULT_MAX_FILES, notifier = null } = {}) {
    this.logFilePath = logFilePath;
    this.maxSize = maxSize;
    this.maxFiles = maxFiles;
    this.notifier = notifier;
    this._currentSize = 0;
    this._checkInterval = 100; // check size every N writes
    this._writeCount = 0;
    this._dedup = new Map(); // anti-spam: key → { count, lastWriteMs }
    ensureDir(path.dirname(logFilePath));

    // Read current file size on startup
    try {
      this._currentSize = fs.statSync(logFilePath).size;
    } catch {
      this._currentSize = 0;
    }
  }

  line(scope, msg, level = 'INFO') {
    const lvl = String(level).toUpperCase();

    // Anti-spam dedup for DEBUG and WARN only (INFO/ERROR always written)
    if (lvl === 'DEBUG' || lvl === 'WARN') {
      const dedupKey = `${scope}|${this._msgSignature(msg)}`;
      const now = Date.now();
      const entry = this._dedup.get(dedupKey);

      if (entry && (now - entry.lastWriteMs) < DEDUP_WINDOW_MS) {
        entry.count++;
        return;
      }

      // Window expired or first occurrence
      let prefix = '';
      if (entry && entry.count > 0) {
        prefix = `[repeated ${entry.count}x] `;
      }

      this._dedup.set(dedupKey, { count: 0, lastWriteMs: now });
      if (this._dedup.size > DEDUP_MAX_ENTRIES) this._cleanupDedup(now);

      this._emit(scope, `${prefix}${msg}`, lvl);
      return;
    }

    this._emit(scope, msg, lvl);
  }

  _emit(scope, msg, level) {
    const timestamp = new Date().toISOString();
    this._write(`[${timestamp}] [${level}] [${scope}] ${msg}\n`);
    if (!this.notifier) return;

    try {
      const result = this.notifier.notify({ timestamp, level, scope, message: String(msg) });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch { /* remote notifications must never affect file logging */ }
  }

  _write(logLine) {
    fs.appendFileSync(this.logFilePath, logLine, 'utf8');
    this._currentSize += Buffer.byteLength(logLine, 'utf8');
    this._writeCount++;

    // Check rotation periodically (not on every write for performance)
    if (this._writeCount >= this._checkInterval) {
      this._writeCount = 0;
      if (this._currentSize >= this.maxSize) {
        this._rotate();
      }
    }
  }

  _msgSignature(msg) {
    if (/^(\[stderr\] )?In: \[/.test(msg)) return 'VU_METER';
    if (msg.includes('skipping slide insertion')) return 'PADENC_SKIP_SLIDE';
    return msg.slice(0, 60);
  }

  _cleanupDedup(now) {
    for (const [key, entry] of this._dedup) {
      if (now - entry.lastWriteMs > DEDUP_WINDOW_MS * 2) {
        this._dedup.delete(key);
      }
    }
  }

  _rotate() {
    try {
      // Delete oldest archive if at limit
      const oldest = `${this.logFilePath}.${this.maxFiles}`;
      try { fs.unlinkSync(oldest); } catch { /* ok */ }

      // Shift existing archives: .4 -> .5, .3 -> .4, etc.
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const from = `${this.logFilePath}.${i}`;
        const to = `${this.logFilePath}.${i + 1}`;
        try { fs.renameSync(from, to); } catch { /* ok */ }
      }

      // Current log -> .1
      fs.renameSync(this.logFilePath, `${this.logFilePath}.1`);
      this._currentSize = 0;
    } catch {
      // If rotation fails, continue logging to current file
    }
  }
}
