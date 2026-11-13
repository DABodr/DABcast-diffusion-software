// Connection watch of the transmitter outputs where odr-dabmux listens (ZMQ / EasyDAB, EDI/TCP, ETI/TCP).
// Read-only: index.js gives it, every 5 s ON AIR, the ESTABLISHED TCP peers per local port (/proc/net/tcp).
// An output that HAD a transmitter connected since the mux Start and has none for DISCONNECT_MS is reported
// once (ERROR, e.g. Telegram); when one connects again: an INFO recovery line ("✅ RESOLVED" on Telegram
// when its option is on). Never alerts for an output nobody connected to (spare / unused), nor around a
// Stop / Start. EDI/UDP: dabmux only sends, nothing to watch. The local SDR / HackRF is watched by appState.

export const DISCONNECT_MS = 15000;
const WATCHED = new Set(['zmq', 'eti-tcp', 'edi-tcp']);

export class OutputMonitor {
  constructor({ logger, now = () => Date.now() }) {
    this.logger = logger;
    this.now = now;
    this.state = new Map();   // output id -> { ever, lastSeenMs, lastPeers, alerted, port }
    this.runKey = null;       // mux run (muxSinceMs): a new Start resets everything
  }

  _recovery(scope, msg) {
    if (typeof this.logger.recovery === 'function') this.logger.recovery('outputs', scope, msg);
    else this.logger.line(scope, msg);
  }

  // running: mux ON AIR; runKey: changes at each Start; outputs: normalized list; peers: Map port -> [ip]
  tick({ running, runKey, outputs, peers }) {
    if (!running) { this.state.clear(); this.runKey = null; return; }
    if (runKey !== this.runKey) { this.state.clear(); this.runKey = runKey; }
    const now = this.now();
    const seen = new Set();
    for (const o of outputs || []) {
      if (!o.enabled || !WATCHED.has(o.type)) continue;
      seen.add(o.id);
      let st = this.state.get(o.id);
      if (!st || st.port !== o.port) {   // new output (or its port changed): starts unwatched
        st = { ever: false, lastSeenMs: 0, lastPeers: [], alerted: false, port: o.port };
        this.state.set(o.id, st);
      }
      const list = [...new Set(peers.get(o.port) || [])];
      if (list.length) {
        if (st.alerted) this._recovery('outputs', `${o.name} connected again (${list.join(', ')}) after ${Math.round((now - st.lastSeenMs) / 1000)} s`);
        st.ever = true;
        st.alerted = false;
        st.lastSeenMs = now;
        st.lastPeers = list;
      } else if (st.ever && !st.alerted && now - st.lastSeenMs >= DISCONNECT_MS) {
        st.alerted = true;
        this.logger.line('outputs', `${o.name} disconnected: no transmitter connected on port ${o.port} for ${Math.round((now - st.lastSeenMs) / 1000)} s (last: ${st.lastPeers.join(', ')})`, 'ERROR');
      }
    }
    for (const id of this.state.keys()) if (!seen.has(id)) this.state.delete(id);   // output removed / OFF
  }
}
