// Real playback through mpv (null audio device): the lights run at the
// sequence rate on the audio clock, and a resume is reported at the measured
// position, never 0. Skipped when mpv or ffmpeg are not installed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
process.env.SPP_MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-play-'));
process.env.SPP_AUDIO_NULL = '1';
process.env.SPP_DISPLAY = '0';

const test = require('node:test');
const assert = require('node:assert');

const has = (bin) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !has('mpv') || !has('ffmpeg') ? 'mpv/ffmpeg not installed' : false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('audio-clocked playback, pause and exact resume', { skip, timeout: 60000 }, async () => {
  const paths = require('../lib/paths');
  const { writeFseq } = require('../lib/fseq');
  const config = require('../lib/config');
  const { Player } = require('../lib/engine/player');
  paths.ensureLayout();
  config.load();
  const STEP = 25, SECS = 8, cc = 300;
  const frames = [];
  for (let i = 0; i < (SECS * 1000) / STEP; i++) { const b = Buffer.alloc(cc); b.writeUIntBE(i, 0, 3); frames.push(b); }
  writeFseq(paths.fileIn('sequences', 't.fseq'), { channelCount: cc, frames, stepMs: STEP });
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECS}`, paths.fileIn('music', 't.mp3')]);
  config.update({ outputs: [{ type: 'ddp', ip: '127.0.0.1', startChannel: 1, channelCount: cc }] });

  const p = new Player(config);
  await p.start();
  try {
    const starts = [], resumes = [];
    p.on('start', (e) => starts.push(e));
    p.on('resume', (e) => resumes.push(e));
    await p.play({ sequence: 't.fseq', media: 't.mp3' });
    assert.equal(starts.length, 1);
    assert.equal(p.clockSource, 'audio');
    await wait(2500);
    const snap = await p.pause();
    assert.ok(snap.positionMs > 2000 && snap.positionMs < 3200, `paused at ${snap.positionMs}`);

    await p.play({ sequence: 't.fseq', media: 't.mp3', startMs: snap.positionMs, resumed: true });
    assert.equal(resumes.length, 1, 'a resume is its own event');
    assert.equal(starts.length, 1, 'a resume is not a start');
    assert.ok(Math.abs(resumes[0].positionMs - snap.positionMs) < 30, `resumed at ${resumes[0].positionMs}, paused at ${snap.positionMs}`);

    await wait(2200);
    const st = p.workerStats;
    assert.ok(st.fps >= 37 && st.fps <= 41, `fps ${st.fps}`);
    assert.ok(st.mediaMs > snap.positionMs + 800, `lights clock ${st.mediaMs} after resume at ${snap.positionMs}`);
    assert.ok(Math.abs(Math.floor(st.mediaMs / STEP) - st.frame) <= 1, `frame ${st.frame} vs clock ${st.mediaMs}`);

    const ended = new Promise((r) => p.once('end', r));
    await ended;
    assert.equal(p.state, 'idle');
  } finally {
    await p.close();
  }
});
