// FPP's settings file format (media/settings and media/config/plugin.<name>):
// one `key = "value"` per line. Shared by the API and the PHP/shell shims.

const fs = require('fs');
const path = require('path');
const paths = require('../paths');

const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function fileFor(plugin) {
  if (!plugin) return path.join(paths.MEDIA_DIR, 'settings');
  return KEY_RE.test(plugin) ? path.join(paths.dir('config'), 'plugin.' + plugin) : null;
}

function readAll(plugin) {
  const f = fileFor(plugin);
  const out = {};
  if (!f) return out;
  let txt = '';
  try { txt = fs.readFileSync(f, 'utf8'); } catch { return out; }
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function read(key, plugin) {
  const all = readAll(plugin);
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : undefined;
}

function write(key, value, plugin) {
  if (!KEY_RE.test(key)) throw new Error('bad setting name');
  const f = fileFor(plugin);
  if (!f) throw new Error('bad plugin name');
  let lines = [];
  try { lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l !== ''); } catch {}
  const re = new RegExp('^\\s*' + key.replace(/[.]/g, '\\.') + '\\s*=');
  lines = lines.filter((l) => !re.test(l));
  lines.push(`${key} = "${String(value).replace(/[\r\n]/g, ' ')}"`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', lines.join('\n') + '\n');
  fs.renameSync(f + '.tmp', f);
}

module.exports = { read, readAll, write, KEY_RE };
