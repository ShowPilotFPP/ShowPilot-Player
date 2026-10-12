// Background music (lib/bgmusic.js): real mpv with null audio, a fake
// player/show. Plays a playlist's audio, yields to show audio and comes back,
// Start Main Show fades lights + music, blackout, starts the show, and
// returns to pre-show. Skipped when mpv or ffmpeg are not installed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
process.env.SPP_MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-bgm-'));
process.env.SPP_AUDIO_NULL = '1';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const has = (bin) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !has('mpv') || !has('ffmpeg') ? 'mpv/ffmpeg not installed' : false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(step); }
  return false;
}

function rig(settings = {}) {
  const paths = require('../lib/paths');
  const playlists = require('../lib/playlists');
  const { resolveMedia } = require('../lib/engine/player');
  const { BackgroundMusic } = require('../lib/bgmusic');
  const { Commands } = require('../lib/commands');
  paths.ensureLayout();
  for (const n of ['one', 'two', 'three']) {
    const f = paths.fileIn('music', `${n}.mp3`);
    if (!fs.existsSync(f)) execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=30', f]);
  }
  playlists.save('Pre-show music', { mainPlaylist: ['one', 'two', 'three'].map((n) => ({ type: 'media', enabled: 1, mediaName: `${n}.mp3` })) });
  playlists.save('Pre-show lights', { mainPlaylist: [{ type: 'sequence', enabled: 1, sequenceName: 'anim.fseq' }] });
  playlists.save('Main Show', { mainPlaylist: [{ type: 'both', enabled: 1, sequenceName: 's.fseq', mediaName: 'one.mp3' }] });

  let cfg = { mode: 'player', backgroundMusic: { source: 'playlist', playlist: 'Pre-show music', shuffle: false, volume: 60, fadeSec: 0.3,
    showPlaylist: 'Main Show', blackoutSec: 0.2, returnToPreShow: true, postShowDelaySec: 0.2, preShowPlaylist: 'Pre-show lights', ...settings } };
  const config = Object.assign(new EventEmitter(), { get: () => cfg, set: (c) => { cfg = c; config.emit('change', cfg); } });
  const player = Object.assign(new EventEmitter(), {
    state: 'idle', item: null, brightness: 1, levels: [], worker: { postMessage() {} },
    setBrightness(v) { this.brightness = v; this.levels.push(v); },
  });
  const show = Object.assign(new EventEmitter(), {
    running: null, started: [], stopped: 0,
    isRunning() { return !!this.running; },
    async start(n) { this.running = n; this.started.push(n); },
    async stopNow() { const had = this.running; this.running = null; this.stopped++; if (had) this.emit('playlist', { Action: 'stop', name: had }); },
  });
  const commands = new Commands();
  const bgm = new BackgroundMusic({ config, player, show, commands, resolveMedia });
  bgm.start();
  return { bgm, player, show, config, commands };
}

test('plays the playlist, yields to show audio and comes back where it was', { skip, timeout: 60000 }, async () => {
  const { bgm, player } = rig();
  try {
    await bgm.play();
    assert.equal(bgm.state, 'playing');
    assert.ok(await until(() => bgm.pos > 0.5), 'music is playing (position moves)');
    assert.equal(bgm.status().track, 1);
    assert.equal(bgm.status().title, 'one');
    await bgm.next();
    assert.ok(await until(() => bgm.status().title === 'two' && bgm.pos > 0.3));
    const posBefore = bgm.pos;
    const proc = bgm.mpv.proc;

    // A show song is about to play: the player asks the music to let go.
    await player.beforeAudio();
    assert.equal(bgm.state, 'yielded');
    assert.ok(proc.exitCode !== null || proc.signalCode !== null, 'music process ended: sound card free');
    player.state = 'playing'; player.item = { mediaFile: '/x/song.mp3' };
    await wait(1500);
    assert.equal(bgm.state, 'yielded', 'stays off while show audio plays');
    player.state = 'idle'; player.item = null;
    assert.ok(await until(() => bgm.state === 'playing' && bgm.pos > posBefore, 8000), 'back after the show audio, same track, later position');
    assert.equal(bgm.status().title, 'two');
  } finally { await bgm.close(); }
});

test('Start Main Show: fade lights + music, blackout, show, then back to pre-show', { skip, timeout: 60000 }, async () => {
  const { bgm, player, show, commands } = rig();
  try {
    await show.start('Pre-show lights');
    await bgm.play();
    assert.ok(await until(() => bgm.pos > 0.2));
    const t0 = Date.now();
    await commands.run('BackgroundMusic - Start Main Show', []); // the FPP plugin's command name
    assert.ok(Date.now() - t0 >= 450, 'fade + blackout took their time');
    assert.equal(bgm.state, 'show');
    assert.equal(show.running, 'Main Show');
    assert.equal(bgm.mpv, null, 'music off during the show');
    assert.ok(player.levels.some((v) => v > 0 && v < 1), 'lights faded through');
    assert.ok(player.levels.includes(0), 'reached black');
    assert.equal(player.brightness, 1, 'full brightness for the show');
    // Show ends.
    show.running = null; show.emit('playlist', { Action: 'stop', name: 'Main Show' });
    assert.ok(await until(() => bgm.state === 'playing' && show.running === 'Pre-show lights', 6000), 'pre-show lights and music again');
  } finally { await bgm.close(); }
});

test('remote mode and missing settings are refused with a reason', { skip, timeout: 30000 }, async () => {
  const { bgm, config } = rig({ playlist: '' });
  try {
    await assert.rejects(bgm.play(), /Pick a music playlist/);
    config.set({ ...config.get(), backgroundMusic: { ...config.get().backgroundMusic, source: 'stream', streamUrl: 'ftp://x' } });
    await assert.rejects(bgm.play(), /stream URL/);
    config.set({ ...config.get(), mode: 'remote' });
    await assert.rejects(bgm.play(), (e) => e.status === 409);
    await assert.rejects(bgm.startMainShow(), (e) => e.status === 409);
  } finally { await bgm.close(); }
});

test('a scheduled show starting while music plays fades into it, and the music stays off', { skip, timeout: 30000 }, async () => {
  const { bgm, player, show } = rig();
  const { Scheduler } = require('../lib/scheduler');
  try {
    await show.start('Pre-show lights');
    await bgm.play();
    assert.ok(await until(() => bgm.pos > 0.2));
    // The scheduler's hook, as server.js wires it, then its own show start.
    const t0 = Date.now();
    assert.equal(await bgm.beforeScheduledShow({ type: 'playlist', playlist: 'Main Show' }), true);
    assert.ok(Date.now() - t0 >= 450, 'fade + blackout before the show');
    assert.equal(bgm.state, 'off');
    assert.equal(bgm.mpv, null);
    assert.equal(show.running, null, 'pre-show stopped for the blackout');
    assert.ok(player.levels.includes(0) && player.brightness === 1);
    // Music not playing (or the option off): the hook does nothing.
    assert.equal(await bgm.beforeScheduledShow({ type: 'playlist', playlist: 'Main Show' }), false);
    show.emit('playlist', { Action: 'stop', name: 'Main Show' });
    await wait(500);
    assert.equal(bgm.state, 'off', 'no return to pre-show after a scheduled show');
    assert.equal(typeof Scheduler.prototype.tick, 'function');
  } finally { await bgm.close(); }
});
