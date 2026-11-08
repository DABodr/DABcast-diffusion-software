#!/usr/bin/env node
/**
 * Reset DABcast credentials to factory defaults.
 *
 * Usage:
 *   node server/src/reset-password.js            # reset to admin / dabcast
 *   node server/src/reset-password.js myuser mypassword
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { readJson, writeJson } from './fsutil.js';
import { DEFAULT_SETTINGS, WEAK_PASSWORDS, MIN_PASSWORD_LENGTH } from './defaults.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const settingsPath = path.resolve(rootDir, DEFAULT_SETTINGS.dataDir, 'settings.json');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node server/src/reset-password.js [username] [password]

Without arguments : reset to factory defaults (admin / dabcast)
With arguments     : set custom credentials

Options:
  --help, -h    Show this help message
  --show        Show current username (password hash is not reversible)

Examples:
  node server/src/reset-password.js
  node server/src/reset-password.js myuser MyStr0ngPass!
`);
  process.exit(0);
}

if (!fs.existsSync(settingsPath)) {
  console.error(`Error: ${settingsPath} not found. Start the server once to generate it.`);
  process.exit(1);
}

const settings = readJson(settingsPath, DEFAULT_SETTINGS);

if (args.includes('--show')) {
  console.log(`Current username : ${settings.auth.username}`);
  console.log(`Password hash    : ${settings.auth.password.substring(0, 20)}...`);
  console.log(`Must change pwd  : ${settings.auth.mustChangePassword}`);
  process.exit(0);
}

let username, password, mustChangePassword;

if (args.length === 0) {
  // Reset to factory defaults
  username = DEFAULT_SETTINGS.auth.username;
  password = DEFAULT_SETTINGS.auth.password;
  mustChangePassword = true;
  console.log('Resetting to factory defaults...');
} else if (args.length === 2) {
  username = args[0];
  password = args[1];
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Error: password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }
  if (WEAK_PASSWORDS.includes(password.toLowerCase())) {
    console.error('Error: this password is too common, choose a stronger one.');
    process.exit(1);
  }
  mustChangePassword = false;
  console.log(`Setting custom credentials for user "${username}"...`);
} else {
  console.error('Usage: node server/src/reset-password.js [username] [password]');
  process.exit(1);
}

settings.auth.username = username;
settings.auth.password = bcrypt.hashSync(password, 10);
settings.auth.mustChangePassword = mustChangePassword;
writeJson(settingsPath, settings);

console.log('');
console.log(`  Username : ${username}`);
console.log(`  Password : ${mustChangePassword ? password + ' (will be prompted to change)' : '(set)'}`);
console.log('');
console.log('Restart the server for changes to take effect.');
