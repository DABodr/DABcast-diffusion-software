// Read-only client for the odr-dabmux management server (general.managementport).
// The management server is a ZMQ REP socket: it speaks ZMTP 3.x, not HTTP or telnet.
// This is a minimal pure-JS ZMQ REQ client (NULL security, single request per connection),
// so no native zeromq dependency is needed (pkg binary + arm64 build friendly).
// Verified against ODR-DabMux 5.1.0: commands "info", "config", "values".
import net from 'node:net';

const SIGNATURE = Buffer.from([0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0x7f]);

export function buildGreeting() {
  const g = Buffer.alloc(64);
  SIGNATURE.copy(g, 0);
  g[10] = 3; g[11] = 0;          // ZMTP 3.0
  g.write('NULL', 12, 'ascii');  // mechanism, zero-padded to 20 bytes
  g[32] = 0;                     // as-server = false
  return g;
}

export function encodeFrame(body, { more = false, command = false } = {}) {
  const long = body.length > 255;
  const flags = (more ? 0x01 : 0) | (long ? 0x02 : 0) | (command ? 0x04 : 0);
  const head = long ? Buffer.alloc(9) : Buffer.alloc(2);
  head[0] = flags;
  if (long) head.writeBigUInt64BE(BigInt(body.length), 1);
  else head[1] = body.length;
  return Buffer.concat([head, body]);
}

export function buildReady(socketType = 'REQ') {
  const name = Buffer.from('READY', 'ascii');
  const key = Buffer.from('Socket-Type', 'ascii');
  const val = Buffer.from(socketType, 'ascii');
  const vlen = Buffer.alloc(4); vlen.writeUInt32BE(val.length, 0);
  const body = Buffer.concat([Buffer.from([name.length]), name, Buffer.from([key.length]), key, vlen, val]);
  return encodeFrame(body, { command: true });
}

// Parse as many complete frames as possible from buf, starting at offset.
// Returns { frames: [{ flags, body }], offset }.
export function parseFrames(buf, offset = 0) {
  const frames = [];
  while (offset < buf.length) {
    const flags = buf[offset];
    const long = (flags & 0x02) !== 0;
    const headLen = long ? 9 : 2;
    if (buf.length - offset < headLen) break;
    const size = long ? Number(buf.readBigUInt64BE(offset + 1)) : buf[offset + 1];
    if (buf.length - offset - headLen < size) break;
    frames.push({ flags, body: buf.subarray(offset + headLen, offset + headLen + size) });
    offset += headLen + size;
  }
  return { frames, offset };
}

// Send one command to the management server and resolve with the reply text.
export function queryDabmux(port, command = 'values', { host = '127.0.0.1', timeoutMs = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    let greeted = false;
    let ready = false;
    let parts = [];
    let done = false;

    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`dabmux management timeout (${timeoutMs} ms)`)), timeoutMs);

    sock.on('connect', () => {
      sock.write(buildGreeting());
      sock.write(buildReady('REQ'));
    });
    sock.on('error', (e) => finish(e));
    sock.on('close', () => finish(new Error('dabmux management connection closed')));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!greeted) {
        if (buf.length < 64) return;
        if (buf[0] !== 0xff || buf[9] !== 0x7f || buf[10] < 3) return finish(new Error('Not a ZMTP 3 peer'));
        greeted = true;
        buf = buf.subarray(64);
      }
      const { frames, offset } = parseFrames(buf);
      buf = buf.subarray(offset);
      for (const f of frames) {
        if (f.flags & 0x04) {            // command frame (READY / ERROR)
          const nameLen = f.body[0];
          const name = f.body.subarray(1, 1 + nameLen).toString('ascii');
          if (name === 'ERROR') return finish(new Error('dabmux management handshake refused'));
          if (name === 'READY' && !ready) {
            ready = true;
            sock.write(encodeFrame(Buffer.alloc(0), { more: true }));    // REQ envelope delimiter
            sock.write(encodeFrame(Buffer.from(command, 'utf8')));
          }
          continue;
        }
        parts.push(f.body);
        if (!(f.flags & 0x01)) {          // last frame of the reply
          const msg = parts.filter((p) => p.length > 0); // drop the empty delimiter
          parts = [];
          return finish(null, Buffer.concat(msg).toString('utf8'));
        }
      }
    });
  });
}

// Map dabmux "values" (keyed by subchannel uid sub_N) to DABcast service ids.
// subToService: { sub_1: { id, name }, ... } — same ordering as muxBuilder.
export function normalizeValues(valuesJson, subToService) {
  const values = valuesJson?.values || {};
  const out = {};
  for (const [sub, entry] of Object.entries(values)) {
    const s = entry?.inputstat;
    if (!s) continue;
    const svc = subToService[sub];
    const state = String(s.state || '').replace(/\s*\(\d+\)\s*$/, '');
    out[svc?.id || sub] = {
      sub,
      name: svc?.name || sub,
      state,                         // Streaming | Unstable | Silence | NoData | ...
      minFill: s.min_fill,
      maxFill: s.max_fill,
      underruns: s.num_underruns,
      overruns: s.num_overruns,
      peakLeft: s.peak_left,         // dBFS
      peakRight: s.peak_right,
    };
  }
  return out;
}
