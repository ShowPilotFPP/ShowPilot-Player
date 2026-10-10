// Writes virtual-matrix images into the FIFO the display mpv reads as raw
// video. Its own thread so a slow or absent reader can never delay light
// frames. The frame worker drops the newest image into a SharedArrayBuffer;
// this loop writes only the latest one (older images are skipped, not
// queued, so the matrix never lags behind the lights).
//
// SAB layout: Int32 [0] = image sequence number, [1] = active flag,
// then the RGB24 image from byte 8.

const { workerData } = require('worker_threads');
const fs = require('fs');

const { fifo, sab, bytes } = workerData;
const hdr = new Int32Array(sab, 0, 2);
const img = new Uint8Array(sab, 8, bytes);
const out = Buffer.alloc(bytes);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleeper, 0, 0, ms);

let fd = null;
let last = -1;

function closeFd() { if (fd !== null) { try { fs.closeSync(fd); } catch {} fd = null; } }

function writeAll(buf) {
  let off = 0;
  const deadline = Date.now() + 250;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      if (e.code === 'EAGAIN' && Date.now() < deadline) { sleep(2); continue; }
      throw e;
    }
  }
}

for (;;) {
  if (Atomics.load(hdr, 1) === 0) { closeFd(); Atomics.wait(hdr, 1, 0, 1000); continue; }
  if (fd === null) {
    try {
      // Non-blocking open fails with ENXIO until mpv has the FIFO open.
      fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      last = -1;
    } catch { sleep(100); continue; }
  }
  const s = Atomics.load(hdr, 0);
  if (s === last) { Atomics.wait(hdr, 0, s, 200); continue; }
  last = s;
  out.set(img);
  try { writeAll(out); } catch { closeFd(); sleep(100); }
}
