// Playlist storage in FPP's JSON format (media/playlists/<name>.json), so
// xLights "Upload Playlist" and plugins that read playlist files keep
// working. Shape:
//   { name, version: 3, repeat, loopCount, random, desc, empty,
//     leadIn: [entry], mainPlaylist: [entry], leadOut: [entry],
//     playlistInfo: { total_duration, total_items } }
// Entry types handled: both, sequence, media, pause, command, script,
// playlist (nested). Others (image, dynamic, plugin, url, effect, ...) are
// kept in the file but skipped at play time with a log line.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const SECTIONS = ['leadIn', 'mainPlaylist', 'leadOut'];

function fileFor(name) {
  const n = paths.safeName(String(name || '').replace(/\.json$/i, ''));
  return n ? path.join(paths.dir('playlists'), n + '.json') : null;
}

function list() {
  try {
    return fs.readdirSync(paths.dir('playlists'))
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}

function load(name) {
  const f = fileFor(name);
  if (!f) return null;
  try {
    const pl = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const s of SECTIONS) if (!Array.isArray(pl[s])) pl[s] = [];
    pl.name = pl.name || String(name);
    return pl;
  } catch { return null; }
}

function normalize(name, body) {
  const pl = { ...body };
  pl.name = String(name);
  pl.version = pl.version || 3;
  for (const s of SECTIONS) pl[s] = Array.isArray(pl[s]) ? pl[s] : [];
  pl.repeat = pl.repeat ? 1 : 0;
  pl.loopCount = Number(pl.loopCount) || 0;
  pl.random = Number(pl.random) || 0;
  pl.empty = pl.mainPlaylist.length + pl.leadIn.length + pl.leadOut.length === 0;
  const items = SECTIONS.reduce((a, s) => a + pl[s].length, 0);
  const dur = SECTIONS.reduce((a, s) => a + pl[s].reduce((b, e) => b + (Number(e.duration) || 0), 0), 0);
  pl.playlistInfo = { ...(pl.playlistInfo || {}), total_items: items, total_duration: Math.round(dur * 1000) / 1000 };
  return pl;
}

function save(name, body) {
  const f = fileFor(name);
  if (!f) throw new Error('invalid playlist name');
  const pl = normalize(name, body || {});
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(pl, null, 4));
  fs.renameSync(tmp, f);
  return pl;
}

function remove(name) {
  const f = fileFor(name);
  if (f) try { fs.unlinkSync(f); return true; } catch {}
  return false;
}

// Name a playlist entry the way ShowPilot does: basename without extension
// of the sequence, else of the media.
function entryName(e) {
  const f = e && (e.sequenceName || e.mediaName);
  return f ? path.basename(f, path.extname(f)) : '';
}

// A one-item playlist for a standalone sequence, with the audio named in the
// sequence header when that file is here.
function forSequence(seq, repeat) {
  const f = paths.fileIn('sequences', seq);
  if (!f || !fs.existsSync(f)) throw new Error(`sequence not found: ${seq}`);
  let media = '';
  try {
    const m = require('./fseq').probe(f).mediaFilename;
    if (m && ['music', 'videos'].some((k) => { const p = paths.fileIn(k, m); return p && fs.existsSync(p); })) media = m;
  } catch {}
  return { name: seq, repeat: repeat ? 1 : 0,
    mainPlaylist: [{ type: media ? 'both' : 'sequence', enabled: 1, playOnce: 0, sequenceName: seq, ...(media ? { mediaName: media } : {}) }] };
}

// What FPP's playlist commands accept: a playlist name, or a sequence file
// name ending in .fseq (FPP's /api/playlists/playable lists both, so FPP
// presets and schedules often name a sequence directly).
function loadPlayable(name, repeat) {
  const pl = load(name);
  if (pl) return pl;
  if (/\.fseq$/i.test(String(name || ''))) {
    try { return normalize(String(name), forSequence(String(name), repeat)); } catch { return null; }
  }
  const media = forMedia(String(name || ''), repeat);
  return media ? normalize(String(name), media) : null;
}

// An audio or video file on its own (FPP's Play Media; plugins use it).
function forMedia(name, repeat) {
  const kind = ['music', 'videos'].find((k) => { const p = paths.fileIn(k, name); return p && fs.existsSync(p); });
  if (!kind) return null;
  return { name, repeat: repeat ? 1 : 0, mainPlaylist: [{ type: 'media', enabled: 1, playOnce: 0, mediaName: name }] };
}

module.exports = { list, load, loadPlayable, forMedia, save, remove, normalize, entryName, forSequence, SECTIONS, fileFor };
