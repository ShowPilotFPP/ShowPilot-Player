// Paced UDP sender (its own thread). Gets one batch of packets per frame
// from the frame worker and clocks each controller's packets out at a rate
// it can absorb, like FPP does with the kernel's fq qdisc and
// SO_MAX_PACING_RATE (90 Mbit/s per destination by default): a full frame
// burst at gigabit line rate overruns switch buffers on the way down to a
// 100 Mbit device, and those drops are silent (seen as DDP sequence errors
// and stale bands on a 240x240 matrix FPP).
//
// One connected socket per destination, so a send goes straight to the
// kernel (no address lookup) and the sleeps between sends are real gaps on
// the wire. Destinations are interleaved: a small controller isn't held up
// behind a big one.

const { parentPort, workerData } = require('worker_threads');
const dgram = require('dgram');
const { performance } = require('perf_hooks');

const now = () => performance.now();
const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleepUntil(t) {
  const d = t - now();
  if (d > 0.05) Atomics.wait(sleeper, 0, 0, d);
}

const socks = new Map(); // "ip:port" -> { sock, ready }
let fallback = null;     // unconnected socket while a destination connects
const stats = { packets: 0, bytes: 0, frames: 0, sendErrors: 0, maxSendMs: 0, overBudget: 0, reanchors: 0 };
const cadence = { last: 0, step: 0 };

function fallbackSock() {
  if (!fallback) {
    fallback = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    fallback.on('error', () => {});
    fallback.bind(0, () => { try { fallback.setBroadcast(true); fallback.setMulticastTTL(4); } catch {} });
  }
  return fallback;
}

function dest(key) {
  let d = socks.get(key);
  if (d) return d;
  const i = key.lastIndexOf(':');
  const ip = key.slice(0, i), port = Number(key.slice(i + 1));
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  d = { sock, ready: false, ip, port };
  sock.on('error', () => { stats.sendErrors++; });
  sock.bind(0, () => {
    try { sock.setBroadcast(true); sock.setMulticastTTL(4); } catch {}
    try { sock.setSendBufferSize(4 * 1024 * 1024); } catch {}
    sock.connect(port, ip, (err) => { if (!err) d.ready = true; });
  });
  socks.set(key, d);
  return d;
}

function send(d, buf) {
  try {
    if (d.ready) d.sock.send(buf);
    else fallbackSock().send(buf, d.port, d.ip);
    stats.packets++; stats.bytes += buf.length;
  } catch { stats.sendErrors++; }
}

// batch: { data: ArrayBuffer,
//          meta: Int32Array [offset, length, socketIndex, groupIndex]*,
//          dests: ["ip:port"] (socketIndex), groups (count), stepMs, mbps }
// A group is one controller (one output entry): its packets go out in order
// at the pacing rate. groupIndex -1 = after every other packet (E1.31 sync).
const pending = workerData && workerData.pending ? new Int32Array(workerData.pending) : null;
function sendBatch(b) {
  const t0 = now();
  const data = Buffer.from(b.data);
  const n = b.meta.length / 4;
  const ds = b.dests.map(dest);
  const G = b.groups | 0;
  const queues = Array.from({ length: G }, () => []);
  const bytes = new Array(G).fill(0);
  const tail = [];
  for (let i = 0; i < n; i++) {
    const o = b.meta[i * 4], l = b.meta[i * 4 + 1], s = b.meta[i * 4 + 2], g = b.meta[i * 4 + 3];
    const item = [ds[s], data.subarray(o, o + l)];
    if (g < 0 || g >= G) tail.push(item);
    else { queues[g].push(item); bytes[g] += l; }
  }
  const paced = b.mbps > 0;
  const step = b.stepMs || 25;
  const budget = Math.max(5, step * 0.8); // the frame must be out well before the next one
  const rate = bytes.map((total) => {
    if (!paced) return Infinity;
    const r = b.mbps * 125; // Mbit/s -> bytes per ms
    if (total / r > budget) { stats.overBudget++; return total / budget; }
    return r;
  });
  const next = new Array(G).fill(t0);
  if (paced) {
    // Steady cadence: every frame finishes (its PUSH packet arrives) exactly
    // one frame time after the previous one, a few ms after it was handed
    // over. Receivers that also output on their own timer (FPP bridge mode:
    // every 50 ms after its last output) otherwise catch a frame half sent
    // whenever one is a little late, and show the top of the new frame over
    // the bottom of the old one (a tear line across moving shapes).
    let dur = 0;
    for (let k = 0; k < G; k++) if (bytes[k]) dur = Math.max(dur, bytes[k] / rate[k]);
    const slack = Math.min(5, step * 0.15);
    let deadline = cadence.last + step;
    if (!cadence.last || step !== cadence.step || deadline < t0 + dur * 0.6 || deadline > t0 + dur + slack * 3) {
      deadline = t0 + dur + slack; // start (or re-anchor) the cadence
      stats.reanchors++;
    }
    cadence.last = deadline;
    cadence.step = step;
    // Each controller starts so its last packet goes at the deadline; one
    // that would have to start in the past is sent a bit faster instead.
    for (let k = 0; k < G; k++) {
      if (!bytes[k]) continue;
      const start = deadline - bytes[k] / rate[k];
      if (start >= t0) next[k] = start;
      else rate[k] = bytes[k] / Math.max(0.5, deadline - t0);
    }
  }
  const pos = new Array(G).fill(0);
  for (let left = n - tail.length; left > 0; left--) {
    // The controller whose next packet may go soonest.
    let k = -1;
    for (let j = 0; j < G; j++) if (pos[j] < queues[j].length && (k < 0 || next[j] < next[k])) k = j;
    if (paced) sleepUntil(next[k]);
    const [d, buf] = queues[k][pos[k]++];
    send(d, buf);
    // Keep the average rate: an oversleep is caught up with, unless far behind.
    const t = now();
    if (t - next[k] > 2) next[k] = t;
    next[k] += buf.length / rate[k];
  }
  for (const [d, buf] of tail) send(d, buf);
  stats.frames++;
  const took = now() - t0;
  if (took > stats.maxSendMs) stats.maxSendMs = took;
  if (pending) Atomics.sub(pending, 0, 1);
}

parentPort.on('message', (m) => {
  if (m.type === 'batch') sendBatch(m);
  else if (m.type === 'stats') { parentPort.postMessage({ type: 'stats', stats: { ...stats } }); stats.maxSendMs = 0; }
  else if (m.type === 'close') { for (const d of socks.values()) try { d.sock.close(); } catch {} process.exit(0); }
});
