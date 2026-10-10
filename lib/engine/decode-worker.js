// Decode thread: reads and decompresses fseq blocks ahead of time and hands
// them to the frame worker, so the thread that sends frames never spends
// time unpacking (about 9 ms per block on a Pi 4, enough to make frames late).

const { parentPort } = require('worker_threads');
const { FseqFile } = require('../fseq');

let cur = null; // { file, f }

parentPort.on('message', (m) => {
  if (m.type === 'close') { if (cur) cur.f.close(); cur = null; return; }
  if (m.type !== 'decode') return;
  try {
    if (!cur || cur.file !== m.file) {
      if (cur) cur.f.close();
      cur = { file: m.file, f: new FseqFile(m.file) };
    }
    if (m.i < 0 || m.i >= cur.f.blockCount) return;
    const t0 = performance.now();
    const { first, data } = cur.f.decodeBlock(m.i);
    // Fill a recycled buffer from the frame worker when one fits, so the
    // frame thread never allocates (big allocations trigger GC pauses there).
    const ab = m.buf && m.buf.byteLength >= data.length ? m.buf : new ArrayBuffer(data.length);
    new Uint8Array(ab, 0, data.length).set(data);
    parentPort.postMessage({ type: 'block', file: m.file, gen: m.gen, i: m.i, first, data: ab, length: data.length, ms: performance.now() - t0 }, [ab]);
  } catch (e) {
    const back = m.buf ? [m.buf] : [];
    parentPort.postMessage({ type: 'error', file: m.file, gen: m.gen, i: m.i, error: e.message, data: m.buf || null }, back);
  }
});
