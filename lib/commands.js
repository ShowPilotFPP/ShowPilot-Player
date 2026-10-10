// FPP Command registry. Same names and argument order as FPP so schedules,
// playlist "command" entries, plugins (/api/command) and MultiSync command
// packets behave the same. Plugin commands from commands/descriptions.json
// are added by plugins.js.
//
// Volume commands are deliberately accepted as no-ops: the output level is
// set once at the amplifier/transmitter, and changing it from software has
// caused distortion or too-quiet audio on FM shows.

const toBool = (v) => v === true || v === 1 || /^(true|1|yes)$/i.test(String(v));
const toInt = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

class Commands {
  constructor() { this.map = new Map(); }

  register(name, { args = [], description = '', run, source = 'core' }) {
    this.map.set(name, { name, args, description, run, source });
  }

  unregisterSource(source) {
    for (const [k, v] of this.map) if (v.source === source) this.map.delete(k);
  }

  list() {
    return [...this.map.values()].map(({ name, args, description, source }) => ({ name, args, description, source }));
  }

  get(name) { return this.map.get(name); }

  async run(name, args = []) {
    const c = this.map.get(name);
    if (!c) { const e = new Error(`Unknown command: ${name}`); e.status = 404; throw e; }
    const r = await c.run(Array.isArray(args) ? args.map((a) => (a === null || a === undefined ? '' : String(a))) : []);
    return typeof r === 'string' ? r : `${name} complete`;
  }
}

function registerCore(cmds, { show, player }) {
  const pl = (d) => ({ name: 'name', type: 'string', description: 'Playlist', contentListUrl: 'api/playlists', ...d });
  cmds.register('Start Playlist', {
    args: [pl(), { name: 'repeat', type: 'bool' }, { name: 'ifNotRunning', type: 'bool' }, { name: 'scheduleProtected', type: 'bool' }],
    run: ([name, repeat, ifNotRunning]) => show.start(name, { repeat: toBool(repeat), ifNotRunning: toBool(ifNotRunning) }),
  });
  cmds.register('Start Playlist At Item', {
    args: [pl(), { name: 'item', type: 'int' }, { name: 'repeat', type: 'bool' }, { name: 'ifNotRunning', type: 'bool' }],
    run: ([name, item, repeat, ifNotRunning]) => show.start(name, { startItem: toInt(item, 1), repeat: toBool(repeat), ifNotRunning: toBool(ifNotRunning) }),
  });
  cmds.register('Insert Playlist After Current', {
    args: [pl(), { name: 'startItem', type: 'int' }, { name: 'endItem', type: 'int' }, { name: 'ifNotRunning', type: 'bool' }],
    run: ([name, s, e, inr]) => show.insertAfterCurrent(name, toInt(s, -1), toInt(e, -1), toBool(inr)),
  });
  cmds.register('Insert Playlist Immediate', {
    args: [pl(), { name: 'startItem', type: 'int' }, { name: 'endItem', type: 'int' }, { name: 'ifNotRunning', type: 'bool' }],
    run: ([name, s, e, inr]) => show.insertImmediate(name, toInt(s, 0), toInt(e, 0), toBool(inr)),
  });
  cmds.register('Stop Now', { run: () => show.stopNow() });
  cmds.register('Stop Gracefully', { run: () => show.stopGracefully() });
  cmds.register('Stop Gracefully After Loop', { run: () => show.stopGracefully() });
  cmds.register('Next Playlist Item', { run: () => show.next() });
  cmds.register('Prev Playlist Item', { run: () => show.prev() });
  cmds.register('Restart Playlist Item', { run: () => show.restartItem() });
  cmds.register('Pause Playlist', { run: () => show.pause() });
  cmds.register('Resume Playlist', { run: () => show.resume() });
  cmds.register('Toggle Playlist', { run: () => show.togglePause() });
  cmds.register('All Lights Off', { run: () => { if (player.state === 'idle') player.worker.postMessage({ type: 'blank' }); } });
  for (const v of ['Volume Set', 'Volume Adjust', 'Volume Increase', 'Volume Decrease']) {
    cmds.register(v, { args: [{ name: 'volume', type: 'int' }], description: 'Ignored: ShowPilot Player never changes the output level.', run: () => 'Volume is fixed in ShowPilot Player' });
  }
}

module.exports = { Commands, registerCore, toBool, toInt };
