// Command presets, stored exactly like FPP's config/commandPresets.json:
//   { "commands": [ { name, presetSlot, command, args, multisyncCommand, multisyncHosts? } ] }
// Rows that share a name form one preset and run in file order. A slot
// (1-255, 0 = none) lets "Trigger Command Preset Slot" fire every row with
// that slot. Some names are fired by the player itself (RESERVED below),
// the same as FPP, so a preset called PLAYLIST_STOPPED runs when a playlist
// stops.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const FILE = () => path.join(paths.dir('config'), 'commandPresets.json');

const RESERVED = ['FPPD_STARTED', 'FPPD_STOPPED', 'PLAYLIST_STARTED', 'PLAYLIST_STOPPED',
  'PLAYLIST_STOPPING_NOW', 'PLAYLIST_STOPPING_GRACEFULLY', 'PLAYLIST_STOPPING_AFTER_LOOP',
  'MEDIA_STARTED', 'MEDIA_STOPPED'];

function cleanRow(r) {
  const row = {
    name: String((r && r.name) || '').trim(),
    presetSlot: Math.max(0, Math.min(255, parseInt(r && r.presetSlot, 10) || 0)),
    command: String((r && r.command) || ''),
    args: Array.isArray(r && r.args) ? r.args.map((a) => (a === null || a === undefined ? '' : String(a))) : [],
    multisyncCommand: !!(r && (r.multisyncCommand === true || r.multisyncCommand === 1 || r.multisyncCommand === '1')),
  };
  if (row.multisyncCommand) row.multisyncHosts = String((r && r.multisyncHosts) || '');
  return row;
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return { commands: (Array.isArray(j.commands) ? j.commands : []).map(cleanRow).filter((r) => r.name && r.command) };
  } catch { return { commands: [] }; }
}

function save(data) {
  const rows = (Array.isArray(data) ? data : (data && Array.isArray(data.commands) ? data.commands : []))
    .map(cleanRow).filter((r) => r.name && r.command);
  const out = { commands: rows };
  const f = FILE();
  fs.writeFileSync(f + '.tmp', JSON.stringify(out, null, 2));
  fs.renameSync(f + '.tmp', f);
  return out;
}

function names() { return [...new Set(load().commands.map((r) => r.name))]; }

// Presets as groups, in first-appearance order: [{ name, presetSlot, commands: [row] }].
function groups(rows = load().commands) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.name)) map.set(r.name, { name: r.name, presetSlot: r.presetSlot, commands: [] });
    const g = map.get(r.name);
    if (!g.presetSlot && r.presetSlot) g.presetSlot = r.presetSlot;
    g.commands.push(r);
  }
  return [...map.values()];
}

// Replace or add some presets (by name), keeping the others.
function merge(newRows) {
  const incoming = newRows.map(cleanRow).filter((r) => r.name && r.command);
  const replace = new Set(incoming.map((r) => r.name));
  return save([...load().commands.filter((r) => !replace.has(r.name)), ...incoming]);
}

// FPP-style %KEYWORD% substitution in preset args.
function fill(args, keywords) {
  if (!keywords) return args;
  return args.map((a) => a.replace(/%([A-Z0-9_]+)%/g, (m, k) => (Object.prototype.hasOwnProperty.call(keywords, k) ? String(keywords[k]) : m)));
}

class PresetRunner {
  constructor({ commands, sendMultisync, log }) {
    this.commands = commands;
    this.sendMultisync = sendMultisync || (() => {});
    this.log = log || (() => {});
    this.running = new Set(); // recursion guard, like FPP
  }

  async runRow(r, keywords) {
    const args = fill(r.args, keywords);
    if (r.multisyncCommand) this.sendMultisync(r.command, args, r.multisyncHosts || '');
    return this.commands.run(r.command, args);
  }

  async _runRows(key, rows, keywords) {
    if (this.running.has(key)) { this.log(`preset ${key} is already running; skipped to avoid a loop`); return 'skipped'; }
    this.running.add(key);
    try {
      for (const r of rows) {
        try { await this.runRow(r, keywords); } catch (e) { this.log(`preset ${r.name}: ${r.command} failed: ${e.message}`); }
      }
    } finally { this.running.delete(key); }
    return `${rows.length} command${rows.length === 1 ? '' : 's'} run`;
  }

  async trigger(name, keywords) {
    const rows = load().commands.filter((r) => r.name === name);
    if (!rows.length) {
      if (RESERVED.includes(name)) return 'no preset';
      const e = new Error(`No command preset named "${name}"`); e.status = 404; throw e;
    }
    return this._runRows('name:' + name, rows, keywords);
  }

  async triggerSlot(slot) {
    const n = parseInt(slot, 10);
    if (!(n >= 1 && n <= 255)) throw new Error('slot must be 1-255');
    const rows = load().commands.filter((r) => r.presetSlot === n);
    if (!rows.length) return 'no preset uses that slot';
    return this._runRows('slot:' + n, rows);
  }

  // Fire a reserved event preset if one exists; never throws.
  fire(name, keywords) {
    if (!load().commands.some((r) => r.name === name)) return;
    this.trigger(name, keywords).catch((e) => this.log(`preset ${name}: ${e.message}`));
  }
}

module.exports = { load, save, names, groups, merge, cleanRow, PresetRunner, RESERVED, FILE };
