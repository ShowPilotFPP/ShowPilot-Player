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

const dgram = require('dgram');

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

class OutputSet {
  constructor(list = []) {
    this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock.on('error', (e) => console.error('[outputs] socket error:', e.message));
    this.sock.bind(0, () => { try { this.sock.setBroadcast(true); this.sock.setMulticastTTL(4); } catch {} });
    this.configure(list);
  }

  configure(list) {
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

  send(frame) {
    for (const o of this.outputs) o.send(this.sock, frame);
    // Sync packets go after every data packet of the frame, once per address.
    const done = new Set();
    for (const o of this.outputs) if (o.sync && !done.has(o.sync)) { done.add(o.sync); o.sendSync(this.sock); }
  }

  close() { try { this.sock.close(); } catch {} }
}

module.exports = { OutputSet, DdpOutput, E131Output, e131Packet, DDP_PORT, E131_PORT, multicastFor };
