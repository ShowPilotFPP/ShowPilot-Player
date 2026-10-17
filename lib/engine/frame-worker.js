// Frame worker: owns the open .fseq and the network outputs, and sends the
// frame that matches the master clock. It runs on its own thread so web
// requests, plugin callbacks and GC on the main thread can't delay a frame.
//
// The main thread only sends clock anchors: "media time M was true at
// absolute time A, advancing at rate R". The worker never estimates position
// from how long it has been playing; everything is derived from the anchor.

const { parentPort, Worker } = require('worker_threads');
const path = require('path');
const { FseqFile } = require('../fseq');
const fs = require('fs');
const { OutputSet } = require('../outputs');
const { buildMatrixMap, renderMatrix } = require('./matrix-map');
const dgram = require('dgram');

const nowAbs = () => performance.timeOrigin + performance.now();

const st = {
  outputs: new OutputSet([]),
  offsetMs: 0,
  blankOnStop: true,
  seq: null,          // { id, file: FseqFile, name }
  frameBuf: Buffer.alloc(0),
  clock: null,        // { mediaMs, at, rate }
  running: false,
  lastFrame: -1,
  timer: null,
  ended: false,
  stats: newStats(),
  matrix: null,       // { map, img, writer }
  test: null,         // { pattern, started }
  total: { frames: 0, over10: 0, over20: 0, maxLateMs: 0 }, // since this sequence loaded
  brightness: 1,      // 0..1, master dimmer (background music "Start Main Show" fade)
  dimBuf: Buffer.alloc(0),
};

// The frame as it goes out: scaled by the master dimmer. A copy, so the
// decoded frame (and channels a sparse frame doesn't rewrite) never compound.
function outFrame() {
  const b = st.brightness;
  if (b >= 1) return st.frameBuf;
  if (st.dimBuf.length !== st.frameBuf.length) st.dimBuf = Buffer.alloc(st.frameBuf.length);
  const src = st.frameBuf, dst = st.dimBuf;
  if (b <= 0) { dst.fill(0); return dst; }
  const k = Math.round(b * 256);
  for (let i = 0; i < src.length; i++) dst[i] = (src[i] * k) >> 8;
  return dst;
}

function newStats() { return { frames: 0, late: 0, maxLateMs: 0, sumLateMs: 0, prefetchMs: 0, since: nowAbs() }; }

function post(msg) { parentPort.postMessage(msg); }

// Blocks are decoded on their own thread and handed in here; this thread
// only falls back to decoding itself if a block isn't ready in time
// (counted as inlineDecodes, which should stay at 0 while playing).
const decoder = new Worker(path.join(__dirname, 'decode-worker.js'));
decoder.on('error', (e) => post({ type: 'log', msg: 'decode thread: ' + e.message }));
let seqGen = 0;
const pool = []; // spent block buffers, sent back to the decoder for reuse
function recycle(ab) { if (ab && ab.byteLength && pool.length < 4) pool.push(ab); }
decoder.on('message', (m) => {
  const s = st.seq;
  if (!s || m.gen !== s.gen) { recycle(m.data); return; }
  s.requested.delete(m.i);
  if (m.type === 'error') { // decode here instead (counted as inlineDecodes)
    if (!s.decodeFailed) post({ type: 'log', msg: `decode thread: ${m.error}` });
    s.decodeFailed = true;
  }
  // Only keep blocks in the window being played: a late block from before a
  // seek/resume must not push the needed ones out of the small cache.
  if (m.type === 'block' && m.i >= s.wantBlock && m.i <= s.wantBlock + 2) {
    const evicted = s.file.putBlock(m.i, m.first, Buffer.from(m.data, 0, m.length));
    for (const e of evicted) if (e.data.byteOffset === 0 && e.data.buffer.byteLength >= e.data.length) recycle(e.data.buffer);
    if (m.ms > st.stats.prefetchMs) st.stats.prefetchMs = m.ms;
  } else recycle(m.data);
});

function requestAhead(frame) {
  const s = st.seq;
  if (!s || !s.file.compressed || s.decodeFailed) return;
  const b = s.file.blockIndexFor(Math.max(0, frame));
  s.wantBlock = b;
  for (let j = b; j <= b + 2 && j < s.file.blockCount; j++) {
    if (s.file.hasBlock(j) || s.requested.has(j)) continue;
    s.requested.add(j);
    const buf = pool.pop();
    decoder.postMessage({ type: 'decode', file: s.path, ident: s.ident, gen: s.gen, i: j, buf }, buf ? [buf] : []);
  }
}

function ensureFrameBuf(min) {
  const want = Math.max(min, st.outputs.maxChannel, st.seq ? st.seq.file.maxChannel : 0,
    st.matrix ? st.matrix.map.endChannel : 0);
  if (st.frameBuf.length !== want) st.frameBuf = Buffer.alloc(want);
}

function mediaNow() {
  const c = st.clock;
  if (!c) return 0;
  return c.mediaMs + (nowAbs() - c.at) * c.rate + st.offsetMs;
}

function blank() {
  st.frameBuf.fill(0);
  st.outputs.send(st.frameBuf, st.seq ? st.seq.file.stepMs : 50);
  if (!st.net) pushMatrix();
}

function pushMatrix(buf = st.frameBuf) {
  const m = st.matrix;
  if (!m || Atomics.load(m.hdr, 1) === 0) return;
  renderMatrix(m.map, buf, m.img);
  Atomics.add(m.hdr, 0, 1);
  Atomics.notify(m.hdr, 0);
}

// Aim at the frame after the last one sent, not "the frame after now".
// Otherwise a timer that fires a hair before a boundary sends nothing (old
// frame), and by the time we reschedule we're past the boundary, so we'd
// wait for the frame after: that frame went out ~one frame late (seen as
// ~1.5% of frames >20 ms late on a Pi 4).
function schedule() {
  clearTimeout(st.timer);
  if (!st.running || !st.seq) return;
  const step = st.seq.file.stepMs;
  const t = mediaNow();
  const target = Math.max(0, st.lastFrame + 1) * step;
  const waitMs = Math.max(0, (target - t) / (st.clock ? st.clock.rate || 1 : 1));
  st.timer = setTimeout(tick, waitMs > 1 ? waitMs - 0.5 : 0);
}

function tick() {
  if (!st.running || !st.seq) return;
  const f = st.seq.file;
  const step = f.stepMs;
  const t = mediaNow();
  const frame = Math.floor(t / step);

  if (frame >= f.frameCount) {
    if (!st.ended) { st.ended = true; post({ type: 'ended', id: st.seq.id }); }
    return; // stay on the last frame until main says otherwise
  }
  if (frame >= 0 && frame !== st.lastFrame) {
    const late = t - frame * step;
    if (st.lastFrame >= 0 && frame > st.lastFrame + 1) st.stats.late += frame - st.lastFrame - 1;
    if (late > st.stats.maxLateMs) st.stats.maxLateMs = late;
    const T = st.total;
    T.frames++;
    if (late > 10) T.over10++;
    if (late > 20) T.over20++;
    if (late > T.maxLateMs) T.maxLateMs = late;
    st.stats.sumLateMs += late;
    st.lastFrame = frame;
    if (f.frameInto(frame, st.frameBuf)) {
      const out = outFrame();
      st.outputs.send(out, step);
      if (!st.net) pushMatrix(out);
      st.stats.frames++;
    }
    requestAhead(frame);
  }
  schedule();
}

function reportStats() {
  const s = st.stats;
  const secs = (nowAbs() - s.since) / 1000;
  post({
    type: 'stats',
    playing: st.running && !!st.seq,
    sequence: st.seq ? st.seq.name : null,
    frame: st.lastFrame,
    mediaMs: st.running ? Math.round(mediaNow() - st.offsetMs) : null,
    fps: secs > 0 ? +(s.frames / secs).toFixed(1) : 0,
    skippedFrames: s.late,
    maxLateMs: +s.maxLateMs.toFixed(2),
    avgLateMs: s.frames ? +(s.sumLateMs / s.frames).toFixed(2) : 0,
    maxDecodeMs: +s.prefetchMs.toFixed(2),
    outputs: st.outputs.pollStats(),
    net: netStats(secs),
    total: { ...st.total, maxLateMs: +st.total.maxLateMs.toFixed(2), inlineDecodes: st.seq ? st.seq.file.syncDecodes : 0 },
  });
  st.stats = newStats();
}
setInterval(reportStats, 1000).unref();

// Test patterns for checking wiring without a sequence.
function runTest() {
  clearTimeout(st.timer);
  if (!st.test) return;
  ensureFrameBuf(0);
  const { pattern, color } = st.test;
  const n = Math.floor((nowAbs() - st.test.started) / 500);
  const buf = st.frameBuf;
  if (pattern === 'solid') {
    for (let i = 0; i < buf.length; i += 3) { buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2]; }
  } else { // 'rgbcycle' and 'chase'
    const c = n % 3;
    buf.fill(0);
    for (let i = 0; i < buf.length; i += 3) {
      if (pattern === 'chase' && ((i / 3) % 3) !== c) continue;
      buf[i + c] = 255;
    }
  }
  st.outputs.send(buf, 50);
  pushMatrix();
  st.timer = setTimeout(runTest, 50);
}

function configureMatrix(m, fifo) {
  if (st.matrix) { st.matrix.writer.terminate(); st.matrix = null; }
  configureNet(null);
  if (!m || !m.enabled || !fifo) return;
  const map = buildMatrixMap(m);
  const bytes = map.width * map.height * 3;
  const sab = new SharedArrayBuffer(8 + bytes);
  const writer = new Worker(path.join(__dirname, 'matrix-writer.js'), { workerData: { fifo, sab, bytes } });
  writer.on('error', (e) => post({ type: 'log', msg: 'matrix writer: ' + e.message }));
  st.matrix = { map, hdr: new Int32Array(sab, 0, 2), img: new Uint8Array(sab, 8, bytes), writer };
  if (m.source === 'network') configureNet({ base: map.base, len: bytes, end: map.endChannel, mode: m.ddpOffset || 'auto', port: m.ddpPort || 4048 });
}

// ---------------------------------------------------------------- DDP input
// The virtual matrix fed over the network (matrix.source = 'network'), like
// FPP's bridge mode but only for the matrix: DDP packets (port 4048) are
// collected into a frame and drawn when the sender's PUSH flag says the frame
// is complete. A frame with a piece missing (packet loss) is not drawn: the
// previous one stays up for that frame time instead of a torn picture.
// Offsets: "raw" = show channel numbers (the Player's own DDP output, FPP
// "DDP raw"); "relative" = 0 is the matrix's first channel (xLights' default
// for a DDP controller); "auto" decides per stream from the first packet.
function configureNet(cfg) {
  if (st.net) { try { st.net.sock.close(); } catch {} clearInterval(st.net.timer); if (st.net.active) post({ type: 'net', active: false }); st.net = null; }
  if (!cfg) return;
  const n = { ...cfg, buf: Buffer.alloc(cfg.end), got: 0, rel: null, active: false, lastAt: 0, sawPush: false,
    frames: 0, partial: 0, incomplete: 0, packets: 0, ignored: 0, from: null, framesWin: 0 };
  n.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  n.sock.on('error', (e) => post({ type: 'log', msg: `DDP input (port ${cfg.port}): ${e.message}` }));
  n.sock.on('message', (p, r) => onDdp(n, p, r));
  // A full matrix frame is ~120 packets; an unpaced sender (xLights) sends
  // them in one burst. Room for several frames so a burst isn't dropped by
  // the kernel (as root the cap can be raised; otherwise the default stays).
  n.sock.on('listening', () => {
    const want = 8 * 1024 * 1024;
    try { if (+fs.readFileSync('/proc/sys/net/core/rmem_max', 'utf8') < want) fs.writeFileSync('/proc/sys/net/core/rmem_max', String(want)); } catch {}
    try { n.sock.setRecvBufferSize(want); } catch {}
  });
  n.sock.bind(cfg.port, '0.0.0.0');
  n.timer = setInterval(() => {
    if (n.active && nowAbs() - n.lastAt > 2000) { n.active = false; n.rel = null; post({ type: 'net', active: false }); }
  }, 250);
  st.net = n;
}

function onDdp(n, p, r) {
  if (st.net !== n || p.length < 10) return;
  const flags = p[0];
  if ((flags & 0xc0) !== 0x40 || (flags & 0x02)) return; // DDP v1 data only (no queries/replies)
  if (p[3] !== 1 && p[3] !== 0) return;                 // default output device
  const hdr = flags & 0x10 ? 14 : 10;
  const off = p.readUInt32BE(4);
  const len = Math.min(p.readUInt16BE(8), p.length - hdr);
  // One sender at a time: a second one (xLights left outputting, a second
  // output to this address) would interleave frames. The first one keeps the
  // matrix until it has been quiet for 2 s.
  if (n.from && n.from !== r.address && n.active) { n.ignored++; n.ignoredFrom = r.address; return; }
  n.packets++;
  n.from = r.address;
  if (n.rel === null) n.rel = n.mode === 'relative' || (n.mode === 'auto' && off < n.base);
  const at = (n.rel ? n.base : 0) + off;
  if (len > 0 && at < n.buf.length) {
    const end = Math.min(at + len, n.buf.length);
    p.copy(n.buf, at, hdr, hdr + (end - at));
    // Bytes of the matrix this packet filled (for the completeness check).
    const a = Math.max(at, n.base), b = Math.min(end, n.base + n.len);
    if (b > a) n.got += b - a;
  }
  if (flags & 0x01) n.sawPush = true;
  if ((flags & 0x01) || (!n.sawPush && n.got >= n.len)) {
    // Complete, or nearly (a lost packet or two): draw it. A missing piece
    // keeps the previous frame's pixels for that part (a few rows for 1/40 s),
    // which beats dropping the whole frame: holding out for perfect frames
    // showed 3 of 40 frames a second with ~2 % loss. Frames missing more than
    // 10 % are skipped.
    if (n.got >= n.len * 0.9) {
      n.frames++; n.framesWin++;
      if (n.got < n.len) n.partial++;
      pushMatrix(n.buf);
    } else if (n.got > 0) n.incomplete++;
    n.got = 0;
    n.lastAt = nowAbs();
    if (!n.active) { n.active = true; post({ type: 'net', active: true, from: n.from }); }
  }
}

function netStats(secs) {
  const n = st.net;
  if (!n) return null;
  const fps = secs > 0 ? +(n.framesWin / secs).toFixed(1) : 0;
  n.framesWin = 0;
  return { active: n.active, fps, frames: n.frames, partial: n.partial, incomplete: n.incomplete, packets: n.packets, from: n.from,
    ignored: n.ignored, ignoredFrom: n.ignoredFrom || null, mbps: +((n.len * fps * 8) / 1e6).toFixed(1),
    offsets: n.rel === null ? n.mode : n.rel ? 'relative' : 'raw' };
}

parentPort.on('message', (m) => {
  try {
    switch (m.type) {
      case 'config':
        st.outputs.configure(m.outputs || [], { pacingMbps: m.outputPacingMbps });
        st.offsetMs = Number(m.syncOffsetMs) || 0;
        st.blankOnStop = m.blankBetweenSequences !== false;
        if ('matrix' in m) configureMatrix(m.matrix, m.matrixFifo);
        ensureFrameBuf(0);
        break;
      case 'load': {
        if (st.seq) st.seq.file.close();
        st.seq = null;
        st.running = false;
        st.ended = false;
        st.lastFrame = -1;
        const file = new FseqFile(m.file);
        // ident: which file this is on disk (inode/size/mtime). The decode
        // thread must read the very same file: xLights replaces a sequence
        // by writing a new file under the same name.
        const fst = fs.fstatSync(file.fd);
        const ident = `${fst.dev}:${fst.ino}:${fst.size}:${fst.mtimeMs}`;
        st.seq = { id: m.id, file, name: m.name, path: m.file, ident, gen: ++seqGen, requested: new Set(), wantBlock: 0 };
        st.total = { frames: 0, over10: 0, over20: 0, maxLateMs: 0 };
        ensureFrameBuf(0);
        requestAhead(Math.floor((Number(m.startMs) || 0) / file.stepMs)); // decode from where playback will start (0, or a resume point)
        post({ type: 'loaded', id: m.id, frameCount: file.frameCount, stepMs: file.stepMs, maxChannel: file.maxChannel });
        break;
      }
      case 'clock':
        st.test = null;
        st.clock = { mediaMs: m.mediaMs, at: m.at, rate: m.rate || 1 };
        if (m.running && st.seq) {
          requestAhead(Math.floor((m.mediaMs + st.offsetMs) / st.seq.file.stepMs)); // resume mid-song: start decoding there
          if (!st.running) { st.running = true; st.lastFrame = -1; st.ended = false; }
          tick();
        } else {
          st.running = false;
          clearTimeout(st.timer);
        }
        break;
      case 'stop':
        st.running = false;
        clearTimeout(st.timer);
        if (st.seq) { st.seq.file.close(); st.seq = null; }
        st.clock = null;
        st.lastFrame = -1;
        if (st.blankOnStop || m.blank) blank();
        break;
      case 'blank':
        blank();
        break;
      case 'brightness':
        st.brightness = Math.max(0, Math.min(1, Number(m.value)));
        if (!Number.isFinite(st.brightness)) st.brightness = 1;
        break;
      case 'matrixActive':
        if (st.matrix) {
          Atomics.store(st.matrix.hdr, 1, m.active ? 1 : 0);
          Atomics.notify(st.matrix.hdr, 1);
          if (m.active) pushMatrix();
        }
        break;
      case 'test':
        st.running = false;
        if (m.pattern) {
          st.test = { pattern: m.pattern, color: m.color || [255, 255, 255], started: nowAbs() };
          runTest();
        } else {
          st.test = null;
          clearTimeout(st.timer);
          blank();
        }
        break;
    }
  } catch (e) {
    post({ type: 'error', id: m.id, error: e.message });
  }
});

post({ type: 'ready' });
