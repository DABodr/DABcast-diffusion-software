// `dabcast --reset-password [username]`: lost credentials on an installed server.
// Sets the factory password (DEFAULT_SETTINGS.auth.password, 'dabcast'), already hashed, with
// mustChangePassword = true: the web UI then forces a new password before anything else.
// Run with sudo; the running service keeps its settings in memory, so it must be restarted.
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { readJson, writeJson } from './fsutil.js';
import { DEFAULT_SETTINGS } from './defaults.js';

// Data directory of the installed service: DABCAST_DATA_DIR from the environment, else from
// /etc/default/dabcast, else the systemd default /var/lib/dabcast; `fallback` for a dev checkout.
export function resolveDataDir(fallback, { env = process.env, defaultsFile = '/etc/default/dabcast', installed = true } = {}) {
  if (env.DABCAST_DATA_DIR) return path.resolve(env.DABCAST_DATA_DIR);
  try {
    const m = /^\s*DABCAST_DATA_DIR\s*=\s*["']?([^"'\s#]+)/m.exec(fs.readFileSync(defaultsFile, 'utf8'));
    if (m) return path.resolve(m[1]);
  } catch { /* no defaults file */ }
  return installed ? '/var/lib/dabcast' : fallback;
}

// Returns the message to print; throws when settings.json cannot be found / written.
export function resetPassword(dataDir, username = null) {
  const settingsPath = path.join(dataDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`${settingsPath} not found (start DABcast once, or set DABCAST_DATA_DIR)`);
  }
  const st = fs.statSync(settingsPath);
  const settings = readJson(settingsPath, null);
  if (!settings || typeof settings !== 'object') throw new Error(`${settingsPath} is not valid JSON`);
  const user = String(username || settings.auth?.username || DEFAULT_SETTINGS.auth.username).trim();
  const password = DEFAULT_SETTINGS.auth.password;
  settings.auth = { ...(settings.auth || {}), username: user, password: bcrypt.hashSync(password, 10), mustChangePassword: true };
  writeJson(settingsPath, settings);
  // sudo writes as root: give the file back to the service user, or the service could not save it
  try { fs.chownSync(settingsPath, st.uid, st.gid); fs.chmodSync(settingsPath, st.mode & 0o777); } catch { /* not root: same owner */ }
  return [
    `DABcast credentials reset in ${settingsPath}`,
    `  username: ${user}`,
    `  password: ${password}  (a new one is required at the first sign-in)`,
    'Restart the service to apply it:  sudo systemctl restart dabcast',
    '(the restart briefly interrupts the broadcast; autoStart puts the multiplex back on air)',
  ].join('\n');
}
