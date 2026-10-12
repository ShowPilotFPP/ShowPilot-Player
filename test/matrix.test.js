// Virtual matrix end to end: a sparse sequence (xLights FPP Connect upload)
// rendered by the display mpv (null video output) and checked from a
// screenshot (read back with ffmpeg). Skipped when mpv is not installed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
process.env.SPP_MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-matrix-'));
process.env.SPP_AUDIO_NULL = '1';
process.env.SPP_DISPLAY = '1';
process.env.SPP_DISPLAY_VO = 'null';

const test = require('node:test');
const assert = require('node:assert');

const has = (bin) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !has('mpv') ? 'mpv not installed' : false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('virtual matrix shows a sparse sequence at its show channel numbers', { skip, timeout: 60000 }, async () => {
  const paths = require('../lib/paths');
  const { writeFseq } = require('../lib/fseq');
  const config = require('../lib/config');
  const { Player } = require('../lib/engine/player');
  paths.ensureLayout();
  config.load();
  // 320x180 at channel 3065, the only range in the file (like FPP Connect sends a matrix-only player).
  const W = 320, H = 180, S = 3064, L = W * H * 3;
  const frames = [];
  for (let i = 0; i < 160; i++) {
    const b = Buffer.alloc(S + L);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = S + (y * W + x) * 3; b[o] = x < W / 2 ? 255 : 0; b[o + 1] = y < H / 2 ? 255 : 0; }
    frames.push(b);
  }
  writeFseq(paths.fileIn('sequences', 'm.fseq'), { channelCount: S + L, frames, stepMs: 25, sparse: [[S, L]] });
  config.update({ outputs: [], matrix: { ...config.get().matrix, enabled: true, startChannel: 3065, width: W, height: H } });

  const p = new Player(config);
  await p.start();
  const sent = [];
  const orig = p.display.command.bind(p.display);
  p.display.command = (...a) => { sent.push(a); return orig(...a); };
  try {
    await p.play({ sequence: 'm.fseq' });
    await wait(1500);
    assert.equal(p.displayMode, 'matrix');
    // mpv 0.38+ reads a 3rd positional loadfile argument as an index: options must be named.
    const load = sent.find((a) => a[0] && (a[0] === 'loadfile' || a[0].name === 'loadfile'));
    assert.ok(load && typeof load[0] === 'object' && load[0].options, 'loadfile sent with named arguments');
    const vp = await p.display.get('video-params');
    assert.equal(vp.w, W);
    assert.equal(vp.h, H);
    const shot = path.join(process.env.SPP_MEDIA_DIR, 'shot.png');
    await p.display.command('screenshot-to-file', shot, 'video');
    if (!has('ffmpeg')) return;
    const buf = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', shot, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const px = (x, y) => [...buf.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
    assert.deepEqual(px(10, 10), [255, 255, 0], 'top left: red + green');
    assert.deepEqual(px(W - 10, 10), [0, 255, 0], 'top right: green');
    assert.deepEqual(px(10, H - 10), [255, 0, 0], 'bottom left: red');
    assert.deepEqual(px(W - 10, H - 10), [0, 0, 0], 'bottom right: black');
  } finally {
    await p.close();
  }
});
