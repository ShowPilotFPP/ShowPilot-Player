// FPP backup import, command presets and the scheduler's FPP-style features
// (holiday dates, repeat-every commands, sequences, stop after loop).
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SPP_MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-backup-'));

const test = require('node:test');
const assert = require('node:assert');
const paths = require('../lib/paths');
paths.ensureLayout();
const config = require('../lib/config');
config.load();
const fppBackup = require('../lib/fpp-backup');
const scheduler = require('../lib/scheduler');
const presets = require('../lib/presets');
const playlists = require('../lib/playlists');
const holidays = require('../lib/holidays');
const { Commands } = require('../lib/commands');

// A trimmed FPP 9 "all" backup (fixtures/fpp-backup.json): text files are line arrays.
const BACKUP = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'fpp-backup.json'), 'utf8'));

test('FPP day codes, times and repeat convert to schedule entries', () => {
  assert.deepStrictEqual(fppBackup.fppDays(66304, () => {}), [5, 6]);
  assert.deepStrictEqual(fppBackup.fppDays(8, () => {}), [1, 2, 3, 4, 5]);
  const w = [];
  assert.deepStrictEqual(fppBackup.fppDays(15, (m) => w.push(m)), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(w.length, 1);

  const a = fppBackup.read(BACKUP);
  const [show, seq, cmd] = a.schedule.map((x) => x.entry);
  assert.equal(show.type, 'playlist');
  assert.equal(show.startTime, 'sunset'); assert.equal(show.startOffset, 15);
  assert.equal(show.endTime, '22:00');
  assert.equal(show.stopType, 'loop');
  assert.equal(show.startDate, 'Thanksgiving'); assert.equal(show.startDateOffset, 1);
  assert.equal(show.endDate, '0000-01-06');
  assert.equal(seq.type, 'sequence'); assert.equal(seq.sequence, 'Countdown.fseq');
  assert.equal(seq.repeatEvery, 30); assert.equal(seq.repeat, false);
  assert.equal(seq.startOffset, 0, 'FPP ignores offsets on clock times');
  assert.equal(seq.startDate, ''); assert.equal(seq.endDate, '');
  assert.equal(seq.stopType, 'hard');
  assert.equal(cmd.type, 'command'); assert.equal(cmd.command, 'Trigger Command Preset');
  assert.deepStrictEqual(cmd.args, ['Lights Off']);
  assert.equal(cmd.multisyncCommand, true); assert.equal(cmd.multisyncHosts, '10.0.0.60');
});

test('analyze lists selectable sections and never offers network or passwords', () => {
  const r = fppBackup.analyze(BACKUP, { commandNames: new Set(['All Lights Off', 'Stop Now', 'Trigger Command Preset', 'URL']), audioCards: [] });
  const ids = r.sections.map((s) => s.id);
  for (const k of ['settings', 'schedule', 'playlists', 'presets', 'scripts', 'outputs', 'plugins', 'holidays']) assert.ok(ids.includes(k), `section ${k}`);
  assert.ok(!JSON.stringify(r).includes('secret'), 'password not shown');
  assert.ok(r.skipped.some((s) => /Network/.test(s)));
  assert.ok(r.skipped.some((s) => /pixel/.test(s)));
  const settings = r.sections.find((s) => s.id === 'settings').items;
  assert.ok(settings.find((i) => i.id === 'audio').disabled, 'unknown sound card cannot be picked');
  const outs = r.sections.find((s) => s.id === 'outputs').items.find((i) => i.id === 'universes');
  assert.match(outs.detail, /^2 outputs/);
  assert.ok(outs.warnings[0].includes('Art-Net'));
  assert.throws(() => fppBackup.analyze({ settings: { commandPresets: [{ __fppBlob: { sha256: 'x' } }] } }), /blob/);
  assert.throws(() => fppBackup.analyze({ hello: 1 }), /does not look like/);
});

test('restore writes only what was picked', async () => {
  scheduler.save([{ type: 'playlist', playlist: 'Old', startTime: '17:00', endTime: '18:00' }]);
  config.update({ hostName: 'keepme', outputs: [] });
  let tzSet = null;
  const res = await fppBackup.restore(BACKUP, {
    settings: ['location', 'multisync', 'timezone'],
    schedule: ['0', '2'], scheduleMode: 'replace',
    playlists: ['Main Show'], presets: ['Lights Off'], scripts: [], outputs: ['universes'], plugins: ['fpp-plugin-Example'], holidays: ['user'],
  }, { config, setTimezone: async (z) => { tzSet = z; } });
  assert.deepStrictEqual(res.problems, []);
  const c = config.get();
  assert.equal(c.hostName, 'keepme', 'name not picked, not changed');
  assert.equal(c.location.latitude, 36.18);
  assert.equal(c.multisync.enabled, true);
  assert.deepStrictEqual(c.multisync.remotes, ['10.0.0.60', '10.0.0.61']);
  assert.equal(tzSet, 'America/Chicago');
  assert.equal(c.outputs.length, 2);
  assert.equal(c.outputs[0].type, 'e131'); assert.equal(c.outputs[0].ip, '10.0.0.50');
  const sch = scheduler.load();
  assert.equal(sch.length, 2);
  assert.equal(sch[0].playlist, 'Main Show');
  assert.equal(sch[1].type, 'command');
  assert.ok(playlists.load('Main Show'));
  const g = presets.groups();
  assert.equal(g.length, 1); assert.equal(g[0].name, 'Lights Off'); assert.equal(g[0].commands.length, 2);
  assert.ok(!fs.existsSync(paths.fileIn('scripts', 'lights-on.sh')), 'scripts not picked');
  assert.match(fs.readFileSync(path.join(paths.dir('config'), 'plugin.fpp-plugin-Example'), 'utf8'), /enabled = "1"/);
  assert.ok(holidays.list().some((h) => h.shortName === 'OpeningNight'));
});

test('holiday and every-year date ranges', () => {
  // Thanksgiving 2026 is Nov 26; +1 = Nov 27. Range runs to Jan 6 the next year.
  assert.equal(holidays.dateOf('Thanksgiving', 2026).getDate(), 26);
  assert.equal(holidays.easter(2027).toDateString(), new Date(2027, 2, 28).toDateString());
  const e = scheduler.clean({ startDate: 'Thanksgiving', startDateOffset: 1, endDate: '0000-01-06' });
  const at = (y, m, d) => scheduler.inDateRange(e, new Date(y, m - 1, d));
  assert.equal(at(2026, 11, 26), false);
  assert.equal(at(2026, 11, 27), true);
  assert.equal(at(2026, 12, 31), true);
  assert.equal(at(2027, 1, 6), true);
  assert.equal(at(2027, 1, 7), false);
  assert.equal(at(2027, 11, 26), true, 'Thanksgiving 2027 is Nov 25, so the 26th is in');
  const lit = scheduler.clean({ startDate: '2026-12-01', endDate: '2026-12-24' });
  assert.equal(scheduler.inDateRange(lit, new Date(2026, 11, 10)), true);
  assert.equal(scheduler.inDateRange(lit, new Date(2027, 11, 10)), false);
});

function fakeShow() {
  const s = { frames: [], started: [], stops: [], isRunning: () => s.frames.length > 0,
    start: async (what, o) => { const name = typeof what === 'object' ? what.name : what; s.frames = [{ name }]; s.started.push({ what, o }); return true; },
    stopNow: async () => { s.stops.push('hard'); s.frames = []; },
    stopGracefully: (loop) => { s.stops.push(loop ? 'loop' : 'graceful'); } };
  return s;
}

test('scheduler: repeat-every commands, sequences and stop types', async () => {
  fs.writeFileSync(paths.fileIn('sequences', 'Countdown.fseq'), Buffer.alloc(32));
  const ran = [];
  const cmds = new Commands();
  cmds.register('Ping', { run: (a) => { ran.push(a[0]); } });
  const show = fakeShow();
  const sch = new scheduler.Scheduler({ show, commands: cmds, config });
  scheduler.save([
    { type: 'command', command: 'Ping', args: ['x'], startTime: '18:00', endTime: '19:00', repeatEvery: 15 },
    { type: 'sequence', sequence: 'Countdown.fseq', startTime: '18:00', endTime: '20:00', stopType: 'loop', repeat: true },
  ]);
  const t = (h, m) => new Date(2026, 10, 5, h, m, 1);
  await sch.tick(t(17, 59)); assert.deepStrictEqual(ran, []);
  await sch.tick(t(18, 0)); assert.deepStrictEqual(ran, ['x']);
  assert.equal(show.started.length, 1);
  assert.equal(show.started[0].what.name, 'Countdown.fseq');
  assert.equal(show.started[0].what.mainPlaylist[0].type, 'sequence');
  await sch.tick(t(18, 5)); assert.equal(ran.length, 1);
  await sch.tick(t(18, 15)); assert.equal(ran.length, 2);
  await sch.tick(t(18, 45)); assert.equal(ran.length, 3);
  await sch.tick(t(19, 0)); assert.equal(ran.length, 3, 'stops at the end time');
  await sch.tick(t(20, 0));
  assert.deepStrictEqual(show.stops, ['loop']);
  const up = sch.upcoming(2, t(17, 0));
  assert.ok(up.some((u) => u.type === 'command' && u.end));
});

test('command presets: FPP file format, slots, keywords and loop guard', async () => {
  const ran = [];
  const cmds = new Commands();
  cmds.register('Echo', { run: (a) => { ran.push(a.join('|')); } });
  const sent = [];
  const runner = new presets.PresetRunner({ commands: cmds, sendMultisync: (c, a, h) => sent.push([c, a, h]) });
  cmds.register('Trigger Command Preset', { run: ([n]) => runner.trigger(n) });
  presets.save({ commands: [
    { name: 'A', presetSlot: 3, command: 'Echo', args: ['a1'] },
    { name: 'A', presetSlot: 3, command: 'Echo', args: ['%PLAYLIST_NAME%'], multisyncCommand: true, multisyncHosts: '10.0.0.7' },
    { name: 'Loop', command: 'Trigger Command Preset', args: ['Loop'] },
  ] });
  const file = JSON.parse(fs.readFileSync(presets.FILE(), 'utf8'));
  assert.ok(Array.isArray(file.commands) && file.commands.length === 3);
  await runner.trigger('A', { PLAYLIST_NAME: 'Main' });
  assert.deepStrictEqual(ran, ['a1', 'Main']);
  assert.deepStrictEqual(sent, [['Echo', ['Main'], '10.0.0.7']]);
  await runner.triggerSlot(3);
  assert.equal(ran.length, 4);
  assert.equal(await runner.trigger('Loop'), '1 command run', 'a preset that triggers itself does not recurse');
  await assert.rejects(runner.trigger('Nope'), /No command preset/);
  assert.deepStrictEqual(presets.names(), ['A', 'Loop']);
});

test('review fixes: one-sided yearly ranges, manual starts win, edited windows keep playing', async () => {
  // "From every year Dec 1" with no end = Dec 1–31, as FPP compares month-day.
  const from = scheduler.clean({ startDate: '0000-12-01' });
  assert.equal(scheduler.inDateRange(from, new Date(2026, 5, 1)), false);
  assert.equal(scheduler.inDateRange(from, new Date(2026, 11, 15)), true);
  const until = scheduler.clean({ endDate: '0000-01-06' });
  assert.equal(scheduler.inDateRange(until, new Date(2026, 0, 3)), true);
  assert.equal(scheduler.inDateRange(until, new Date(2026, 5, 1)), false);

  const cmds = new Commands();
  const show = fakeShow();
  // Frames are new objects per start, like the real show runner.
  show.start = async (what) => { show.frames = [{ name: typeof what === 'object' ? what.name : what }]; show.started.push(what); return true; };
  const sch = new scheduler.Scheduler({ show, commands: cmds, config });
  const id = 'abc123';
  scheduler.save([{ id, type: 'playlist', playlist: 'X', repeat: false, startTime: '17:00', endTime: '22:00' }]);
  const t = (h, m) => new Date(2026, 10, 5, h, m, 1);
  await sch.tick(t(17, 0));
  assert.equal(show.started.length, 1);
  // The entry is edited while live (start moved): no restart.
  scheduler.save([{ id, type: 'playlist', playlist: 'X', repeat: false, startTime: '16:30', endTime: '22:00' }]);
  await sch.tick(t(17, 5));
  assert.equal(show.started.length, 1, 'editing a live entry does not restart the show');
  // It finishes, then the user starts X by hand: the schedule must not stop that.
  show.frames = [];
  await show.start('X');
  await sch.tick(t(22, 0));
  assert.deepStrictEqual(show.stops, [], 'manual start of the same playlist wins');
});

test('review fixes: malformed backup fields do not block the rest', () => {
  const b = JSON.parse(JSON.stringify(BACKUP));
  b.backup_taken = 1e20;
  b.show_setup.playlist['Main Show.json'] = JSON.stringify({ name: 'Main Show', mainPlaylist: [null, { type: 'pause', duration: 1 }] }).split('\n');
  const r = fppBackup.analyze(b, { library: { sequences: [], media: [] } });
  assert.equal(r.meta.taken, null);
  assert.ok(r.sections.some((s) => s.id === 'playlists'));
});
