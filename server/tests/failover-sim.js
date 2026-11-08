#!/usr/bin/env node
// Simulation du failover watchdog — exécutable standalone
// Usage: node tests/failover-sim.js

const FAILOVER_CRASH_THRESHOLD = 3;
const FAILOVER_STABLE_MS = 30000;

const MAIN_URI  = 'https://maxxima.mine.nu/maxa.mp3';      // cassé
const BACKUP_URI = 'https://maxxima.mine.nu/maxxima.mp3';   // OK

const TICK_MS = 5000;         // intervalle watchdog
const ENCODER_CRASH_MS = 7000; // l'encodeur crash après 7s sur le main cassé

// --- Simulation state ---
let rt = {
  status: 'RUNNING',
  activeUri: MAIN_URI,
  consecutiveCrashes: 0,
  lastStartMs: Date.now(),
  lastDeathMs: 0,
  encWasAlive: true,
  lastSwitchMs: 0
};

let encoderStartedAt = Date.now();
let encoderAlive = true;
let tick = 0;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}

function headOk(uri) {
  // Simule: main cassé répond 200 au HEAD mais l'audio est cassé
  // backup fonctionne
  if (uri === BACKUP_URI && uri !== MAIN_URI) return true;
  if (uri === MAIN_URI) return true; // HEAD répond OK même si stream cassé
  return false;
}

function simulateEncoder(now) {
  // Si on est sur le main cassé, l'encoder crash après ENCODER_CRASH_MS
  if (rt.activeUri === MAIN_URI && encoderAlive) {
    if (now - encoderStartedAt >= ENCODER_CRASH_MS) {
      encoderAlive = false;
      log(`  [odr-audioenc] EXIT code=5 (stream error après ${Math.round((now - encoderStartedAt) / 1000)}s)`);
    }
  }
  // Si on est sur backup, l'encoder tourne toujours
  if (rt.activeUri === BACKUP_URI && rt.activeUri !== MAIN_URI) {
    encoderAlive = true;
  }
}

function switchUri(newUri, now) {
  log(`  => _switchServiceUri: ${rt.activeUri} -> ${newUri}`);
  rt.activeUri = newUri;
  rt.lastSwitchMs = now;
  rt.lastStartMs = now;
  rt.encWasAlive = true;
  rt.status = 'RUNNING';
  encoderAlive = true;
  encoderStartedAt = now;
}

function watchdogTick(now) {
  tick++;
  const encAlive = encoderAlive;
  const hasDistinctBackup = BACKUP_URI && BACKUP_URI !== MAIN_URI;
  const okMain = headOk(MAIN_URI);
  const okBackup = hasDistinctBackup ? headOk(BACKUP_URI) : false;

  log(`--- TICK ${tick} | encoder=${encAlive ? 'ALIVE' : 'DEAD'} | crashes=${rt.consecutiveCrashes} | uri=${rt.activeUri === MAIN_URI ? 'MAIN' : 'BACKUP'} | status=${rt.status}`);

  // Crash detection (transition-based)
  if (!encAlive && rt.encWasAlive) {
    rt.consecutiveCrashes = (rt.consecutiveCrashes || 0) + 1;
    rt.lastDeathMs = now;
    const ranMs = rt.lastStartMs ? (now - rt.lastStartMs) : 0;
    rt.status = 'ERROR';
    log(`  CRASH détecté (alive→dead) — crash #${rt.consecutiveCrashes}/${FAILOVER_CRASH_THRESHOLD}, a tourné ${Math.round(ranMs / 1000)}s`);
  }
  rt.encWasAlive = encAlive;

  // Encoder dead
  if (!encAlive) {
    const crashes = rt.consecutiveCrashes || 0;
    const activeIsMain = (rt.activeUri || MAIN_URI) === MAIN_URI;

    if (crashes >= FAILOVER_CRASH_THRESHOLD && hasDistinctBackup) {
      const targetUri = activeIsMain ? BACKUP_URI : MAIN_URI;
      const targetOk = activeIsMain ? okBackup : okMain;

      if (targetOk) {
        log(`  *** FAILOVER: ${crashes} crashes >= seuil ${FAILOVER_CRASH_THRESHOLD} — BASCULE ${activeIsMain ? 'main' : 'backup'} => ${activeIsMain ? 'backup' : 'main'} ***`);
        rt.consecutiveCrashes = 0;
        switchUri(targetUri, now);
      } else {
        log(`  FAILOVER: ${crashes} crashes mais cible injoignable — restart sur même URI`);
        switchUri(rt.activeUri, now);
      }
    } else if (crashes >= FAILOVER_CRASH_THRESHOLD && !hasDistinctBackup) {
      log(`  FAILOVER: ${crashes} crashes mais PAS de backup distinct — restart`);
      switchUri(rt.activeUri, now);
    } else {
      log(`  Sous le seuil (${crashes}/${FAILOVER_CRASH_THRESHOLD}) — restart sur ${rt.activeUri === MAIN_URI ? 'MAIN' : 'BACKUP'}`);
      switchUri(rt.activeUri, now);
    }
    return;
  }

  // Encoder alive — check stability
  if (rt.consecutiveCrashes > 0 && rt.lastStartMs) {
    const upMs = now - rt.lastStartMs;
    if (upMs >= FAILOVER_STABLE_MS) {
      log(`  Encoder stable depuis ${Math.round(upMs / 1000)}s — reset compteur`);
      rt.consecutiveCrashes = 0;
    } else {
      log(`  Encoder vivant mais instable (up ${Math.round(upMs / 1000)}s < ${FAILOVER_STABLE_MS / 1000}s) — compteur maintenu à ${rt.consecutiveCrashes}`);
    }
  } else {
    log(`  Encoder OK`);
  }
}

// --- Run simulation ---
console.log('=== SIMULATION FAILOVER WATCHDOG ===');
console.log(`Main:   ${MAIN_URI} (CASSÉ — crash après ${ENCODER_CRASH_MS / 1000}s)`);
console.log(`Backup: ${BACKUP_URI} (OK)`);
console.log(`Distinct backup: ${BACKUP_URI !== MAIN_URI}`);
console.log(`Threshold: ${FAILOVER_CRASH_THRESHOLD} crashes`);
console.log(`Stable: ${FAILOVER_STABLE_MS / 1000}s`);
console.log(`Tick interval: ${TICK_MS / 1000}s`);
console.log('');

let simTime = Date.now();

for (let i = 0; i < 20; i++) {
  simTime += TICK_MS;
  simulateEncoder(simTime);
  watchdogTick(simTime);
  console.log('');

  // Stop si on est sur backup et stable
  if (rt.activeUri === BACKUP_URI && rt.activeUri !== MAIN_URI && rt.status === 'RUNNING' && rt.consecutiveCrashes === 0) {
    log('=== SUCCÈS: encodeur stable sur BACKUP — fin de simulation ===');
    break;
  }
}
