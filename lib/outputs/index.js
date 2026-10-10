// Channel outputs: DDP and E1.31 (sACN), byte-compatible with what FPP sends
// (see PRIMER.md "Outputs"). Runs inside the frame worker, so nothing here
// may block or allocate per channel.
//
// Output entry (config.outputs[]):
//   { type: 'ddp'|'e131', enabled, description, ip, startChannel (1-based),
//     channelCount,
//     ddpOneBased: false,                       // DDP: offset relative to this output
//     universe, universeCount, universeSize,    // E1.31
//     multicast: true, priority: 0, syncUniverse: 0 }

const DDP_PORT = 4048;
const DDP_MAX = 1440;
const E131_PORT = 5568;
const E131_CID = Buffer.from('FALCON FPP\0\0\0\0\0\0', 'latin1'); // FPP's constant CID
const E131_SOURCE = 'ShowPilot Player';

class DdpOutput {
  constructor(cfg) {
    this.ip = cfg.ip;
    this.start = Math.max(0, (cfg.startChannel | 0) - 1);
    this.count = Math.max(0, cfg.channelCount | 0);
    this.oneBased = !!cfg.ddpOneBased;
    this.seq = 1;
    const n = Math.ceil(this.count / DDP_MAX);
    this.packets = [];
    for (let i = 0; i < n; i++) {
      const len = Math.min(DDP_MAX, this.count - i * DDP_MAX);
      const p = Buffer.alloc(10 + len);
      p[0] = i === n - 1 ? 0x41 : 0x40; // version 1, PUSH on the last packet only
      p[2] = 0x00;                       // data type: undefined (FPP sends 0)
      p[3] = 0x01;                       // destination: default display
      p.writeUInt32BE((this.oneBased ? 0 : this.start) + i * DDP_MAX, 4);
      p.writeUInt16BE(len, 8);
      this.packets.push(p);
    }
  }

  send(sock, frame) {
    for (let i = 0; i < this.packets.length; i++) {
      const p = this.packets[i];
      const from = this.start + i * DDP_MAX;
      frame.copy(p, 10, from, from + p.length - 10);
      p[1] = this.seq;
      this.seq = this.seq === 15 ? 1 : this.seq + 1;
      sock.send(p, DDP_PORT, this.ip);
    }
  }
}

function e131Packet(universe, size, priority, syncUniverse) {
  const p = Buffer.alloc(126 + size);
  p.writeUInt16BE(0x0010, 0);
  p.writeUInt16BE(0x0000, 2);
  p.write('ASC-E1.17\0\0\0', 4, 'latin1');
  p.writeUInt16BE(0x7000 | (110 + size), 16);
  p.writeUInt32BE(0x00000004, 18);
  E131_CID.copy(p, 22);
  p.writeUInt16BE(0x7000 | (88 + size), 38);
  p.writeUInt32BE(0x00000002, 40);
  p.write(E131_SOURCE, 44, 64, 'latin1');
  p[108] = priority & 0xff;
  p.writeUInt16BE(syncUniverse & 0xffff, 109);
  p[112] = 0;
  p.writeUInt16BE(universe & 0xffff, 113);
  p.writeUInt16BE(0x7000 | (11 + size), 115);
  p[117] = 0x02;
  p[118] = 0xa1;
  p.writeUInt16BE(0x0000, 119);
  p.writeUInt16BE(0x0001, 121);
  p.writeUInt16BE(size + 1, 123);
  p[125] = 0x00;
  return p;
}

function e131SyncPacket(syncUniverse) {
  const p = Buffer.alloc(49);
  p.writeUInt16BE(0x0010, 0);
  p.write('ASC-E1.17\0\0\0', 4, 'latin1');
  p.writeUInt16BE(0x7021, 16);
  p.writeUInt32BE(0x00000008, 18);
  E131_CID.copy(p, 22);
  p.writeUInt16BE(0x700b, 38);
  p.writeUInt32BE(0x00000001, 40);
  p.writeUInt16BE(syncUniverse, 45);
  return p;
}

function multicastFor(u) { return `239.255.${(u >> 8) & 0xff}.${u & 0xff}`; }

class E131Output {
  constructor(cfg) {
    this.start = Math.max(0, (cfg.startChannel | 0) - 1);
    this.size = Math.min(512, Math.max(1, (cfg.universeSize | 0) || 512));
    const first = Math.max(1, cfg.universe | 0);
    const count = Math.max(1, cfg.universeCount | 0 || 1);
    const multicast = cfg.multicast !== false;
    this.sync = (cfg.syncUniverse | 0) > 0 && (cfg.syncUniverse | 0) < 64000 ? cfg.syncUniverse | 0 : 0;
    this.universes = [];
    for (let x = 0; x < count; x++) {
      const u = first + x;
      this.universes.push({
        u, seq: 0,
        dest: multicast ? multicastFor(u) : cfg.ip,
        pkt: e131Packet(u, this.size, cfg.priority | 0, this.sync),
        from: this.start + x * this.size,
      });
    }
    if (this.sync) { this.syncPkt = e131SyncPacket(this.sync); this.syncSeq = 0; this.syncDest = multicastFor(this.sync); }
  }

  send(sock, frame) {
    for (const s of this.universes) {
      frame.copy(s.pkt, 126, s.from, s.from + this.size);
      s.seq = (s.seq + 1) & 0xff;
      s.pkt[111] = s.seq;
      sock.send(s.pkt, E131_PORT, s.dest);
    }
  }

  sendSync(sock) {
    if (!this.sync) return;
    this.syncSeq = (this.syncSeq + 1) & 0xff;
    this.syncPkt[44] = this.syncSeq;
    sock.send(this.syncPkt, E131_PORT, this.syncDest);
  }
}

// Sending is paced like FPP (UDPOutput.cpp: fq qdisc + SO_MAX_PACING_RATE,
// "UDPPacingRate" 90 Mbit/s per destination). A full frame fired at gigabit
// line rate overruns the switch's buffer where it steps down to a 100 Mbit
// device; those drops are silent and show as DDP sequence errors and stale
// bands on a big matrix. Node can't set SO_MAX_PACING_RATE, so a dedicated
// thread (sender-worker.js) clocks each controller's packets out at that
// rate, controllers interleaved, and always finishes a frame within 80% of
// the frame time (a controller that needs more than that is sent faster).
//
// The frame worker builds every packet of a frame into one buffer and hands
// it over (transferred, no copy). If the sender is still two frames behind,
// a frame is dropped instead of piling up delay (stats.droppedFrames).
const DEFAULT_PACING_MBPS = 90;
const BURST = 24; // kept for older callers

class OutputSet {
  // opts.transport(batch): replaces the sender thread (tests).
  constructor(list = [], opts = {}) {
    this.mbps = DEFAULT_PACING_MBPS;
    this.transport = opts.transport || null;
    this.sender = null;
    this.pending = new Int32Array(new SharedArrayBuffer(4));
    this.stats = { frames: 0, packets: 0, droppedFrames: 0 };
    this.senderStats = null;
    this.configure(list, opts);
    if (!this.transport) this._startSender(); // ready (sockets connected) before the first frame
  }

  configure(list, opts = {}) {
    if (opts.pacingMbps !== undefined && opts.pacingMbps !== null) {
      const v = Number(opts.pacingMbps);
      this.mbps = Number.isFinite(v) && v >= 0 ? v : DEFAULT_PACING_MBPS;
    }
    this.outputs = [];
    let max = 0;
    for (const o of list || []) {
      if (!o || o.enabled === false) continue;
      try {
        if (o.type === 'ddp' && o.ip && o.channelCount > 0) this.outputs.push(new DdpOutput(o));
        else if (o.type === 'e131') this.outputs.push(new E131Output(o));
        else continue;
        const last = this.outputs[this.outputs.length - 1];
        const end = last instanceof DdpOutput ? last.start + last.count : last.start + last.universes.length * last.size;
        if (end > max) max = end;
      } catch (e) { console.error('[outputs] bad output entry:', e.message); }
    }
    this.maxChannel = max;
  }

  _startSender() {
    const { Worker } = require('worker_threads');
    const path = require('path');
    this.sender = new Worker(path.join(__dirname, 'sender-worker.js'), { workerData: { pending: this.pending.buffer } });
    this.sender.on('error', (e) => { console.error('[outputs] sender:', e.message); this.sender = null; Atomics.store(this.pending, 0, 0); });
    this.sender.on('message', (m) => { if (m && m.type === 'stats') this.senderStats = m.stats; });
    this.sender.unref();
  }

  // stepMs: the sequence's frame time (the frame must be out well within it).
  send(frame, stepMs) {
    const packets = [];   // [buf, sockKey, group]
    let total = 0;
    this.outputs.forEach((o, g) => {
      o.send({ send: (p, port, ip) => { packets.push([p, `${ip}:${port}`, g]); total += p.length; } }, frame);
    });
    // Sync packets go after every data packet of the frame, once per address.
    const done = new Set();
    for (const o of this.outputs) {
      if (o.sync && !done.has(o.sync)) {
        done.add(o.sync);
        o.sendSync({ send: (p, port, ip) => { packets.push([p, `${ip}:${port}`, -1]); total += p.length; } });
      }
    }
    if (!packets.length) return;
    const data = new ArrayBuffer(total);
    const view = Buffer.from(data);
    const meta = new Int32Array(packets.length * 4);
    const keys = new Map();
    let off = 0;
    packets.forEach(([p, key, g], i) => {
      p.copy(view, off); // own copy: the packet buffers are reused next frame
      let s = keys.get(key);
      if (s === undefined) { s = keys.size; keys.set(key, s); }
      meta[i * 4] = off; meta[i * 4 + 1] = p.length; meta[i * 4 + 2] = s; meta[i * 4 + 3] = g;
      off += p.length;
    });
    const batch = { type: 'batch', data, meta, dests: [...keys.keys()], groups: this.outputs.length, stepMs: stepMs || 0, mbps: this.mbps };
    this.stats.frames++;
    this.stats.packets += packets.length;
    if (this.transport) return this.transport(batch);
    if (!this.sender) this._startSender();
    if (Atomics.load(this.pending, 0) >= 2) { this.stats.droppedFrames++; return; }
    Atomics.add(this.pending, 0, 1);
    this.sender.postMessage(batch, [data]);
  }

  // Latest numbers from the sender thread (refreshed each call).
  pollStats() {
    if (this.sender) this.sender.postMessage({ type: 'stats' });
    return { ...this.stats, pacingMbps: this.mbps, sender: this.senderStats };
  }

  close() {
    if (this.sender) { try { this.sender.postMessage({ type: 'close' }); } catch {} this.sender = null; }
  }
}

module.exports = { BURST, DEFAULT_PACING_MBPS, OutputSet, DdpOutput, E131Output, e131Packet, DDP_PORT, E131_PORT, multicastFor };
