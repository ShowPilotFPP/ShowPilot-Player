// Screen sleep: HDMI screen off when idle, on when something plays or a show is due.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { ScreenSleep } = require('../lib/screen-sleep');

function rig(cfg, { schedule = {}, hp = null } = {}) {
  const fb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spp-fb-')), 'blank');
  fs.writeFileSync(fb, '0');
  let now = Date.parse('2026-12-01T18:00:00Z');
  const player = new EventEmitter();
  player.state = 'idle';
  player.calls = [];
  player.suspendDisplay = async () => { player.calls.push('suspend'); return true; };
  player.resumeDisplay = async () => { player.calls.push('resume'); return true; };
  const scheduler = { active: schedule.active || null, nextRuns: () => schedule.runs || {}, load: () => schedule.entries || [] };
  const ran = [];
  const ss = new ScreenSleep({
    config: { get: () => ({ screenSleep: { enabled: true, idleMinutes: 5, method: 'hdmi', keepAwakeDuringShows: true, ...cfg } }) },
    player, scheduler, now: () => now, fbPath: fb, hotplug: hp || { procCmdline: '/nonexistent' }, shell: async (c) => { ran.push(c); return { ok: true, out: '' }; },
  });
  return { ss, player, scheduler, fb, ran, advance: (ms) => { now += ms; }, now: () => now };
}

test('turns the screen off after the idle time and on again when something plays', async () => {
  const r = rig({});
  await r.ss.tick();
  r.advance(4 * 60000); await r.ss.tick();
  assert.equal(r.ss.asleep, false, 'still on before 5 minutes');
  r.advance(61000); await r.ss.tick();
  assert.equal(r.ss.asleep, true);
  assert.equal(fs.readFileSync(r.fb, 'utf8'), '4', 'framebuffer blanked with power-down');
  assert.deepEqual(r.player.calls, ['suspend'], 'the player let go of the screen first');
  r.player.emit('activity'); // a song starts
  await new Promise((x) => setTimeout(x, 20));
  assert.equal(r.ss.asleep, false);
  assert.equal(fs.readFileSync(r.fb, 'utf8'), '0');
  assert.deepEqual(r.player.calls, ['suspend', 'resume']);
  // playing keeps it on however long
  r.player.state = 'playing';
  r.advance(30 * 60000); await r.ss.tick();
  assert.equal(r.ss.asleep, false);
});

test('stays on through a scheduled show and wakes 2 minutes before one', async () => {
  const entries = [{ id: 'a', type: 'playlist' }, { id: 'c', type: 'command' }];
  const r = rig({}, { schedule: { entries, runs: {} } });
  r.advance(10 * 60000); await r.ss.tick();
  assert.equal(r.ss.asleep, true);
  // a command entry about to run doesn't wake it
  r.scheduler.nextRuns = () => ({ c: { start: new Date(r.now() + 30000), end: null } });
  await r.ss.tick();
  assert.equal(r.ss.asleep, true);
  r.scheduler.nextRuns = () => ({ a: { start: new Date(r.now() + 90000), end: new Date(r.now() + 3600000) } });
  await r.ss.tick();
  assert.equal(r.ss.asleep, false, 'woken before the show starts');
  r.scheduler.nextRuns = () => ({});
  r.scheduler.active = { entry: { type: 'playlist' } };
  r.advance(60 * 60000); await r.ss.tick();
  assert.equal(r.ss.asleep, false, 'on for the whole show window');
  assert.equal(r.ss.status().keepAwake, 'show window');
});

test('own commands, and nothing happens while turned off', async () => {
  const r = rig({ method: 'command', sleepCommand: 'off-cmd', wakeCommand: 'on-cmd' });
  r.advance(6 * 60000); await r.ss.tick();
  await r.ss.wake('manual');
  assert.deepEqual(r.ran, ['off-cmd', 'on-cmd']);
  assert.deepEqual(r.player.calls, [], 'command mode leaves the display alone');
  const off = rig({ enabled: false });
  off.advance(60 * 60000); await off.ss.tick();
  assert.equal(off.ss.asleep, false);
});

test('a remote ignores its own schedule (songs come from the master)', async () => {
  const start = new Date(Date.parse('2026-12-01T17:30:00Z')), end = new Date(Date.parse('2026-12-01T23:00:00Z'));
  const r = rig({}, { schedule: { runs: { a: { start, end } }, entries: [{ id: 'a', type: 'playlist' }] } });
  assert.equal(r.ss.keepAwakeReason(), 'show starting', 'a player keeps the screen on through its show window');
  r.scheduler.enabled = false; // remote mode
  assert.equal(r.ss.keepAwakeReason(), '');
  await r.ss.tick();
  r.advance(5 * 60000 + 1000); await r.ss.tick();
  assert.equal(r.ss.asleep, true, 'sleeps after the idle time even inside the old show window');
});

test('hdmi sleep sets vc4.force_hotplug so a monitor going to standby does not switch HDMI back on', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-hp-'));
  const proc = path.join(d, 'proc-cmdline'), boot = path.join(d, 'cmdline.txt'), param = path.join(d, 'force_hotplug');
  fs.writeFileSync(proc, 'console=tty1 root=PARTUUID=x rootwait\n');
  fs.writeFileSync(boot, 'console=tty1 root=PARTUUID=x rootwait consoleblank=0\n');
  // Kernel without a writable parameter: one reboot needed.
  const r = rig({}, { hp: { procCmdline: proc, cmdlines: [boot], param: path.join(d, 'missing', 'force_hotplug') } });
  r.ss.ensureHotplug();
  assert.equal(fs.readFileSync(boot, 'utf8'), 'console=tty1 root=PARTUUID=x rootwait consoleblank=0 vc4.force_hotplug=3\n', 'added to the one cmdline line');
  assert.equal(r.ss.status().needsReboot, true);
  r.ss.ensureHotplug();
  assert.equal((fs.readFileSync(boot, 'utf8').match(/force_hotplug/g) || []).length, 1, 'added once');
  // Writable parameter: applied live, no reboot.
  fs.writeFileSync(param, '0');
  const live = rig({}, { hp: { procCmdline: proc, cmdlines: [boot], param } });
  live.ss.ensureHotplug();
  assert.equal(fs.readFileSync(param, 'utf8'), '3');
  assert.equal(live.ss.status().needsReboot, false);
  // Already booted with it: nothing to do. Command method: leaves boot alone.
  fs.writeFileSync(proc, 'console=tty1 vc4.force_hotplug=3\n');
  const done = rig({}, { hp: { procCmdline: proc, cmdlines: [boot], param: path.join(d, 'missing', 'x') } });
  done.ss.ensureHotplug();
  assert.equal(done.ss.status().needsReboot, false);
  const cmd = rig({ method: 'command' }, { hp: { procCmdline: path.join(d, 'nope'), cmdlines: [boot], param } });
  cmd.ss.ensureHotplug();
  assert.equal(cmd.ss.status().needsReboot, false);
});

test('switching off goes through on first, so a stale "already off" state cannot swallow it', async () => {
  const r = rig({});
  const writes = [];
  const orig = fs.writeFileSync;
  fs.writeFileSync = (f, v, ...a) => { if (f === r.fb) writes.push(String(v)); return orig(f, v, ...a); };
  try { await r.ss._hdmi(false); } finally { fs.writeFileSync = orig; }
  assert.deepEqual(writes, ['0', '4']);
});
