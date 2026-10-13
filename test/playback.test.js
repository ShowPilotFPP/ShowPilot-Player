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
    // Regression: a boundary race in the scheduler sent ~1.5% of frames a whole frame late.
    assert.ok(st.total.over20 <= 1, `${st.total.over20} frames over 20 ms late`);

    const ended = new Promise((r) => p.once('end', r));
    await ended;
    assert.equal(p.state, 'idle');
  } finally {
    await p.close();
  }
});

test('a sequence replaced on disk (re-uploaded from xLights) plays its new data, not the old file\'s', { skip, timeout: 60000 }, async () => {
  const dgram = require('dgram');
  const paths = require('../lib/paths');
  const { writeFseq } = require('../lib/fseq');
  const config = require('../lib/config');
  const { Player } = require('../lib/engine/player');
  paths.ensureLayout();
  config.load();
  const STEP = 25, SECS = 3, cc = 600;
  const make = (mark, fpb) => {
    const frames = [];
    for (let i = 0; i < (SECS * 1000) / STEP; i++) { const b = Buffer.alloc(cc, mark); b.writeUInt16BE(i, 0); frames.push(b); }
    const f = paths.fileIn('sequences', 'r.fseq');
    const tmp = f + '.new';
    writeFseq(tmp, { channelCount: cc, frames, stepMs: STEP, framesPerBlock: fpb });
    fs.renameSync(tmp, f); // like an upload: a new file under the same name
  };
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECS}`, paths.fileIn('music', 'r.mp3')]);
  const rx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise((r) => rx.bind(4048, '127.0.0.1', r));
  let marks = [];
  rx.on('message', (m) => { if (m.readUInt32BE(4) === 0 && m.length > 20) marks.push(m[20]); });
  config.update({ outputs: [{ type: 'ddp', ip: '127.0.0.1', startChannel: 1, channelCount: cc }], outputPacingMbps: 90 });
  const p = new Player(config);
  await p.start();
  try {
    make(0x11, 10);
    await p.play({ sequence: 'r.fseq', media: 'r.mp3' });
    await wait(800);
    await p.stop();
    make(0x77, 7); // different data and a different block layout
    marks = [];
    await p.play({ sequence: 'r.fseq', media: 'r.mp3' });
    await wait(1500);
    const seen = marks.filter((x) => x !== 0);
    const after = seen.slice(seen.indexOf(0x77)); // a frame of the first play may still be on its way
    assert.ok(after.length > 20, `frames received: ${after.length}`);
    assert.ok(after.every((x) => x === 0x77), `old data sent after the file was replaced: ${after.filter((x) => x !== 0x77).length} frames`);
  } finally {
    await p.close();
    rx.close();
  }
});

test('master dimmer scales what goes out (Start Main Show fade), not the sequence', { skip, timeout: 30000 }, async () => {
  const dgram = require('dgram');
  const paths = require('../lib/paths');
  const { writeFseq } = require('../lib/fseq');
  const config = require('../lib/config');
  const { Player } = require('../lib/engine/player');
  const { DDP_PORT } = require('../lib/outputs');
  paths.ensureLayout();
  config.load();
  const rx = dgram.createSocket('udp4');
  try { await new Promise((r, j) => { rx.once('error', j); rx.bind(DDP_PORT, '127.0.0.1', r); }); }
  catch { rx.close(); return; } // port busy on this machine: nothing to check
  let last = null;
  rx.on('message', (m) => { last = m; });
  const cc = 30, frames = [];
  for (let i = 0; i < 200; i++) frames.push(Buffer.alloc(cc, 200));
  writeFseq(paths.fileIn('sequences', 'dim.fseq'), { channelCount: cc, frames, stepMs: 25 });
  config.update({ outputs: [{ type: 'ddp', ip: '127.0.0.1', startChannel: 1, channelCount: cc }], outputPacingMbps: 0 });
  const p = new Player(config);
  await p.start();
  try {
    await p.play({ sequence: 'dim.fseq' });
    await wait(300);
    assert.equal(last[10], 200, 'full level');
    p.setBrightness(0.5);
    await wait(300);
    assert.equal(last[10], 100, 'half level');
    p.setBrightness(0);
    await wait(300);
    assert.equal(last[10], 0, 'black');
    p.setBrightness(1);
    await wait(300);
    assert.equal(last[10], 200, 'back to full: the frames themselves were never changed');
  } finally {
    await p.close();
    rx.close();
  }
});

test('remote: audio it does not have is not "played", and a silent master stops it', { skip, timeout: 30000 }, async () => {
  const paths = require('../lib/paths');
  const { writeFseq } = require('../lib/fseq');
  const config = require('../lib/config');
  const { Player } = require('../lib/engine/player');
  paths.ensureLayout();
  config.load();
  const frames = [];
  for (let i = 0; i < 400; i++) frames.push(Buffer.alloc(30));
  writeFseq(paths.fileIn('sequences', 'remote.fseq'), { channelCount: 30, frames, stepMs: 25 });
  const p = new Player(config);
  await p.start();
  try {
    // End of a song: the master's media syncs for an mp3 this remote doesn't have.
    await p.followMaster({ media: 'Not Here.mp3', seconds: 120 });
    await p.followMaster({ media: 'Not Here.mp3', seconds: 120.5 });
    assert.equal(p.state, 'idle', 'nothing to play: stays idle (was stuck "playing" before 0.7.2)');
    // A sequence it has: follows it.
    await p.followMaster({ sequence: 'remote.fseq', seconds: 0 });
    assert.equal(p.state, 'playing');
    assert.equal(p.clockSource, 'external');
    // The master goes quiet: the remote stops by itself.
    p.followTimeoutMs = 600;
    await wait(1500);
    assert.equal(p.state, 'idle', 'stopped after the master went quiet');
  } finally { await p.close(); }
});
