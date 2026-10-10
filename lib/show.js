// Show runner: walks playlists and hands items to the player.
//
// Frames form a stack. The bottom frame is the started playlist (lead-in,
// main loop, lead-out). Inserted playlists push frames on top:
//   - immediate : the current song is paused at a measured position and
//                 resumed exactly where it stopped once the insert finishes;
//   - after     : queued; runs when the current item ends, then the
//                 original playlist carries on with its next item.
// The two never get confused with each other or with a fresh start.

const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const playlists = require('./playlists');
const paths = require('./paths');

const PLAYABLE = new Set(['both', 'sequence', 'media']);

function shuffle(a) {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
  return r;
}

class Show extends EventEmitter {
  constructor(player) {
    super();
    this.player = player;
    this.frames = [];
    this.after = [];           // inserted-after frames waiting for the current item to end
    this.current = null;       // { entry, frame, section, index, token }
    this.token = 0;
    this.pauseTimer = null;
    this.gracefulStop = false;
    this.stopAfterLoop = false; // finish the main playlist loop, then lead-out
    this.skip = null;          // (entry, ctx) => bool ; ShowPilot cooldowns
    this.queryNext = null;     // async (info) => void ; plugin query_next callbacks
    this.pausedSnapshot = null;
    this.runCommand = async () => { throw new Error('commands not wired'); };

    player.on('end', (e) => { if (this.current && this.current.playerItem === e.id) this._advance('ended'); });
  }

  // ---------------------------------------------------------------- frames
  _baseFrame(pl, { repeat, startItem } = {}) {
    const f = {
      kind: 'base', name: pl.name, pl,
      repeat: repeat !== undefined ? !!repeat : !!pl.repeat,
      loopsLeft: Number(pl.loopCount) > 0 ? Number(pl.loopCount) : 0,
      section: 'leadIn', index: -1,
      order: null,
    };
    f.order = this._mainOrder(pl);
    if (startItem && startItem > 0) {
      // FPP's item index is global: lead-in items first, then main, then lead-out.
      const li = pl.leadIn.length, mi = pl.mainPlaylist.length;
      const g = startItem - 1;
      if (g < li) { f.section = 'leadIn'; f.index = g - 1; }
      else if (g < li + mi) { f.section = 'mainPlaylist'; f.index = g - li - 1; }
      else { f.section = 'leadOut'; f.index = g - li - mi - 1; }
    }
    return f;
  }

  _mainOrder(pl) {
    const idx = pl.mainPlaylist.map((_, i) => i);
    return pl.random ? shuffle(idx) : idx;
  }

  _insertFrame(pl, kind, startItem, endItem) {
    const all = [...pl.leadIn, ...pl.mainPlaylist, ...pl.leadOut];
    const s = startItem > 0 ? startItem - 1 : 0;
    const e = endItem > 0 ? endItem : all.length;
    return { kind, name: pl.name, pl, items: all.slice(s, Math.max(s, e)), index: -1, offset: s, resume: null };
  }

  _entryAt(f, section, i) {
    if (f.kind !== 'base') return f.items[i];
    if (section === 'mainPlaylist') return f.pl.mainPlaylist[f.order[i]];
    return f.pl[section][i];
  }

  // Pick the next entry from a frame, mutating its cursor. Returns null when
  // the frame is finished.
  _nextFrom(f) {
    if (f.kind !== 'base') {
      f.index++;
      return f.index < f.items.length ? { entry: f.items[f.index], section: 'Inserted', index: f.index } : null;
    }
    for (let guard = 0; guard < 10000; guard++) {
      if (this.gracefulStop && f.section !== 'leadOut') { f.section = 'leadOut'; f.index = -1; }
      const list = f.section === 'mainPlaylist' ? f.order : f.pl[f.section];
      f.index++;
      if (f.index < list.length) {
        let entry = this._entryAt(f, f.section, f.index);
        if (f.section === 'mainPlaylist' && this.skip) {
          // Cooldowns: walk forward to the first allowed item, never past the
          // end of this loop (no wrap, no stall) — same rule as the plugin.
          let j = f.index;
          while (j < list.length && this.skip(this._entryAt(f, f.section, j), { playlist: f.name })) j++;
          if (j < list.length && j !== f.index) { f.index = j; entry = this._entryAt(f, f.section, j); }
        }
        return { entry, section: f.section, index: f.index };
      }
      if (f.section === 'leadIn') { f.section = 'mainPlaylist'; f.index = -1; continue; }
      if (f.section === 'mainPlaylist') {
        if (f.pl.mainPlaylist.length && !this.gracefulStop && !this.stopAfterLoop) {
          if (f.repeat) { f.index = -1; f.order = this._mainOrder(f.pl); continue; }
          if (f.loopsLeft > 1) { f.loopsLeft--; f.index = -1; f.order = this._mainOrder(f.pl); continue; }
        }
        f.section = 'leadOut'; f.index = -1; continue;
      }
      return null;
    }
    return null;
  }

  // ---------------------------------------------------------------- control
  async start(name, { repeat, startItem, ifNotRunning } = {}) {
    if (ifNotRunning && this.isRunning()) return false;
    // A playlist name, or a ready-made playlist object (scheduled sequences).
    const pl = name && typeof name === 'object' ? playlists.normalize(name.name, name) : playlists.load(name);
    if (!pl) throw new Error(`playlist not found: ${name}`);
    await this._stopAll(false);
    this.gracefulStop = false;
    this.stopAfterLoop = false;
    this.frames = [this._baseFrame(pl, { repeat, startItem })];
    this._playlistEvent('start');
    await this._advance('start');
    return true;
  }

  isRunning() { return this.frames.length > 0 || !!this.current; }

  async insertImmediate(name, startItem = 0, endItem = 0, ifNotRunning = false) {
    if (ifNotRunning && this.isRunning()) return false;
    const pl = playlists.load(name);
    if (!pl) throw new Error(`playlist not found: ${name}`);
    if (!this.isRunning()) return this.start(name, { startItem });
    const f = this._insertFrame(pl, 'immediate', startItem, endItem);
    const cur = this.current;
    if (cur && PLAYABLE.has(cur.entry.type) && this.player.state === 'playing') {
      const snap = await this.player.pause();
      if (snap) f.resume = { ...cur, positionMs: snap.positionMs };
    }
    clearTimeout(this.pauseTimer);
    this.current = null;
    this.frames.push(f);
    await this._advance('insert');
    return true;
  }

  async insertAfterCurrent(name, startItem = 0, endItem = 0, ifNotRunning = false) {
    if (ifNotRunning && this.isRunning()) return false;
    const pl = playlists.load(name);
    if (!pl) throw new Error(`playlist not found: ${name}`);
    if (!this.isRunning()) return this.start(name, { startItem });
    this.after.push(this._insertFrame(pl, 'after', startItem, endItem));
    return true;
  }

  async next() { if (this.isRunning()) await this._advance('skip'); }

  async prev() {
    const f = this.frames[this.frames.length - 1];
    if (!f) return;
    f.index = Math.max(-1, (this.current ? this.current.index : f.index) - 1);
    await this._advance('prev', true);
  }

  async restartItem() {
    const f = this.frames[this.frames.length - 1];
    if (!f || !this.current) return;
    f.index = this.current.index - 1;
    await this._advance('restart', true);
  }

  async pause() {
    if (!this.current || this.pausedSnapshot) return false;
    if (PLAYABLE.has(this.current.entry.type) && this.player.state === 'playing') {
      const snap = await this.player.pause();
      this.pausedSnapshot = { ...this.current, positionMs: snap ? snap.positionMs : 0 };
      return true;
    }
    return false;
  }

  async resume() {
    const s = this.pausedSnapshot;
    if (!s) return false;
    this.pausedSnapshot = null;
    await this._playEntry(s, { startMs: s.positionMs, resumed: true });
    return true;
  }

  async togglePause() { return this.pausedSnapshot ? this.resume() : this.pause(); }

  stopGracefully(afterLoop) {
    if (!this.isRunning()) return;
    if (afterLoop) { this.stopAfterLoop = true; this.emit('stopping', 'afterLoop'); }
    else { this.gracefulStop = true; this.emit('stopping', 'graceful'); }
  }

  async stopNow() { if (this.isRunning()) this.emit('stopping', 'now'); await this._stopAll(true); }

  async _stopAll(emit) {
    clearTimeout(this.pauseTimer);
    const had = this.isRunning();
    const name = this.frames.length ? this.frames[0].name : null;
    this.frames = [];
    this.after = [];
    this.current = null;
    this.pausedSnapshot = null;
    this.gracefulStop = false;
    this.stopAfterLoop = false;
    this.token++;
    await this.player.stop();
    if (had && emit) this._playlistEvent('stop', name);
  }

  // ---------------------------------------------------------------- advance
  async _advance(reason, keepCursor) {
    const my = ++this.token;
    clearTimeout(this.pauseTimer);

    // Plugins may insert the next item (FPP's synchronous query_next).
    if (this.queryNext && reason === 'ended' && this.frames.length === 1 && !keepCursor) {
      try { await this.queryNext(this.info()); } catch {}
      if (my !== this.token) return;
    }

    if (this.after.length && reason !== 'start') {
      this.frames.push(this.after.shift());
    }

    for (let guard = 0; guard < 1000; guard++) {
      const f = this.frames[this.frames.length - 1];
      if (!f) {
        const had = this.current;
        this.current = null;
        await this.player.stop();
        this._playlistEvent('stop', had ? had.frameName : null);
        this.emit('idle');
        return;
      }
      const nx = this._nextFrom(f);
      if (!nx) {
        this.frames.pop();
        if (this.after.length) { this.frames.push(this.after.shift()); continue; }
        if (f.resume) {
          // Back to the interrupted song, exactly where it was paused.
          const r = f.resume;
          if (this.frames.length) {
            await this._playEntry(r, { startMs: r.positionMs, resumed: true });
            return;
          }
        }
        continue;
      }
      const ok = await this._startEntry(f, nx, my);
      if (my !== this.token) return;
      if (ok) return;
    }
  }

  // Returns true if the entry is now running (playback/pause), false to move on.
  async _startEntry(f, nx, my) {
    const e = nx.entry || {};
    if (e.enabled === 0 || e.enabled === false) return false;
    const cur = { entry: e, frameName: f.name, section: nx.section, index: nx.index, frameKind: f.kind };
    switch (e.type) {
      case 'both': case 'sequence': case 'media':
        try {
          await this._playEntry(cur, {});
          return true;
        } catch (err) {
          this.emit('log', `skip ${e.sequenceName || e.mediaName}: ${err.message}`);
          return false;
        }
      case 'pause': {
        this.current = cur;
        await this.player.stop();
        const ms = Math.max(0, (Number(e.duration) || 0) * 1000);
        this.pauseTimer = setTimeout(() => { if (my === this.token) this._advance('pause'); }, ms);
        this._playlistEvent('playing');
        return true;
      }
      case 'command':
        try { await this.runCommand(e.command, e.args || []); } catch (err) { this.emit('log', `command ${e.command}: ${err.message}`); }
        return false;
      case 'script': {
        const file = paths.fileIn('scripts', e.scriptName);
        if (file) {
          const args = String(e.scriptArgs || '').split(' ').filter(Boolean);
          const p = spawn('/bin/bash', [file, ...args], { cwd: paths.dir('scripts'), stdio: 'ignore', detached: !e.blocking });
          if (e.blocking) await new Promise((r) => p.on('exit', r)); else p.unref();
        }
        return false;
      }
      case 'playlist': {
        const sub = playlists.load(e.name || e.playlistName);
        if (sub) this.frames.push(this._insertFrame(sub, 'nested', 0, 0));
        return false;
      }
      default:
        this.emit('log', `playlist entry type "${e.type}" is not supported by ShowPilot Player; skipped`);
        return false;
    }
  }

  async _playEntry(cur, { startMs = 0, resumed = false }) {
    const e = cur.entry;
    const seq = e.type === 'media' ? null : (e.sequenceName || null);
    const media = e.type === 'sequence' ? null : (e.mediaName || null);
    this.current = { ...cur };
    delete this.current.positionMs;
    await this.player.play({ sequence: seq, media, startMs, resumed, meta: { playlist: cur.frameName, section: cur.section, index: cur.index } });
    this.current.playerItem = this.player.item ? this.player.item.id : null;
    this._playlistEvent('playing');
    this.emit('item', { ...this.current, resumed });
  }

  // ---------------------------------------------------------------- status
  _globalIndex(f, cur) {
    if (!f || !cur) return 0;
    if (f.kind !== 'base') return (f.offset || 0) + cur.index + 1;
    const li = f.pl.leadIn.length, mi = f.pl.mainPlaylist.length;
    if (cur.section === 'leadIn') return cur.index + 1;
    if (cur.section === 'mainPlaylist') return li + cur.index + 1;
    return li + mi + cur.index + 1;
  }

  // FPP Playlist::GetInfo()-like object (used by plugin callbacks + API).
  info() {
    const f = this.frames[this.frames.length - 1];
    const cur = this.current;
    const pl = f ? f.pl : null;
    const size = pl ? pl.leadIn.length + pl.mainPlaylist.length + pl.leadOut.length : 0;
    return {
      currentState: cur ? (this.pausedSnapshot ? 'paused' : 'playing') : 'idle',
      name: f ? f.name : '',
      desc: pl ? (pl.desc || '') : '',
      repeat: f && f.kind === 'base' ? (f.repeat ? 1 : 0) : 0,
      loop: 0,
      loopCount: pl ? Number(pl.loopCount) || 0 : 0,
      random: pl ? Number(pl.random) || 0 : 0,
      blankAtEnd: 1,
      size,
      index: this._globalIndex(f, cur),
      breadcrumbs: this.frames.slice(0, -1).map((x) => x.name),
      currentEntry: cur ? { ...cur.entry } : {},
    };
  }

  // The scheduled item after the current one (for ShowPilot "next").
  peekNext() {
    const f = this.frames[0];
    if (!f || f.kind !== 'base' || !this.current) return null;
    const list = f.pl.mainPlaylist;
    if (!list.length) return null;
    const i = this.current.frameName === f.name && this.current.section === 'mainPlaylist' ? this.current.index : f.index;
    const nextIdx = f.order[(i + 1) % f.order.length];
    return list[nextIdx] || null;
  }

  _playlistEvent(action, name) {
    const info = this.info();
    if (name && !info.name) info.name = name;
    const sec = this.current ? this.current.section : 'New';
    this.emit('playlist', { ...info, Action: action,
      Section: sec === 'mainPlaylist' ? 'MainPlaylist' : sec === 'leadIn' ? 'LeadIn' : sec === 'leadOut' ? 'LeadOut' : sec,
      Item: this.current ? this.current.index : 0 });
  }
}

module.exports = { Show, PLAYABLE, entryName: playlists.entryName };
