// Show runner rules and scheduler math, against a fake player.
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SPP_MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-show-'));

const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');
const paths = require('../lib/paths');
const playlists = require('../lib/playlists');
const { Show } = require('../lib/show');
const { occurrence, clean } = require('../lib/scheduler');
const { sunTimes } = require('../lib/suntimes');

paths.ensureLayout();

class FakePlayer extends EventEmitter {
  constructor() { super(); this.state = 'idle'; this.item = null; this.played = []; this.n = 0; this.pos = 0; }
  async play(o) {
    this.item = { id: ++this.n, sequence: o.sequence, media: o.media };
    this.state = 'playing';
    this.played.push({ seq: o.sequence || o.media, startMs: o.startMs || 0, resumed: !!o.resumed });
    return true;
  }
  async pause() { const s = { positionMs: this.pos }; this.state = 'idle'; this.item = null; return s; }
  async stop() { this.state = 'idle'; this.item = null; }
  finish() { const id = this.item.id; this.state = 'idle'; this.emit('end', { id }); }
  mediaMs() { return this.pos; }
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const seq = (n) => ({ type: 'sequence', enabled: 1, sequenceName: `${n}.fseq` });

playlists.save('Main', { leadIn: [seq('intro')], mainPlaylist: [seq('a'), seq('b'), seq('c')], leadOut: [seq('outro')], repeat: 0 });
playlists.save('Remote', { leadIn: [{ type: 'pause', duration: 1 }], mainPlaylist: [seq('r1'), seq('r2')] });

test('lead-in, main, lead-out in order; stops at the end', async () => {
  const p = new FakePlayer(); const s = new Show(p);
  await s.start('Main');
  for (let i = 0; i < 5; i++) { p.finish(); await tick(); }
  assert.deepEqual(p.played.map((x) => x.seq), ['intro.fseq', 'a.fseq', 'b.fseq', 'c.fseq', 'outro.fseq']);
  assert.equal(s.isRunning(), false);
});

test('insert immediate pauses, plays the request, resumes at the measured position', async () => {
  const p = new FakePlayer(); const s = new Show(p);
  await s.start('Main', { startItem: 2 }); // global item 2 = a.fseq (after one lead-in item)
  p.pos = 41234;
  await s.insertImmediate('Remote', 3, 3); // global 3 = r2 (lead-in pause is item 1)
  assert.equal(p.played.at(-1).seq, 'r2.fseq');
  p.finish(); await tick();
  const last = p.played.at(-1);
  assert.deepEqual(last, { seq: 'a.fseq', startMs: 41234, resumed: true });
  p.finish(); await tick();
  assert.equal(p.played.at(-1).seq, 'b.fseq');
  await s.stopNow();
});

test('insert after current waits for the song to end, then the playlist carries on', async () => {
  const p = new FakePlayer(); const s = new Show(p);
  await s.start('Main', { startItem: 2 });
  await s.insertAfterCurrent('Remote', 2, 2);
  await s.insertAfterCurrent('Remote', 3, 3);
  assert.equal(p.played.at(-1).seq, 'a.fseq');
  p.finish(); await tick();
  assert.equal(p.played.at(-1).seq, 'r1.fseq');
  p.finish(); await tick();
  assert.equal(p.played.at(-1).seq, 'r2.fseq');
  p.finish(); await tick();
  assert.equal(p.played.at(-1).seq, 'b.fseq');
  assert.equal(p.played.filter((x) => x.resumed).length, 0);
  await s.stopNow();
});

test('cooldown skip walks forward but never wraps past the loop end', async () => {
  const p = new FakePlayer(); const s = new Show(p);
  const cooled = new Set(['b']);
  s.skip = (e) => cooled.has(playlists.entryName(e));
  await s.start('Main', { startItem: 2 });
  p.finish(); await tick();
  assert.equal(p.played.at(-1).seq, 'c.fseq');
  cooled.add('c'); cooled.add('a');
  await s.stopNow();
  await s.start('Main', { startItem: 2 });
  p.finish(); await tick();
  // b and c are cooled: nothing allowed before the end of main, so play on (no stall, no wrap)
  assert.equal(p.played.at(-1).seq, 'b.fseq');
  await s.stopNow();
});

test('graceful stop jumps to the lead-out after the current song', async () => {
  const p = new FakePlayer(); const s = new Show(p);
  await s.start('Main', { startItem: 2 });
  s.stopGracefully();
  p.finish(); await tick();
  assert.equal(p.played.at(-1).seq, 'outro.fseq');
  p.finish(); await tick();
  assert.equal(s.isRunning(), false);
});

test('repeat loops main without replaying the lead-in', async () => {
  playlists.save('Loop', { leadIn: [seq('intro')], mainPlaylist: [seq('a'), seq('b')], repeat: 1 });
  const p = new FakePlayer(); const s = new Show(p);
  await s.start('Loop');
  for (let i = 0; i < 4; i++) { p.finish(); await tick(); }
  assert.deepEqual(p.played.map((x) => x.seq), ['intro.fseq', 'a.fseq', 'b.fseq', 'a.fseq', 'b.fseq']);
  await s.stopNow();
});

test('schedule occurrence handles overnight windows and day filters', () => {
  const e = clean({ playlist: 'Main', days: [5], startTime: '22:00', endTime: '01:00' });
  const fri = new Date(2026, 9, 9); // Friday
  const o = occurrence(e, fri, {});
  assert.ok(o);
  assert.equal(o.start.getHours(), 22);
  assert.equal(o.end.getDate(), 10);
  assert.equal(o.end.getHours(), 1);
  assert.equal(occurrence(e, new Date(2026, 9, 10), {}), null);
});

test('sun times are in a sane range and dusk follows sunset', () => {
  const t = sunTimes(new Date(2026, 9, 10), 36.2, -94.1);
  assert.ok(t.sunset && t.dusk && t.sunrise && t.dawn);
  const mins = (t.dusk - t.sunset) / 60000;
  assert.ok(mins > 15 && mins < 40, `dusk ${mins} min after sunset`);
  assert.ok(t.sunrise < t.sunset);
  assert.equal(sunTimes(new Date(), null, null), null);
});
