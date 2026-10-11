// Decode thread: reads and decompresses fseq blocks ahead of time and hands
// them to the frame worker, so the thread that sends frames never spends
// time unpacking (about 9 ms per block on a Pi 4, enough to make frames late).

const { parentPort } = require('worker_threads');
const fs = require('fs');
const { FseqFile } = require('../fseq');

let cur = null; // { file, f }

parentPort.on('message', (m) => {
  if (m.type === 'close') { if (cur) cur.f.close(); cur = null; return; }
  if (m.type !== 'decode') return;
  try {
    // Reopen when the frame worker opened a different file than ours: the
    // same name re-uploaded from xLights is a new file (new block table,
    // new channel ranges). Decoding the old one by the new one's frame
    // numbers sent garbage to every controller until the player restarted.
    if (!cur || cur.file !== m.file || cur.ident !== m.ident) {
      if (cur) cur.f.close();
      cur = null;
      const f = new FseqFile(m.file);
      const st = fs.fstatSync(f.fd);
      const ident = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
      if (m.ident && ident !== m.ident) { f.close(); throw new Error('sequence file changed on disk; decoding in the frame thread'); }
      cur = { file: m.file, ident: m.ident, f };
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
