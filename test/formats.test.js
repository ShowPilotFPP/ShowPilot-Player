// fseq, DDP, E1.31, MultiSync and matrix layouts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { FseqFile, writeFseq } = require('../lib/fseq');
const { DdpOutput, E131Output } = require('../lib/outputs');
const { syncPacket } = require('../lib/multisync');
const { buildMatrixMap, renderMatrix } = require('../lib/engine/matrix-map');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-test-'));
const frames = (n, cc) => Array.from({ length: n }, (_, i) => { const b = Buffer.alloc(cc); for (let j = 0; j < cc; j++) b[j] = (i * 7 + j) & 255; return b; });

test('fseq round-trips for every compression and sparse ranges', () => {
  const cc = 1200, fr = frames(97, cc);
  for (const compression of [0, 1, 2]) {
    for (const sparse of [[], [[100, 300], [800, 200]]]) {
      const f = path.join(tmp, `c${compression}-${sparse.length}.fseq`);
      writeFseq(f, { channelCount: cc, frames: fr, compression, sparse, mediaFile: 'song.mp3' });
      const r = new FseqFile(f);
      assert.equal(r.frameCount, 97);
      assert.equal(r.mediaFilename, 'song.mp3');
      for (const n of [0, 9, 10, 11, 50, 96]) {
        const t = Buffer.alloc(r.maxChannel);
        assert.ok(r.frameInto(n, t));
        if (!sparse.length) assert.deepEqual(t, fr[n]);
        else for (const [s, l] of sparse) assert.deepEqual(t.subarray(s, s + l), fr[n].subarray(s, s + l));
      }
      assert.equal(r.rawFrame(97), null);
      r.close();
    }
  }
});

test('fseq block holding two concatenated zstd frames (FPP tolerates this)', () => {
  const cc = 500, fr = frames(10, cc);
  const f = path.join(tmp, 'two.fseq');
  writeFseq(f, { channelCount: cc, frames: fr, compression: 1 });
  const r0 = new FseqFile(f); const off = r0.h.blocks[0].offset; r0.close();
  const hdr = fs.readFileSync(f).subarray(0, off);
  const raw = Buffer.concat(fr);
  const two = Buffer.concat([zlib.zstdCompressSync(raw.subarray(0, 5 * cc)), zlib.zstdCompressSync(raw.subarray(5 * cc))]);
  hdr.writeUInt32LE(two.length, 36);
  fs.writeFileSync(f, Buffer.concat([hdr, two]));
  const r = new FseqFile(f);
  const t = Buffer.alloc(cc);
  r.frameInto(8, t);
  assert.deepEqual(t, fr[8]);
  r.close();
});

test('fseq meta matches the shape xLights compares', () => {
  const f = path.join(tmp, 'meta.fseq');
  writeFseq(f, { channelCount: 512, frames: frames(4, 512), compression: 1, uniqueId: 123456789 });
  const r = new FseqFile(f);
  const m = r.meta('meta.fseq');
  r.close();
  assert.equal(m.Version, '2.1');
  assert.equal(m.ID, '123456789');
  assert.equal(m.CompressionType, 1);
  assert.equal(m.ChannelCount, 512);
  assert.equal(m.NumFrames, 4);
});

test('DDP packets: 1440-byte payloads, PUSH on last, BE offset, seq 1..15', () => {
  const o = new DdpOutput({ ip: '127.0.0.1', startChannel: 101, channelCount: 3000 });
  const sent = [];
  const frame = Buffer.alloc(4000, 7);
  o.send({ send: (p) => sent.push(Buffer.from(p)) }, frame);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((p) => p[0]), [0x40, 0x40, 0x41]);
  assert.deepEqual(sent.map((p) => p[1]), [1, 2, 3]);
  assert.deepEqual(sent.map((p) => p.readUInt32BE(4)), [100, 1540, 2980]);
  assert.deepEqual(sent.map((p) => p.readUInt16BE(8)), [1440, 1440, 120]);
  assert.equal(sent[0][2], 0); assert.equal(sent[0][3], 1);
  for (let i = 0; i < 20; i++) o.send({ send: (p) => sent.push(Buffer.from(p)) }, frame);
  assert.ok(sent.every((p) => p[1] >= 1 && p[1] <= 15));
});

test('E1.31 packet matches FPP layout', () => {
  const o = new E131Output({ universe: 258, universeCount: 2, universeSize: 510, startChannel: 1, multicast: true, priority: 0 });
  const sent = [];
  const frame = Buffer.alloc(1020); frame[0] = 9; frame[510] = 11;
  o.send({ send: (p, port, ip) => sent.push({ p: Buffer.from(p), port, ip }) }, frame);
  const [a, b] = sent;
  assert.equal(a.port, 5568);
  assert.equal(a.ip, '239.255.1.2');
  assert.equal(b.ip, '239.255.1.3');
  assert.equal(a.p.length, 126 + 510);
  assert.equal(a.p.toString('latin1', 4, 13), 'ASC-E1.17');
  assert.equal(a.p.readUInt16BE(16), 0x7000 | (110 + 510));
  assert.equal(a.p.readUInt16BE(38), 0x7000 | (88 + 510));
  assert.equal(a.p.readUInt16BE(115), 0x7000 | (11 + 510));
  assert.equal(a.p.readUInt16BE(113), 258);
  assert.equal(a.p.readUInt16BE(123), 511);
  assert.equal(a.p[111], 1);
  assert.equal(a.p[126], 9);
  assert.equal(b.p[126], 11);
});

test('MultiSync sync packet layout (length counts the trailing NUL)', () => {
  const p = syncPacket(2, 0, 123, 3.075, 'song.fseq');
  assert.equal(p.toString('latin1', 0, 4), 'FPPD');
  assert.equal(p[4], 1);
  assert.equal(p.readUInt16LE(5), 11 + 9);
  assert.equal(p.length, 7 + 11 + 9);
  assert.equal(p[7], 2); assert.equal(p[8], 0);
  assert.equal(p.readUInt32LE(9), 123);
  assert.ok(Math.abs(p.readFloatLE(13) - 3.075) < 1e-6);
  assert.equal(p.toString('latin1', 17, 26), 'song.fseq');
  assert.equal(p[p.length - 1], 0);
});

test('matrix map follows xLights start corner and serpentine', () => {
  const m = buildMatrixMap({ startChannel: 1, width: 3, height: 2, startCorner: 'BL', orientation: 'horizontal', serpentine: true });
  // pixel order in channels: (0,1)(1,1)(2,1) then serpentine back on row 0: (2,0)(1,0)(0,0)
  const frame = Buffer.alloc(18);
  for (let i = 0; i < 6; i++) frame[i * 3] = i + 1; // red = pixel index + 1
  const img = renderMatrix(m, frame, Buffer.alloc(18));
  const red = [0, 1, 2, 3, 4, 5].map((i) => img[i * 3]);
  assert.deepEqual(red, [6, 5, 4, 1, 2, 3]);
  const g = buildMatrixMap({ width: 1, height: 1, colorOrder: 'GRB' });
  const px = renderMatrix(g, Buffer.from([10, 20, 30]), Buffer.alloc(3));
  assert.deepEqual([...px], [20, 10, 30]);
});

test('system update: parse apt upgradable list and compare versions', () => {
  const { parseUpgradable, cmpVersion } = require('../lib/os-update');
  const out = 'Listing...\nmpv/stable 0.40.0-3 arm64 [upgradable from: 0.40.0-2]\nlibc6/stable-security 2.41-12+deb13u1 arm64 [upgradable from: 2.41-12]\n';
  assert.deepEqual(parseUpgradable(out), [
    { name: 'mpv', to: '0.40.0-3', from: '0.40.0-2' },
    { name: 'libc6', to: '2.41-12+deb13u1', from: '2.41-12' },
  ]);
  assert.ok(cmpVersion('22.21.0', '22.15.1') > 0);
  assert.ok(cmpVersion('v22.9.0', '22.10.0') < 0);
  assert.equal(cmpVersion('22.1.0', '22.1.0'), 0);
});

test('audio: automatic output prefers a USB sound card', () => {
  const a = require('../lib/audio-devices');
  const pi = ' 0 [vc4hdmi0       ]: vc4-hdmi - vc4-hdmi-0\n 1 [Headphones     ]: bcm2835_headpho - bcm2835 Headphones\n 2 [S3             ]: USB-Audio - Sound Blaster Play! 3\n';
  assert.equal(a.resolve('auto', a.cards(pi)).id, 'alsa/plughw:CARD=S3,DEV=0');
  assert.equal(a.resolve('auto', a.cards(' 1 [Headphones     ]: bcm2835_headpho - bcm2835 Headphones\n')).id, 'alsa');
  assert.equal(a.resolve('alsa/plughw:CARD=Headphones,DEV=0', a.cards(pi)).id, 'alsa/plughw:CARD=Headphones,DEV=0');
});

test('fseq media name from xLights is reduced to the file name (Windows or Mac path)', () => {
  for (const mf of ['C:\\Users\\me\\Show\\Audio\\Song One.mp3', '/Users/me/Show/Audio/Song One.mp3', 'Song One.mp3']) {
    const f = path.join(tmp, 'mf.fseq');
    writeFseq(f, { channelCount: 3, frames: frames(2, 3), compression: 0, mediaFile: mf });
    const r = new FseqFile(f);
    assert.equal(r.mediaFilename, 'Song One.mp3');
    r.close();
  }
});
