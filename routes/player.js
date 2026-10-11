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
const presetStore = require('../lib/presets');
const tz = require('../lib/timezone');
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
  const smallJson = express.json({ limit: '4mb' });
  const bigJson = express.json({ limit: '64mb' }); // FPP backups carry playlists and scripts
  r.use((req, res, next) => (req.path.startsWith('/backup/') ? bigJson : smallJson)(req, res, next));

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
      player: st, playlist: { name: info.name, index: info.index, size: info.size, breadcrumbs: info.breadcrumbs, paused: !!show.pausedSnapshot, stopping: show.gracefulStop || show.stopAfterLoop },
      next: show.peekNext(),
      schedule: { active: ctx.scheduler.active ? { playlist: scheduler.targetName(ctx.scheduler.active.entry), end: ctx.scheduler.active.end } : null },
      showpilot: showpilot.status(),
      multisync: { sending: multisync.isSending(), lastMaster: multisync.stats.lastMaster, systems: multisync.systems.size },
      ips: ifaces().map((i) => i.address),
      pluginRestart: plugins.restartFlag() > 0,
      rebootNeeded: plugins.rebootFlag() > 0,
      problems: [
        ...(config.get().outputs || []).some((o) => o.enabled !== false) ? [] : ['No controller outputs are set up, so no lights are sent. Add them under Lights → Controllers, or in xLights FPP Connect set this player\'s "UDP Out" to "All".'],
        ...require('../lib/health').missing().map((d) => `${d.bin} is not installed (${d.why}). Install it under Settings → Updates → System software.`),
        ...(player.problems || []),
      ],
    };
  }));
  r.get('/logs', wrap((req) => ({ lines: log.tail(Math.min(1000, parseInt(req.query.n, 10) || 300)) })));

  // ------------------------------------------------------------ settings
  r.get('/config', wrap(() => config.get()));
  r.put('/config', wrap((req) => config.update(req.body || {})));

  // ------------------------------------------------------------ transport
  r.post('/play', wrap(async (req) => {
    const b = req.body || {};
    // Report what actually happened: a playlist whose items can't play stops
    // right away, and the reason goes back to the page instead of a false "Playing".
    const outcome = () => {
      if (show.isRunning()) return { ok: true, playing: true };
      if (show.lastProblem) { const e = new Error(show.lastProblem); e.status = 409; throw e; }
      return { ok: true, playing: false, finished: true };
    };
    if (b.playlist) { await show.start(b.playlist, { repeat: !!b.repeat, startItem: b.startItem }); return outcome(); }
    if (!b.sequence && !b.media) throw new Error('nothing to play');
    if (b.sequence && !b.media) { await show.start(playlists.forSequence(String(b.sequence), !!b.repeat), { repeat: !!b.repeat }); return outcome(); }
    // One-off item: run it as a tiny playlist so the show runner manages it.
    const tmpName = '_now';
    playlists.save(tmpName, { mainPlaylist: [{ type: b.sequence && b.media ? 'both' : b.sequence ? 'sequence' : 'media', enabled: 1, sequenceName: b.sequence || undefined, mediaName: b.media || undefined }] });
    await show.start(tmpName, { repeat: !!b.repeat });
    return outcome();
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
  r.post('/command', wrap(async (req) => {
    const b = req.body || {};
    if (b.multisyncCommand) multisync.sendCommand(String(b.command || ''), (b.args || []).map(String), String(b.multisyncHosts || ''));
    return { result: await commands.run(b.command, b.args || []) };
  }));
  r.get('/commands', wrap(() => commands.list()));

  // ------------------------------------------------------------ command presets
  r.get('/presets', wrap(() => ({ presets: presetStore.groups(), reserved: presetStore.RESERVED })));
  r.put('/presets', wrap((req) => {
    // Body: { presets: [{ name, presetSlot, commands: [{ command, args, multisyncCommand, multisyncHosts }] }] }
    const rows = [];
    const seen = new Set();
    for (const g of (req.body && req.body.presets) || []) {
      const name = String(g.name || '').trim();
      if (!name) throw new Error('every preset needs a name');
      if (seen.has(name)) throw new Error(`two presets are called "${name}"`);
      seen.add(name);
      for (const c of g.commands || []) rows.push({ ...c, name, presetSlot: g.presetSlot });
    }
    presetStore.save(rows);
    return { presets: presetStore.groups(), reserved: presetStore.RESERVED };
  }));
  r.post('/presets/run', wrap(async (req) => ({ result: await ctx.presets.trigger(String((req.body || {}).name || '')) })));

  // ------------------------------------------------------------ library
  r.get('/library', wrap(() => {
    const ls = (k) => { try { return fs.readdirSync(paths.dir(k)).filter((f) => !f.startsWith('.') && !f.endsWith('.part')).sort(); } catch { return []; } };
    const sequences = ls('sequences').filter((f) => /\.fseq$/i.test(f)).map((name) => {
      try {
        const i = probe(paths.fileIn('sequences', name));
        delete i.ranges;
        return { name, ...i };
      } catch (e) { return { name, error: e.message }; }
    });
    const stat = (k, f) => { try { const st = fs.statSync(paths.fileIn(k, f)); return { size: st.size, mtime: st.mtimeMs }; } catch { return { size: 0, mtime: 0 }; } };
    for (const sq of sequences) Object.assign(sq, stat('sequences', sq.name));
    return {
      sequences,
      music: ls('music').map((name) => ({ name, ...stat('music', name) })),
      videos: ls('videos').map((name) => ({ name, ...stat('videos', name) })),
      scripts: ls('scripts'),
      scriptFiles: ls('scripts').map((name) => ({ name, ...stat('scripts', name) })),
      playlists: playlists.list().filter((n) => !n.startsWith('_')),
    };
  }));

  // ------------------------------------------------------------ schedule
  const schedView = (entries) => ({ entries, upcoming: ctx.scheduler.upcoming(7), next: ctx.scheduler.nextRuns(),
    holidays: require('../lib/holidays').list(), enabled: ctx.scheduler.enabled });
  r.get('/schedule', wrap(() => schedView(scheduler.load())));
  r.put('/schedule', wrap((req) => schedView(scheduler.save((req.body || {}).entries || []))));
  r.get('/suntimes', wrap(() => {
    const { sunTimes } = require('../lib/suntimes');
    const loc = config.get().location || {};
    return sunTimes(new Date(), loc.latitude, loc.longitude) || {};
  }));

  // ------------------------------------------------------------ FPP backup restore
  const fppBackup = require('../lib/fpp-backup');
  const backupEnv = () => {
    const ls = (k) => { try { return fs.readdirSync(paths.dir(k)); } catch { return []; } };
    return {
      commandNames: new Set(commands.list().map((c) => c.name)),
      audioCards: require('../lib/audio-devices').cards(),
      plugins: plugins.list().map((p) => p.name),
      library: { sequences: ls('sequences'), media: [...ls('music'), ...ls('videos')] },
    };
  };
  r.post('/backup/inspect', wrap((req) => fppBackup.analyze((req.body || {}).backup, backupEnv())));
  r.post('/backup/restore', wrap(async (req) => {
    const b = req.body || {};
    const env = backupEnv();
    const res = await fppBackup.restore(b.backup, b.selection || {}, { config, audioCards: env.audioCards, setTimezone: (z) => tz.set(z) });
    log.info('backup', `restored from an FPP backup: ${res.restored.join(', ') || 'nothing'}${res.problems.length ? ` (problems: ${res.problems.join('; ')})` : ''}`);
    return res;
  }));

  // ------------------------------------------------------------ plugins
  r.get('/plugins', wrap(() => plugins.list()));
  r.get('/plugins/catalog', wrap(() => plugins.catalog()));
  r.post('/plugins/install', wrap((req) => plugins.install(req.body.url, { branch: req.body.branch })));
  r.post('/plugins/:name/update', wrap((req) => plugins.update(req.params.name)));
  r.delete('/plugins/:name', wrap((req) => plugins.uninstall(req.params.name)));
  r.post('/plugins/reload', wrap(async () => { await plugins.loadAll(); return { ok: true }; }));
  r.post('/plugins/restart', wrap(async () => { await plugins.restart(); return { ok: true }; }));

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
  // System software (OS packages + Node.js) without reflashing.
  const osUpdate = require('../lib/os-update');
  r.get('/system-update', wrap(() => osUpdate.status()));
  r.post('/system-update/check', wrap(() => osUpdate.check()));
  r.post('/system-update', wrap(() => osUpdate.start({
    isShowRunning: () => player.state === 'playing' || show.isRunning(),
    onRestart: () => { log.info('system', 'restarting after a system update'); process.exit(0); },
  })));
  r.get('/updates', wrap(async (req) => ({ ...(await updater.check(req.query.force === '1')), canRollback: updater.canRollback() })));
  r.post('/updates/apply', wrap(() => updater.apply((m) => log.info('updater', m))));
  r.post('/updates/rollback', wrap(() => updater.rollback()));
  r.get('/audio-devices', wrap(() => {
    const audioDevices = require('../lib/audio-devices');
    const list = audioDevices.cards();
    return { devices: list.map((c) => ({ id: c.id, name: `${c.name}${c.usb ? ' (USB)' : ''}` })), auto: audioDevices.resolve('auto', list).name };
  }));
  // Schedules run in local time, so the timezone matters.
  r.get('/timezone', wrap(async () => ({ current: tz.current(), zones: await tz.list() })));
  r.put('/timezone', wrap(async (req) => {
    const z = await tz.set((req.body || {}).timezone);
    log.info('system', `timezone set to ${z}`);
    return { ok: true, timezone: z };
  }));
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
