// Scheduler: starts and stops playlists or sequences, and runs commands, by
// day and time. Stored in media/config/schedule.json as an array of entries:
//   { id, enabled,
//     type: 'playlist' | 'sequence' | 'command',
//     playlist, sequence, repeat (bool),
//     command, args, multisyncCommand, multisyncHosts,
//     repeatEvery (minutes; 0 = once): commands run again every N minutes
//       until the end time; playlists/sequences start again every N minutes
//       when nothing is playing,
//     days: [0..6] (0 = Sunday),
//     startDate/endDate: '' | 'YYYY-MM-DD' | '0000-MM-DD' (every year) |
//       holiday shortName (see holidays.js), startDateOffset/endDateOffset
//       (days, holidays only),
//     startTime/endTime: 'HH:MM' | 'dawn' | 'sunrise' | 'sunset' | 'dusk',
//     startOffset/endOffset (minutes),
//     stopType: 'graceful' | 'loop' | 'hard' }
// An end time at or before the start runs past midnight; the day it starts
// on is the day that counts. Entries earlier in the list win when two
// overlap. Booting inside a window starts the show.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const paths = require('./paths');
const playlists = require('./playlists');
const holidays = require('./holidays');
const { sunTimes } = require('./suntimes');

const FILE = () => path.join(paths.dir('config'), 'schedule.json');
const SUN = new Set(['dawn', 'sunrise', 'sunset', 'dusk']);
const TYPES = new Set(['playlist', 'sequence', 'command']);
const LITERAL = /^\d{4}-\d{2}-\d{2}$/;
const CATCH_UP_MS = 120000; // a command due less than 2 minutes ago still runs

function load() {
  try { const a = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return Array.isArray(a) ? a.map(clean) : []; } catch { return []; }
}

const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
const dateSpec = (v) => {
  const s = String(v || '').trim();
  return LITERAL.test(s) || /^[A-Za-z][A-Za-z0-9_]*$/.test(s) ? s : '';
};
const timeSpec = (v, d) => {
  const s = String(v || '').trim();
  if (SUN.has(s.toLowerCase())) return s.toLowerCase();
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  return m && +m[1] <= 24 && +m[2] < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : d;
};

function clean(e) {
  e = e || {};
  const days = Array.isArray(e.days) ? e.days.map(Number).filter((d) => d >= 0 && d <= 6) : [0, 1, 2, 3, 4, 5, 6];
  const type = TYPES.has(e.type) ? e.type : 'playlist';
  return {
    id: typeof e.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(e.id) ? e.id : crypto.randomBytes(6).toString('hex'),
    enabled: e.enabled !== false,
    type,
    playlist: String(e.playlist || ''),
    sequence: String(e.sequence || ''),
    repeat: e.repeat !== false,
    command: String(e.command || ''),
    args: Array.isArray(e.args) ? e.args.map((a) => (a === null || a === undefined ? '' : String(a))) : [],
    multisyncCommand: !!e.multisyncCommand,
    multisyncHosts: String(e.multisyncHosts || ''),
    repeatEvery: num(e.repeatEvery, 0, 1440),
    days: [...new Set(days)].sort(),
    startDate: dateSpec(e.startDate),
    startDateOffset: num(e.startDateOffset, -366, 366),
    endDate: dateSpec(e.endDate),
    endDateOffset: num(e.endDateOffset, -366, 366),
    startTime: timeSpec(e.startTime, '17:00'),
    startOffset: num(e.startOffset, -720, 720),
    endTime: timeSpec(e.endTime, '22:00'),
    endOffset: num(e.endOffset, -720, 720),
    stopType: ['hard', 'loop'].includes(e.stopType) ? e.stopType : 'graceful',
  };
}

function save(list) {
  const out = (Array.isArray(list) ? list : []).map(clean);
  const f = FILE();
  fs.writeFileSync(f + '.tmp', JSON.stringify(out, null, 2));
  fs.renameSync(f + '.tmp', f);
  return out;
}

const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// A date spec in a given year as local midnight, or null when unknown.
function resolveDate(spec, offsetDays, year) {
  if (LITERAL.test(spec)) {
    const [y, m, d] = spec.split('-').map(Number);
    return new Date(y === 0 ? year : y, m - 1, d);
  }
  const h = holidays.dateOf(spec, year);
  return h ? addDays(h, offsetDays || 0) : null;
}
const yearly = (spec) => !!spec && !(LITERAL.test(spec) && !spec.startsWith('0000'));

// Is `day` (local midnight) inside the entry's date range?
function inDateRange(e, day) {
  if (!e.startDate && !e.endDate) return true;
  const Y = day.getFullYear();
  for (const y of [Y - 1, Y]) {
    // A one-sided yearly range stays inside the calendar year, as in FPP
    // (FPP's default other bound is a literal date, compared as month-day).
    const s = e.startDate ? resolveDate(e.startDate, e.startDateOffset, y) : yearly(e.endDate) ? new Date(y, 0, 1) : new Date(-8.64e15);
    let en = e.endDate ? resolveDate(e.endDate, e.endDateOffset, y) : yearly(e.startDate) ? new Date(y, 11, 31) : new Date(8.64e15);
    if (!s || !en) return false;
    if (en < s && yearly(e.endDate)) en = resolveDate(e.endDate, e.endDateOffset, y + 1);
    if (s <= day && day <= en) return true;
  }
  return false;
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
  return new Date(+t + (offsetMin || 0) * 60000);
}

// A command without "repeat every" only happens at its start time.
const isOneShot = (e) => e.type === 'command' && !e.repeatEvery;

// The occurrence of entry e that starts on `day` (local), or null.
function occurrence(e, day, loc) {
  if (!e.enabled || !e.days.includes(day.getDay())) return null;
  if (!inDateRange(e, midnight(day))) return null;
  const start = resolveTime(day, e.startTime, e.startOffset, loc);
  if (!start) return null;
  let end;
  if (isOneShot(e)) end = new Date(+start + CATCH_UP_MS);
  else {
    end = resolveTime(day, e.endTime, e.endOffset, loc);
    if (!end) return null;
    if (end <= start) end = new Date(+end + 86400000);
  }
  return { key: `${e.id}@${start.toISOString()}`, entry: e, start, end };
}

// What the show runner calls the thing this entry plays.
const targetName = (e) => (e.type === 'sequence' ? e.sequence : e.playlist);

class Scheduler extends EventEmitter {
  constructor({ show, commands, config, presets }) {
    super();
    this.show = show;
    this.commands = commands;
    this.config = config;
    this.presets = presets;
    this.multisync = null;   // set by server.js, for multisyncCommand entries
    this.active = null;      // occurrence currently driving the show
    this.fired = new Set();  // command runs already done: "<key>#<n>"
    this.enabled = true;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => this.emit('log', 'scheduler: ' + e.message)), 2000);
    setTimeout(() => this.tick().catch(() => {}), 1500);
  }

  stop() { clearInterval(this.timer); }

  entries() { return load(); }

  _loc() { return this.config.get().location || {}; }

  current(now = new Date()) {
    const loc = this._loc();
    const today = midnight(now);
    const live = [];
    for (const e of load()) {
      for (const day of [addDays(today, -1), today]) {
        const o = occurrence(e, day, loc);
        if (o && o.start <= now && now < o.end) live.push(o);
      }
    }
    return live;
  }

  upcoming(days = 7, now = new Date()) {
    const loc = this._loc();
    const out = [];
    const list = load();
    const today = midnight(now);
    for (let i = -1; i < days; i++) {
      const day = addDays(today, i);
      list.forEach((e, index) => {
        const o = occurrence(e, day, loc);
        if (!o || o.end <= now) return;
        out.push({ id: e.id, index, type: e.type, name: e.type === 'command' ? e.command : targetName(e), args: e.args,
          start: o.start, end: isOneShot(e) ? null : o.end, repeatEvery: e.repeatEvery,
          live: !!(this.active && this.active.key === o.key) });
      });
    }
    return out.sort((a, b) => a.start - b.start).slice(0, 80);
  }

  // Next start for each enabled entry, for the entry list.
  nextRuns(days = 400, now = new Date()) {
    const loc = this._loc();
    const res = {};
    const today = midnight(now);
    for (const e of load()) {
      if (!e.enabled) continue;
      for (let i = -1; i < days; i++) {
        const o = occurrence(e, addDays(today, i), loc);
        if (o && o.end > now) { res[e.id] = { start: o.start, end: isOneShot(e) ? null : o.end, live: !!(this.active && this.active.key === o.key) }; break; }
      }
    }
    return res;
  }

  _runCommand(e) {
    if (e.multisyncCommand && this.multisync) this.multisync.sendCommand(e.command, e.args, e.multisyncHosts);
    this.commands.run(e.command, e.args)
      .then((r) => this.emit('log', `scheduled command ${e.command}: ${r}`))
      .catch((err) => this.emit('log', `scheduled command ${e.command} failed: ${err.message}`));
  }

  async _startShow(o) {
    const e = o.entry;
    o.lastStart = Date.now();
    const repeat = e.repeat && !e.repeatEvery;
    await this.show.start(e.type === 'sequence' ? playlists.forSequence(e.sequence, repeat) : e.playlist, { repeat });
    o.frame = this.show.frames[0] || null; // identity: only stop the run we started
  }

  // Is the show currently playing the run this occurrence started?
  _ours(o) {
    const base = this.show.frames[0];
    return !!(base && o.frame && base === o.frame);
  }

  async tick(now = new Date()) {
    if (!this.enabled) return;
    const live = this.current(now);

    for (const o of live.filter((x) => x.entry.type === 'command' && x.entry.command)) {
      const every = o.entry.repeatEvery * 60000;
      const n = every ? Math.floor((now - o.start) / every) : 0;
      const due = new Date(+o.start + n * every);
      const k = `${o.key}#${n}`;
      if (this.fired.has(k)) continue;
      this.fired.add(k);
      if (now - due < CATCH_UP_MS) this._runCommand(o.entry); // not when booting long after it was due
    }
    for (const k of this.fired) {
      const t = Date.parse(k.slice(k.indexOf('@') + 1, k.lastIndexOf('#')));
      if (!(t > +now - 3 * 86400000)) this.fired.delete(k);
    }

    const want = live.find((x) => x.entry.type !== 'command' && targetName(x.entry)) || null;
    // The same entry with a moved start (edited times, new location, dusk
    // drifting) is the same window: keep playing instead of restarting.
    if (want && this.active && want.key !== this.active.key && want.entry.id === this.active.entry.id
        && targetName(want.entry) === targetName(this.active.entry) && want.entry.type === this.active.entry.type) {
      want.lastStart = this.active.lastStart;
      want.frame = this.active.frame;
      this.active = want;
    }
    const curKey = this.active ? this.active.key : null;
    if (want && want.key === curKey) {
      // "Start again every N minutes" while the window is open and nothing plays.
      const e = this.active.entry;
      if (e.repeatEvery && !this.show.isRunning() && +now - (this.active.lastStart || 0) >= e.repeatEvery * 60000) {
        this.emit('log', `schedule restarting ${targetName(e)} (every ${e.repeatEvery} min)`);
        try { await this._startShow(this.active); } catch (err) { this.emit('log', `schedule could not start ${targetName(e)}: ${err.message}`); }
      }
      return;
    }

    if (this.active) {
      const ending = this.active;
      this.active = null;
      // Only stop the run we started; a manual start in the meantime wins.
      if (this._ours(ending)) {
        if (ending.entry.stopType === 'hard') await this.show.stopNow();
        else this.show.stopGracefully(ending.entry.stopType === 'loop');
      }
      this.emit('log', `schedule ended: ${targetName(ending.entry)}`);
    }
    if (want) {
      this.active = want;
      this.emit('log', `schedule started: ${targetName(want.entry)}`);
      // Background music fades music + lights out into the show (bgmusic.js).
      if (this.beforeShow) { try { await this.beforeShow(want.entry); } catch (e) { this.emit('log', `before show: ${e.message}`); } }
      try { await this._startShow(want); } catch (e) { this.emit('log', `schedule could not start ${targetName(want.entry)}: ${e.message}`); }
    }
  }
}

module.exports = { Scheduler, load, save, clean, occurrence, inDateRange, resolveDate, targetName };
