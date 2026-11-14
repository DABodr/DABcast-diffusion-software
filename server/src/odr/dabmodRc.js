// Client for the telnet remote control of odr-dabmod (dabmod.ini: telnet=1, telnetport=2121).
// - getDabmodValue: read-only, used by the watchdog to read 'sdr frames' (frames sent to the SDR):
//   odr-dabmod keeps running without any error when its device is unplugged, only this counter stops.
// - setDabmodValue: live change of a parameter while ON AIR (SDR output 'Apply now': frequency,
//   TX gain, digital gain) — no restart of the multiplex.
import net from 'node:net';

// Reply of one command: "<banner>\n**********\n> <value>> " → "<value>" (null when not found yet)
export function parseRcReply(raw) {
  const m = /\*{5,}\n> ([\s\S]*?)> /.exec(String(raw));
  return m ? m[1].trim() : null;
}

// Reply of one remote control command as text, or null (not reachable, timeout)
function rcCommand(cmd, { host = '127.0.0.1', port = 2121, timeoutMs = 2000 } = {}) {
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
    const sock = net.connect({ host, port }, () => sock.write(`${cmd}\n`));
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      if (buf.length > 65536) return finish(null);
      if (parseRcReply(buf) !== null) finish(parseRcReply(buf));
    });
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(parseRcReply(buf)));
  });
}

// Value of 'get <controllable> <param>' as text, or null (not reachable, timeout, unknown parameter)
export async function getDabmodValue(controllable, param, opts = {}) {
  const v = await rcCommand(`get ${controllable} ${param}`, opts);
  return v === null || /not exported|error/i.test(v) ? null : v;
}

// 'set <controllable> <param> <value>': { ok, reply }. Only simple tokens are sent (numbers, channel
// names): never a line break or a second command.
export async function setDabmodValue(controllable, param, value, opts = {}) {
  const tok = (x) => /^[A-Za-z0-9_.+-]{1,32}$/.test(String(x));
  if (!tok(controllable) || !tok(param) || !tok(value)) return { ok: false, reply: 'invalid value' };
  const reply = await rcCommand(`set ${controllable} ${param} ${value}`, opts);
  return { ok: reply !== null && !/error|not exported|invalid|fail|unknown/i.test(reply), reply: reply ?? 'remote control not reachable' };
}
