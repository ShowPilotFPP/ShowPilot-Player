// FPP MultiSync over UDP 32320 (see PRIMER.md "MultiSync"). Master side
// mirrors FPP's packets and cadence so unmodified FPP remotes (video, virtual
// matrix, extra outputs) follow us; remote side follows an FPP or ShowPilot
// Player master. Also answers xLights/FPP discovery pings.

const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const pkg = require('../package.json');

const PORT = 32320;
const MCAST = '239.70.80.80';
const T_CMD = 0, T_SYNC = 1, T_BLANK = 3, T_PING = 4, T_PLUGIN = 5, T_FPPCMD = 6;
const S_START = 0, S_STOP = 1, S_SYNC = 2, S_OPEN = 3;
const F_SEQ = 0, F_MEDIA = 1;
const MODE_PLAYER = 0x02, MODE_REMOTE = 0x08, MODE_SENDING = 0x04;

// We report FPP 9.3 so xLights enables FPP Connect features; our own version
// rides along in the version string.
const COMPAT_MAJOR = 9, COMPAT_MINOR = 3;
const VERSION_STRING = `${COMPAT_MAJOR}.${COMPAT_MINOR}-SPP-${pkg.version}`;

function piModel() {
  try { return fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim(); } catch { return ''; }
}

function typeIdFor(model) {
  const m = model || '';
  if (/Raspberry Pi 5/.test(m)) return 0x0e;
  if (/Raspberry Pi 4/.test(m) || /Compute Module 4/.test(m)) return 0x0d;
  if (/Zero 2 W/.test(m)) return 0x0f;
  if (/Raspberry Pi 3 Model B Plus/.test(m)) return 0x09;
  if (/Raspberry Pi 3 Model A Plus/.test(m)) return 0x0c;
  if (/Raspberry Pi 3/.test(m)) return 0x08;
  return 0x01; // generic FPP; anything < 0x80 is treated as a full FPP by xLights
}

function ifaces() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (name === 'lo' || /^(usb|tether|SoftAp)/.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      const bcast = ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.');
      out.push({ name, address: a.address, broadcast: bcast, linkLocal: a.address.startsWith('169.254.') });
    }
  }
  // Ignore 169.254 addresses on an interface that also has a routable one.
  return out.filter((a) => !a.linkLocal || !out.some((b) => b.name === a.name && !b.linkLocal));
}

function header(type, extraLen) {
  const b = Buffer.alloc(7 + extraLen);
  b.write('FPPD', 0, 'latin1');
  b[4] = type;
  b.writeUInt16LE(extraLen, 5);
  return b;
}

function syncPacket(action, fileType, frame, seconds, filename) {
  const name = Buffer.from(filename || '', 'utf8');
  const b = header(T_SYNC, 11 + name.length); // extra length counts the trailing NUL
  b[7] = action;
  b[8] = fileType;
  b.writeUInt32LE(Math.max(0, frame | 0), 9);
  b.writeFloatLE(seconds || 0, 13);
  name.copy(b, 17);
  b[17 + name.length] = 0;
  return b;
}

function cstr(buf, off, len) {
  const s = buf.subarray(off, Math.min(buf.length, off + len));
  const nul = s.indexOf(0);
  return s.toString('utf8', 0, nul === -1 ? s.length : nul);
}

class MultiSync extends EventEmitter {
  constructor({ config, player, commands }) {
    super();
    this.config = config;
    this.player = player;
    this.commands = commands;
    this.systems = new Map(); // address -> system
    this.model = piModel();
    this.typeId = typeIdFor(this.model);
    this.lastSeqFrame = -1;
    this.lastMediaHalf = -1;
    this.stats = { sent: 0, received: 0, lastMaster: null };
  }

  get cfg() { return this.config.get(); }
  isRemote() { return this.cfg.mode === 'remote'; }
  isSending() { return !this.isRemote() && !!this.cfg.multisync.enabled; }

  start() {
    this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock.on('error', (e) => this.emit('log', 'multisync socket: ' + e.message));
    this.sock.on('message', (m, rinfo) => this._onPacket(m, rinfo));
    this.sock.bind(PORT, () => {
      try { this.sock.setBroadcast(true); this.sock.setMulticastTTL(4); this.sock.setMulticastLoopback(false); } catch {}
      this._joinGroups();
      this.ping(true);
    });
    this._joinTimer = setInterval(() => this._joinGroups(), 60000);
    this._pingTimer = setInterval(() => this.ping(false), 3600000);

    const p = this.player;
    p.on('open', (e) => this._onOpen(e));
    p.on('start', (e) => this._onStart(e));
    p.on('resume', (e) => this._onStart(e));
    for (const ev of ['stop', 'paused', 'end']) p.on(ev, (e) => this._onStop(e));
    this._syncTimer = setInterval(() => this._periodic(), 5);
  }

  close() {
    clearInterval(this._syncTimer); clearInterval(this._pingTimer); clearInterval(this._joinTimer);
    try { this.sock.close(); } catch {}
  }

  _joinGroups() {
    this.joined = this.joined || new Set();
    for (const i of ifaces()) {
      if (this.joined.has(i.address)) continue;
      try { this.sock.addMembership(MCAST, i.address); this.joined.add(i.address); } catch {}
    }
  }

  // ---------------------------------------------------------------- sending
  _send(buf, { multicastOnly = false } = {}) {
    const c = this.cfg.multisync;
    const targets = new Set();
    for (const r of c.remotes || []) if (r) targets.add(r);
    for (const t of targets) this.sock.send(buf, PORT, t);
    const ifs = ifaces();
    if (c.multicast !== false || (!targets.size && !c.broadcast) || multicastOnly) {
      for (const i of ifs) {
        try { this.sock.setMulticastInterface(i.address); this.sock.send(buf, PORT, MCAST); } catch {}
      }
    }
    if (c.broadcast && !multicastOnly) for (const i of ifs) this.sock.send(buf, PORT, i.broadcast);
    this.stats.sent++;
  }

  _seqSecs() { return (this.player.mediaMs() + (Number(this.cfg.syncOffsetMs) || 0)) / 1000; }

  _onOpen(e) {
    if (!this.isSending()) return;
    if (e.sequence) this._send(syncPacket(S_OPEN, F_SEQ, 0, 0, e.sequence));
    if (e.media) this._send(syncPacket(S_OPEN, F_MEDIA, 0, 0, e.media));
  }

  _onStart(e) {
    if (!this.isSending()) return;
    this.lastSeqFrame = -1;
    this.lastMediaHalf = -1;
    const secs = (e.positionMs || 0) / 1000;
    if (e.sequence) this._send(syncPacket(S_START, F_SEQ, 0, 0, e.sequence));
    // FPP remotes honour seconds on MEDIA START, so a resume starts in place.
    if (e.media) this._send(syncPacket(S_START, F_MEDIA, 0, secs, e.media));
    this._periodic(true);
  }

  _onStop(e) {
    if (!this.isSending() || !e) return;
    if (e.sequence) this._send(syncPacket(S_STOP, F_SEQ, 0, 0, e.sequence));
    if (e.media) this._send(syncPacket(S_STOP, F_MEDIA, 0, 0, e.media));
  }

  // FPP cadence: sequence sync every 4 frames for the first 32 frames, then
  // every 10; media sync whenever int(seconds*2) changes (twice a second).
  _periodic(force) {
    if (!this.isSending() || this.player.state !== 'playing' || !this.player.item) return;
    const it = this.player.item;
    if (it.sequence && it.stepMs) {
      const secs = this._seqSecs();
      const frame = Math.max(0, Math.floor((secs * 1000) / it.stepMs));
      const gap = frame <= 32 ? 4 : 10;
      if (force || this.lastSeqFrame < 0 || frame - this.lastSeqFrame >= gap || frame < this.lastSeqFrame) {
        this.lastSeqFrame = frame;
        this._send(syncPacket(S_SYNC, F_SEQ, frame, secs, it.sequence));
      }
    }
    if (it.media) {
      const ms = this.player.mediaMs() / 1000;
      const half = Math.floor(ms * 2);
      if (force || half !== this.lastMediaHalf) {
        this.lastMediaHalf = half;
        this._send(syncPacket(S_SYNC, F_MEDIA, 0, ms, it.media));
      }
    }
  }

  blank() { if (this.isSending()) this._send(header(T_BLANK, 0)); }

  // Send an FPP command to remotes (FPP "multisyncCommand"). hosts: comma
  // separated names/IPs, empty = every remote.
  sendCommand(cmd, args = [], hosts = '') {
    if (!this.sock) return false;
    const parts = [String(hosts || ''), String(cmd), ...args.map(String)].map((s) => Buffer.from(s + '\0', 'utf8'));
    const body = Buffer.concat([Buffer.from([Math.min(255, args.length)]), ...parts]);
    const b = header(T_FPPCMD, body.length);
    body.copy(b, 7);
    try { this._send(b); } catch (e) { this.emit('log', `multisync command send failed: ${e.message}`); return false; }
    return true;
  }

  // ---------------------------------------------------------------- ping
  pingPacket(discover, ip) {
    const c = this.cfg;
    const b = header(T_PING, 359);
    const e = 7;
    b[e] = 4;
    b[e + 1] = discover ? 1 : 0;
    b[e + 2] = this.typeId;
    b.writeUInt16BE(COMPAT_MAJOR, e + 3);
    b.writeUInt16BE(COMPAT_MINOR, e + 5);
    b[e + 7] = (this.isRemote() ? MODE_REMOTE : MODE_PLAYER) | (this.isSending() ? MODE_SENDING : 0);
    const oct = (ip || '0.0.0.0').split('.').map(Number);
    for (let i = 0; i < 4; i++) b[e + 8 + i] = oct[i] || 0;
    b.write(String(c.hostName || os.hostname()).slice(0, 64), e + 12, 'utf8');
    b.write(VERSION_STRING.slice(0, 40), e + 77, 'utf8');
    b.write((this.model || 'ShowPilot Player').slice(0, 40), e + 118, 'utf8');
    b.write(this.channelRanges().slice(0, 120), e + 159, 'utf8');
    if (c.uuid) b.write(String(c.uuid).slice(0, 64), e + 294, 'utf8');
    return b;
  }

  ping(discover) {
    if (!this.sock) return;
    for (const i of ifaces()) {
      const pkt = this.pingPacket(discover, i.address);
      try { this.sock.send(pkt, PORT, i.broadcast); } catch {}
      try { this.sock.setMulticastInterface(i.address); this.sock.send(pkt, PORT, MCAST); } catch {}
    }
  }

  channelRanges() {
    const r = [];
    for (const o of this.cfg.outputs || []) {
      if (o.enabled === false) continue;
      const s = Math.max(0, (o.startChannel | 0) - 1);
      const n = o.type === 'e131' ? (o.universeCount || 1) * Math.min(512, o.universeSize || 512) : (o.channelCount | 0);
      if (n > 0) r.push(`${s}-${s + n - 1}`);
    }
    return r.join(',') || '0-0';
  }

  // ---------------------------------------------------------------- receive
  _isLocal(addr) { return ifaces().some((i) => i.address === addr); }

  _onPacket(m, rinfo) {
    if (m.length < 7 || m.toString('latin1', 0, 4) !== 'FPPD') return;
    const len = m.readUInt16LE(5);
    if (m.length !== 7 + len) return;
    if (this._isLocal(rinfo.address) && m[4] !== T_PING) return;
    this.stats.received++;
    switch (m[4]) {
      case T_SYNC: if (this.isRemote()) this._onSync(m, rinfo); break;
      case T_BLANK: if (this.isRemote() && this.player.state === 'idle') this.player.worker.postMessage({ type: 'blank' }); break;
      case T_PING: this._onPing(m, rinfo, len); break;
      case T_FPPCMD: this._onFppCommand(m, len); break;
      case T_CMD: break; // legacy text commands are not supported
      case T_PLUGIN: this.emit('plugin', { name: cstr(m, 7, len), rinfo }); break;
    }
  }

  async _onSync(m, rinfo) {
    if (m.length < 18) return;
    const action = m[7], fileType = m[8];
    const frame = m.readUInt32LE(9);
    let seconds = m.readFloatLE(13);
    const name = cstr(m, 17, m.length - 17);
    if (!name || name.includes('/') || name.includes('\\')) return;
    this.stats.lastMaster = rinfo.address;
    const off = (Number(this.cfg.multisync.remoteOffsetMs) || 0) / 1000;
    seconds = Math.max(0, seconds + off);
    const p = this.player;
    const it = p.item;
    try {
      if (fileType === F_SEQ) {
        if (action === S_STOP) { if (it && it.sequence === name) await p.stop(); return; }
        if (action === S_OPEN) return;
        if (action === S_START && !(it && it.sequence === name)) {
          this._pendingSeq = name;
          await p.followMaster({ sequence: name, media: this._pendingMedia, seconds: 0 });
          return;
        }
        if (action === S_SYNC) {
          // Trust seconds over the frame number, like FPP remotes do.
          const secs = seconds > 0.0001 ? seconds : (frame * (it && it.stepMs ? it.stepMs : 25)) / 1000;
          await p.followMaster({ sequence: name, media: it && it.sequence === name ? undefined : this._pendingMedia, seconds: secs });
        }
      } else if (fileType === F_MEDIA) {
        if (action === S_OPEN) { this._pendingMedia = name; return; }
        if (action === S_STOP) { if (this._pendingMedia === name) this._pendingMedia = null; if (it && !it.sequence && it.media === name) await p.stop(); return; }
        if (action === S_START) { this._pendingMedia = name; }
        // Media positions only drive us when no sequence is running (video/media-only remotes).
        if (!it || !it.sequence) {
          if (action === S_SYNC || (action === S_START)) await p.followMaster({ media: name, seconds });
        }
      }
    } catch (e) { this.emit('log', `multisync follow: ${e.message}`); }
  }

  _onPing(m, rinfo, len) {
    if (len < 169) return;
    const e = 7;
    const discover = m[e + 1] === 1;
    const ip = [m[e + 8], m[e + 9], m[e + 10], m[e + 11]].join('.');
    const hostname = cstr(m, e + 12, 65);
    if (hostname === this.cfg.hostName && this._isLocal(rinfo.address)) return;
    const address = ip !== '0.0.0.0' ? ip : (discover ? null : rinfo.address);
    if (address && !this._isLocal(address)) {
      const mode = m[e + 7];
      this.systems.set(address, {
        address, hostname,
        typeId: m[e + 2],
        majorVersion: m.readUInt16BE(e + 3),
        minorVersion: m.readUInt16BE(e + 5),
        fppMode: mode & ~MODE_SENDING,
        multisync: !!(mode & MODE_SENDING),
        version: cstr(m, e + 77, 41),
        model: cstr(m, e + 118, 41),
        channelRanges: len > 169 ? cstr(m, e + 159, 135) : '',
        uuid: len >= 359 ? cstr(m, e + 294, 65) : '',
        lastSeen: Math.floor(Date.now() / 1000),
      });
    }
    if (discover) {
      // Reply: broadcast on every interface, then unicast to the asker, all to port 32320.
      setTimeout(() => {
        this.ping(false);
        for (const i of ifaces()) {
          const pkt = this.pingPacket(false, i.address);
          if (ip !== '0.0.0.0') this.sock.send(pkt, PORT, ip);
          if (rinfo.address !== ip) this.sock.send(pkt, PORT, rinfo.address);
        }
      }, Math.random() * 5);
    }
  }

  _onFppCommand(m, len) {
    let p = 8;
    const n = m[7];
    const next = () => { const s = cstr(m, p, m.length - p); p += Buffer.byteLength(s) + 1; return s; };
    const host = next();
    const cmd = next();
    const args = [];
    for (let i = 0; i < n; i++) args.push(next());
    if (host) {
      const me = [this.cfg.hostName, os.hostname(), ...ifaces().map((i) => i.address)].map((x) => String(x).toLowerCase());
      if (!host.split(',').some((h) => me.includes(h.trim().toLowerCase()))) return;
    }
    this.commands.run(cmd, args).catch((e) => this.emit('log', `multisync command ${cmd}: ${e.message}`));
  }

  // ---------------------------------------------------------------- API views
  localSystems() {
    const c = this.cfg;
    return ifaces().map((i) => ({
      type: this.model || 'ShowPilot Player', typeId: this.typeId,
      majorVersion: COMPAT_MAJOR, minorVersion: COMPAT_MINOR, uuid: c.uuid,
      fppMode: this.isRemote() ? MODE_REMOTE : MODE_PLAYER,
      multisync: this.isSending(),
      fppModeString: this.isRemote() ? 'remote' : 'player',
      address: i.address, hostname: c.hostName, version: VERSION_STRING,
      model: this.model || 'ShowPilot Player', channelRanges: this.channelRanges(),
      local: 1, multiSyncCapable: 1, HostDescription: c.hostDescription || '',
      channelInputsEnabled: false, channelOutputsEnabled: true,
    }));
  }

  allSystems() {
    const remote = [...this.systems.values()].map((s) => ({
      type: s.model, typeId: s.typeId, majorVersion: s.majorVersion, minorVersion: s.minorVersion,
      uuid: s.uuid, fppMode: s.fppMode, multisync: s.multisync,
      fppModeString: s.fppMode === MODE_REMOTE ? 'remote' : s.fppMode === MODE_PLAYER ? 'player' : s.fppMode === 1 ? 'bridge' : 'unknown',
      address: s.address, hostname: s.hostname, version: s.version, model: s.model,
      channelRanges: s.channelRanges, local: 0, multiSyncCapable: 1, lastSeen: s.lastSeen,
    }));
    return { systems: [...this.localSystems(), ...remote] };
  }
}

module.exports = { MultiSync, syncPacket, header, ifaces, typeIdFor, VERSION_STRING, COMPAT_MAJOR, COMPAT_MINOR, PORT, MCAST };
