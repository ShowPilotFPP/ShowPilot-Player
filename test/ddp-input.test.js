// Network-fed virtual matrix: DDP packets (as the Player's own DDP output and
// xLights send them) drawn by the display mpv (null video output), checked
// from screenshots. Raw and relative offsets, incomplete frames held back,
// display switches on/off with the stream. Skipped without mpv/ffmpeg.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { execFileSync } = require('child_process');
process.env.SPP_MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-ddpin-'));
process.env.SPP_AUDIO_NULL = '1';
process.env.SPP_DISPLAY = '1';
process.env.SPP_DISPLAY_VO = 'null';

const test = require('node:test');
const assert = require('node:assert');

const has = (bin) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !has('mpv') || !has('ffmpeg') ? 'mpv/ffmpeg not installed' : false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(50); } return false; }

const W = 32, H = 18, START = 3065, LEN = W * H * 3, PORT = 4049;

// One frame as DDP packets: offset base + i*1440, PUSH on the last.
function packets(frame, base, { drop = -1 } = {}) {
  const out = [];
  const n = Math.ceil(frame.length / 1440);
  for (let i = 0; i < n; i++) {
    const data = frame.subarray(i * 1440, Math.min(frame.length, (i + 1) * 1440));
    const p = Buffer.alloc(10 + data.length);
    p[0] = i === n - 1 ? 0x41 : 0x40; p[1] = 1; p[3] = 1;
    p.writeUInt32BE(base + i * 1440, 4); p.writeUInt16BE(data.length, 8);
    data.copy(p, 10);
    if (i !== drop) out.push(p);
  }
  return out;
}
const solid = (r, g, b) => { const f = Buffer.alloc(LEN); for (let i = 0; i < LEN; i += 3) { f[i] = r; f[i + 1] = g; f[i + 2] = b; } return f; };

test('virtual matrix from DDP: raw and xLights-style offsets, torn frames held back', { skip, timeout: 60000 }, async () => {
  const paths = require('../lib/paths');
  const config = require('../lib/config');
  const { Player } = require('../lib/engine/player');
  paths.ensureLayout();
  config.load();
  config.update({ outputs: [], matrix: { ...config.get().matrix, enabled: true, startChannel: START, width: W, height: H,
    source: 'network', ddpOffset: 'auto', ddpPort: PORT } });
  const p = new Player(config);
  const tx = dgram.createSocket('udp4');
  await p.start();
  const shot = async () => {
    const f = path.join(process.env.SPP_MEDIA_DIR, `s${Date.now()}.png`);
    await p.display.command('screenshot-to-file', f, 'video');
    const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    return [...raw.subarray(0, 3)];
  };
  const send = async (pkts) => { for (const pk of pkts) await new Promise((r) => tx.send(pk, PORT, '127.0.0.1', r)); };
  try {
    assert.equal(p.displayMode, 'idle', 'nothing until DDP arrives');
    // The Player's own DDP output: raw show channel offsets (3064...).
    for (let i = 0; i < 5; i++) { await send(packets(solid(255, 0, 0), START - 1)); await wait(25); }
    assert.ok(await until(() => p.displayMode === 'matrix' && p.netActive), 'matrix shown when DDP arrives');
    await wait(300);
    assert.deepEqual(await shot(), [255, 0, 0], 'raw offsets drawn');
    // A frame with a packet lost: not drawn (still red, no tear).
    await send(packets(solid(0, 255, 0), START - 1, { drop: 0 }));
    await wait(200);
    assert.deepEqual(await shot(), [255, 0, 0], 'incomplete frame held back');
    // Stream stops: matrix off after ~2 s.
    assert.ok(await until(() => !p.netActive && p.displayMode === 'idle', 5000), 'display idle after the stream stops');
    // xLights default: offset 0 is the matrix's first channel.
    for (let i = 0; i < 5; i++) { await send(packets(solid(0, 0, 255), 0)); await wait(25); }
    assert.ok(await until(() => p.displayMode === 'matrix'));
    await wait(300);
    assert.deepEqual(await shot(), [0, 0, 255], 'relative offsets drawn');
    await wait(1100);
    const net = p.workerStats.net;
    assert.ok(net && net.frames >= 8 && net.incomplete >= 1, `stats ${JSON.stringify(net)}`);
    assert.equal(net.offsets, 'relative');
  } finally {
    tx.close();
    await p.close();
  }
});
