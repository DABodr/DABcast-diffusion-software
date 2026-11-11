# DABcast Project Memory

## Architecture
- Node.js Express backend: `server/src/`
- Vanilla JS frontend: `web/`
- ODR tools used: `odr-dabmux`, `odr-audioenc`, `odr-padenc`
- No `odr-dabmod` (modulator is external)

## Logging
- Append-only log file: `data/logs/dabweb.log`
- Logger uses `fs.appendFileSync()` (no truncate)
- Logs include START/STOP markers, full spawn args, exit codes, prefixed stdout/stderr
- Logs modal includes filters + “Download (.log)” (raw file)

Key files:
- `server/src/logger.js`
- `server/src/index.js` — `/api/logs/download`
- `processManager.js` — `[stdout]/[stderr]` prefixing

## Process management (stability)
- Processes spawned detached; stop kills whole process group: `process.kill(-pid)`
- Stop is idempotent; SIGTERM → SIGKILL escalation
- Crash recovery:
  - `cleanupOrphans()` runs on startup
  - PID reuse protection by checking `/proc/<pid>/cmdline` matches `odr-*`
- Mux state persisted in `state.json`, `muxRunning=false` on restart until verified

Key files:
- `processManager.js`
- `appState.js`
- `server/src/index.js` — startup cleanup

## Service status (UI pastille)
- Watchdog checks:
  1) encoder process alive (pm.isRunning)
  2) HTTP HEAD on active stream (timeout 2.5s)
  3) WARNING thresholds then ERROR/switch-to-backup
- Limitation: the process watchdog itself has no buffer/silence detection
- Mux input stats (display only, no action): `odr/dabmuxStats.js` queries dabmux `managementport` (ZMQ REP, command `values`)
  → state Streaming/Unstable/Silence/NoData + underrun/overrun counters per `sub_N`
  - `Unstable` is sticky after start-up prebuffering: judge on counter increases, not on the state
  - Verified on ODR-DabMux 5.1.0; old HTTP fetch to that port never worked (wrong protocol)

## CU / ETSI (EEP-A + EEP-B)
- CU estimation uses ETSI formulas for EEP-A and EEP-B
- UI includes EEP selector
- `.mux` includes `protection-profile EEP_B` when selected

Key files/tests:
- `cu.js`, `muxBuilder.js`
- `cu.test.js`, `muxBuilder.test.js`

## TX modes (.mux outputs)
- EASYDAB: `throttle "simul://"` + `zmq "zmq+tcp://0.0.0.0:18081"`
- EDI: `throttle "simul://"` + `edi { ... tcp listenport 13000 }`
- USRP1: `stdout "fifo:///dev/stdout?type=raw"`

Ref: `muxBuilder.js` (TX mode block)

## Test suite
- 178 tests passing (CU, defaults, command builder, mux builder, validation, process cleanup, dabmux stats client)
- Run with `node --test tests/*.test.js` from `server/` (Node 24 rejects a bare directory)
