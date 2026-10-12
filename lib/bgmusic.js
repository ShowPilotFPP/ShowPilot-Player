// Background music (pre-show music), the features of the FPP Background
// Music plugin built in: a playlist of audio files (or an internet radio
// stream) plays over sequence-only playlists, e.g. a pre-show animation on
// repeat.
//
// - Its own mpv process, started on Start and ended on Stop. The sound card
//   is used directly (ALSA hw, exclusive), so the music and show audio take
//   turns: when an item with audio is about to play, `player.beforeAudio`
//   fades the music out and ends the process first; once no show audio has
//   played for RESUME_AFTER_MS the music comes back where it left off.
// - Start Main Show: music and lights fade out together over fadeSec, the
//   pre-show playlist stops, blackout for blackoutSec, then the show playlist
//   starts. When it ends, after postShowDelaySec, the pre-show lights
//   playlist (if set) and the music start again (returnToPreShow).
// - Off in Remote mode (the master runs pre-show and show).
//
// States: off | playing | yielded (show audio has the card) | transition
// (Start Main Show fading/blackout) | show (main show running, will return).

const path = require('path');
const EventEmitter = require('events');
const playlists = require('./playlists');

const RESUME_AFTER_MS = 3000;
const YIELD_FADE_MS = 1000;
const RETRY_STREAM_MS = 5000;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;

const DEFAULTS = {
  source: 'playlist',       // 'playlist' | 'stream'
  playlist: '',
  streamUrl: '',
  shuffle: true,
  volume: 70,               // 0..100 (mpv volume)
  fadeSec: 5,
  showPlaylist: '',
  preShowPlaylist: '',      // optional: lights playlist to restart with the music after the show
  blackoutSec: 2,
  returnToPreShow: true,
  postShowDelaySec: 5,
  fadeIntoScheduledShows: true, // a scheduled show starting while music plays: fade + blackout, music off after
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shuffled(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}

class BackgroundMusic extends EventEmitter {
  constructor({ config, player, show, commands, resolveMedia, Mpv = require('./engine/mpv'), now = () => Date.now() }) {
    super();
    this.config = config;
    this.player = player;
    this.show = show;
    this.commands = commands;
    this.resolveMedia = resolveMedia;
    this.Mpv = Mpv;
    this.now = now;
    this.state = 'off';
    this.mpv = null;
    this.queue = [];          // file paths, in play order
    this.index = -1;
    this.title = '';
    this.pos = 0; this.dur = 0;
    this.resumeAt = null;     // { index, pos } when yielded
    this.lastError = null;
    this.quietSince = null;
    this.gen = 0;             // bumps on every stop: stale async steps bail out
  }

  get cfg() { return { ...DEFAULTS, ...(this.config.get().backgroundMusic || {}) }; }
  isRemote() { return this.config.get().mode === 'remote'; }
  log(m) { this.emit('log', m); }

  start() {
    this.player.beforeAudio = () => this._yield();
    if (this.commands) this._registerCommands();
    if (this.show) this.show.on('playlist', (e) => this._onPlaylist(e));
    this.config.on('change', () => this._onConfig());
    this.timer = setInterval(() => this._tick(), 1000);
    if (this.timer.unref) this.timer.unref();
  }

  close() { clearInterval(this.timer); return this._kill(); }

  // ------------------------------------------------------------ public
  async play() {
    if (this.isRemote()) { const e = new Error('Background music is off in Remote mode: the MultiSync master plays it.'); e.status = 409; throw e; }
    if (this.state === 'playing') return this.status();
    if (this.state === 'transition') throw new Error('the main show is starting');
    this.lastError = null;
    const c = this.cfg;
    if (c.source === 'stream') {
      if (!/^https?:\/\//i.test(c.streamUrl || '')) throw new Error('Set a stream URL (http:// or https://) first.');
      this.queue = [c.streamUrl];
    } else {
      this.queue = this._tracks();
      if (!this.queue.length) throw new Error(c.playlist ? `"${c.playlist}" has no audio files on this player.` : 'Pick a music playlist first.');
      if (c.shuffle) this.queue = shuffled(this.queue);
    }
    this.index = -1;
    this.resumeAt = null;
    this.state = 'playing';
    // Show audio playing right now has the card: wait for it to finish.
    if (this._showAudio()) { this.state = 'yielded'; this.quietSince = null; this.log('background music waits for the show audio to finish'); return this.status(); }
    await this._open(c.volume);
    await this._next();
    this.log(`background music started (${c.source === 'stream' ? 'stream' : `${this.queue.length} tracks${c.shuffle ? ', shuffled' : ''}`})`);
    this.emit('change');
    return this.status();
  }

  async stopMusic({ fade = true } = {}) {
    const was = this.state;
    this.state = 'off';
    this.gen++;
    clearTimeout(this.returnTimer);
    if (this.mpv && fade) await this._fade(0, this.cfg.fadeSec * 1000);
    await this._kill();
    this.resumeAt = null;
    this.title = ''; this.pos = 0; this.dur = 0;
    if (was !== 'off') { this.log('background music stopped'); this.emit('change'); }
    return this.status();
  }

  async next() {
    if (this.state !== 'playing' || !this.mpv) throw new Error('background music is not playing');
    if (this.cfg.source === 'stream') return this.status();
    await this._next();
    return this.status();
  }

  // FPP plugin's "Start Main Show": fade music + lights, stop the pre-show,
  // blackout, start the show playlist; come back to pre-show after it.
  async startMainShow(name) {
    if (this.isRemote()) { const e = new Error('Start Main Show runs on the MultiSync master, not on a remote.'); e.status = 409; throw e; }
    const c = this.cfg;
    const showName = String(name || c.showPlaylist || '');
    if (!showName) throw new Error('Pick the main show playlist on the Background music page first.');
    if (!playlists.load(showName)) throw new Error(`playlist not found: ${showName}`);
    if (this.state === 'transition') throw new Error('the main show is already starting');
    const my = ++this.gen;
    clearTimeout(this.returnTimer);
    this.state = 'transition';
    this.emit('change');
    this.log(`starting main show "${showName}": ${c.fadeSec}s fade, ${c.blackoutSec}s blackout`);
    await this._fadeToBlack(c, my);
    if (my !== this.gen) return this.status();
    this.state = 'show';
    this.showName = showName;
    this.emit('change');
    try {
      await this.show.start(showName, { repeat: false });
    } catch (e) {
      this.state = 'off';
      this.lastError = e.message;
      this.emit('change');
      throw e;
    }
    return this.status();
  }

  // Music and lights fade out together, the pre-show stops, blackout; lights
  // back to full (the next show starts on black frames anyway).
  async _fadeToBlack(c, my) {
    const fadeMs = Math.max(0, c.fadeSec * 1000);
    await Promise.all([this.mpv ? this._fade(0, fadeMs) : null, this._dimLights(0, fadeMs)]);
    await this._kill();
    this.resumeAt = null;
    if (my !== this.gen) { this.player.setBrightness(1); return; }
    try { await this.show.stopNow(); } catch {}
    try { this.player.worker && this.player.worker.postMessage({ type: 'blank' }); } catch {}
    await sleep(Math.max(0, c.blackoutSec * 1000));
    this.player.setBrightness(1);
  }

  // scheduler.beforeShow: a scheduled show (not a command) is about to start.
  // With music on, fade into it like Start Main Show; the music then stays
  // off for the night (no return to pre-show after a scheduled show).
  async beforeScheduledShow(entry) {
    const c = this.cfg;
    if (!c.fadeIntoScheduledShows || this.isRemote() || !['playing', 'yielded'].includes(this.state)) return false;
    const my = ++this.gen;
    clearTimeout(this.returnTimer);
    this.state = 'transition';
    this.emit('change');
    this.log(`scheduled show "${(entry && (entry.playlist || entry.sequence)) || ''}": fading music and lights out (${c.fadeSec}s, ${c.blackoutSec}s blackout)`);
    await this._fadeToBlack(c, my);
    if (my === this.gen) { this.state = 'off'; this.title = ''; this.pos = 0; this.dur = 0; this.emit('change'); this.log('background music stopped for the scheduled show'); }
    return true;
  }

  status() {
    const c = this.cfg;
    return {
      state: this.state, source: c.source, title: this.title,
      track: this.index >= 0 && this.queue.length && c.source !== 'stream' ? this.index + 1 : null,
      tracks: c.source !== 'stream' ? this.queue.length : null,
      positionSec: Math.round(this.pos || 0), durationSec: Math.round(this.dur || 0),
      volume: c.volume, showPlaylist: this.showName || c.showPlaylist || '', lastError: this.lastError,
      remoteMode: this.isRemote(),
    };
  }

  // ------------------------------------------------------------ internals
  _tracks() {
    const pl = playlists.load(this.cfg.playlist);
    if (!pl) return [];
    const out = [];
    for (const sec of ['leadIn', 'mainPlaylist', 'leadOut']) {
      for (const e of pl[sec] || []) {
        if (e.enabled === 0 || e.enabled === false) continue;
        const n = e.mediaName || (e.type === 'media' ? e.name : null);
        if (!n || !AUDIO_EXT.test(n)) continue;
        const f = this.resolveMedia(path.basename(String(n).split(/[\\/]/).pop()));
        if (f) out.push(f);
      }
    }
    return out;
  }

  _showAudio() {
    const p = this.player;
    return p.state !== 'idle' && !!(p.item && p.item.mediaFile);
  }

  async _open(volume) {
    await this._kill();
    const args = ['--no-video', '--audio-display=no', '--gapless-audio=no', '--keep-open=no', '--replaygain=no',
      '--volume=' + Math.max(0, Math.min(100, Number(volume) || 0)), '--cache=yes', '--demuxer-max-bytes=4MiB'];
    if (process.env.SPP_AUDIO_NULL === '1') args.push('--ao=null');
    else args.push('--ao=alsa', '--audio-device=' + ((this.player.audioOut && this.player.audioOut.id) || 'alsa'));
    const m = new this.Mpv('bgm', args);
    m.on('log', (s) => this.log('mpv(music): ' + s));
    m.observe('media-title'); m.observe('time-pos'); m.observe('duration');
    m.on('prop:media-title', (v) => {
      if (typeof v !== 'string') return;
      v = v.replace(AUDIO_EXT, ''); // untagged files: mpv's title is the file name
      if (v && v !== this.title) { this.title = v; this.emit('change'); }
    });
    m.on('prop:time-pos', (v) => { if (typeof v === 'number') this.pos = v; });
    m.on('prop:duration', (v) => { if (typeof v === 'number') this.dur = v; });
    m.on('end-file', (e) => this._onEnd(m, e));
    // mpv crashed and its supervisor restarted it: carry on with the next track.
    m.on('exit', () => { if (this.mpv === m) this._crashed = true; });
    m.on('ready', () => {
      if (!this._crashed || this.mpv !== m || this.state !== 'playing') return;
      this._crashed = false;
      m.set('volume', this.vol).catch(() => {});
      if (this.cfg.source === 'stream') this._load(this.queue[0]).catch(() => {}); else this._next().catch(() => {});
    });
    m.start();
    this.mpv = m;
    this.vol = Number(volume) || 0;
    await m.whenReady();
  }

  async _kill() {
    const m = this.mpv;
    this.mpv = null;
    if (m) await m.stop();
  }

  async _load(file, startSec = 0) {
    if (!this.mpv) return;
    this.pos = startSec; this.dur = 0;
    this.title = /^https?:/i.test(file) ? '' : path.basename(file).replace(/\.[^.]+$/, '');
    this._loading = true;
    try {
      const loaded = startSec > 1 ? this.mpv.waitEvent('file-loaded', 8000).catch(() => null) : null;
      await this.mpv.command('loadfile', file, 'replace');
      if (loaded && (await loaded)) { try { await this.mpv.command('seek', startSec, 'absolute'); } catch {} }
    } finally { this._loading = false; }
    this.emit('change');
  }

  async _next() {
    const c = this.cfg;
    if (!this.queue.length) return;
    this.index++;
    if (this.index >= this.queue.length) {
      this.index = 0;
      if (c.source !== 'stream') {
        // Pick up playlist edits; reshuffle each time round, like the plugin.
        const fresh = this._tracks();
        if (fresh.length) this.queue = c.shuffle ? shuffled(fresh) : fresh;
      }
    }
    await this._load(this.queue[this.index]);
  }

  _onEnd(m, e) {
    if (m !== this.mpv || this.state !== 'playing' || e.reason === 'stop' || e.reason === 'redirect') return;
    const my = this.gen;
    if (this.cfg.source === 'stream') {
      this.lastError = e.reason === 'error' ? `stream stopped (${e.file_error || 'error'}), retrying` : null;
      this.log(`background stream ended (${e.reason}), retrying in ${RETRY_STREAM_MS / 1000}s`);
      setTimeout(() => { if (my === this.gen && this.state === 'playing' && this.mpv === m) this._load(this.queue[0]).catch(() => {}); }, RETRY_STREAM_MS);
      return;
    }
    if (e.reason === 'error') this.log(`background music: could not play ${path.basename(this.queue[this.index] || '')}: ${e.file_error || 'error'}`);
    this._next().catch((err) => this.log('background music: ' + err.message));
  }

  async _fade(to, ms) {
    const m = this.mpv;
    if (!m) return;
    const from = this.vol;
    const steps = Math.max(1, Math.round(ms / 100));
    for (let i = 1; i <= steps; i++) {
      if (this.mpv !== m) return;
      const v = from + (to - from) * (i / steps);
      this.vol = v;
      try { await m.set('volume', v); } catch {}
      if (i < steps) await sleep(ms / steps);
    }
  }

  async _dimLights(to, ms) {
    const from = this.player.brightness === undefined ? 1 : this.player.brightness;
    const steps = Math.max(1, Math.round(ms / 50));
    for (let i = 1; i <= steps; i++) {
      this.player.setBrightness(from + (to - from) * (i / steps));
      if (i < steps) await sleep(ms / steps);
    }
  }

  // player.beforeAudio: show audio is about to start.
  async _yield() {
    if (this.state !== 'playing' || !this.mpv) return;
    this.resumeAt = { index: this.index, pos: this.cfg.source === 'stream' ? 0 : this.pos };
    this.state = 'yielded';
    this.quietSince = null;
    await this._fade(0, YIELD_FADE_MS);
    await this._kill();
    this.log('background music paused for show audio');
    this.emit('change');
  }

  async _resume() {
    const r = this.resumeAt || { index: -1, pos: 0 };
    this.state = 'playing';
    try {
      await this._open(0);
      if (!this.queue.length) return;
      if (r.index >= 0 && r.index < this.queue.length) { this.index = r.index; await this._load(this.queue[r.index], r.pos); }
      else await this._next();
      await this._fade(this.cfg.volume, Math.min(3000, this.cfg.fadeSec * 1000));
      this.log('background music resumed');
      this.emit('change');
    } catch (e) { this.lastError = e.message; this.log('background music: ' + e.message); }
  }

  _tick() {
    if (this.isRemote() && this.state !== 'off') { this.stopMusic({ fade: false }).catch(() => {}); return; }
    if (this.state !== 'yielded') return;
    if (this._showAudio()) { this.quietSince = null; return; }
    if (this.quietSince === null) { this.quietSince = this.now(); return; }
    if (this.now() - this.quietSince >= RESUME_AFTER_MS) { this.quietSince = null; this._resume(); }
  }

  _onConfig() {
    if (this.state === 'playing' && this.mpv) {
      const v = this.cfg.volume;
      if (Math.abs(v - this.vol) > 0.5) { this.vol = v; this.mpv.set('volume', v).catch(() => {}); }
    }
  }

  // The main show playlist ended (or was stopped): back to pre-show.
  _onPlaylist(e) {
    if (this.state !== 'show' || e.Action !== 'stop') return;
    const c = this.cfg;
    this.state = 'off';
    this.showName = null;
    this.emit('change');
    if (!c.returnToPreShow) return;
    const my = this.gen;
    this.log(`main show finished; pre-show again in ${c.postShowDelaySec}s`);
    this.returnTimer = setTimeout(async () => {
      if (my !== this.gen || this.state !== 'off' || this.isRemote()) return;
      try {
        if (c.preShowPlaylist && !this.show.isRunning()) await this.show.start(c.preShowPlaylist, { repeat: true });
      } catch (err) { this.log(`pre-show playlist: ${err.message}`); }
      try { await this.play(); } catch (err) { this.lastError = err.message; this.log('background music: ' + err.message); }
    }, Math.max(0, c.postShowDelaySec * 1000));
  }

  _registerCommands() {
    const reg = (n, run, args = [], description = '') => this.commands.register(n, { source: 'bgmusic', category: 'Background music', args, description, run });
    const pl = [{ name: 'playlist', type: 'string', description: 'Show playlist (blank = the one set on the Background music page)', optional: true, contentListUrl: 'api/playlists/playable' }];
    reg('Background Music - Start', async () => { await this.play(); return 'Background music started'; }, [], 'Start the pre-show music');
    reg('Background Music - Stop', async () => { await this.stopMusic(); return 'Background music stopped'; }, [], 'Fade out and stop the pre-show music');
    reg('Background Music - Next Track', async () => { await this.next(); return 'Next track'; });
    reg('Background Music - Start Main Show', async (a) => { await this.startMainShow(a[0]); return 'Main show started'; }, pl,
      'Fade music and lights, blackout, then start the show playlist');
    // The FPP plugin's command names, so schedules and buttons brought over
    // from FPP keep working.
    reg('BackgroundMusic - Start Background Music', async () => { await this.play(); return 'Background music started'; });
    reg('BackgroundMusic - Stop Background Music', async () => { await this.stopMusic(); return 'Background music stopped'; });
    reg('BackgroundMusic - Start Main Show', async () => { await this.startMainShow(); return 'Main show started'; });
    reg('BackgroundMusic - Start Show', async (a) => { await this.startMainShow(a[0]); return 'Main show started'; }, pl);
  }
}

module.exports = { BackgroundMusic, DEFAULTS, shuffled };
