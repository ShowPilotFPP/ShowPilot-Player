// Scheduler: starts and stops playlists (or runs commands) by day and time.
// Stored in media/config/schedule.json as an array of entries:
//   { id, enabled, type: 'playlist'|'command', playlist, repeat,
//     command, args, days: [0..6] (0 = Sunday),
//     startDate: 'YYYY-MM-DD' | '', endDate: 'YYYY-MM-DD' | '',
//     startTime: 'HH:MM' | 'dawn'|'sunrise'|'sunset'|'dusk', startOffset (min),
//     endTime: same forms, endOffset (min),
//     stopType: 'graceful' | 'hard' }
// An end time at or before the start runs past midnight. Entries earlier in
// the list win when two overlap. Booting inside a window starts the show.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const paths = require('./paths');
const { sunTimes } = require('./suntimes');

const FILE = () => path.join(paths.dir('config'), 'schedule.json');
const SUN = new Set(['dawn', 'sunrise', 'sunset', 'dusk']);

function load() {
  try { const a = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}

function clean(e) {
  const days = Array.isArray(e.days) ? e.days.map(Number).filter((d) => d >= 0 && d <= 6) : [0, 1, 2, 3, 4, 5, 6];
  return {
    id: typeof e.id === 'string' && e.id ? e.id : crypto.randomBytes(6).toString('hex'),
    enabled: e.enabled !== false,
    type: e.type === 'command' ? 'command' : 'playlist',
    playlist: String(e.playlist || ''),
    repeat: e.repeat !== false,
    command: String(e.command || ''),
    args: Array.isArray(e.args) ? e.args.map(String) : [],
    days: [...new Set(days)].sort(),
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(e.startDate || '') ? e.startDate : '',
    endDate: /^\d{4}-\d{2}-\d{2}$/.test(e.endDate || '') ? e.endDate : '',
    startTime: String(e.startTime || '17:00'),
    startOffset: Number(e.startOffset) || 0,
    endTime: String(e.endTime || '22:00'),
    endOffset: Number(e.endOffset) || 0,
    stopType: e.stopType === 'hard' ? 'hard' : 'graceful',
  };
}

function save(list) {
  const out = (Array.isArray(list) ? list : []).map(clean);
  const f = FILE();
  fs.writeFileSync(f + '.tmp', JSON.stringify(out, null, 2));
  fs.renameSync(f + '.tmp', f);
  return out;
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function resolveTime(day, spec, offsetMin, loc) {
  let t;
  if (SUN.has(spec)) {
    const s = sunTimes(day, loc.latitude, loc.longitude);
    if (!s || !s[spec]) return null;
    t = new Date(s[spec]);
  } else {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(spec);
    if (!m) return null;
    t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), +m[1], +m[2], +(m[3] || 0));
  }
  return new Date(+t + offsetMin * 60000);
}

// The occurrence of entry e that starts on `day` (local), or null.
function occurrence(e, day, loc) {
  if (!e.enabled || !e.days.includes(day.getDay())) return null;
  const d = ymd(day);
  if (e.startDate && d < e.startDate) return null;
  if (e.endDate && d > e.endDate) return null;
  const start = resolveTime(day, e.startTime, e.startOffset, loc);
  if (!start) return null;
  let end = resolveTime(day, e.endTime, e.endOffset, loc);
  if (!end) return null;
  if (end <= start) end = new Date(+end + 86400000);
  return { key: `${e.id}@${start.toISOString()}`, entry: e, start, end };
}

class Scheduler extends EventEmitter {
  constructor({ show, commands, config }) {
    super();
    this.show = show;
    this.commands = commands;
    this.config = config;
    this.active = null;      // occurrence currently driving the show
    this.fired = new Set();  // command occurrences already run
    this.enabled = true;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => this.emit('log', 'scheduler: ' + e.message)), 2000);
    setTimeout(() => this.tick().catch(() => {}), 1500);
  }

  stop() { clearInterval(this.timer); }

  entries() { return load(); }

  current(now = new Date()) {
    const loc = this.config.get().location || {};
    const list = load();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(+today - 86400000);
    const live = [];
    for (const e of list) {
      for (const day of [yesterday, today]) {
        const o = occurrence(e, day, loc);
        if (o && o.start <= now && now < o.end) live.push(o);
      }
    }
    return live;
  }

  upcoming(days = 7, now = new Date()) {
    const loc = this.config.get().location || {};
    const out = [];
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    for (let i = -1; i < days; i++) {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      for (const e of load()) {
        const o = occurrence(e, day, loc);
        if (o && o.end > now) out.push({ id: e.id, type: e.type, playlist: e.playlist, command: e.command, start: o.start, end: o.end });
      }
    }
    return out.sort((a, b) => a.start - b.start).slice(0, 50);
  }

  async tick(now = new Date()) {
    if (!this.enabled) return;
    const live = this.current(now);

    for (const o of live.filter((x) => x.entry.type === 'command')) {
      if (this.fired.has(o.key)) continue;
      this.fired.add(o.key);
      if (now - o.start < 120000) { // only fire near the start, not when booting mid-window
        this.commands.run(o.entry.command, o.entry.args).catch((e) => this.emit('log', `scheduled command failed: ${e.message}`));
      }
    }
    for (const k of this.fired) {
      const t = Date.parse(k.slice(k.indexOf('@') + 1));
      if (!(t > +now - 3 * 86400000)) this.fired.delete(k); // keys are "<id>@<start ISO>"
    }

    const want = live.find((x) => x.entry.type === 'playlist' && x.entry.playlist) || null;
    const curKey = this.active ? this.active.key : null;
    if (want && want.key === curKey) return;

    if (this.active) {
      const ending = this.active;
      this.active = null;
      // Only stop the show we started; a manual start in the meantime wins.
      const base = this.show.frames[0];
      if (base && base.name === ending.entry.playlist) {
        if (ending.entry.stopType === 'hard') await this.show.stopNow(); else this.show.stopGracefully();
      }
      this.emit('log', `schedule ended: ${ending.entry.playlist}`);
    }
    if (want) {
      this.active = want;
      this.emit('log', `schedule started: ${want.entry.playlist}`);
      try {
        await this.show.start(want.entry.playlist, { repeat: want.entry.repeat });
      } catch (e) { this.emit('log', `schedule could not start ${want.entry.playlist}: ${e.message}`); }
    }
  }
}

module.exports = { Scheduler, load, save, clean, occurrence };
