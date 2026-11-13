// Read-only client for the telnet remote control of odr-dabmod (dabmod.ini: telnet=1, telnetport=2121).
// Used by the watchdog to read 'sdr frames' (frames sent to the SDR): odr-dabmod keeps running without
// any error when its device is unplugged, only this counter stops. Only 'get' commands are sent.
import net from 'node:net';

// Reply of one command: "<banner>\n**********\n> <value>> " → "<value>" (null when not found yet)
export function parseRcReply(raw) {
  const m = /\*{5,}\n> ([\s\S]*?)> /.exec(String(raw));
  return m ? m[1].trim() : null;
}

// Value of 'get <controllable> <param>' as text, or null (not reachable, timeout, unknown parameter)
export function getDabmodValue(controllable, param, { host = '127.0.0.1', port = 2121, timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const sock = net.connect({ host, port }, () => sock.write(`get ${controllable} ${param}\n`));
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.setEncoding('utf8');
    const value = () => {
      const v = parseRcReply(buf);
      return v === null || /not exported|error/i.test(v) ? null : v;
    };
    sock.on('data', (d) => {
      buf += d;
      if (buf.length > 65536) return finish(null);
      if (parseRcReply(buf) !== null) finish(value());
    });
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(value()));
  });
}
