// FPP-compatible HTTP API (see PRIMER.md "FPP compatibility"). Enough of
// FPP's /api for xLights FPP Connect (discovery + chunked uploads) and for
// the calls FPP script/PHP plugins make. Like FPP, these routes have no
// login; the Player is meant for a show LAN.

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const paths = require('../lib/paths');
const playlists = require('../lib/playlists');
const { FseqFile } = require('../lib/fseq');
const settingsFile = require('../lib/fppcompat/settings-file');
const { runPhp } = require('../lib/fppcompat/php');
const { COMPAT_MAJOR, COMPAT_MINOR, VERSION_STRING } = require('../lib/multisync');
const { FPPDIR } = require('../lib/plugins');
const pkg = require('../package.json');

// Upload directory keys accepted by PATCH/POST /api/file/:dir.
const DIRS = {
  sequences: 'sequences', sequence: 'sequences', music: 'music', videos: 'videos', video: 'videos',
  effects: 'effects', images: 'images', scripts: 'scripts', upload: 'upload', uploads: 'upload',
  virtualdisplay_assets: 'virtualdisplay_assets', playlists: 'playlists',
};
const mapDir = (d) => DIRS[String(d || '').toLowerCase()] || null;

function human(n) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 2 : 0)} ${u[i]}`;
}

function mmss(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

const probeCache = new Map();
function ffprobe(file) {
  let st;
  try { st = fs.statSync(file); } catch { return Promise.resolve(null); }
  const key = `${file}:${st.mtimeMs}:${st.size}`;
  if (probeCache.has(key)) return Promise.resolve(probeCache.get(key));
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 15000, maxBuffer: 4 << 20 }, (err, out) => {
      let j = null;
      try { j = JSON.parse(out); } catch {}
      if (!j) j = { format: { filename: file, size: String(st.size) } };
      probeCache.set(key, j);
      resolve(j);
    });
  });
}

module.exports = function fppRoutes(ctx) {
  const { config, player, show, multisync, commands, plugins } = ctx;
  const r = express.Router();
  const raw = express.raw({ type: () => true, limit: '64mb' });
  const text = express.text({ type: () => true, limit: '1mb' });
  const jsonBody = express.json({ limit: '4mb', type: () => true });

  // ------------------------------------------------------------ system
  function systemInfo() {
    const c = config.get();
    const ips = multisync ? require('../lib/multisync').ifaces().map((i) => i.address) : [];
    return {
      HostName: c.hostName, HostDescription: c.hostDescription || '',
      Platform: 'Raspberry Pi', Variant: multisync ? (multisync.model || 'ShowPilot Player') : 'ShowPilot Player',
      Mode: c.mode === 'remote' ? 'remote' : 'player', multisync: c.mode !== 'remote' && !!c.multisync.enabled,
      Version: VERSION_STRING, Branch: 'showpilot-player', majorVersion: COMPAT_MAJOR, minorVersion: COMPAT_MINOR,
      typeId: multisync ? multisync.typeId : 1, uuid: c.uuid,
      channelRanges: multisync ? multisync.channelRanges() : '',
      OSVersion: os.release(), Kernel: os.release(), IPs: ips,
      Utilization: { CPU: +(os.loadavg()[0] / os.cpus().length * 100).toFixed(1), Memory: +((1 - os.freemem() / os.totalmem()) * 100).toFixed(1), Uptime: `${Math.floor(os.uptime() / 86400)} days` },
      ShowPilotPlayer: pkg.version,
    };
  }
  r.get('/system/info', (req, res) => res.json(systemInfo()));
  r.get('/fppd/version', (req, res) => res.json({ version: VERSION_STRING, majorVersion: COMPAT_MAJOR, minorVersion: COMPAT_MINOR, branch: 'showpilot-player', fppdAPI: 4, Status: 'OK' }));
  r.get('/fppd/multiSyncSystems', (req, res) => {
    const all = multisync.allSystems();
    if (req.query.localOnly) all.systems = all.systems.filter((s) => s.local);
    res.json(all);
  });
  r.get('/fppd/multiSyncStats', (req, res) => res.json({ status: 'OK', stats: multisync.stats }));

  // FPP status shape (Playlist::GetCurrentStatus + HTTP layer fields).
  function status() {
    const c = config.get();
    const it = player.item;
    const info = show.info();
    const playing = player.state === 'playing' || !!show.current;
    const elapsed = it ? Math.max(0, player.mediaMs() / 1000) : 0;
    const remaining = it && it.durationMs ? Math.max(0, it.durationMs / 1000 - elapsed) : 0;
    const statusName = !playing ? 'idle' : show.gracefulStop ? 'stopping gracefully' : show.pausedSnapshot ? 'paused' : 'playing';
    return {
      fppd: 'running', status: playing ? 1 : 0, status_name: statusName,
      mode: c.mode === 'remote' ? 8 : 2, mode_name: c.mode === 'remote' ? 'remote' : 'player',
      current_playlist: { playlist: info.name || '', description: info.desc || '', count: String(info.size || 0), index: String(info.index || 0), type: it ? (it.sequence && it.media ? 'both' : it.media ? 'media' : 'sequence') : '' },
      current_sequence: it && it.sequence ? it.sequence : '',
      current_song: it && it.media ? it.media : '',
      seconds_played: String(Math.floor(elapsed)), seconds_elapsed: String(Math.floor(elapsed)),
      seconds_remaining: String(Math.floor(remaining)), milliseconds_elapsed: Math.floor(elapsed * 1000),
      time_elapsed: mmss(elapsed), time_remaining: mmss(remaining),
      repeat_mode: String(info.repeat || 0), random: info.random || 0,
      breadcrumbs: info.breadcrumbs, uuid: c.uuid, volume: 100,
      scheduler: { enabled: true, status: ctx.scheduler && ctx.scheduler.active ? 'playing' : 'idle' },
    };
  }
  r.get('/fppd/status', (req, res) => res.json(status()));
  r.get('/system/status', (req, res) => res.json({ ...status(), advancedView: systemInfo() }));
  r.get('/system/fppd/restart', async (req, res) => { await plugins.loadAll().catch(() => {}); res.json({ status: 'OK' }); });
  r.get('/cape', (req, res) => res.status(404).json({ id: 'No Cape!' }));
  r.get('/proxies', (req, res) => res.json([]));
  r.get('/channel/output/:file', (req, res) => res.status(404).json({ status: 'not supported' }));

  // ------------------------------------------------------------ settings
  r.get('/settings/:name', (req, res) => {
    const v = settingsFile.read(req.params.name);
    if (v === undefined) return res.status(404).json({ status: 'not found' });
    res.json({ name: req.params.name, value: v });
  });
  r.put('/settings/:name', text, (req, res) => {
    try { settingsFile.write(req.params.name, typeof req.body === 'string' ? req.body : ''); res.json({ status: 'OK' }); }
    catch (e) { res.status(400).json({ status: e.message }); }
  });
  r.get('/plugin/:repo/settings/:key', (req, res) => {
    const v = settingsFile.read(req.params.key, req.params.repo);
    res.json({ status: 'OK', [req.params.key]: v === undefined ? '' : v });
  });
  const putPluginSetting = (req, res) => {
    try {
      settingsFile.write(req.params.key, typeof req.body === 'string' ? req.body : '', req.params.repo);
      res.json({ status: 'OK', [req.params.key]: settingsFile.read(req.params.key, req.params.repo) });
    } catch (e) { res.status(400).json({ status: e.message }); }
  };
  r.put('/plugin/:repo/settings/:key', text, putPluginSetting);
  r.post('/plugin/:repo/settings/:key', text, putPluginSetting);

  // ------------------------------------------------------------ sequences & media
  const listDir = (key, filter) => {
    try { return fs.readdirSync(paths.dir(key)).filter((f) => !f.startsWith('.') && !f.includes('.part') && (!filter || filter(f))).sort(); } catch { return []; }
  };
  r.get('/sequence', (req, res) => res.json(listDir('sequences', (f) => /\.fseq$/i.test(f)).map((f) => f.replace(/\.fseq$/i, ''))));
  r.get('/sequence/:name/meta', (req, res) => {
    let n = req.params.name;
    if (!/\.(fseq|eseq)$/i.test(n)) n += '.fseq';
    const f = paths.fileIn(/\.eseq$/i.test(n) ? 'effects' : 'sequences', n);
    if (!f || !fs.existsSync(f)) return res.status(404).send(`Not found: ${n}`);
    let s;
    try { s = new FseqFile(f); res.json(s.meta(n)); } catch { res.json({ Name: n, Version: '?.?', ID: '-1', StepTime: -1, NumFrames: -1, MaxChannel: -1, ChannelCount: -1 }); }
    finally { if (s) s.close(); }
  });
  r.delete('/sequence/:name', (req, res) => {
    let n = req.params.name;
    if (!/\.fseq$/i.test(n)) n += '.fseq';
    const f = paths.fileIn('sequences', n);
    try { fs.unlinkSync(f); res.json({ status: 'OK' }); } catch { res.status(404).json({ status: 'not found' }); }
  });
  r.get('/media', (req, res) => res.json([...listDir('music'), ...listDir('videos')].sort()));
  r.get('/media/:name/meta', async (req, res) => {
    const n = paths.safeName(req.params.name);
    const f = n && ([paths.fileIn('music', n), paths.fileIn('videos', n)].find((x) => x && fs.existsSync(x)));
    if (!f) return res.json({ [req.params.name]: [] });
    res.json(await ffprobe(f));
  });
  r.get('/files/:dir', async (req, res) => {
    const d = mapDir(req.params.dir);
    if (!d) return res.status(400).json({ status: 'Invalid Directory' });
    const files = [];
    for (const name of listDir(d)) {
      let st;
      try { st = fs.statSync(path.join(paths.dir(d), name)); } catch { continue; }
      if (!st.isFile()) continue;
      const e = { name, mtime: new Date(st.mtimeMs).toISOString().replace('T', ' ').slice(0, 19), sizeBytes: st.size, sizeHuman: human(st.size) };
      if (d === 'sequences' && /\.fseq$/i.test(name)) {
        try { const s = new FseqFile(path.join(paths.dir(d), name)); e.playtimeSeconds = Math.round(s.durationMs / 1000); e.mediaName = s.mediaFilename; s.close(); } catch {}
      }
      files.push(e);
    }
    res.json({ status: 'ok', files });
  });

  // ------------------------------------------------------------ file upload / download
  r.post('/file/:dir', (req, res, next) => {
    if (req.params.dir && !mapDir(req.params.dir)) return next();
    res.type('text/plain').send(Date.now().toString(16) + Math.random().toString(16).slice(2, 8));
  });

  // xLights FPP Connect: sequential PATCH chunks with Upload-Offset/-Length/-Name.
  r.patch('/file/:dir', raw, (req, res) => {
    const dir = mapDir(req.params.dir);
    if (!dir) return res.status(400).json({ status: 'Invalid Directory' });
    const name = paths.safeName(req.get('Upload-Name') || '');
    const off = req.get('Upload-Offset'), len = req.get('Upload-Length');
    if (!name || !/^\d+$/.test(off || '') || !/^\d+$/.test(len || '')) return res.status(400).json({ status: 'Missing or invalid Upload-Name, Upload-Offset or Upload-Length' });
    const offset = Number(off), total = Number(len);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const cl = Number(req.get('Content-Length') || body.length);
    if (body.length < cl) return res.status(400).json({ status: 'failed', file: name, dir: req.params.dir, error: 'short body' });
    const target = path.join(paths.dir(dir), name);
    const part = target + '.part';
    try {
      if (offset === 0) { try { fs.unlinkSync(part); } catch {} }
      else if (!fs.existsSync(part)) {
        try { if (fs.statSync(target).size === total) return res.json({ status: 'OK', file: name, dir: req.params.dir, size: String(total) }); } catch {}
        return res.status(409).json({ status: 'failed', file: name, dir: req.params.dir, error: 'upload not started' });
      }
      const fd = fs.openSync(part, offset === 0 ? 'w' : 'r+');
      try { fs.writeSync(fd, body, 0, body.length, offset); } finally { fs.closeSync(fd); }
      const size = fs.statSync(part).size;
      if (size >= total && offset + body.length >= total) {
        fs.truncateSync(part, total);
        fs.renameSync(part, target); // atomic swap; a playing file keeps its old inode
        ctx.emit && ctx.emit('upload', { dir, name });
        return res.json({ status: 'OK', file: name, dir: req.params.dir, size: String(total) });
      }
      res.json({ status: 'OK', file: name, dir: req.params.dir, size: String(offset + body.length) });
    } catch (e) {
      res.status(500).json({ status: 'failed', file: name, dir: req.params.dir, error: e.message });
    }
  });

  // Raw body upload: POST /api/file/<Dir>/<Name>
  r.post('/file/:dir/:name', raw, (req, res) => {
    const dir = mapDir(req.params.dir);
    const name = paths.safeName(req.params.name);
    if (!dir || !name) return res.status(400).json({ status: 'Invalid' });
    const target = path.join(paths.dir(dir), name);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    fs.writeFileSync(target + '.part', body);
    fs.renameSync(target + '.part', target);
    res.json({ status: 'OK', file: name, dir: req.params.dir, written: body.length, size: body.length, offset: 0 });
  });

  r.get('/file/:dir/:name', (req, res) => {
    const dir = mapDir(req.params.dir) || (req.params.dir.toLowerCase() === 'logs' ? 'logs' : null);
    const f = dir && paths.fileIn(dir, req.params.name);
    if (!f || !fs.existsSync(f)) return res.status(404).json({ status: 'not found' });
    if (req.query.tail) {
      const n = Math.min(5000, parseInt(req.query.tail, 10) || 100);
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      return res.type('text/plain').send(lines.slice(-n).join('\n'));
    }
    res.sendFile(f);
  });
  r.delete('/file/:dir/:name', (req, res) => {
    const dir = mapDir(req.params.dir);
    const f = dir && paths.fileIn(dir, req.params.name);
    try { fs.unlinkSync(f); res.json({ status: 'OK' }); } catch { res.status(404).json({ status: 'not found' }); }
  });

  // ------------------------------------------------------------ playlists
  r.get('/playlists', (req, res) => res.json(playlists.list()));
  const ok = (res) => res.json({ Status: 'OK', Message: '' });
  const fail = (res, e) => res.status(e.status || 500).json({ Status: 'Error', Message: e.message });
  r.get('/playlists/stop', async (req, res) => { await show.stopNow(); ok(res); });
  r.get('/playlists/stopgracefully', (req, res) => { show.stopGracefully(); ok(res); });
  r.get('/playlists/pause', async (req, res) => { await show.pause(); ok(res); });
  r.get('/playlists/resume', async (req, res) => { await show.resume(); ok(res); });
  r.get('/playlist/:name', (req, res) => {
    const pl = playlists.load(req.params.name);
    if (!pl) return res.status(404).json({ Status: 'Error', Message: `Playlist not found: ${req.params.name}` });
    res.json(pl);
  });
  r.post('/playlist/:name', jsonBody, (req, res) => {
    try { res.json(playlists.save(req.params.name, req.body)); } catch (e) { fail(res, e); }
  });
  r.put('/playlist/:name', jsonBody, (req, res) => {
    try { res.json(playlists.save(req.params.name, req.body)); } catch (e) { fail(res, e); }
  });
  r.delete('/playlist/:name', (req, res) => (playlists.remove(req.params.name) ? ok(res) : res.status(404).json({ Status: 'Error', Message: 'not found' })));
  r.get(['/playlist/:name/start', '/playlist/:name/start/:repeat', '/playlist/:name/start/:repeat/:protected'], async (req, res) => {
    try { await show.start(req.params.name, { repeat: req.params.repeat === 'true' || req.params.repeat === '1' }); ok(res); } catch (e) { fail(res, e); }
  });
  r.get('/sequence/current/stop', async (req, res) => { await show.stopNow(); ok(res); });

  // ------------------------------------------------------------ commands
  r.get('/commands', (req, res) => res.json(commands.list()));
  r.get('/commands/:name', (req, res) => {
    const c = commands.get(req.params.name);
    if (!c) return res.status(404).json({ status: 'not found' });
    res.json({ name: c.name, args: c.args, description: c.description });
  });
  const runCmd = async (res, name, args) => {
    try { res.type('text/plain').send(String(await commands.run(name, args))); }
    catch (e) { res.status(e.status || 500).type('text/plain').send(e.message); }
  };
  r.get('/command/:name*', (req, res) => {
    const rest = (req.params[0] || '').split('/').filter((x, i) => i > 0 || x !== '');
    let args;
    try { args = rest.map((a) => decodeURIComponent(a)); } catch { return res.status(400).type('text/plain').send('bad argument encoding'); }
    runCmd(res, req.params.name, args);
  });
  r.post('/command/:name', jsonBody, (req, res) => runCmd(res, req.params.name, Array.isArray(req.body) ? req.body : []));
  r.post('/command', jsonBody, (req, res) => runCmd(res, req.body && req.body.command, (req.body && req.body.args) || []));

  // ------------------------------------------------------------ plugins
  r.get('/plugin', (req, res) => res.json(plugins.list().map((p) => p.name)));
  r.post('/fppd/plugin/:dir/:action', async (req, res) => {
    const { dir, action } = req.params;
    try {
      if (action === 'load') await plugins.load(dir); else if (action === 'unload') await plugins.unload(dir);
      else return res.status(400).json({ Status: 'Error' });
      res.json({ Status: 'OK', Message: '', plugin: dir, loaded: action === 'load' });
    } catch (e) { res.status(500).json({ Status: 'Error', Message: e.message }); }
  });
  r.all('/plugin/:repo/*', raw, (req, res) => {
    const repo = req.params.repo;
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repo)) return res.status(404).end();
    runPhp(path.join(FPPDIR, 'www/api/plugin-router.php'), req, res, {
      env: { SPP_PLUGIN: repo, SPP_ENDPOINT: req.params[0] || '', FPPDIR, MEDIADIR: paths.MEDIA_DIR },
    });
  });

  return r;
};
