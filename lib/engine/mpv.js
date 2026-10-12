// Thin client for one long-lived mpv process driven over its JSON IPC
// socket. Keeping mpv running between songs (instead of spawning per file)
// removes per-song startup latency; per-file state still resets on loadfile.

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

let seq = 0;

class Mpv extends EventEmitter {
  constructor(name, args = [], { bin = process.env.SPP_MPV_BIN || 'mpv' } = {}) {
    super();
    this.name = name;
    this.args = args;
    this.bin = bin;
    this.sock = path.join(os.tmpdir(), `spp-mpv-${name}-${process.pid}-${++seq}.sock`);
    this.reqId = 0;
    this.pending = new Map();
    this.buf = '';
    this.ready = false;
    this.stopped = false;
    this.observers = new Map();
  }

  start() {
    try { fs.unlinkSync(this.sock); } catch {}
    const args = ['--idle=yes', '--no-config', '--no-terminal', '--input-ipc-server=' + this.sock, ...this.args];
    this.proc = spawn(this.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) this.emit('log', s); });
    this.proc.on('exit', (code, sig) => {
      this.ready = false;
      this.emit('exit', code, sig);
      for (const { reject } of this.pending.values()) reject(new Error('mpv exited'));
      this.pending.clear();
      if (!this.stopped) setTimeout(() => this.start(), 1000); // supervisor: never leave the show silent
    });
    this.proc.on('error', (e) => this.emit('log', `spawn failed: ${e.message}`));
    this._connect(0);
    return this;
  }

  _connect(tries) {
    const c = net.createConnection(this.sock);
    c.on('connect', () => {
      this.conn = c;
      this.ready = true;
      for (const [id, name] of this.observers) this._send({ command: ['observe_property', id, name] });
      this.emit('ready');
    });
    c.on('data', (d) => this._onData(d));
    c.on('error', () => {
      if (!this.ready && tries < 100 && !this.stopped) setTimeout(() => this._connect(tries + 1), 50);
    });
    c.on('close', () => { if (this.conn === c) { this.conn = null; this.ready = false; } });
  }

  _onData(d) {
    this.buf += d.toString();
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.request_id !== undefined && this.pending.has(msg.request_id)) {
        const { resolve, reject } = this.pending.get(msg.request_id);
        this.pending.delete(msg.request_id);
        if (msg.error && msg.error !== 'success') reject(new Error(msg.error)); else resolve(msg.data);
      } else if (msg.event === 'property-change') {
        this.emit('prop', msg.name, msg.data);
        this.emit('prop:' + msg.name, msg.data);
      } else if (msg.event) {
        this.emit(msg.event, msg);
      }
    }
  }

  _send(obj) {
    if (!this.conn) return false;
    this.conn.write(JSON.stringify(obj) + '\n');
    return true;
  }

  // command('loadfile', url, 'replace') or, with named arguments,
  // command({ name: 'loadfile', url, flags, options }). Named arguments are
  // needed where mpv's positional order changed between versions (0.38 put
  // an index before loadfile's options).
  command(...cmd) {
    const body = cmd.length === 1 && cmd[0] && typeof cmd[0] === 'object' && !Array.isArray(cmd[0]) ? cmd[0] : cmd;
    return new Promise((resolve, reject) => {
      const id = ++this.reqId;
      this.pending.set(id, { resolve, reject });
      if (!this._send({ command: body, request_id: id })) {
        this.pending.delete(id);
        reject(new Error('mpv not connected'));
      }
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('mpv timeout')); } }, 5000);
    });
  }

  get(name) { return this.command('get_property', name); }
  set(name, value) { return this.command('set_property', name, value); }

  observe(name) {
    const id = this.observers.size + 1;
    this.observers.set(id, name);
    if (this.ready) this._send({ command: ['observe_property', id, name] });
  }

  waitEvent(event, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.off(event, on); reject(new Error(`timeout waiting for ${event}`)); }, timeoutMs);
      const on = (m) => { clearTimeout(t); resolve(m); };
      this.once(event, on);
    });
  }

  whenReady(timeoutMs = 10000) {
    if (this.ready) return Promise.resolve();
    return this.waitEvent('ready', timeoutMs);
  }

  // Resolves once the process has exited (SIGKILL after killMs), so a
  // caller that needs the screen or the sound card back can wait for it.
  stop(killMs = 3000) {
    this.stopped = true;
    const p = this.proc;
    try { fs.unlinkSync(this.sock); } catch {}
    if (!p || p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, killMs);
      p.once('exit', () => { clearTimeout(t); resolve(); });
      try { p.kill('SIGTERM'); } catch { clearTimeout(t); resolve(); }
    });
  }
}

module.exports = Mpv;
