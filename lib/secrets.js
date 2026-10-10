// Secrets live in media/plugindata/showpilot-player/, not media/config/,
// because config folders get copied into backups and support bundles
// (same rule the FPP plugin follows for its show token).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');

function dir() {
  const d = path.join(paths.dir('plugindata'), 'showpilot-player');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function read(name) {
  try { return fs.readFileSync(path.join(dir(), name), 'utf8').trim(); } catch { return ''; }
}

function write(name, value) {
  const file = path.join(dir(), name);
  if (!value) { try { fs.unlinkSync(file); } catch {} return; }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, String(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function checkPassword(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 32);
  const want = Buffer.from(keyHex, 'hex');
  return want.length === key.length && crypto.timingSafeEqual(key, want);
}

module.exports = {
  getShowToken: () => read('showToken'),
  setShowToken: (t) => write('showToken', t),
  getUiPasswordHash: () => read('uiPassword'),
  setUiPassword: (pw) => write('uiPassword', pw ? hashPassword(pw) : ''),
  checkUiPassword: (pw) => checkPassword(pw, read('uiPassword')),
  sessionSecret() {
    let s = read('sessionSecret');
    if (!s) { s = crypto.randomBytes(32).toString('hex'); write('sessionSecret', s); }
    return s;
  },
};
