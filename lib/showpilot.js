// Built-in ShowPilot client: a native re-implementation of the ShowPilot FPP
// plugin ("ShowPilot Blackbox"), wire-compatible with the ShowPilot server:
//   * POST /api/plugin/{heartbeat,playing,position,next,viewer-mode,sync-sequences}
//   * GET  /api/plugin/state  (votes, jukebox requests, race winners, cooldowns)
//   * audio-cache manifest/link/upload
//   * the audio position daemon the server connects to (WebSocket + /audio on 8090)
// Differences from the plugin, all improvements the server can't see:
//   * positions come from the player's master clock, not FPP status polling;
//   * a resume reports its real position (never 0:00);
//   * request queueing uses the show runner's own after-current queue (no
//     "ShowPilot Queue" playlist file) and resolves lead-in offsets correctly.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const EventEmitter = require('events');
const pkg = require('../package.json');
const paths = require('./paths');
const playlists = require('./playlists');
const secrets = require('./secrets');
const { probe } = require('./fseq');
const { AUDIO_EXT } = require('./engine/player');

const PLUGIN_VERSION = `player-${pkg.version}`;
const MODES = ['ON', 'OFF', 'VOTING', 'JUKEBOX', 'RACE'];
const baseName = (f) => (f ? path.basename(f, path.extname(f)) : '');

class ShowPilotClient extends EventEmitter {
  constructor({ config, player, show, commands }) {
    super();
    this.config = config;
    this.player = player;
    this.show = show;
    this.commands = commands;
    this.cooldowns = new Map(); // lowercase name -> until epoch ms
    this.pending = [];          // names queued, in order
    this.lastQueuedAt = 0;
    this.lastPlaying = undefined;
    this.lastNext = undefined;
    this.idleSent = false;
    this.mode = null;
    this.modeAt = 0;
    this.lastHeartbeat = 0;
    this.lastError = null;
    this.lastOkAt = null;
    this.warned = new Map();
  }

  get cfg() { return this.config.get().showpilot; }
  enabled() { return !!(this.cfg.enabled && this.cfg.serverUrl && secrets.getShowToken()); }

  start() {
    this.show.skip = (entry, ctx) => this._isCooled(entry, ctx);
    this._registerCommands();
    this._loop();
    if (this.cfg.enabled) this._startDaemon();
    this.config.on('change', () => this._restartDaemonIfNeeded());
  }

  close() {
    clearTimeout(this.timer);
    this._stopDaemon();
  }

  log(msg, verboseOnly) {
    if (verboseOnly && !this.cfg.verboseLogging) return;
    this.emit('log', msg);
  }

  // ---------------------------------------------------------------- HTTP
  baseUrl() {
    const u = String(this.cfg.serverUrl || '').trim().replace(/\/+$/, '');
    // Plain http(s) only: no credentials, query or fragment (same rule as the plugin).
    if (!/^https?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/i.test(u)) return null;
    return u;
  }

  async api(method, p, body, { raw, contentType, timeoutMs = 10000 } = {}) {
    const base = this.baseUrl();
    const token = secrets.getShowToken();
    if (!base || !token) return null;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    let payload;
    if (raw) { payload = raw; headers['Content-Type'] = contentType || 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    try {
      // redirect: 'manual' — never send the bearer token to wherever a 3xx points.
      const r = await fetch(base + p, { method, headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if (r.status >= 300 && r.status < 400) { this.lastError = `server redirected (${r.status}); fix the server URL`; this.log(this.lastError); return null; }
      if (!r.ok) { this.lastError = `${method} ${p} -> HTTP ${r.status}`; this.log(this.lastError, true); return null; }
      this.lastOkAt = new Date().toISOString();
      this.lastError = null;
      const t = await r.text();
      try { return t ? JSON.parse(t) : {}; } catch { return {}; }
    } catch (e) {
      this.lastError = `${method} ${p}: ${e.message}`;
      this.log(this.lastError, true);
      return null;
    }
  }

  // ---------------------------------------------------------------- main loop
  async _loop() {
    try { if (this.enabled()) await this._iteration(); } catch (e) { this.log('showpilot loop: ' + e.message); }
    this.timer = setTimeout(() => this._loop(), Math.max(250, this.cfg.statusIntervalMs || 500));
  }

  async _iteration() {
    const cfg = this.cfg;
    const now = Date.now();
    if (now - this.lastHeartbeat >= Math.max(5, cfg.heartbeatIntervalSec || 15) * 1000) {
      this.lastHeartbeat = now;
      this.api('POST', '/api/plugin/heartbeat', { pluginVersion: PLUGIN_VERSION });
    }
    this._pruneCooldowns();

    const p = this.player;
    const playing = p.state === 'playing' && p.item;
    if (!playing && !this.show.current) {
      if (!this.idleSent) {
        this.idleSent = true;
        this.lastPlaying = '';
        this.lastNext = '';
        this.pending = [];
        await this.api('POST', '/api/plugin/playing', { sequence: '' });
        await this.api('POST', '/api/plugin/next', { sequence: '' });
      }
      return;
    }
    this.idleSent = false;
    if (!playing) return; // a pause entry is running

    const name = baseName(p.item.sequence || p.item.media);
    const posSec = Math.max(0, p.mediaMs() / 1000);
    if (name !== this.lastPlaying) {
      this.lastPlaying = name;
      this.log(`now playing ${name}`, true);
      await this.api('POST', '/api/plugin/playing', { sequence: name, seconds_played: Math.floor(posSec) });
      const i = this.pending.findIndex((n) => n.toLowerCase() === name.toLowerCase());
      if (i >= 0) this.pending.splice(0, i + 1);
    }
    this.api('POST', '/api/plugin/position', { sequence: name, position: +posSec.toFixed(3) });

    const remote = cfg.remotePlaylist;
    const base = this.show.frames[0];
    let next = '';
    if (base && base.name !== remote) next = baseName((this.show.peekNext() || {}).sequenceName || (this.show.peekNext() || {}).mediaName);
    if (next !== this.lastNext) { this.lastNext = next; this.api('POST', '/api/plugin/next', { sequence: next }); }

    if (now - this.modeAt > 60000 || this.mode === null) {
      const st = await this.api('GET', '/api/plugin/state');
      if (st) { this.mode = st.mode; this.modeAt = now; this._applyPatches(st.playlistPatches); }
    }
    const voting = this.mode === 'VOTING', race = this.mode === 'RACE';
    const effectiveInterrupt = !!cfg.interruptSchedule && !voting && !race;
    const remaining = p.item.durationMs ? (p.item.durationMs - p.mediaMs()) / 1000 : 999;
    const nearEnd = Math.floor(remaining) < Math.max(1, cfg.requestFetchTime || 3);

    let shouldCheck = true;
    if (((!effectiveInterrupt && !race) || voting) && !nearEnd) shouldCheck = false;
    if (race && !cfg.interruptSchedule && !nearEnd) shouldCheck = false;
    if (now - this.lastQueuedAt < (2 + (Number(cfg.additionalWaitTime) || 0)) * 1000) shouldCheck = false;
    if (!shouldCheck || !remote) return;

    const st = await this.api('GET', '/api/plugin/state');
    if (!st) return;
    this.mode = st.mode; this.modeAt = now;
    this._applyPatches(st.playlistPatches);
    let cand = null, raceInterrupt = false;
    if (st.mode === 'VOTING') cand = st.winningVote;
    else if (st.mode === 'JUKEBOX') cand = st.nextRequest;
    else if (st.mode === 'RACE') { cand = st.raceWinner; raceInterrupt = !!(st.raceWinner && st.raceWinner.interrupt); }
    if (!cand || !cand.sequence) {
      if (!effectiveInterrupt) this.lastQueuedAt = now;
      return;
    }
    await this._queue(cand, remote, effectiveInterrupt || raceInterrupt);
  }

  // Resolve by name in the live Remote Playlist (the server's index can be stale).
  _resolve(remote, cand) {
    const pl = playlists.load(remote);
    if (!pl) return null;
    const want = String(cand.sequence).toLowerCase();
    const main = pl.mainPlaylist;
    const nameAt = (i) => baseName(main[i] && (main[i].sequenceName || main[i].mediaName)).toLowerCase();
    let idx = -1;
    const si = (cand.playlistIndex | 0) - 1;
    if (si >= 0 && si < main.length && nameAt(si) === want) idx = si;
    if (idx < 0) idx = main.findIndex((_, i) => nameAt(i) === want);
    if (idx < 0) return null;
    return pl.leadIn.length + idx + 1; // global 1-based item index (FPP semantics)
  }

  async _queue(cand, remote, interrupt) {
    const name = cand.sequence;
    if (this.pending.some((n) => n.toLowerCase() === String(name).toLowerCase())) return;
    const idx = this._resolve(remote, cand);
    if (!idx) {
      const last = this.warned.get(name) || 0;
      if (Date.now() - last > 60000) { this.warned.set(name, Date.now()); this.log(`"${name}" is not in the remote playlist "${remote}"; request skipped`); }
      return;
    }
    this.pending.push(name);
    this.lastQueuedAt = Date.now();
    const playingRemote = this.show.frames.some((f) => f.name === remote && f.kind !== 'base');
    try {
      if (interrupt && !playingRemote && this.pending.length === 1) {
        this.log(`interrupting for ${name}`);
        await this.show.insertImmediate(remote, idx, idx);
      } else {
        this.log(`queued ${name} after current`);
        await this.show.insertAfterCurrent(remote, idx, idx);
      }
    } catch (e) { this.log(`queue ${name}: ${e.message}`); }
  }

  // ---------------------------------------------------------------- cooldowns
  _applyPatches(patches) {
    if (!Array.isArray(patches)) return;
    for (const pt of patches) {
      if (!pt || typeof pt.sequenceName !== 'string') continue;
      const k = pt.sequenceName.toLowerCase();
      if (pt.enabled === true) { this.cooldowns.delete(k); continue; }
      if (pt.enabled === false && typeof pt.reenableAt === 'string') {
        const t = Date.parse(pt.reenableAt);
        if (Number.isFinite(t) && t > Date.now()) this.cooldowns.set(k, t);
      }
    }
  }

  _pruneCooldowns() { const n = Date.now(); for (const [k, t] of this.cooldowns) if (t <= n) this.cooldowns.delete(k); }

  _isCooled(entry, ctx) {
    if (!this.cfg.enabled || !this.cooldowns.size) return false;
    if (ctx && ctx.playlist === this.cfg.remotePlaylist) return false;
    const n = playlists.entryName(entry).toLowerCase();
    const t = this.cooldowns.get(n);
    return !!t && t > Date.now();
  }

  // ---------------------------------------------------------------- commands
  async setViewerMode(mode) {
    if (!MODES.includes(mode)) throw new Error('bad mode');
    const r = await this.api('POST', '/api/plugin/viewer-mode', { mode });
    if (!r) throw new Error(this.lastError || 'ShowPilot server did not accept the mode change');
    this.mode = mode === 'ON' ? null : mode;
    return true;
  }

  _registerCommands() {
    const c = this.commands;
    const reg = (n, fn) => c.register(n, { source: 'showpilot', category: 'ShowPilot', run: fn });
    reg('ShowPilot - Turn Viewer Control On', () => this.setViewerMode('ON'));
    reg('ShowPilot - Turn Viewer Control Off', () => this.setViewerMode('OFF'));
    reg('ShowPilot - Switch to Voting Mode', () => this.setViewerMode('VOTING'));
    reg('ShowPilot - Switch to Jukebox Mode', () => this.setViewerMode('JUKEBOX'));
    reg('ShowPilot - Switch to Race Mode', () => this.setViewerMode('RACE'));
    reg('ShowPilot - Turn Interrupt Schedule On', () => { this.config.update({ showpilot: { interruptSchedule: true } }); });
    reg('ShowPilot - Turn Interrupt Schedule Off', () => { this.config.update({ showpilot: { interruptSchedule: false } }); });
  }

  // ---------------------------------------------------------------- sync
  async syncPlaylist() {
    const remote = this.cfg.remotePlaylist;
    const pl = remote && playlists.load(remote);
    if (!pl) throw new Error('set a remote playlist first');
    const sequences = [];
    pl.mainPlaylist.forEach((e, i) => {
      if (!e || !['both', 'sequence', 'media'].includes(e.type)) return;
      const name = baseName(e.sequenceName || e.mediaName);
      let dur = Number(e.duration) || null;
      if (!dur && e.sequenceName) { try { dur = probe(paths.fileIn('sequences', e.sequenceName)).durationMs / 1000; } catch {} }
      sequences.push({
        name,
        displayName: name.replace(/[_-]+/g, ' ').trim(),
        mediaName: e.mediaName || null,
        durationSeconds: dur ? Math.round(dur) : null,
        playlistIndex: i + 1,
      });
    });
    const r = await this.api('POST', '/api/plugin/sync-sequences', { playlistName: remote, sequences });
    if (!r) throw new Error(this.lastError || 'sync failed');
    let audio = null;
    try { audio = await this.syncAudioCache(pl); } catch (e) { audio = { error: e.message }; }
    return { synced: r.synced ?? sequences.length, audio };
  }

  async syncAudioCache(pl) {
    const man = await this.api('GET', '/api/plugin/audio-cache/manifest');
    if (!man) throw new Error(this.lastError || 'manifest failed');
    if (man.audioEnabled === false) return { skipped: 'audio disabled on server' };
    const have = new Set(man.haveHashes || []);
    let linked = 0, uploaded = 0, missing = 0;
    for (const e of pl.mainPlaylist) {
      const m = e && e.mediaName;
      if (!m || !AUDIO_EXT.has(path.extname(m).toLowerCase())) continue;
      const f = paths.fileIn('music', m);
      if (!f || !fs.existsSync(f)) { missing++; continue; }
      const buf = fs.readFileSync(f);
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      if (have.has(hash)) {
        if (await this.api('POST', '/api/plugin/audio-cache/link', { mediaName: m, hash })) linked++;
      } else {
        const ext = path.extname(m).slice(1).toLowerCase();
        const type = ext === 'mp3' ? 'audio/mpeg' : `audio/${ext}`;
        if (await this.api('POST', `/api/plugin/audio-cache/upload?hash=${hash}&mediaName=${encodeURIComponent(m)}`, undefined, { raw: buf, contentType: type, timeoutMs: 120000 })) uploaded++;
      }
    }
    return { linked, uploaded, missing };
  }

  status() {
    return {
      enabled: this.cfg.enabled, connected: this.enabled() && !this.lastError && !!this.lastOkAt,
      tokenSet: !!secrets.getShowToken(), mode: this.mode, lastOkAt: this.lastOkAt, lastError: this.lastError,
      pending: this.pending, cooldowns: [...this.cooldowns.entries()].map(([n, t]) => ({ name: n, until: new Date(t).toISOString() })),
      daemonPort: this.daemonPort || null, wsClients: this.wss ? this.wss.clients.size : 0,
    };
  }

  // ---------------------------------------------------------------- audio daemon
  // Same messages and endpoints as the plugin's showpilot_audio.js, so the
  // ShowPilot server's relay connects to us unchanged.
  _startDaemon() {
    const port = this.cfg.audioDaemonPort || 8090;
    this.daemonPort = port;
    this.lastSyncPointAt = 0;
    this.suppressUntil = 0;
    this.forceSyncAt = 0;
    const srv = http.createServer((req, res) => this._daemonHttp(req, res));
    this.wss = new WebSocketServer({ server: srv });
    this.wss.on('connection', (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', (d) => {
        let m; try { m = JSON.parse(d); } catch { return; }
        if (m && m.type === 'timeReq') ws.send(JSON.stringify({ type: 'timeResp', t0: m.t0, daemonNow: Date.now() }));
      });
      ws.send(JSON.stringify(this._pos('position')));
    });
    srv.on('error', (e) => this.log(`audio daemon port ${port}: ${e.message}`));
    srv.listen(port, '0.0.0.0');
    this.daemon = srv;

    const p = this.player;
    this._onStart = (e) => {
      // A resume is a position, not a restart: no 0:00 report, short suppression.
      this.suppressUntil = Date.now() + (e.resumed ? 300 : 1000);
      this.forceSyncAt = Date.now() + (e.resumed ? 400 : 1000);
      this._broadcast(this._pos('position'));
    };
    this._onStopEvt = () => this._broadcast(this._pos('position'));
    p.on('start', this._onStart);
    p.on('resume', this._onStart);
    p.on('stop', this._onStopEvt);
    p.on('end', this._onStopEvt);
    p.on('paused', this._onStopEvt);
    this._tick = setInterval(() => this._daemonTick(), 500);
    this._hb = setInterval(() => this._broadcast({ type: 'heartbeat', playing: this.player.state === 'playing', serverTimestamp: Date.now() }), 5000);
    this._ping = setInterval(() => {
      for (const ws of this.wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch {} }
    }, 30000);
  }

  _stopDaemon() {
    clearInterval(this._tick); clearInterval(this._hb); clearInterval(this._ping);
    const p = this.player;
    if (this._onStart) { p.off('start', this._onStart); p.off('resume', this._onStart); p.off('stop', this._onStopEvt); p.off('end', this._onStopEvt); p.off('paused', this._onStopEvt); }
    try { this.wss && this.wss.close(); } catch {}
    try { this.daemon && this.daemon.close(); } catch {}
    this.daemon = null; this.wss = null;
  }

  // The daemon only listens while ShowPilot is enabled.
  _restartDaemonIfNeeded() {
    const want = !!this.cfg.enabled;
    const port = this.cfg.audioDaemonPort || 8090;
    if (!want && this.daemon) this._stopDaemon();
    else if (want && !this.daemon) this._startDaemon();
    else if (want && port !== this.daemonPort) { this._stopDaemon(); this._startDaemon(); }
  }

  _pos(type) {
    const p = this.player;
    const playing = p.state === 'playing' && !!p.item && !!p.item.media;
    return { type, playing, filename: p.item ? p.item.media : null,
      positionSec: playing ? +(p.mediaMs() / 1000).toFixed(3) : 0, serverTimestamp: Date.now() };
  }

  _broadcast(msg) {
    if (!this.wss) return;
    const s = JSON.stringify(msg);
    for (const ws of this.wss.clients) if (ws.readyState === 1) { try { ws.send(s); } catch {} }
  }

  _daemonTick() {
    const p = this.player;
    if (p.state !== 'playing' || !p.item || !p.item.media) return;
    this._broadcast(this._pos('position'));
    const now = Date.now();
    if (now < this.suppressUntil) return;
    if (now - this.lastSyncPointAt >= 1000 || (this.forceSyncAt && now >= this.forceSyncAt)) {
      this.forceSyncAt = 0;
      this.lastSyncPointAt = now;
      this._broadcast(this._pos('syncPoint'));
    }
  }

  _daemonHttp(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' }); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const url = new URL(req.url, 'http://x');
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const st = this._pos('position');
    if (url.pathname === '/health') return json({ ok: true, version: PLUGIN_VERSION, port: this.daemonPort, fppStatus: { playing: st.playing, filename: st.filename, positionSec: st.positionSec, at: Date.now() }, wsClients: this.wss ? this.wss.clients.size : 0 });
    if (url.pathname === '/status') return json({ playing: st.playing, filename: st.filename, positionSec: st.positionSec, at: Date.now(), serverTimestamp: Date.now() });
    if (url.pathname.startsWith('/audio/')) return this._serveAudio(decodeURIComponent(url.pathname.slice(7)), req, res);
    res.writeHead(404); res.end();
  }

  _serveAudio(name, req, res) {
    const n = paths.safeName(name);
    const ok = n && ['.mp3', '.ogg', '.wav', '.flac', '.aac', '.m4a'].includes(path.extname(n).toLowerCase());
    const f = ok && paths.fileIn('music', n);
    let st;
    try { st = f && fs.statSync(f); } catch {}
    if (!st || !st.isFile()) { res.writeHead(404); return res.end(); }
    const type = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.aac': 'audio/aac', '.m4a': 'audio/mp4' }[path.extname(n).toLowerCase()];
    const common = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      let s = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
      let e = range[1] === '' || range[2] === '' ? st.size - 1 : Number(range[2]);
      if (!(s >= 0 && s <= e && e < st.size)) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...common, 'Content-Range': `bytes ${s}-${e}/${st.size}`, 'Content-Length': e - s + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(f, { start: s, end: e }).pipe(res);
    }
    res.writeHead(200, { ...common, 'Content-Length': st.size, 'X-Audio-Source': 'showpilot-daemon' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(f).pipe(res);
  }
}

module.exports = { ShowPilotClient, PLUGIN_VERSION };
