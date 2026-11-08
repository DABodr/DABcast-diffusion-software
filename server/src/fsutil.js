import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function readJson(p, fallback = null) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", 'utf8');
  fs.renameSync(tmp, p);
}

export function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

export function safeExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

export function resolveFrom(baseDir, ...parts) {
  return path.resolve(baseDir, ...parts);
}
