// Playback engine. One master clock per item:
//   - 'audio'    : the audio mpv's measured position (normal case)
//   - 'internal' : wall clock, for sequences with no media
//   - 'external' : a MultiSync master's position (remote mode)
// Everything else follows that clock: the light frames (frame worker), the
// display mpv (video or virtual matrix), MultiSync packets we send, and the
// ShowPilot phone stream. Lessons from FPP baked in here:
//   * every mid-file seek is exact (hr-seek), and the position we report is
//     measured from mpv after the seek, not the position we asked for;
//   * "resume at X" is its own event, never confused with "start at 0";
//   * the audio output stays open across songs and interrupts.

const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { execFileSync } = require('child_process');
const EventEmitter = require('events');
const Mpv = require('./mpv');
const { hideConsole } = require('../console-screen');
const paths = require('../paths');
const { probe } = require('../fseq');
const audioDevices = require('../audio-devices');

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.avi', '.mpg', '.mpeg', '.webm', '.m4v']);
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.m4a', '.wav', '.flac', '.aac', '.wma', '.au', '.m4p', '.opus']);
const nowAbs = () => performance.timeOrigin + performance.now();
const isVideo = (name) => VIDEO_EXT.has(path.extname(name || '').toLowerCase());

// Resolve a media name the way FPP does: videos/ for video extensions,
// music/ otherwise, falling back to the other folder.
function resolveMedia(name) {
  if (!name) return null;
  const order = isVideo(name) ? ['videos', 'music'] : ['music', 'videos'];
  for (const d of order) {
    const f = paths.fileIn(d, name);
    if (f && fs.existsSync(f)) return f;
  }
  return null;
}

function findMatchingVideo(...names) {
  for (const n of names) {
    if (!n) continue;
    const base = path.basename(n, path.extname(n));
    for (const ext of VIDEO_EXT) {
      const f = paths.fileIn('videos', base + ext);
      if (f && fs.existsSync(f)) return f;
    }
  }
  return null;
}

function displayAvailable() {
  if (process.env.SPP_DISPLAY === '0') return false;
  if (process.env.SPP_DISPLAY === '1') return true;
  try { return fs.readdirSync('/dev/dri').some((n) => n.startsWith('card')); } catch { return !!process.env.DISPLAY; }
}

class Player extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.state = 'idle';          // idle | starting | playing | paused
    this.item = null;             // { id, sequence, media, ... }
    this.clockSource = 'internal';
    this.anchor = null;           // { mediaMs, at, rate }
    this.itemId = 0;
    this.seqEnded = false;
    this.mediaEnded = false;
    this.workerStats = {};
    this.displayMode = 'idle';    // idle | video | matrix
    this.matrixFifo = path.join(require('os').tmpdir(), 'spp-matrix.fifo');
    this.followTimeoutMs = 15000; // remote: stop if the master stops sending sync
    this._chain = Promise.resolve();
  }

  // Transitions (play, pause, stop, end-of-item) run one at a time: the show
  // runner, MultiSync and HTTP commands can all trigger them, and they share
  // one audio mpv.
  _serial(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => {});
    return run;
  }

  // ---------------------------------------------------------------- startup
  async start() {
    this.worker = new Worker(path.join(__dirname, 'frame-worker.js'));
    this.worker.on('message', (m) => this._onWorker(m));
    this.worker.on('error', (e) => console.error('[player] frame worker error:', e));
    this.worker.on('exit', (c) => { if (!this.closing) console.error('[player] frame worker exited', c); });

    const cfg = this.config.get();
    const audioArgs = ['--no-video', '--audio-display=no', '--hr-seek=yes', '--gapless-audio=no',
      '--keep-open=no', '--volume=100', '--replaygain=no'];
    // ALSA directly: a root service on Pi OS Lite has no PipeWire/Pulse session.
    if (process.env.SPP_AUDIO_NULL === '1') audioArgs.push('--ao=null');
    else {
      this.audioOut = audioDevices.resolve(cfg.audioDevice);
      audioArgs.push('--ao=alsa', '--audio-device=' + this.audioOut.id);
    }
    this.audio = new Mpv('audio', audioArgs);
    this.audio.on('log', (s) => this.emit('log', 'mpv(audio): ' + s));
    this.audio.observe('time-pos');
    this.audio.on('prop:time-pos', (v) => this._onAudioPos(v));
    this.audio.on('end-file', (m) => this._onAudioEnd(m));
    this.audio.start();
    this.problems = [];
    // Never crash-loop on a missing/broken mpv: keep the web UI up and say what's wrong.
    try { await this.audio.whenReady(); }
    catch (e) { this.problems.push('Audio player (mpv) is not running. Install it under Settings → Updates → System software, then restart the player.'); this.emit('log', 'mpv(audio) not ready: ' + e.message); }

    this._buildDisplayArgs();
    if (this._dispArgs && (cfg.video.enabled || cfg.matrix.enabled)) {
      await hideConsole((m) => this.emit('log', m));
      await this._openDisplay();
    }
    this._ensureFifo();
    this.applyConfig();
    this._idleScreen();
    // Every minute: refresh the idle screen, and take the screen if it wasn't
    // there or mpv couldn't open it at boot (HDMI/DRM came up after us).
    this._idleTimer = setInterval(() => { this._ensureDisplay(); this._idleScreen(); }, 60000);
    this.config.on('change', () => this.applyConfig());
    this._slaveTimer = setInterval(() => this._slaveLoop(), 250);
  }

  _buildDisplayArgs() {
    this.hasDisplay = displayAvailable();
    if (this.hasDisplay && !this._dispArgs) {
      const dispArgs = ['--audio=no', '--hr-seek=yes', '--keep-open=no', '--force-window=yes',
        '--fullscreen', '--osc=no', '--osd-level=0', '--no-input-default-bindings', '--cursor-autohide=always',
        '--hwdec=auto-safe', '--video-sync=audio', // default background is already black
        // Simple scaling keeps each GPU job short. Long GPU jobs time out on a
        // Pi 4, and the v3d driver's timeout recovery can wedge the display
        // until a reboot (seen Oct 2026; kernel bug CVE-2026-74638).
        '--profile=fast'];
      // A console Pi has no desktop: render straight to the screen with DRM.
      if (process.env.SPP_DISPLAY_VO) dispArgs.push('--vo=' + process.env.SPP_DISPLAY_VO);
      else if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) dispArgs.push('--vo=gpu', '--gpu-context=drm');
      this._dispArgs = dispArgs;
    }
  }

  _ensureDisplay() {
    const c = this.config.get();
    if (this.display || this._displaySuspended || this._opening || !(c.video.enabled || c.matrix.enabled)) return;
    this._buildDisplayArgs();
    if (!this._dispArgs) return;
    this.emit('log', 'display: taking the HDMI screen');
    this._displayFailed = false;
    this.applyConfig();
  }

  _ensureFifo() {
    try {
      const s = fs.statSync(this.matrixFifo);
      if (!s.isFIFO()) fs.unlinkSync(this.matrixFifo); else return;
    } catch {}
    try { execFileSync('mkfifo', ['-m', '600', this.matrixFifo]); } catch (e) { console.error('[player] mkfifo failed:', e.message); }
  }

  applyConfig() {
    const c = this.config.get();
    // Video or matrix switched on after start: take the screen now, no restart.
    if (this._dispArgs && !this.display && !this._displaySuspended && !this._opening && !this._displayFailed && (c.video.enabled || c.matrix.enabled)) {
      this._opening = hideConsole((m) => this.emit('log', m)).then(() => this._openDisplay()).then(() => {
        this._opening = null;
        if (!this.display) { this._displayFailed = true; this.emit('log', 'display: mpv did not start for HDMI'); }
        this.applyConfig();
        this._redisplay();
      });
      return;
    }
    // Audio output changes apply right away (next sound plays on the new card).
    if (this.audio && process.env.SPP_AUDIO_NULL !== '1') {
      const out = audioDevices.resolve(c.audioDevice);
      if (!this.audioOut || out.id !== this.audioOut.id) {
        this.audioOut = out;
        this.audio.set('audio-device', out.id).catch(() => {});
        this.emit('log', `audio output: ${out.name} (${out.id})`);
      }
    }
    this.worker.postMessage({
      type: 'config', outputs: c.outputs, syncOffsetMs: c.syncOffsetMs,
      blankBetweenSequences: c.blankBetweenSequences, outputPacingMbps: c.outputPacingMbps,
      matrix: this.display ? c.matrix : null, matrixFifo: this.matrixFifo,
    });
    // Matrix size/layout changed while it is showing: reload it with the new shape.
    if (this.displayMode === 'matrix' && this._matrixKey !== this._matrixKeyFor(c)) {
      this.displayMode = 'idle';
      this._matrixKey = null;
      if (this.item && this.state === 'playing') this._startDisplay().catch((e) => this.emit('log', 'display: ' + e.message));
      else if (this.netActive && this._netMatrix(c)) this._openMatrix(c).catch((e) => this.emit('log', 'display: ' + e.message));
    }
    this._idleScreen();
  }

  _matrixKeyFor(c) {
    const m = c.matrix;
    return m.enabled ? [m.width, m.height, m.source === 'network' ? 'net' : (this.item ? this.item.stepMs : 0)].join('x') : null;
  }

  async close() {
    this.closing = true;
    clearInterval(this._slaveTimer);
    clearInterval(this._idleTimer);
    try { await this.stop(); } catch {}
    this.audio && this.audio.stop();
    this.display && this.display.stop();
    if (this.worker) await this.worker.terminate();
  }

  // ---------------------------------------------------------------- clock
  mediaMs() {
    const a = this.anchor;
    if (!a) return 0;
    return a.mediaMs + (nowAbs() - a.at) * a.rate;
  }

  // Position the lights are showing (includes the sync offset) in frames.
  status() {
    const it = this.item;
    return {
      state: this.state,
      testPattern: this.testing ? this.testPatternName : null,
      clock: this.clockSource,
      sequence: it ? it.sequence : null,
      media: it ? it.media : null,
      video: it ? (it.videoFile ? path.basename(it.videoFile) : null) : null,
      positionMs: it ? Math.round(this.mediaMs()) : 0,
      durationMs: it ? it.durationMs : 0,
      stepMs: it ? it.stepMs : 0,
      display: this.display ? this.displayMode : 'none',
      audioOut: this.audioOut ? this.audioOut.name : (process.env.SPP_AUDIO_NULL === '1' ? 'none (test mode)' : 'default'),
      worker: this.workerStats,
    };
  }

  // Hard-set the clock (start, resume, seek, remote catch-up).
  _setAnchor(mediaMs, rate = 1) {
    this.anchor = { mediaMs, at: nowAbs(), rate };
    this._bigErr = 0;
    this._postClock();
  }

  _postClock() {
    const a = this.anchor;
    this.worker.postMessage({ type: 'clock', mediaMs: a.mediaMs, at: a.at, rate: a.rate, running: this.state === 'playing' });
  }

  // Discipline the running clock with a measured position (a phase-locked
  // loop). The clock free-runs on the monotonic system clock; each report may
  // slew it by at most SLEW_MS, which easily tracks sound-card drift (parts
  // per million) while ignoring report jitter. A large error must persist for
  // two consecutive reports before we jump, so one stale or noisy report
  // can't yank the lights.
  _discipline(measuredMs) {
    const SLEW_MS = 1, JUMP_MS = 100;
    const a = this.anchor;
    if (!a) return this._setAnchor(measuredMs);
    const at = nowAbs();
    const predicted = a.mediaMs + (at - a.at) * a.rate;
    const err = measuredMs - predicted;
    if (Math.abs(err) >= JUMP_MS) {
      if (++this._bigErr < 2) return;
      if (process.env.SPP_DEBUG_CLOCK) console.log('[clock] jump', err.toFixed(1));
      return this._setAnchor(measuredMs, a.rate);
    }
    this._bigErr = 0;
    const corr = Math.max(-SLEW_MS, Math.min(SLEW_MS, err * 0.1));
    this.anchor = { mediaMs: predicted + corr, at, rate: a.rate };
    this._lastErr = err;
    if (Math.abs(corr) >= 0.05) this._postClock();
  }

  _onAudioPos(v) {
    if (this.clockSource !== 'audio' || this.state !== 'playing' || typeof v !== 'number') return;
    // Reports queued before the exact seek finished describe the old position.
    if (this._audioGate && v * 1000 < this._audioGate) return;
    this._audioGate = 0;
    this._discipline(v * 1000);
  }

  // ---------------------------------------------------------------- play
  // opts: { sequence, media, startMs, resumed, clock: 'auto'|'external', playlist info passthrough }
  play(opts) { return this._serial(() => this._play(opts)); }

  // xLights uploads a sparse sequence holding only the channels of the
  // controllers it knew this player sends to at upload time. Outputs added
  // later get nothing from such a file: say so instead of sending black.
  async _play(opts) {
    this.emit('activity');
    await this._halt(false);
    const id = ++this.itemId;
    const seqName = opts.sequence ? paths.safeName(opts.sequence) : null;
    const seqFile = seqName ? paths.fileIn('sequences', seqName) : null;
    if (seqName && !fs.existsSync(seqFile)) throw new Error(`sequence not found: ${seqName}`);

    let info = null;
    if (seqFile) info = probe(seqFile);
    let mediaName = opts.media || null;
    if (mediaName === undefined || mediaName === null) mediaName = null;
    // xLights stores the full path from the PC it ran on (often C:\\...): keep the file name.
    const mediaFile = mediaName ? resolveMedia(paths.safeName(String(mediaName).split(/[\\/]/).pop())) : null;
    if (mediaName && !mediaFile) this.emit('log', `media not found: ${mediaName} (playing lights only)`);

    const cfg = this.config.get();
    let videoFile = null;
    if (mediaFile && isVideo(mediaFile)) videoFile = mediaFile;
    else if (this.display && cfg.matrix.enabled && cfg.matrix.preferVideo) videoFile = findMatchingVideo(seqName, mediaName);
    if (videoFile && !cfg.video.enabled && !(cfg.matrix.enabled && cfg.matrix.preferVideo)) videoFile = null;

    const startMs = Math.max(0, Number(opts.startMs) || 0);
    this.item = {
      id, sequence: seqName, media: mediaFile ? path.basename(mediaFile) : null,
      mediaFile, videoFile, startMs, resumed: !!opts.resumed,
      stepMs: info ? info.stepMs : 0,
      durationMs: info ? info.durationMs : 0,
      meta: opts.meta || {},
    };
    this.seqEnded = !seqFile;
    this.mediaEnded = !mediaFile;
    this.state = 'starting';
    this.clockSource = opts.clock === 'external' ? 'external' : (mediaFile ? 'audio' : 'internal');

    if (seqFile) await this._workerLoad(id, seqFile, seqName);
    if (id !== this.itemId) return false;
    this.emit('open', this._evt());

    // Background music lets go of the sound card before show audio needs it.
    if (mediaFile && this.beforeAudio) {
      try { await this.beforeAudio(); } catch (e) { this.emit('log', 'background music: ' + e.message); }
      if (id !== this.itemId) return false;
    }

    let measured = startMs;
    if (mediaFile && this.clockSource === 'audio') {
      measured = await this._startAudio(mediaFile, startMs);
      if (id !== this.itemId) return false;
      if (!this.item.durationMs) {
        try { this.item.durationMs = Math.round((await this.audio.get('duration')) * 1000); } catch {}
      }
    } else if (mediaFile) {
      // External clock: media is a follower, started at the master's position.
      this._startFollower(this.audio, mediaFile, startMs).catch((e) => this.emit('log', 'audio follower: ' + e.message));
    }

    this.state = 'playing';
    this._setAnchor(measured, 1);
    this._startDisplay(startMs).catch((e) => this.emit('log', 'display: ' + e.message));
    const evt = this._evt();
    evt.positionMs = Math.round(measured);
    // Distinct events: listeners must never treat a resume as position 0.
    this.emit(this.item.resumed ? 'resume' : 'start', evt);
    return true;
  }

  _evt() {
    const it = this.item;
    return { id: it.id, sequence: it.sequence, media: it.media, durationMs: it.durationMs,
      stepMs: it.stepMs, startMs: it.startMs, resumed: it.resumed, meta: it.meta,
      video: it.videoFile ? path.basename(it.videoFile) : null };
  }

  _workerLoad(id, file, name) {
    return new Promise((resolve, reject) => {
      const onMsg = (m) => {
        if (m.id !== id) return;
        if (m.type === 'loaded') { this.worker.off('message', onMsg); resolve(m); }
        if (m.type === 'error') { this.worker.off('message', onMsg); reject(new Error(m.error)); }
      };
      this.worker.on('message', onMsg);
      this.worker.postMessage({ type: 'load', id, file, name, startMs: this.item ? this.item.startMs : 0 });
    });
  }

  // Load paused, seek exactly, then unpause; return the measured position.
  async _startAudio(file, startMs) {
    const a = this.audio;
    await a.whenReady();
    await a.set('pause', true);
    const loaded = a.waitEvent('file-loaded', 8000);
    await a.command('loadfile', file, 'replace');
    await loaded;
    if (startMs > 0) {
      const restarted = a.waitEvent('playback-restart', 8000);
      await a.command('seek', startMs / 1000, 'absolute+exact');
      await restarted;
    }
    let pos = startMs / 1000;
    try { const p = await a.get('time-pos'); if (typeof p === 'number') pos = p; } catch {}
    this._audioGate = Math.max(0, pos * 1000 - 250);
    await a.set('pause', false);
    return pos * 1000;
  }

  async _startFollower(m, file, startMs) {
    await m.whenReady();
    const loaded = m.waitEvent('file-loaded', 8000);
    await m.command('loadfile', file, 'replace');
    await loaded;
    const target = this.mediaMs();
    if (target > 50 || startMs > 0) await m.command('seek', Math.max(0, target) / 1000, 'absolute+exact');
    await m.set('speed', 1);
  }

  async _startDisplay() {
    if (!this.display) return;
    const cfg = this.config.get();
    const it = this.item;
    if (it.videoFile) {
      // One load at a time: a display that has stopped answering must not
      // pile up a load per sync packet (seen: 25 "timeout waiting for
      // file-loaded" in 6 s and a listener-leak warning).
      if (this._displayLoading) return;
      this._matrix(false);
      this.displayMode = 'video';
      this._displayLoading = true;
      try { await this._startFollower(this.display, it.videoFile, this.mediaMs()); }
      catch (e) { this._displayFailed(e); throw e; }
      finally { this._displayLoading = false; }
    } else if (cfg.matrix.enabled && (this._netMatrix(cfg) ? this.netActive : it.sequence)) {
      await this._openMatrix(cfg);
    } else {
      await this._displayIdle();
    }
  }

  // Put back whatever the screen should show now (after the display mpv was
  // (re)opened or its stream ended): the playing item, or the DDP matrix.
  _redisplay() {
    if (this.item && this.state === 'playing') return this._startDisplay().catch((e) => this.emit('log', 'display: ' + e.message));
    if (this.netActive && this._netMatrix()) return this._openMatrix().catch((e) => this.emit('log', 'display: ' + e.message));
  }

  _netMatrix(cfg = this.config.get()) { return !!(cfg.matrix.enabled && cfg.matrix.source === 'network'); }

  // Show the matrix stream (FIFO of rendered frames) on the display.
  async _openMatrix(cfg = this.config.get()) {
    const it = this.item;
    {
      if (this.displayMode !== 'matrix' || this._matrixKey !== this._matrixKeyFor(cfg)) {
        this.displayMode = 'matrix';
        this._matrixKey = this._matrixKeyFor(cfg);
        const m = cfg.matrix;
        const fps = it && it.stepMs && !this._netMatrix(cfg) ? Math.round(1000 / it.stepMs) : 40;
        const opts = [
          'demuxer=rawvideo', `demuxer-rawvideo-w=${m.width}`, `demuxer-rawvideo-h=${m.height}`,
          'demuxer-rawvideo-mp-format=rgb24', `demuxer-rawvideo-fps=${fps}`,
          'scale=nearest', 'cache=no', 'untimed=yes', 'video-sync=display-desync',
          'demuxer-readahead-secs=0', 'demuxer-max-bytes=65536',
        ].join(',');
        // Named arguments: mpv 0.38+ (Raspberry Pi OS trixie) reads a 3rd
        // positional loadfile argument as a playlist index, not options.
        try {
          await this.display.command({ name: 'loadfile', url: this.matrixFifo, flags: 'replace', options: opts });
        } catch (e) {
          this.displayMode = 'idle';
          this._matrixKey = null;
          throw new Error('matrix could not start: ' + e.message);
        }
        this._matrix(true);
      }
    }
  }

  // DDP frames started/stopped arriving for a network-fed matrix.
  async _onNet(active) {
    this.netActive = active;
    if (active) this.emit('activity');
    if (!this.display || !this._netMatrix()) return;
    if (active) {
      if (this.displayMode === 'video') return; // a matching video plays: it wins
      await this._openMatrix().catch((e) => this.emit('log', 'display: ' + e.message));
    } else if (!(this.item && this.state === 'playing' && this.displayMode === 'video')) {
      await this._displayIdle();
    }
  }

  _matrix(on) { this.worker.postMessage({ type: 'matrixActive', active: on }); }

  // The display mpv stopped answering (GPU hang): restart it. If it can't
  // even start again, the display driver itself is stuck: say so
  // (displayStuck), screen sleep then reboots the Pi when it is idle.
  _displayFailed(e) {
    if (!/timeout/i.test(e && e.message)) return;
    const now = Date.now();
    this._dispFails = (this._dispFails || []).filter((t) => now - t < 60000);
    this._dispFails.push(now);
    if (this._dispFails.length < 2 || this._restartingDisplay) return;
    this._dispFails = [];
    this._restartingDisplay = true;
    this.emit('log', 'display: the screen program stopped answering; restarting it');
    (async () => {
      const d = this.display;
      this.display = null;
      this._matrix(false);
      this.displayMode = 'idle';
      if (d) await d.stop(2000);
      if (this._displaySuspended) return;
      await this._openDisplay();
      if (!this.display) { this.displayStuck = true; this.emit('log', 'display: the screen program could not start again: the display driver looks stuck (a reboot clears it)'); return; }
      this.applyConfig();
      if (this.item && this.state === 'playing') this._startDisplay().catch(() => {});
      else if (this.netActive && this._netMatrix()) this._openMatrix().catch(() => {});
    })().catch(() => {}).finally(() => { this._restartingDisplay = false; });
  }

  async _openDisplay() {
    const d = new Mpv('display', this._dispArgs);
    d.on('log', (s) => { if (!/libcuda|libnvcuvid|vaapi|vdpau/i.test(s)) this.emit('log', 'mpv(display): ' + s); });
    // The matrix stream ended under us (mpv restarted, read error): forget it
    // so it is opened again instead of leaving the screen dark for the rest
    // of the show.
    d.on('end-file', (m) => {
      if (this.display !== d || this.displayMode !== 'matrix' || (m.reason !== 'eof' && m.reason !== 'error')) return;
      this.emit('log', `matrix stream ended (${m.reason}${m.file_error ? ': ' + m.file_error : ''}), reopening`);
      this._matrix(false);
      this.displayMode = 'idle';
      this._matrixKey = null;
      const now = Date.now();
      if (((this.item && this.state === 'playing') || (this.netActive && this._netMatrix())) && now - (this._matrixRetryAt || 0) > 5000) {
        this._matrixRetryAt = now;
        setTimeout(() => this._redisplay(), 300);
      }
    });
    d.on('exit', (code, sig) => {
      if (this.display !== d) return;
      this.emit('log', `mpv(display) exited (${sig || code}), restarting`);
      this.displayMode = 'idle'; this._matrixKey = null;
    });
    d.start();
    this.display = d;
    this.displayMode = 'idle';
    try { await d.whenReady(); } catch (e) { this.emit('log', 'display: mpv could not open the HDMI screen (' + e.message + '), retrying every minute'); if (this.display === d) this.display = null; d.stop(); }
  }

  // Screen sleep (lib/screen-sleep.js): let go of the HDMI output so the
  // screen can be switched off, and take it back on wake. mpv holds the
  // display (DRM master) while it runs, so it is stopped, not just paused.
  get displaySuspended() { return !!this._displaySuspended; }
  async suspendDisplay() {
    if (this._displaySuspended || !this._dispArgs) return false;
    this._displaySuspended = true;
    const d = this.display;
    this._matrix(false);
    this.displayMode = 'idle';
    this.display = null;
    // Wait until mpv has really exited: while it is still DRM master the
    // kernel silently ignores a framebuffer blank, then restores the console
    // picture when mpv lets go (screen said "off" but stayed on, 0.6.3).
    if (d) await d.stop();
    await new Promise((r) => setTimeout(r, 1000)); // console mode restored
    return true;
  }
  async resumeDisplay() {
    if (!this._displaySuspended) return false;
    this._displaySuspended = false;
    await this._openDisplay();
    if (this.item && this.state === 'playing') await this._startDisplay().catch((e) => this.emit('log', 'display: ' + e.message));
    // Woken by DDP arriving (network-fed matrix): show it. Before 0.8.1 the
    // screen woke up but stayed black.
    else if (this.netActive && this._netMatrix()) await this._openMatrix().catch((e) => this.emit('log', 'display: ' + e.message));
    else this._idleScreen();
    return true;
  }

  async _displayIdle() {
    if (!this.display || this.displayMode === 'idle') return;
    // Network-fed matrix with DDP still arriving: back to (or stay on) the matrix.
    if (this.netActive && this._netMatrix()) {
      if (this.displayMode !== 'matrix') await this._openMatrix().catch(() => {});
      return;
    }
    this._matrix(false);
    this.displayMode = 'idle';
    try { await this.display.command('stop'); } catch {}
    this._idleScreen();
  }

  // Idle HDMI is black. Optionally (video.idleAddress) it shows the player's
  // address instead, handy while setting up a new player.
  _idleScreen() {
    if (!this.display || this.displayMode !== 'idle' || !this.display.ready) return;
    if (!this.config.get().video.idleAddress) {
      this.display.command('show-text', '', 1, 0).catch(() => {});
      return;
    }
    const ips = [];
    for (const [name, list] of Object.entries(require('os').networkInterfaces())) {
      if (name === 'lo') continue;
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
    }
    const host = require('os').hostname();
    const text = `ShowPilot Player is ready\n\nhttp://${host}.local/${ips.length ? `\nhttp://${ips[0]}/` : '\n(no network yet)'}`;
    // Level 0 so it shows even with --osd-level=0; refreshed every minute.
    this.display.command('show-text', text, 120000, 0).catch(() => {});
  }

  // Keep followers (display video; audio in remote mode) on the master clock.
  // Same shape as FPP's remote AdjustSpeed: small error -> nudge speed,
  // large error -> exact seek.
  async _slaveLoop() {
    if (this.state !== 'playing' || !this.item) return;
    // Remote: the master went quiet (stopped without a STOP we understood,
    // went offline): don't keep "playing" on our own.
    if (this.clockSource === 'external' && this.lastFollowAt && Date.now() - this.lastFollowAt > this.followTimeoutMs) {
      this.lastFollowAt = 0;
      this.emit('log', `no MultiSync from the master for ${Math.round(this.followTimeoutMs / 1000)} s: stopping`);
      this.stop().catch(() => {});
      return;
    }
    const pairs = [];
    if (this.display && this.displayMode === 'video') pairs.push(this.display);
    if (this.clockSource === 'external' && this.item.mediaFile) pairs.push(this.audio);
    for (const m of pairs) {
      try {
        const pos = await m.get('time-pos');
        if (typeof pos !== 'number') continue;
        const diff = pos * 1000 - this.mediaMs();
        let speed = 1;
        if (Math.abs(diff) > 1000) { await m.command('seek', this.mediaMs() / 1000, 'absolute+exact'); }
        else if (Math.abs(diff) > 25) speed = 1 - Math.max(-0.05, Math.min(0.05, diff / 2000));
        await m.set('speed', +speed.toFixed(4));
      } catch {}
    }
  }

  // ---------------------------------------------------------------- remote mode
  // Feed a MultiSync master position. Starts the item if needed.
  async followMaster({ sequence, media, seconds }) {
    const ms = Math.max(0, seconds * 1000);
    const cur = this.item;
    this.lastFollowAt = Date.now();
    const same = cur && this.state !== 'idle' &&
      (sequence ? cur.sequence === sequence : true) && (media ? cur.media === path.basename(media) : true);
    if (!same) {
      // An audio/video-only item whose file this player doesn't have (a
      // matrix remote never gets the show's mp3s): nothing to play. Before
      // 0.7.2 it started an empty item that never ended (its STOP named a
      // file the item didn't have), so the remote showed "playing" for
      // ever and kept its screen awake after the show.
      const seqName = sequence || (cur && cur.sequence);
      const mediaName = media || (cur && cur.media);
      const mediaHere = mediaName && resolveMedia(paths.safeName(String(mediaName).split(/[\\/]/).pop()));
      if (!seqName && !mediaHere) {
        if (cur && this.state !== 'idle' && !cur.sequence && !cur.mediaFile) await this.stop();
        return;
      }
      if (this._followStarting) return;
      this._followStarting = true;
      try {
        await this.play({ sequence: sequence || (cur && cur.sequence), media: media || (cur && cur.media),
          startMs: ms, clock: 'external' });
      } finally { this._followStarting = false; }
      return;
    }
    if (this.clockSource !== 'external') return;
    if (Math.abs(ms - this.mediaMs()) > 200) this._setAnchor(ms, 1); else this._discipline(ms);
  }

  // ---------------------------------------------------------------- stop / pause
  // Pause for an interrupt: returns the measured resume point.
  pause() { return this._serial(() => this._pause()); }

  async _pause() {
    if (!this.item || this.state !== 'playing') return null;
    let pos = this.mediaMs();
    if (this.clockSource === 'audio') {
      try { await this.audio.set('pause', true); const p = await this.audio.get('time-pos'); if (typeof p === 'number') pos = p * 1000; } catch {}
    }
    const snap = { sequence: this.item.sequence, media: this.item.media, positionMs: Math.max(0, pos), meta: this.item.meta };
    await this._halt(true);
    this.emit('paused', snap);
    return snap;
  }

  stop() { return this._serial(() => this._halt(true)); }

  async _halt(emitStop) {
    const was = this.item;
    this.itemId++;
    this.state = 'idle';
    this.anchor = null;
    this.worker && this.worker.postMessage({ type: 'stop' });
    if (was && was.mediaFile) { try { await this.audio.command('stop'); } catch {} }
    if (was && this.displayMode === 'video') { try { await this.display.command('stop'); } catch {} this.displayMode = 'idle'; }
    this.item = null;
    if (was && emitStop) this.emit('stop', { sequence: was.sequence, media: was.media });
    if (emitStop) this._displayIdle().catch(() => {});
  }

  _onAudioEnd(m) {
    if (!this.item || this.clockSource !== 'audio' || this.state !== 'playing') return;
    if (m.reason !== 'eof') return;
    this.mediaEnded = true;
    this._maybeEnded();
  }

  _onWorker(m) {
    if (m.type === 'stats') { this.workerStats = m; return; }
    if (m.type === 'log') { this.emit('log', m.msg); return; }
    if (m.type === 'net') { if (m.active) this.emit('log', `DDP for the matrix arriving from ${m.from}`); else this.emit('log', 'DDP for the matrix stopped'); this._onNet(m.active).catch(() => {}); return; }
    if (m.type === 'ended' && this.item && m.id === this.item.id) { this.seqEnded = true; this._maybeEnded(); }
  }

  // An item with both a sequence and media ends when both have (FPP "both").
  _maybeEnded() {
    if (!this.item || this.state !== 'playing') return;
    if (!this.seqEnded || !this.mediaEnded) return;
    const it = this.item;
    this._serial(async () => {
      if (!this.item || this.item.id !== it.id) return; // something else already moved on
      await this._halt(false);
      this.emit('end', { sequence: it.sequence, media: it.media, id: it.id });
    });
  }

  // Master dimmer for the lights this player sends (and its matrix), 0..1.
  setBrightness(v) { this.brightness = v; this.worker && this.worker.postMessage({ type: 'brightness', value: v }); }

  // ---------------------------------------------------------------- tests
  testPattern(pattern, color) {
    if (this.state !== 'idle') return false;
    this.testing = !!pattern;
    this.testPatternName = pattern ? (pattern === 'solid' && Array.isArray(color) ? `solid:${color.join(',')}` : pattern) : null;
    if (pattern) this.emit('activity');
    this.worker.postMessage({ type: 'test', pattern: pattern || null, color });
    return true;
  }
}

module.exports = { Player, resolveMedia, isVideo, VIDEO_EXT, AUDIO_EXT };
