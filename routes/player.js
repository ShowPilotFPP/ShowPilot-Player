// ShowPilot Player's own admin API, used by the web UI. Optional password:
// when one is set, everything under /api/player (except auth) needs the
// session cookie. FPP-compatible routes stay open, as on FPP, because xLights
// and plugins call them without logging in.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const paths = require('../lib/paths');
const secrets = require('../lib/secrets');
const log = require('../lib/log');
const playlists = require('../lib/playlists');
const scheduler = require('../lib/scheduler');
const updater = require('../lib/updater');
const { probe } = require('../lib/fseq');
const { ifaces } = require('../lib/multisync');
const pkg = require('../package.json');

const COOKIE = 'spp_session';

function sign(v) { return crypto.createHmac('sha256', secrets.sessionSecret()).update(v).digest('hex'); }
function makeSession() { const exp = Date.now() + 30 * 86400000; const v = `v1.${exp}`; return `${v}.${sign(v)}`; }
function validSession(c) {
  if (!c) return false;
  const i = c.lastIndexOf('.');
  const v = c.slice(0, i), sig = c.slice(i + 1);
  if (!v || sig.length !== 64) return false;
  const want = sign(v);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
  return Number(v.split('.')[1]) > Date.now();
}
function cookieOf(req) {
  const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)').exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}

module.exports = function playerRoutes(ctx) {
  const { config, player, show, multisync, commands, plugins, showpilot } = ctx;
  const r = express.Router();
  r.use(express.json({ limit: '4mb' }));

  // ------------------------------------------------------------ auth
  const needsAuth = () => !!secrets.getUiPasswordHash();
  r.get('/auth', (req, res) => res.json({ required: needsAuth(), loggedIn: !needsAuth() || validSession(cookieOf(req)) }));
  const attempts = new Map();
  r.post('/auth/login', (req, res) => {
    const ip = req.socket.remoteAddress;
    const a = attempts.get(ip) || { n: 0, at: 0 };
    if (a.n >= 5 && Date.now() - a.at < 60000) return res.status(429).json({ error: 'too many attempts; wait a minute' });
    if (!needsAuth() || secrets.checkUiPassword(String(req.body.password || ''))) {
      attempts.delete(ip);
      res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(makeSession())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
      return res.json({ ok: true });
    }
    attempts.set(ip, { n: a.n + 1, at: Date.now() });
    res.status(401).json({ error: 'wrong password' });
  });
  r.post('/auth/logout', (req, res) => { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`); res.json({ ok: true }); });
  r.use((req, res, next) => {
    if (!needsAuth() || validSession(cookieOf(req))) return next();
    res.status(401).json({ error: 'login required' });
  });
  r.post('/auth/password', (req, res) => {
    const pw = String(req.body.password || '');
    if (pw && pw.length < 6) return res.status(400).json({ error: 'use at least 6 characters' });
    secrets.setUiPassword(pw);
    if (pw) res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(makeSession())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
    res.json({ ok: true, required: !!pw });
  });

  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req, res)); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  };

  // ------------------------------------------------------------ status
  r.get('/status', wrap(() => {
    const st = player.status();
    const info = show.info();
    return {
      version: pkg.version, hostName: config.get().hostName, mode: config.get().mode,
      player: st, playlist: { name: info.name, index: info.index, size: info.size, breadcrumbs: info.breadcrumbs, paused: !!show.pausedSnapshot, stopping: show.gracefulStop },
      next: show.peekNext(),
      schedule: { active: ctx.scheduler.active ? { playlist: ctx.scheduler.active.entry.playlist, end: ctx.scheduler.active.end } : null },
      showpilot: showpilot.status(),
      multisync: { sending: multisync.isSending(), lastMaster: multisync.stats.lastMaster, systems: multisync.systems.size },
      ips: ifaces().map((i) => i.address),
    };
  }));
  r.get('/logs', wrap((req) => ({ lines: log.tail(Math.min(1000, parseInt(req.query.n, 10) || 300)) })));

  // ------------------------------------------------------------ settings
  r.get('/config', wrap(() => config.get()));
  r.put('/config', wrap((req) => config.update(req.body || {})));

  // ------------------------------------------------------------ transport
  r.post('/play', wrap(async (req) => {
    const b = req.body || {};
    if (b.playlist) { await show.start(b.playlist, { repeat: !!b.repeat, startItem: b.startItem }); return { ok: true }; }
    if (!b.sequence && !b.media) throw new Error('nothing to play');
    // One-off item: run it as a tiny playlist so the show runner manages it.
    const tmpName = '_now';
    playlists.save(tmpName, { mainPlaylist: [{ type: b.sequence && b.media ? 'both' : b.sequence ? 'sequence' : 'media', enabled: 1, sequenceName: b.sequence || undefined, mediaName: b.media || undefined }] });
    await show.start(tmpName, { repeat: false });
    return { ok: true };
  }));
  r.post('/stop', wrap(async (req) => { if (req.body && req.body.graceful) show.stopGracefully(); else await show.stopNow(); return { ok: true }; }));
  r.post('/next', wrap(async () => { await show.next(); return { ok: true }; }));
  r.post('/prev', wrap(async () => { await show.prev(); return { ok: true }; }));
  r.post('/pause', wrap(async () => ({ ok: await show.togglePause() })));
  r.post('/insert', wrap(async (req) => {
    const { playlist, item, immediate } = req.body || {};
    const i = parseInt(item, 10) || 0;
    if (immediate) await show.insertImmediate(playlist, i, i); else await show.insertAfterCurrent(playlist, i, i);
    return { ok: true };
  }));
  r.post('/test', wrap((req) => {
    const { pattern, color } = req.body || {};
    if (!player.testPattern(pattern || null, Array.isArray(color) ? color.map(Number) : undefined)) throw new Error('stop the show before running a test pattern');
    return { ok: true };
  }));
  r.post('/command', wrap(async (req) => ({ result: await commands.run(req.body.command, req.body.args || []) })));
  r.get('/commands', wrap(() => commands.list()));

  // ------------------------------------------------------------ library
  r.get('/library', wrap(() => {
    const ls = (k) => { try { return fs.readdirSync(paths.dir(k)).filter((f) => !f.startsWith('.') && !f.endsWith('.part')).sort(); } catch { return []; } };
    const sequences = ls('sequences').filter((f) => /\.fseq$/i.test(f)).map((name) => {
      try { const i = probe(paths.fileIn('sequences', name)); return { name, ...i }; } catch (e) { return { name, error: e.message }; }
    });
    const size = (k, f) => { try { return fs.statSync(paths.fileIn(k, f)).size; } catch { return 0; } };
    return {
      sequences,
      music: ls('music').map((name) => ({ name, size: size('music', name) })),
      videos: ls('videos').map((name) => ({ name, size: size('videos', name) })),
      scripts: ls('scripts'),
      playlists: playlists.list().filter((n) => !n.startsWith('_')),
    };
  }));

  // ------------------------------------------------------------ schedule
  r.get('/schedule', wrap(() => ({ entries: scheduler.load(), upcoming: ctx.scheduler.upcoming(7) })));
  r.put('/schedule', wrap((req) => ({ entries: scheduler.save(req.body.entries || []), upcoming: ctx.scheduler.upcoming(7) })));
  r.get('/suntimes', wrap(() => {
    const { sunTimes } = require('../lib/suntimes');
    const loc = config.get().location || {};
    return sunTimes(new Date(), loc.latitude, loc.longitude) || {};
  }));

  // ------------------------------------------------------------ plugins
  r.get('/plugins', wrap(() => plugins.list()));
  r.get('/plugins/catalog', wrap(() => plugins.catalog()));
  r.post('/plugins/install', wrap((req) => plugins.install(req.body.url, { branch: req.body.branch })));
  r.post('/plugins/:name/update', wrap((req) => plugins.update(req.params.name)));
  r.delete('/plugins/:name', wrap((req) => plugins.uninstall(req.params.name)));
  r.post('/plugins/reload', wrap(async () => { await plugins.loadAll(); return { ok: true }; }));

  // ------------------------------------------------------------ ShowPilot
  r.get('/showpilot', wrap(() => ({ ...config.get().showpilot, status: showpilot.status() })));
  r.put('/showpilot', wrap((req) => {
    const b = { ...(req.body || {}) };
    if (typeof b.showToken === 'string') { secrets.setShowToken(b.showToken.trim()); delete b.showToken; }
    if (b.serverUrl !== undefined) b.serverUrl = String(b.serverUrl).trim().replace(/\/+$/, '');
    config.update({ showpilot: b });
    return { ...config.get().showpilot, status: showpilot.status() };
  }));
  r.post('/showpilot/test', wrap(async () => {
    const h = await showpilot.api('GET', '/api/plugin/health');
    if (!h) throw new Error(showpilot.lastError || 'no response');
    return { ok: true, health: h };
  }));
  r.post('/showpilot/sync', wrap(() => showpilot.syncPlaylist()));
  r.post('/showpilot/mode', wrap(async (req) => ({ ok: await showpilot.setViewerMode(String(req.body.mode || '').toUpperCase()) })));

  // ------------------------------------------------------------ MultiSync
  r.get('/multisync', wrap(() => ({ ...multisync.allSystems(), stats: multisync.stats })));
  r.post('/multisync/discover', wrap(() => { multisync.ping(true); return { ok: true }; }));

  // ------------------------------------------------------------ system
  r.get('/updates', wrap(async (req) => ({ ...(await updater.check(req.query.force === '1')), canRollback: updater.canRollback() })));
  r.post('/updates/apply', wrap(() => updater.apply((m) => log.info('updater', m))));
  r.post('/updates/rollback', wrap(() => updater.rollback()));
  r.get('/audio-devices', wrap(() => new Promise((resolve) => {
    execFile(process.env.SPP_MPV_BIN || 'mpv', ['--audio-device=help', '--no-config'], { timeout: 10000 }, (err, out) => {
      const list = [];
      for (const line of String(out || '').split('\n')) {
        const m = /^\s*'([^']+)'\s*\((.*)\)\s*$/.exec(line);
        if (m) list.push({ id: m[1], name: m[2] });
      }
      resolve(list);
    });
  })));
  // Schedules run in local time, so the timezone matters.
  r.get('/timezone', wrap(() => new Promise((resolve) => {
    execFile('timedatectl', ['list-timezones'], { timeout: 10000 }, (err, out) => {
      const current = Intl.DateTimeFormat().resolvedOptions().timeZone;
      resolve({ current, zones: err ? [current] : String(out).split('\n').filter(Boolean) });
    });
  })));
  r.put('/timezone', wrap((req) => new Promise((resolve, reject) => {
    const tz = String((req.body || {}).timezone || '');
    if (!/^[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+)*$/.test(tz)) return reject(new Error('bad timezone'));
    execFile('timedatectl', ['set-timezone', tz], { timeout: 10000 }, (err) => {
      if (err) return reject(new Error('could not set the timezone: ' + err.message));
      process.env.TZ = tz; // takes effect for new Date() in this process right away
      log.info('system', `timezone set to ${tz}`);
      resolve({ ok: true, timezone: tz });
    });
  })));
  r.post('/system/:action', wrap((req) => {
    const a = req.params.action;
    if (!['reboot', 'shutdown', 'restart'].includes(a)) throw new Error('unknown action');
    log.info('system', `${a} requested from the UI`);
    setTimeout(() => {
      if (a === 'restart') process.exit(0);
      execFile('systemctl', [a === 'reboot' ? 'reboot' : 'poweroff'], () => {});
    }, 500);
    return { ok: true };
  }));

  return r;
};
