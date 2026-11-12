# CLAUDE.md — DABcast AI Development Charter

> **Primary directive**: DABcast is a live DAB+ broadcast system running ON AIR on real hardware.
> Every code change carries a risk of interrupting live radio transmission.
> **Stability > elegance. Minimal patch > refactor. Compatibility > innovation.**

---

## 1. PROJECT OVERVIEW

DABcast is a Node.js/Express web application that manages a chain of ODR-mmbTools
processes to produce and multiplex DAB+ radio signals.

**Stack:**
- Backend: Node.js 18+ (ESM `type: "module"`), Express 4, no TypeScript
- Frontend: Vanilla JS single-page app (`web/app.js`), no framework, no build step
- Tests: Node.js built-in test runner (`node --test server/tests/*.test.js` — Node 24 no longer accepts a bare directory)  — **252 tests, 60 suites**
- Build: `esbuild` (bundle) → `@yao-pkg/pkg` (binary) → `dpkg-deb` (.deb package)
- Targets: `./build.sh` → amd64 | `./build.sh arm64` → Raspberry Pi OS 64-bit
- Service port: **9090** (default)

**ODR process chain (ON AIR) — encoder modes (GSTREAMER / VLC):**
```
odr-audioenc × N  ──ZMQ──► odr-dabmux ──EDI──► [odr-dabmod ──► hackrf_transfer]
odr-padenc × N   ──FIFO──► odr-audioenc
```
**Direct input modes (ZMQ / EDI per service):** no odr-audioenc, no odr-padenc — external encoder pushes audio directly to odr-dabmux subchannel.

**Transmission modes:** `EASYDAB` (default, net output) | `EDI` | `HACKRF` | `USRP1`

---

## 2. ARCHITECTURE SNAPSHOT

```
project root/
├── server/
│   ├── src/
│   │   ├── index.js              # Express app, API routes, auth middleware, autoStart
│   │   ├── appState.js           # Core state machine (1700+ lines) — mux lifecycle,
│   │   │                         # watchdog, failover, metadata loop, service CRUD
│   │   ├── defaults.js           # DEFAULT_SETTINGS, ALLOWED_BITRATES, PTY_LIST, DAB_FREQ_TABLE
│   │   ├── cu.js                 # Capacity Unit calculation (ETSI EN 300 401 EEP-A/B)
│   │   ├── logger.js             # FileLogger: append-only, rotation, dedup, optional notifier
│   │   ├── telegramNotifier.js   # Async Telegram Bot API log forwarding and rate limiting
│   │   ├── fsutil.js             # ensureDir, readJson, writeJson (atomic), safeExists
│   │   ├── slideImage.js         # SLS slide conversion: 320x240 JPEG, bands in the picture's edge colours
│   │   ├── player.js             # Web player: mux ETI monitor → dablin -p → ffmpeg MP3 (read-only)
│   │   ├── preset.js             # Preset load/save helpers
│   │   ├── auth/
│   │   │   └── sessionAuth.js    # Signed session cookies, private secret, login rate limiter
│   │   ├── odr/
│   │   │   ├── processManager.js # spawn/stop/kill ODR processes, pids.json, orphan cleanup
│   │   │   ├── commandBuilder.js # Build odr-audioenc / odr-padenc / odr-dabmod command args
│   │   │   ├── muxBuilder.js     # Generate odr-dabmux .mux config file text
│   │   │   ├── dabmuxStats.js    # Read-only ZMQ (ZMTP 3) client for the dabmux management port
│   │   │   └── validate.js       # validateService() — normalization + errors + warnings
│   │   └── utils/
│   │       └── dlplus.js         # DL+ tag parsing, buildDlPlusFileContent, parseNowPlaying
│   └── tests/                    # 178 tests — run with: node --test server/tests/*.test.js
│
├── web/
│   ├── index.html                # Single-page app shell (all dialogs inline)
│   ├── app.js                    # Full frontend: STATE object, render(), API polling, dialogs
│   ├── login.html/js/css         # Integrated authentication screen
│   └── style.css                 # All styles (CSS variables, dark theme)
│
├── data/                         # Runtime data root (DABCAST_DATA_DIR or ../data from binary)
│   ├── settings.json             # Persisted app settings (atomic write)
│   ├── .auth-secret              # Session signing secret (0600, ignored, never served)
│   ├── .telegram.json            # Telegram secret config (0600, ignored, never served/exported)
│   ├── presets/                  # *.json preset files; demo.json = active preset
│   ├── runtime/                  # Generated: current.mux, *.dls, *.mta, pids.json, state.json
│   ├── mot/XXXX/                 # Per-service MOT dirs (XXXX = PI code, e.g. F9A3/)
│   │   └── slide/                # Slide images (logo.jpeg, etc.)
│   └── logs/                     # dabweb.log (append-only, 10 MB × 5 rotations)
│
├── build/                        # .deb packaging
│   ├── build.sh                  # Full build pipeline
│   ├── dabcast.service           # systemd unit file
│   └── debian/                   # control, postinst, prerm, postrm, conffiles, dabcast.default
│
```

**ON AIR state lifecycle:**
1. `startMux()` → `_initRuntime()` (reset ALL service runtime state)
2. For each enabled service: `_startService()` → spawn padenc + audioenc (skipped for ZMQ/EDI direct modes)
3. Spawn odr-dabmux
4. \[HACKRF only\] 500ms delay → spawn odr-dabmod → spawn hackrf_transfer
5. `muxRunning = true` → `_startWatchdog()` + `_startMetadataLoop()`
6. Watchdog loop (every 5s): `isRunning()` check + `headOk()` check → failover if needed
7. `stopMux()` → stop watchdog → stop ODR chain → reset service statuses

**Frontend polling:**
- `GET /api/state` called every **2500ms**
- Response replaces entire `STATE` object → `getState()` **must include every field** the frontend needs
- CSS stream dot logic: green = `status==='RUNNING' && activeUri===svc.input.uri`

---

## 3. SAFE CHANGE STRATEGY

### 3.1 — Fundamental Principle

> Every modification must be **local and minimal**.
> Preserve existing behavior by default.
> The burden of proof is on the change, not on keeping the status quo.

Before touching any file, answer: *"What is the smallest possible change that achieves the goal?"*
If the answer requires touching more than 2 files or more than ~30 lines, reconsider the scope.

### 3.2 — ONE SUBSYSTEM AT A TIME

Never modify multiple critical layers in a single patch. The subsystems are:

| Subsystem | Files |
|---|---|
| Process management | `odr/processManager.js` |
| Watchdog / failover | `appState.js` lines ~1441–1696 |
| Mux config generation | `odr/muxBuilder.js` |
| Command building | `odr/commandBuilder.js` |
| Service validation | `odr/validate.js` |
| State machine / CRUD | `appState.js` (rest) |
| API routes | `server/src/index.js` |
| Mux input stats (read-only) | `odr/dabmuxStats.js`, `/api/mux/stats` route |
| Frontend rendering | `web/app.js` |
| Frontend UI | `web/index.html`, `web/style.css` |
| Telegram notifications | `server/src/telegramNotifier.js`, `server/src/logger.js`, Telegram routes/UI |
| Build / packaging | `build/` |

**A bug fix in the watchdog must not also refactor the process manager.**
**A UI change must not also touch API route logic.**

### 3.3 — SURGERY PATCH MODE

- **Prefer targeted patch** over redesign.
- **Never rewrite a complete file** unless explicitly requested.
- Keep existing structure and patterns — if the code uses `Map`, keep `Map`.
- If a function has 5 arguments, don't change it to an options object without being asked.
- Do not rename variables, reorder functions, or reorganize imports incidentally.
- Do not convert callback patterns to async/await or vice versa.

### 3.4 — RISK ASSESSMENT (required before any edit)

Before modifying any code, mentally verify:

1. **Who calls this code?** (callers in index.js, appState.js, frontend)
2. **Who depends on this behavior?** (watchdog, metadata loop, frontend polling)
3. **Runtime impact?** (will this affect a live ON AIR broadcast?)
4. **Preset compatibility?** (does this change the preset JSON schema?)
5. **ON AIR impact?** (can this be called while mux is running?)

**If in doubt → preserve existing logic, add alongside rather than replace.**

---

## 4. ANTI-REGRESSION RULES

### 4.1 — Never delete without proof

- Do not remove code unless you can prove it is unreachable or superseded.
- Dead-looking code may be a safety net for edge cases (crash recovery, Pi timing, etc.).
- Prefer commenting out and explaining over deleting.

### 4.2 — API stability

- Never change an API route path (`/api/mux/start`, `/api/services/:id`, etc.).
- Never change a JSON response shape without updating all consumers.
- Never rename fields in `getState()` output without updating `app.js` render logic.
- The `/api/state` response is consumed by the frontend every 2.5s — breaking it breaks the UI.

### 4.2.1 — /api/state CONTRACT (CRITICAL)

`GET /api/state` is the frontend ABI (Application Binary Interface).

The frontend polls this endpoint every 2500ms and replaces the entire `STATE` object.
Any missing or renamed field is an immediate UI regression.

Rules:

- Existing fields MUST NOT be removed or renamed.
- New fields are allowed only if:
  - they are optional OR
  - they include safe defaults.
- Backend must always provide:
  - `muxRunning`
  - `muxStatus`
  - `settings.autoStart`
  - `services[]`
  - `runtime`
  - any field read by `web/app.js`.

If `/api/state` structure changes:
- Update corresponding tests.
- Verify frontend rendering still works after refresh() replacement.

Golden rule:
> Additive changes only. Never breaking changes.

### 4.3 — Preset format compatibility

- The preset JSON schema (`.json` files in `data/presets/`) is a de-facto external format.
- Never remove or rename existing preset fields.
- New fields must have safe defaults (backward compatible with old preset files).
- `validateService()` / `normalizePi()` outputs must remain stable — they determine process keys and MOT directory names.

### 4.4 — ODR command compatibility

- `commandBuilder.js` generates the exact CLI args passed to ODR tools.
- Any change here directly affects the DAB signal quality.
- Do not add, remove, or reorder flags without testing on actual hardware.
- Known constraints:
  - `-D` (drift compensation) only for non-HTTP sources in VLC mode — **never add to GStreamer or HTTP streams**
  - `-G` flag = GStreamer mode (`-v` = VLC mode) — these are mutually exclusive
  - `-s 180` silence timeout is intentional (3 minutes before audioenc self-terminates)

### 4.5 — Before each modification

- Identify all frontend/backend dependencies of the changed code.
- Verify watchdog and process lifecycle impacts.
- Check if the change affects ON AIR services (can it interrupt a live broadcast?).

---

## 5. HIGH RISK AREAS

These modules must be modified with **maximum caution**. A bug here can interrupt a live broadcast or corrupt runtime state.

### 🔴 CRITICAL — `server/src/appState.js`

The entire broadcast control system. 1700+ lines. Contains:
- `startMux()` / `stopMux()` — the ON AIR on/off switch
- `_startService()` / `_stopService()` — per-service encoder lifecycle (ZMQ/EDI direct: early return, no encoder spawned)
- `_startWatchdog()` / `_stopWatchdog()` — crash detection and failover
- `_switchServiceUri()` — live failover between main and backup stream
- `_startMetadataLoop()` — DLS/SLS/DL+ update loop
- `getState()` — the single source of truth for the frontend

**Rules:**
- Never modify multiple sections in one patch.
- `_initRuntime()` is called at `startMux()` start — it resets ALL service runtime state. Do not call it elsewhere without understanding full impact.
- `getState()` must always return `autoStart` and every field the frontend reads from `runtime:`.
- The `_watchdogRunning` flag prevents concurrent iterations — **do not remove or bypass it**.
- The `_switchLocks` map prevents concurrent failovers per service — **do not remove**.
- `encWasAlive` is transition-based (alive→dead = 1 crash) — not tick-based. Do not simplify to tick-based.

### 🔴 CRITICAL — `server/src/odr/processManager.js`

Controls all ODR process spawning, killing, and crash recovery.

**Rules:**
- `spawn()` uses `detached: true` — always kill with `process.kill(-child.pid, signal)` (negative PID = process group).
- `pids.json` is written atomically (temp file + `renameSync`). Never use `writeFileSync` directly to `pids.json`.
- `cleanupOrphans()` uses `/proc/PID/cmdline` to verify process identity before killing (PID reuse protection).
- The `exit` event handler calls `procs.delete(key)` — `isRunning()` depends on this.
- Do not add synchronous blocking operations inside `spawn()` or `stop()`.

### 🟠 HIGH RISK — `server/src/odr/commandBuilder.js`

Generates exact CLI arguments for ODR tools. Any error here = silent audio failure or crash.

**Rules:**
- Do not reorder arguments — some ODR tools are position-sensitive.
- Preserve the `-v`/`-G` mutual exclusion logic.
- The `-D` flag (drift compensation) is explicitly excluded for HTTP sources — keep this guard.
- Test with `node --test server/tests/commandBuilder.test.js` after any change.

### 🟠 HIGH RISK — `server/src/odr/muxBuilder.js`

Generates the `.mux` config file consumed by odr-dabmux.

**Rules:**
- The `.mux` format uses `{ }` blocks, not YAML or TOML. Preserve exact syntax.
- For GSTREAMER/VLC modes: ZMQ port numbers (`tcp://127.0.0.1:{port}`) must match what audioenc uses.
- For ZMQ direct mode (`svc.input.mode === 'ZMQ'`): `inputproto zmq`, `inputuri "tcp://0.0.0.0:{port}"` — listens for external encoder.
- For EDI direct mode (`svc.input.mode === 'EDI'`): `inputproto edi`, `inputuri "udp://:{port}"`, `buffer-management prebuffering`, `prebuffering 20` — no zmq-buffer.
- Service ordering is by `ui.order` — this affects the DAB multiplex channel layout.

### 🟠 HIGH RISK — `web/app.js`

All frontend logic in a single 1800+ line file. No framework, no build step in dev mode.

**Rules:**
- `refresh()` replaces the entire `STATE` object — never assume `STATE` persists between calls.
- `render()` is called after every `refresh()` — it must be idempotent and fast.
- Service edit dialogs use `editingId` (null = new, non-null = edit mode) — don't confuse.
- PI normalization: always uppercase, 4 hex chars, with `0x` prefix.
- `streamDot(activeIsMain, hasUri, isOnAir)` logic: green only when `status==='RUNNING' && activeUri===svc.input.uri`.
- Do not add global state variables without considering their lifetime across `refresh()` calls.

### 🟡 MODERATE RISK — `server/src/index.js`

Express routes and startup sequence.

**Rules:**
- Auth middleware verifies signed cookies without running bcrypt on every request. Bcrypt is used only at login and credential changes.
- Never expose `data/.auth-secret`; signed sessions must remain `HttpOnly` and `SameSite=Strict`.
- Changing the stored username or password hash must invalidate existing sessions.
- The `mustChangePassword` gating blocks all sensitive endpoints until password is changed.
- `autoStart` uses a 2-second `setTimeout` after server listen — do not reduce this delay.
---

## 6. CRITICAL INVARIANTS

These are non-negotiable patterns. Breaking them causes runtime failures.

### File I/O
| Invariant | Rule |
|---|---|
| **Logs are append-only** | Use `appendFileSync`. Never `writeFileSync` to a log file. Never truncate. |
| **JSON writes are atomic** | Use `fsutil.writeJson()` (temp file + `renameSync`). Never `writeFileSync` directly to settings/presets. |
| **pids.json is serialized** | Use `_withPidsLock()` in processManager. Never write pids.json outside that lock. |

### Process management
| Invariant | Rule |
|---|---|
| **Process group kill** | Always `process.kill(-child.pid, signal)`. The negative PID kills the entire process group. |
| **Detached spawn** | Always `{ detached: true }` for ODR processes. This is what makes group kill work. |
| **Exit handler cleanup** | The `exit` event on child processes calls `procs.delete(key)`. `isRunning()` depends on this. |
| **PAD FIFO must exist before audioenc** | `mkfifo` is now synchronous (`execFileSync`). Do not revert to async spawn. |

### Watchdog
| Invariant | Rule |
|---|---|
| **Crash detection is transition-based** | `!encAlive && rt.encWasAlive` = 1 crash. `rt.encWasAlive = encAlive` at end of tick. |
| **Concurrent watchdog prevention** | `_watchdogRunning` guard. Never remove. |
| **Per-service switch lock** | `_switchLocks.has(lockKey)` prevents concurrent failovers for the same service. |
| **FAILOVER_CRASH_THRESHOLD = 1** | 1 crash before switching to backup. |
| **FAILOVER_STABLE_MS = 30000** | 30s of uptime to reset crash counter. |
| **headOk: HEAD then GET fallback** | HEAD fails (any reason including timeout) → try GET. GET 503 = stream alive (slot full). |
| **effectiveActiveOk** | `activeOk \|\| encAlive` — if encoder is alive, stream is OK regardless of HTTP check result. Applies to both main and backup. |
| **Audio probe encoder** | One `odr-audioenc -s 15 -o tcp://localhost:9099` per mux, no PAD/MTA. Checks main stream audio for return-to-main. Respects service input mode (VLC/GST). |
| **Probe guard** | `_probeRunning` flag prevents concurrent probe iterations. Never remove. |

### Service identity
| Invariant | Rule |
|---|---|
| **PI format** | Always `0xXXXX` uppercase 4 hex digits. `normalizePi()` is the canonical normalizer. |
| **MOT dir naming** | `data/mot/{PI_UPPERCASE}/` — derived from PI code. Renaming a service's PI renames the dir. |
| **Process keys** | `svc:${svc.id}:audioenc`, `svc:${svc.id}:padenc`, `mux:odr-dabmux`, etc. Never change format. |

### Frontend state
| Invariant | Rule |
|---|---|
| **STATE is replaced on each refresh** | `getState()` must return every field the frontend needs. Missing fields = lost state. |
| **editingId** | `null` = new service dialog. Non-null = edit mode. Do not confuse. |
| **Polling interval** | Frontend polls `/api/state` every **2500ms**. Do not reduce (server load on Pi). |

### Build & deployment
| Invariant | Rule |
|---|---|
| **`__APP_VERSION__`** | Replaced by esbuild at build time. In dev mode, falls back to `package.json` version. |
| **Data directory** | Resolved from `DABCAST_DATA_DIR` env var, or `../data` relative to the binary. |
| **Port 9090** | Default port. 8080 = lighttpd — already in use on target systems. |
| **500ms dabmod delay** | After dabmux start, wait 500ms before dabmod. Gives dabmux time to open its EDI port. |

### Transmission chain invariants (DABMOD / RF OUTPUT)

The transmission chain order is intentional and timing-sensitive.

#### Startup order (HACKRF mode)

1. Spawn odr-audioenc + odr-padenc
2. Spawn odr-dabmux
3. Wait 500ms (dabmux must open EDI output)
4. Spawn odr-dabmod
5. Spawn hackrf_transfer

Rules:

- The 500ms delay is a runtime synchronization requirement.
  It is NOT a magic number to optimize away.
- ON AIR must not be declared until the required chain for the mode is alive.
- hackrf_transfer is the terminal RF process:
  - if it exits unexpectedly → transmission is considered failed.

#### Mode-specific invariants

- EASYDAB / EDI:
  - odr-dabmux output availability defines chain health.
  - EDI PFT/FEC is disabled by default. `ediPftEnabled` applies only to external
    EDI mode (GatesAir compatibility), never to the local HACKRF chain.
  - `ediTistOffsetSec` is also external-EDI-only; default `0`, GatesAir profile `5`.
- HACKRF:
  - dabmod + hackrf_transfer must both be alive.
- USRP1:
  - FIFO output must be ready before mux start.

Never reorder chain startup without real hardware validation.
---

## 7. CHANGE WORKFLOW

Before writing any code, follow this sequence:

### Step 1 — Read before editing
- Read the full function/class you intend to modify.
- Read its callers (use Grep to find all call sites).
- Understand the current behavior completely before proposing a change.

### Step 2 — Explain the plan (3–5 lines max)
Describe:
- What you are changing and why
- What you are NOT touching
- What potential side effects exist

### Step 3 — Minimal modification
- Write the smallest change that achieves the goal.
- Do not add error handling for impossible cases.
- Do not add logging beyond what is necessary.
- Do not add configuration options for things that should be fixed.

### Step 4 — No unsolicited improvements
- Do not refactor adjacent code that works.
- Do not add docstrings/comments to code you didn't change.
- Do not rename variables that are already clear.
- Do not convert sync code to async or vice versa.
- Do not add type annotations or JSDoc to existing code.

### Step 5 — Verify tests
After any backend change: `node --test server/tests/`
All 178 tests must pass. If a test fails, fix the code (not the test) unless the test is demonstrably wrong.

## 7.1 — RELEASE & ROLLBACK POLICY

DABcast runs on real broadcast hardware.
Any deployment must be reversible.

Rules:

- Changes touching these files MUST be easily revertable:
  - appState.js
  - processManager.js
  - commandBuilder.js
  - muxBuilder.js

- Avoid irreversible runtime migrations.
- If changing runtime file formats or behavior:
  - preserve backward compatibility
  OR
  - provide automatic migration + fallback.

### Pre-deployment safety checks (real hardware)

Before deploying:

- Start mux → stop mux → repeat 3 times.
- Simulate encoder crash and verify watchdog behavior.
- Verify ON AIR transitions correctly.
- Confirm logs remain append-only.
- Verify no unexpected CPU spikes on Raspberry Pi.

Golden rule:
> A safe revert must always be possible.

## PERFORMANCE RULES (Raspberry Pi Safety)

DABcast must remain lightweight on Raspberry Pi hardware.

Rules:

- No blocking filesystem operations inside periodic loops:
  - watchdog
  - metadata loop
  - frontend polling handlers
- Complexity must remain O(N services).
- Avoid large object allocations inside render loops.
- Do not increase polling frequency.
- Avoid unnecessary JSON serialization in hot paths.

If performance impact is uncertain → keep existing implementation.
---

## 8. WHEN IN DOUBT

```
IF you are uncertain about a behavior → PRESERVE the existing behavior
IF a change seems risky → ADD alongside, don't REPLACE
IF two approaches seem equal → choose the one touching fewer lines
IF a pattern exists in the codebase → follow it, don't introduce a new one
IF a test would break → the change is probably wrong
IF it requires touching >2 files → reconsider scope
```

Do NOT ask for confirmation unless the change is structurally major (schema change, new dependency, new API endpoint pattern). Minor behavior decisions should be resolved by defaulting to the most conservative option.

## 8.1 — NO SILENT BEHAVIOR CHANGES

Runtime behavior changes must never be implicit.

If a change modifies behavior:

- Explicitly state it in the explanation.
- Add or update a test when possible.
- Preserve previous behavior as default when feasible.

Forbidden:

- Hidden logic changes without documentation.
- Silent modification of watchdog or failover behavior.
- Changing default flags passed to ODR tools without explicit mention.

---

## 9. PRE-EDIT CHECKLIST

Before writing any code modification:

- [ ] I have read the full function/section I am changing
- [ ] I have identified all callers of this code
- [ ] Change is minimal (< ~30 lines changed per logical unit)
- [ ] I am only touching ONE subsystem
- [ ] No global refactor triggered by this change
- [ ] Existing behavior preserved for all current inputs
- [ ] Runtime safe: will not interrupt a live ON AIR broadcast
- [ ] API shape unchanged (or backward compatible)
- [ ] Preset JSON format unchanged (or backward compatible)
- [ ] ODR command arguments unchanged (or verified safe)
- [ ] `getState()` still returns all required fields
- [ ] Tests still pass (`node --test server/tests/`)

---

## 10. PRE-ANSWER CHECKLIST

Before submitting any response involving code:

- [ ] Explained exactly what changed (not just why)
- [ ] Confirmed why the change is safe
- [ ] Listed potential side effects (even if minimal)
- [ ] Confirmed no unrelated code was touched
- [ ] Tests pass (or explained why they don't apply)

---

## 11. KNOWN GOTCHAS

These are non-obvious behaviors that have caused bugs in the past:

| Area | Gotcha |
|---|---|
| **Frontend refresh** | `refresh()` replaces ALL of `STATE`. Any data not in `getState()` is lost immediately. |
| **autoStart checkbox** | `getState()` must include `settings.autoStart` or the checkbox unchecks after mux start. |
| **PI normalization** | Strip `0x` prefix, uppercase, pad to 4 chars. `0xf9a3` → `0xF9A3`. |
| **headOk + Icecast** | Many Icecast servers reject HEAD with 400/405/501. Always fall back to GET. 503 = stream full = alive. |
| **Drift compensation** | `-D` flag is ALSA-only. Never add it for HTTP streams in VLC mode (causes desync). |
| **GStreamer mode** | `-G` flag. Incompatible with `-L`, `-C`, `-D` VLC flags. Never mix. |
| **Process group kill** | Use `process.kill(-pid, signal)` (negative). `child.kill()` only kills the direct process. |
| **encWasAlive** | Set to `true` in `_startService()` for encoder modes. For ZMQ/EDI direct modes, set to `false` (no encoder). |
| **ZMQ/EDI direct mode** | `svc.input.mode === 'ZMQ'` or `'EDI'`: no audioenc/padenc spawned, watchdog skips these services, `rt.activeUri = null`. |
| **MOT dir on PI rename** | Changing `svc.id` (PI code) renames the MOT directory. Runtime references must follow. |
| **Port conflicts** | 8080 = lighttpd — already in use on target systems. Default port is 9090. |
| **editingId** | `null` in service dialog = creating new. Do not initialize to `undefined` or `''`. |
| **_watchdogRunning** | If a watchdog iteration takes >5s (slow Pi + many services), next tick is skipped. Normal behavior. |
| **pkg binary paths** | `typeof process.pkg !== 'undefined'` detects binary mode. Paths are relative to binary, not cwd. |
| **DLS file write** | Use `writeTextFileAtomicIfChanged()` (in dlplus.js) to avoid unnecessary writes to the runtime dir. |
| **dablin -s flag** | Do NOT pass `-s <serviceId>` to dablin — causes immediate exit if SId format doesn't match. Let dablin auto-select first service. |
| **WARNING status** | Set when `!activeIsMain && consecutiveCrashes > 0` (backup unstable). Cleared when `effectiveActiveOk && !backupUnstable`. |
| **Metadata loop periods** | `metadata.intervalSec` ('Refresh (sec)', JSON tab) only paces URL modes (JSON / XML / FILE). STREAM (local ICY file) and NONE use `META_LOCAL_INTERVAL_SEC` (5 s). Any `metadata` patch resets `rt.lastMetaUpdateMs` → applied at the next 1 s tick. Mode NONE honours `defaultDlsAllowed`. ZMQ/EDI direct inputs are skipped by the loop (DLS/DL+/SLS from the remote encoder). |
| **End of item (JSON)** | APIs often keep returning the last song during ads. Same rules for every station, no setting needed: start / duration / type are read from configured keys or from usual fields next to the title (`findNearTitle`). Duration known → over at start + duration + 15 s (any item, a 2 h show keeps its logo). Else by type (`classifyItemType`): ad/jingle → over at once; song → capped at `trackMaxMin` (default 8, 0 = never); show / talk / unknown → never cut (previous behaviour). Over = default DLS + no cover (logo back on air) until the title changes. |
| **On-air slides (`mot/<PI>/air`)** | odr-padenc's `-d` is `mot/<PI>/air`, not `slide/`. `_syncAirSlides()` (at `_startService` and after each metadata tick) copies there either `cover.jpg` alone (a track cover exists, JSON mode) or every image of `slide/` except the cover. odr-padenc has no priority option: with logo + cover in its dir the logo replaced the cover within seconds. `slide/` stays the source of truth; temp files go in `mot/<PI>/`; on error `-d slide/` (previous behaviour). `rt.airSlides` = what is on air. `metadata.logoEverySec` (default 40, 0 = cover only): during a cover, one logo (in turn) replaces it every N s for its estimated send time (size / (PAD × 24 B/s) + 4 s, min 6 s); a new cover goes first and restarts the count (`_airChoice`). |
| **SLS slides = JPEG 320x240** | odr-padenc sends every file of `mot/<PI>/slide/`. Anything written there must go through the conversion of `slideImage.js` (`convertToSlide`, used by `_convertToSlide` in appState and `convertToSlideFile`/`writeSlideImage` in index.js). Square pictures get side bands instead of black: each band row takes the running per-channel median (±60 rows) of the picture's edge on that row (`composeSlide`), so plain backgrounds and gradients continue seamlessly while a small shape touching the border does not streak; top / bottom for wide pictures; transparency flattened on black; PPM read with `-depth 8` (Q16 builds). `regenerateBandedLogos()` (index.js, once, marker `mot/.slide-bands-v3`) re-converts pre-1.7 logos: from `original/` if present, else `removeBlackBands()` crops the symmetric black bands (+8 px inset = one JPEG block against blending; v3 restarts from `original/bands_<name>` when v2 already ran; logos with a real black background are left alone) — previous file kept as `original/bands_<name>`: an unconverted 300x300 PNG weighs 50-110 kB = 30-80 s to send with a 58-byte PAD (5-15 kB once converted). `repairSlides()` converts non-conforming `*.jpg` at start-up (before autoStart), originals kept in `mot/<PI>/original/`. Temp files go in `mot/<PI>/`, never in `slide/`. |
| **MOT logo seed** | On startup, logos are copied from `defaults/mot/` to `data/mot/` only if no `logo.jpg` exists. Uses `force: true` + try/catch. |
| **build.sh MOT copy** | Uses `find -type f` (not `cp -r`) to exclude runtime FIFOs created by odr-padenc from the .deb package. |
| **Data preservation on upgrade** | `/var/lib/dabcast/` is never modified by dpkg. demo.json only copied if absent. Logos only seeded if no logo.jpg found. |
| **Telegram token** | Stored in `data/.telegram.json` with mode `0600`. Never expose it through `/api/telegram`, `/data`, config exports, logs, tests, or commits. |
| **Telegram failure isolation** | Network/API failures must never interrupt file logging or the ON AIR process chain. Default forwarding threshold is `ERROR`. |
| **dabmux management port** | `managementport` (12720) is a **ZMQ REP** socket, not HTTP/telnet. Send `values` → per-subchannel `inputstat` (state, min/max fill, `num_underruns`, `num_overruns`, peaks). Use `odr/dabmuxStats.js` (pure-JS ZMTP client, no native zeromq dep). Telnet 12721 = parameters only, no fill stats. |
| **sub_N ↔ service mapping** | `.mux` subchannels are `sub_1…sub_N` over the services **not explicitly disabled** (`enabled !== false`) sorted by `ui.order ?? 0` — `muxBuilder` and the `/api/mux/stats` mapping must use the same filter. A missing `enabled` field counts as ON (old presets). |
| **Unique input ports** | Each service needs its own `network.ediOutputTcp.port` (two dabmux inputs on one port = "Could not bind"). `_repairDuplicatePorts()` runs at preset load and in `setPreset()` (first in mux order keeps its port, others get `_pickFreePort()`); `upsertService()` (service import) reassigns a taken port; `setService`/`addService` refuse duplicates via `_checkInputPort()`. |
| **Service ON/OFF** | `enabled: false` = service left out of the `.mux` (off air, CU freed) and no encoder spawned. ON AIR, the row ON/OFF button runs Stop → PATCH → Start after confirmation; the last ON service cannot be turned OFF while ON AIR, and Start is disabled when every service is OFF. ON AIR, `addService()` and `upsertService()` (service import) create the service OFF (no restart); `deleteService()` and replacing via import only accept an OFF service whose encoder is not running. |
| **dabmux "Unstable" is sticky** | Start-up prebuffering underruns put every input in `Unstable`, and it stays so for minutes after counters stop increasing. Judge health on **counter increases**, not on the state string. The UI shows `Unstable` as `BUFFER OK` (and counts it healthy) unless underruns rose in the last 30 s (`BUF_GLITCH_WINDOW_MS`). |
| **Web player** | `/api/player/stream?id=` reads the ETI monitoring output (`easyDabOutput.netPort`, same source as Dablin) → `dablin -R <subch> -p` → `ffmpeg` MP3. Sub-channel = position in the `.mux` (same filter/order as muxBuilder). The mux socket is read **without back-pressure** (excess dropped) so a slow browser never slows dabmux. Not ODR chain processes: not in processManager/pids.json, killed when the listener disconnects, max 2 listeners. Meter: browser Web Audio analyser, or — when it stays flat while playing (iOS Safari does not route live streams through Web Audio) — `/api/player/levels?k=` peaks computed server-side on the PCM fed to ffmpeg, stamped on the stream timeline and shown at `audio.currentTime`. `ffmpeg`/`dablin` are `Recommends` (updates use `dpkg -i`, which never installs dependencies — a hard `Depends` would break updates). |
| **/api/mux/stats and getState()** | Do not call `getState()` there: it consumes `lastError`, which the frontend must receive via `/api/state`. Read `state.muxRunning` / `state.preset` / `state.settings` directly. Results cached 2s, concurrent requests share one query. |

## ARCHITECTURE LOCK MODE

The project architecture is considered LOCKED.

The AI MUST ask for explicit confirmation before:

- Moving files or changing folder structure
- Splitting or merging large modules
- Introducing new frameworks or build systems
- Changing process lifecycle architecture
- Changing ON AIR state machine logic
- Altering API contracts or preset schema
- Rewriting major functions (>50 lines changed)

Default behavior:

- Assume architecture changes are NOT allowed.
- Prefer local patching over redesign.

Required question before proceeding:

"This change affects architecture or critical runtime behavior. Confirm before continuing?"

### 3.5 — NO TWO CRITICAL FILES RULE

Never modify more than ONE critical file in a single patch.

Critical files include:
- appState.js
- processManager.js
- commandBuilder.js
- muxBuilder.js

If a change requires touching multiple critical files:
- stop
- explain why
- ask for confirmation first.
