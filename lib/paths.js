// Filesystem layout. The media tree deliberately mirrors FPP's
// (/home/fpp/media/{sequences,music,videos,...}) because FPP script plugins
// and xLights both hard-code those names. SPP_MEDIA_DIR overrides it for
// development and tests.

const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');
const MEDIA_DIR = path.resolve(process.env.SPP_MEDIA_DIR || '/home/fpp/media');

const SUBDIRS = {
  sequences: 'sequences',
  music: 'music',
  videos: 'videos',
  effects: 'effects',
  images: 'images',
  scripts: 'scripts',
  playlists: 'playlists',
  config: 'config',
  logs: 'logs',
  plugins: 'plugins',
  plugindata: 'plugindata',
  upload: 'upload',
  virtualdisplay_assets: 'virtualdisplay_assets',
};

function dir(key) {
  const sub = SUBDIRS[key];
  if (!sub) throw new Error(`unknown media dir ${key}`);
  return path.join(MEDIA_DIR, sub);
}

function ensureLayout() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  for (const sub of Object.values(SUBDIRS)) fs.mkdirSync(path.join(MEDIA_DIR, sub), { recursive: true });
}

// Accept only a bare file name. Everything that reaches the filesystem from
// HTTP, MultiSync or playlists goes through this, so "../" can never escape.
function safeName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  if (!n || n.length > 255) return null;
  if (n.includes('/') || n.includes('\\') || n.includes('\0')) return null;
  if (n === '.' || n === '..' || n.startsWith('.')) return null;
  return n;
}

function fileIn(key, name) {
  const n = safeName(name);
  if (!n) return null;
  return path.join(dir(key), n);
}

module.exports = { APP_DIR, MEDIA_DIR, dir, ensureLayout, safeName, fileIn, SUBDIRS };
