// Automatic updates at a time chosen in ⚙ Settings (off by default). Rules only (no I/O): the scheduler,
// the installation and the check after the restart live in index.js.
//
// - installs the latest official release, at HH:MM (server local time), on the days ticked, once a day;
// - only a release published at least delayDays ago (a broken release is usually replaced within days);
// - never a version that had to be rolled back (skip list);
// - after the restart, a health check: when the multiplex was ON AIR it must be back on air with at least
//   as many services running as before, else the previous version is installed again (rollback).

export const DEFAULT_AUTO_UPDATE = { enabled: false, time: '02:00', days: [1, 2, 3, 4, 5, 6, 7], delayDays: 3, skip: [] };
export const AUTO_UPDATE_DELAYS = [0, 1, 3, 7];
export const AUTO_UPDATE_CHECK_MS = 5 * 60000;   // health check 5 min after the restart
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function normalizeAutoUpdate(s = {}) {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time) ? s.time : DEFAULT_AUTO_UPDATE.time;
  const days = [...new Set((Array.isArray(s.days) ? s.days : DEFAULT_AUTO_UPDATE.days).map(Number).filter((d) => d >= 1 && d <= 7))].sort();
  const delayDays = AUTO_UPDATE_DELAYS.includes(Number(s.delayDays)) ? Number(s.delayDays) : DEFAULT_AUTO_UPDATE.delayDays;
  const skip = (Array.isArray(s.skip) ? s.skip : []).map(String).filter((v) => VERSION.test(v)).slice(-20);
  return { enabled: s.enabled === true, time, days, delayDays, skip };
}

// -1 / 0 / 1
export function compareVersions(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
}

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
// Is it the time to try (this minute, a day ticked, not tried yet today)? lastDay = dayKey of the last try.
export function isDue(cfg, now = new Date(), lastDay = null) {
  if (!cfg.enabled || !cfg.days.length) return false;
  const dow = ((now.getDay() + 6) % 7) + 1;   // 1 = Monday … 7 = Sunday
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return cfg.days.includes(dow) && hm === cfg.time && lastDay !== dayKey(now);
}
export { dayKey };

// Version to install, or why not: { version } | { none: reason }
export function pickVersion({ cfg, current, latest, publishedAt, now = Date.now() }) {
  if (!latest || !VERSION.test(latest)) return { none: 'no release information' };
  if (compareVersions(latest, current) <= 0) return { none: `up to date (v${current})` };
  if (cfg.skip.includes(latest)) return { none: `v${latest} was rolled back before: skipped` };
  const age = now - Date.parse(publishedAt || '');
  if (!Number.isFinite(age)) return { none: 'release date unknown' };
  if (age < cfg.delayDays * 86400000) {
    const left = Math.ceil((cfg.delayDays * 86400000 - age) / 86400000);
    return { none: `v${latest} published less than ${cfg.delayDays} day(s) ago (installed in ${left} day(s) at the earliest)` };
  }
  return { version: latest };
}

// Health after the restart: { ok, reason }. before / after = { muxRunning, running } (services running).
export function healthAfterUpdate({ wasOnAir, before, after }) {
  if (!wasOnAir) return { ok: true, reason: 'multiplex was off air: nothing to compare' };
  if (!after.muxRunning) return { ok: false, reason: 'multiplex not back on air' };
  if (after.running < before.running) return { ok: false, reason: `${after.running} service(s) running instead of ${before.running}` };
  return { ok: true, reason: `back on air, ${after.running} service(s) running` };
}
