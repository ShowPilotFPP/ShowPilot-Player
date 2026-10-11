// FPP Command registry. Same names and argument order as FPP so schedules,
// command presets, playlist "command" entries, plugins (/api/command) and
// MultiSync command packets behave the same. Plugin commands from
// commands/descriptions.json are added by plugins.js.
//
// Descriptions follow FPP's /api/commands shape: { name, description,
// category, args: [{ name, type, description, optional, min, max, default,
// contentListUrl | contents }] } so the UI and xLights can build a form.
//
// Volume commands are deliberately accepted as no-ops: the output level is
// set once at the amplifier/transmitter, and changing it from software has
// caused distortion or too-quiet audio on FM shows.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');

const toBool = (v) => v === true || v === 1 || /^(true|1|yes)$/i.test(String(v));
const toInt = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

class Commands {
  constructor() { this.map = new Map(); }

  register(name, { args = [], description = '', category = 'Other', run, source = 'core' }) {
    this.map.set(name, { name, args, description, category, run, source });
  }

  unregisterSource(source) {
    for (const [k, v] of this.map) if (v.source === source) this.map.delete(k);
  }

  list() {
    return [...this.map.values()].map(({ name, args, description, category, source }) => {
      const d = { name, category, args, source };
      if (description) d.description = description;
      return d;
    });
  }

  get(name) { return this.map.get(name); }

  async run(name, args = []) {
    const c = this.map.get(name);
    if (!c) { const e = new Error(`Unknown command: ${name}`); e.status = 404; throw e; }
    const r = await c.run(Array.isArray(args) ? args.map((a) => (a === null || a === undefined ? '' : String(a))) : []);
    return typeof r === 'string' ? r : `${name} complete`;
  }
}

// The URL command: GET or POST a URL. Only http(s); 10 s timeout.
async function fetchUrl(url, method, data) {
  let u;
  try { u = new URL(String(url || '')); } catch { throw new Error('URL is not valid'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http and https URLs');
  const post = /^post$/i.test(method || '');
  const init = { method: post ? 'POST' : 'GET', signal: AbortSignal.timeout(10000) };
  if (post && data) {
    init.body = String(data);
    init.headers = { 'Content-Type': /^\s*[[{]/.test(init.body) ? 'application/json' : 'text/plain' };
  }
  const r = await fetch(u, init);
  const body = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`URL returned HTTP ${r.status}`);
  return body.slice(0, 2000) || `HTTP ${r.status}`;
}

function registerCore(cmds, { show, player, presets, system = {} }) {
  const pl = (d) => ({ name: 'name', type: 'string', description: 'Playlist', contentListUrl: 'api/playlists/playable', ...d });
  const b = (name, description, d = 'false') => ({ name, type: 'bool', description, optional: true, default: d });
  const P = 'Playlist';

  cmds.register('Start Playlist', {
    category: P, description: 'Start a playlist from the top, stopping anything already playing.',
    args: [pl(), b('repeat', 'Repeat'), b('ifNotRunning', 'Only if nothing is playing'), b('scheduleProtected', 'Schedule protected')],
    run: ([name, repeat, ifNotRunning]) => show.start(name, { repeat: toBool(repeat), ifNotRunning: toBool(ifNotRunning) }),
  });
  cmds.register('Start Playlist At Item', {
    category: P, description: 'Start a playlist at an item number (lead-in items count first).',
    args: [pl(), { name: 'item', type: 'int', description: 'Item', min: 1, max: 1000, default: '1' }, b('repeat', 'Repeat'), b('ifNotRunning', 'Only if nothing is playing')],
    run: ([name, item, repeat, ifNotRunning]) => show.start(name, { startItem: toInt(item, 1), repeat: toBool(repeat), ifNotRunning: toBool(ifNotRunning) }),
  });
  cmds.register('Insert Playlist After Current', {
    category: P, description: 'Play a playlist when the current item ends, then carry on.',
    args: [pl(), { name: 'startItem', type: 'int', description: 'Start item (-1 = all)', optional: true, min: -1, max: 1000, default: '-1' },
      { name: 'endItem', type: 'int', description: 'End item (-1 = all)', optional: true, min: -1, max: 1000, default: '-1' }, b('ifNotRunning', 'Only if nothing is playing')],
    run: ([name, s, e, inr]) => show.insertAfterCurrent(name, toInt(s, -1), toInt(e, -1), toBool(inr)),
  });
  cmds.register('Insert Playlist Immediate', {
    category: P, description: 'Interrupt the current item with a playlist, then resume where it left off.',
    args: [pl(), { name: 'startItem', type: 'int', description: 'Start item (0 = all)', optional: true, min: 0, max: 1000, default: '0' },
      { name: 'endItem', type: 'int', description: 'End item (0 = all)', optional: true, min: 0, max: 1000, default: '0' }, b('ifNotRunning', 'Only if nothing is playing')],
    run: ([name, s, e, inr]) => show.insertImmediate(name, toInt(s, 0), toInt(e, 0), toBool(inr)),
  });
  // FPP plays the file on top of the show; here (one audio clock) it
  // interrupts the current item like Insert Playlist Immediate, then resumes.
  cmds.register('Play Media', {
    category: 'Media', description: 'Play an audio or video file now, then carry on with the show.',
    args: [{ name: 'media', type: 'string', description: 'Media', contentListUrl: 'api/media' },
      { name: 'loop', type: 'int', description: 'Loop count', optional: true, min: 1, max: 100, default: '1' },
      { name: 'volume', type: 'int', description: 'Volume (ignored)', optional: true, min: -100, max: 100, default: '0' }],
    run: ([name]) => show.insertImmediate(name, 0, 0, false),
  });
  cmds.register('Stop Now', { category: P, description: 'Stop the show immediately.', run: () => show.stopNow() });
  cmds.register('Stop Gracefully', {
    category: P, description: 'Finish the current song (or the whole loop), play the lead-out, then stop.',
    args: [b('loop', 'Finish the whole playlist loop first')],
    run: ([loop]) => show.stopGracefully(toBool(loop)),
  });
  // Older ShowPilot Player name; FPP uses Stop Gracefully with loop=true.
  cmds.register('Stop Gracefully After Loop', { category: P, description: 'Same as Stop Gracefully with loop on.', run: () => show.stopGracefully(true) });
  cmds.register('Next Playlist Item', { category: P, run: () => show.next() });
  cmds.register('Prev Playlist Item', { category: P, run: () => show.prev() });
  cmds.register('Restart Playlist Item', { category: P, run: () => show.restartItem() });
  cmds.register('Pause Playlist', { category: P, run: () => show.pause() });
  cmds.register('Resume Playlist', { category: P, run: () => show.resume() });
  cmds.register('Toggle Playlist', { category: P, description: 'Pause if playing, resume if paused.', run: () => show.togglePause() });

  cmds.register('All Lights Off', {
    category: 'Lights', description: 'Send all channels off (only while nothing is playing).',
    run: () => { if (player.state === 'idle') player.worker.postMessage({ type: 'blank' }); },
  });

  for (const v of ['Volume Set', 'Volume Adjust', 'Volume Increase', 'Volume Decrease']) {
    cmds.register(v, { category: 'Media', args: [{ name: 'volume', type: 'int', description: 'Volume', min: v === 'Volume Adjust' ? -100 : 0, max: 100 }],
      description: 'Ignored: ShowPilot Player never changes the output level.', run: () => 'Volume is fixed in ShowPilot Player' });
  }

  cmds.register('URL', {
    category: 'System', description: 'Call a web address, e.g. to switch a smart plug or tell another system something.',
    args: [{ name: 'name', type: 'string', description: 'URL' },
      { name: 'method', type: 'string', description: 'Method', contents: ['GET', 'POST'], default: 'GET', optional: true },
      { name: 'data', type: 'string', description: 'POST data', optional: true }],
    run: ([url, method, data]) => fetchUrl(url, method, data),
  });

  cmds.register('Run Script', {
    category: 'System', description: 'Run a shell script from the scripts folder.',
    args: [{ name: 'script', type: 'string', description: 'Script', contentListUrl: 'api/scripts' },
      { name: 'args', type: 'string', description: 'Arguments', optional: true },
      { name: 'env', type: 'string', description: 'Environment (A=1,B=2)', optional: true }],
    run: ([script, args, env]) => {
      const f = paths.fileIn('scripts', script);
      if (!f || !fs.existsSync(f)) throw new Error('script not found');
      const extra = {};
      for (const pair of String(env || '').split(',')) {
        const i = pair.indexOf('=');
        if (i > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(pair.slice(0, i).trim())) extra[pair.slice(0, i).trim()] = pair.slice(i + 1);
      }
      const p = spawn('/bin/bash', [f, ...String(args || '').split(' ').filter(Boolean)],
        { cwd: paths.dir('scripts'), detached: true, stdio: 'ignore', env: { ...process.env, ...extra, MEDIADIR: paths.MEDIA_DIR } });
      p.on('error', () => {});
      p.unref();
      return `${path.basename(f)} started`;
    },
  });

  if (presets) {
    cmds.register('Trigger Command Preset', {
      category: 'Presets', description: 'Run every command in a preset.',
      args: [{ name: 'name', type: 'datalist', description: 'Preset', contentListUrl: 'api/commandPresets?names=true' }],
      run: ([name]) => presets.trigger(name),
    });
    cmds.register('Trigger Command Preset Slot', {
      category: 'Presets', description: 'Run every preset command with this slot number.',
      args: [{ name: 'slot', type: 'int', description: 'Slot', min: 1, max: 255, default: '1' }],
      run: ([slot]) => presets.triggerSlot(slot),
    });
    cmds.register('Trigger Multiple Command Presets', {
      category: 'Presets', description: 'Run up to six presets in order.',
      args: ['A', 'B', 'C', 'D', 'E', 'F'].map((k, i) => ({ name: 'Name' + k, type: 'datalist', description: 'Preset ' + k, contentListUrl: 'api/commandPresets?names=true', optional: i > 0 })),
      run: async (names) => { for (const n of names) if (n) await presets.trigger(n); },
    });
  }

  const confirm = [{ name: 'confirm', type: 'bool', description: 'Confirm', default: 'false' }];
  const needConfirm = (c) => { if (!toBool(c)) throw new Error('set confirm to true to run this'); };
  if (system.restart) cmds.register('Restart FPPD', { category: 'System', description: 'Restart the player software.', run: () => { system.restart(); return 'restarting'; } });
  if (system.reboot) cmds.register('Reboot', { category: 'System', description: 'Reboot the Pi.', args: confirm, run: ([c]) => { needConfirm(c); system.reboot(); return 'rebooting'; } });
  if (system.shutdown) cmds.register('Shutdown', { category: 'System', description: 'Shut the Pi down.', args: confirm, run: ([c]) => { needConfirm(c); system.shutdown(); return 'shutting down'; } });
}

module.exports = { Commands, registerCore, toBool, toInt, fetchUrl };
