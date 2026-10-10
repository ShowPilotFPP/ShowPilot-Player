// Restore from an FPP backup file (the JSON from FPP's Content Setup →
// File Manager/Backups "Download" or an "all" backup). analyze() lists what
// the file holds as sections of selectable items; restore() writes only the
// items the user picked. Network settings, passwords, pixel-string/panel
// outputs and other hardware specific to the FPP device are never restored.
//
// Backup layout (FPP www/backup.php): text files are arrays of lines (join
// with "\n"), JSON files are wrapped in a one-element array, settings are
// settings.system_settings[0] (all values strings). See PRIMER.md.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const playlists = require('./playlists');
const scheduler = require('./scheduler');
const presets = require('./presets');
const holidays = require('./holidays');
const { fromFpp } = require('./fppcompat/outputs-map');

const SAFE = /^[A-Za-z0-9_][A-Za-z0-9 _.()&'+,-]*$/;
const PLUGIN_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

const joinLines = (v) => (Array.isArray(v) ? v.map((x) => (x === null || x === undefined ? '' : String(x))).join('\n') : typeof v === 'string' ? v : '');
const unwrap = (v) => (Array.isArray(v) && v.length === 1 && !Array.isArray(v[0]) && typeof v[0] !== 'string' ? v[0] : v);
const parseJsonLines = (v) => { const t = joinLines(v).trim(); if (!t) return null; try { return JSON.parse(t); } catch { return undefined; } };
const truthy = (v) => /^(1|true|yes)$/i.test(String(v ?? '').replace(/"/g, ''));

function findBlob(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 12) return false;
  if (!Array.isArray(o) && o.__fppBlob) return true;
  return Object.values(o).some((v) => findBlob(v, depth + 1));
}

// ------------------------------------------------------------- schedule

const DAY_SETS = { 7: [0, 1, 2, 3, 4, 5, 6], 8: [1, 2, 3, 4, 5], 9: [0, 6], 10: [1, 3, 5], 11: [2, 4], 12: [0, 1, 2, 3, 4], 13: [5, 6] };
const MASK_BITS = [0x4000, 0x2000, 0x1000, 0x0800, 0x0400, 0x0200, 0x0100]; // Sun..Sat

function fppDays(code, warn) {
  const n = Number(code);
  if (n >= 0 && n <= 6) return [n];
  if (DAY_SETS[n]) return DAY_SETS[n];
  if (n === 14 || n === 15) { warn(`"${n === 14 ? 'Odd' : 'Even'} days" is not supported; it now runs every day`); return DAY_SETS[7]; }
  if (n >= 0x10000) { const d = MASK_BITS.map((b, i) => (n & b ? i : -1)).filter((i) => i >= 0); return d.length ? d : DAY_SETS[7]; }
  warn(`unknown day setting ${code}; it now runs every day`);
  return DAY_SETS[7];
}

const SUN_NAMES = { sunrise: 'sunrise', sunset: 'sunset', dawn: 'dawn', dusk: 'dusk' };
function fppTime(t, offset) {
  const s = String(t || '').trim();
  if (s === '25:00:00') return { time: 'sunrise', offset: Number(offset) || 0 };
  if (s === '26:00:00') return { time: 'sunset', offset: Number(offset) || 0 };
  const sun = SUN_NAMES[s.toLowerCase()];
  if (sun) return { time: sun, offset: Number(offset) || 0 };
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  return m ? { time: `${m[1].padStart(2, '0')}:${m[2]}`, offset: 0 } : null; // FPP ignores offsets on clock times
}

function fppDate(d, known, warn) {
  const s = String(d || '').trim();
  if (!s || s === '2019-01-01' || s === '2099-12-31' || s === '0000-00-00') return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    if (s.slice(5, 7) === '00') { warn(`monthly date "${s}" is not supported; the date limit was removed`); return ''; }
    return s;
  }
  if (known.has(s)) return s;
  warn(`holiday "${s}" is not known here; the date limit was removed`);
  return '';
}

// One FPP schedule.json entry → a ShowPilot Player entry (+ warnings).
function convertScheduleEntry(f, { knownHolidays = new Set(holidays.list().map((h) => h.shortName)) } = {}) {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const isCmd = !f.playlist;
  const isSeq = !isCmd && (f.sequence === 1 || f.sequence === true || f.sequence === '1' || /\.fseq$/i.test(f.playlist));
  const st = fppTime(f.startTime, f.startTimeOffset);
  const et = fppTime(f.endTime, f.endTimeOffset);
  if (!st) return { entry: null, warnings: [`entry with start time "${f.startTime}" skipped`] };
  const rep = Number(f.repeat) || 0;
  const entry = {
    enabled: !(f.enabled === 0 || f.enabled === false || f.enabled === '0'),
    type: isCmd ? 'command' : isSeq ? 'sequence' : 'playlist',
    playlist: isCmd || isSeq ? '' : String(f.playlist),
    sequence: isSeq ? String(f.playlist) : '',
    repeat: rep === 1,
    repeatEvery: rep >= 100 ? Math.round(rep / 100) : 0,
    command: isCmd ? String(f.command || '') : '',
    args: isCmd && Array.isArray(f.args) ? f.args.map(String) : [],
    multisyncCommand: isCmd && truthy(f.multisyncCommand),
    multisyncHosts: isCmd && truthy(f.multisyncCommand) ? String(f.multisyncHosts || '') : '',
    days: fppDays(f.day, warn),
    startDate: fppDate(f.startDate, knownHolidays, warn),
    startDateOffset: Number(f.startDateOffset) || 0,
    endDate: fppDate(f.endDate, knownHolidays, warn),
    endDateOffset: Number(f.endDateOffset) || 0,
    startTime: st.time, startOffset: st.offset,
    endTime: et ? et.time : st.time, endOffset: et ? et.offset : 0,
    stopType: Number(f.stopType) === 1 ? 'hard' : Number(f.stopType) === 2 ? 'loop' : 'graceful',
  };
  if (isCmd && !entry.command) return { entry: null, warnings: ['command entry with no command skipped'] };
  return { entry: scheduler.clean(entry), warnings };
}

// ------------------------------------------------------------- reading

function read(backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) throw new Error('This is not an FPP backup file.');
  const known = ['settings', 'show_setup', 'channelOutputs', 'plugins', 'model-overlays', 'fpp_backup_version', 'backup_taken'];
  if (!known.some((k) => k in backup)) throw new Error('This file does not look like an FPP backup (no settings, show setup or outputs in it).');
  if (findBlob(backup)) throw new Error('This backup refers to separate blob files that are only on the FPP device. Download the backup from FPP\'s web page instead of copying it off the SD card.');

  const settings = (backup.settings && unwrap(backup.settings.system_settings)) || {};
  const ss = (backup.show_setup || {});
  const out = { settings: typeof settings === 'object' && !Array.isArray(settings) ? settings : {}, warnings: [] };

  out.timezone = (backup.settings && Array.isArray(backup.settings.timezone) && typeof backup.settings.timezone[0] === 'string' && backup.settings.timezone[0]) || out.settings.TimeZone || '';

  // User holidays (misc_configs) first, so schedule dates using them resolve.
  out.userHolidays = null;
  const misc = backup.misc_configs && Array.isArray(backup.misc_configs.configs) ? backup.misc_configs.configs[0] : null;
  if (misc && Array.isArray(misc['user-holidays.json'])) out.userHolidays = misc['user-holidays.json'];

  out.schedule = [];
  if (ss.schedule) {
    const raw = Array.isArray(ss.schedule) && Array.isArray(ss.schedule[0]) ? parseJsonLines(ss.schedule[0]) : parseJsonLines(ss.schedule);
    if (raw === undefined) out.warnings.push('The schedule in this backup could not be read.');
    else if (Array.isArray(raw)) {
      const knownHolidays = new Set([...holidays.list().map((h) => h.shortName), ...(out.userHolidays || []).map((h) => h && h.shortName)]);
      raw.forEach((f, i) => {
        const r = convertScheduleEntry(f || {}, { knownHolidays });
        out.schedule.push({ index: i, source: f, entry: r.entry, warnings: r.warnings });
      });
    }
  }

  out.playlists = [];
  for (const [file, lines] of Object.entries(ss.playlist || {})) {
    const name = file.replace(/\.json$/i, '');
    if (!SAFE.test(name)) { out.warnings.push(`playlist "${name}" has an unusable name; skipped`); continue; }
    const pl = parseJsonLines(lines);
    if (!pl || typeof pl !== 'object') { out.warnings.push(`playlist "${name}" could not be read; skipped`); continue; }
    out.playlists.push({ name, data: pl });
  }

  out.scripts = [];
  for (const [file, lines] of Object.entries(ss.scripts || {})) {
    if (!SAFE.test(file) || file.includes('/')) { out.warnings.push(`script "${file}" has an unusable name; skipped`); continue; }
    out.scripts.push({ name: file, text: joinLines(lines) });
  }

  const cp = backup.settings ? unwrap(backup.settings.commandPresets) : null;
  out.presets = cp && Array.isArray(cp.commands) ? presets.groups(cp.commands.map(presets.cleanRow).filter((r) => r.name && r.command)) : [];

  const uni = backup.channelOutputs ? unwrap(backup.channelOutputs.universes) : null;
  out.outputs = uni && typeof uni === 'object' ? fromFpp(uni) : null;
  out.otherOutputs = [];
  for (const k of ['pixel_strings', 'bbb_strings', 'pwm', 'led_panels', 'other']) {
    const v = backup.channelOutputs ? unwrap(backup.channelOutputs[k]) : null;
    if (v && Array.isArray(v.channelOutputs) && v.channelOutputs.some((c) => c && (c.enabled === 1 || c.enabled === true))) out.otherOutputs.push(k);
  }

  const mo = backup['model-overlays'];
  out.models = mo && Array.isArray(mo.models) ? mo.models : Array.isArray(mo) ? mo : null;
  out.virtualDisplay = Array.isArray(backup.virtualdisplaymap) ? joinLines(backup.virtualdisplaymap) : null;

  out.pluginSettings = [];
  for (const [name, v] of Object.entries(backup.plugins || {})) {
    if (!PLUGIN_RE.test(name) || !v || typeof v !== 'object') continue;
    const lines = v['plugin.' + name];
    const text = joinLines(Array.isArray(lines) && Array.isArray(lines[0]) ? lines[0] : lines);
    if (text.trim()) out.pluginSettings.push({ name, text });
  }

  out.meta = {
    hostName: out.settings.HostName || '', description: out.settings.HostDescription || '',
    platform: String(backup.platform || out.settings.Platform || ''), taken: Number.isFinite(new Date(Number(backup.backup_taken) * 1000).getTime()) && Number(backup.backup_taken) ? new Date(Number(backup.backup_taken) * 1000).toISOString() : null,
    comment: backup.backup_comment || '',
  };
  return out;
}

// ------------------------------------------------------------- analyze

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function describeEntry(e, holidayNames = {}) {
  const what = e.type === 'command' ? `Command: ${e.command}${e.args.filter(Boolean).length ? ` (${e.args.filter(Boolean).join(', ')})` : ''}` : e.type === 'sequence' ? `Sequence: ${e.sequence.replace(/\.fseq$/i, '')}` : `Playlist: ${e.playlist}`;
  const off = (o, unit) => (o ? ` ${o > 0 ? '+' : '−'}${Math.abs(o)} ${unit}` : '');
  const t = (x, o) => {
    if (/^\d/.test(x)) { const [h, m] = x.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h % 24 < 12 ? 'AM' : 'PM'}`; }
    return x.charAt(0).toUpperCase() + x.slice(1) + off(o, 'min');
  };
  const d = (x, o) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(x);
    if (m) return `${MON[+m[2] - 1]} ${+m[3]}${m[1] === '0000' ? '' : `, ${m[1]}`}`;
    return (holidayNames[x] || x) + off(o, Math.abs(o) === 1 ? 'day' : 'days');
  };
  const days = e.days.length === 7 ? 'every day' : e.days.map((x) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][x]).join(', ');
  const when = e.type === 'command' && !e.repeatEvery ? `at ${t(e.startTime, e.startOffset)}` : `${t(e.startTime, e.startOffset)} – ${t(e.endTime, e.endOffset)}${e.repeatEvery ? `, every ${e.repeatEvery} min` : ''}`;
  const dates = e.startDate || e.endDate ? ` · ${e.startDate ? d(e.startDate, e.startDateOffset) : 'any time'} → ${e.endDate ? d(e.endDate, e.endDateOffset) : 'no end'}` : '';
  return `${what} · ${days} · ${when}${dates}${e.enabled ? '' : ' · disabled'}`;
}

// What the file holds, as sections the UI shows with checkboxes.
// env: { commandNames: Set, audioCards: [{ id, card }], plugins: [names], library: { sequences, media } }
function analyze(backup, env = {}) {
  const b = read(backup);
  const s = b.settings;
  const sections = [];
  const cmdKnown = (c) => !env.commandNames || env.commandNames.has(c);

  // Settings, split so each can be picked on its own.
  const items = [];
  if (s.HostName || s.HostDescription) items.push({ id: 'identity', label: 'Name and description', detail: [s.HostName, s.HostDescription].filter(Boolean).join(' — '), checked: false });
  if (s.Latitude && s.Longitude) items.push({ id: 'location', label: 'Location (for dusk and sunset)', detail: `${s.Latitude}, ${s.Longitude}`, checked: true });
  if (b.timezone) items.push({ id: 'timezone', label: 'Timezone', detail: b.timezone, checked: true });
  if ('MultiSyncEnabled' in s || s.MultiSyncRemotes) {
    const remotes = [s.MultiSyncRemotes, s.MultiSyncExtraRemotes].filter(Boolean).join(',').replace(/"/g, '').split(',').map((x) => x.trim()).filter(Boolean);
    items.push({ id: 'multisync', label: 'MultiSync', detail: `${truthy(s.MultiSyncEnabled) ? 'sending' : 'off'}${remotes.length ? ` · remotes ${remotes.join(', ')}` : ''}`, checked: true });
  }
  if (s.fppMode) items.push({ id: 'mode', label: 'Player / remote mode', detail: /remote/i.test(s.fppMode) ? 'Remote' : 'Player', checked: false });
  if (s.AudioOutput) {
    const card = (env.audioCards || []).find((c) => c.card === s.AudioOutput);
    items.push({ id: 'audio', label: 'Audio output', detail: card ? `${s.AudioOutput}` : `${s.AudioOutput} (no such sound card on this player; automatic stays)`, checked: false, disabled: !card });
  }
  if (items.length) sections.push({ id: 'settings', label: 'Settings', items, note: 'Network settings and passwords are never restored.' });

  const holidayNames = Object.fromEntries([...holidays.list().map((h) => [h.shortName, h.name]), ...(b.userHolidays || []).filter(Boolean).map((h) => [h.shortName, h.name])]);
  if (b.schedule.length) {
    sections.push({ id: 'schedule', label: 'Schedule', mode: 'replace', note: 'Replaces the current schedule (or add to it).',
      items: b.schedule.map((x) => ({ id: String(x.index), label: x.entry ? describeEntry(x.entry, holidayNames) : 'Unusable entry', checked: !!x.entry, disabled: !x.entry,
        warnings: [...x.warnings, ...(x.entry && x.entry.type === 'command' && !cmdKnown(x.entry.command) ? [`"${x.entry.command}" is not a command on this player (a plugin may add it)`] : [])] })) });
  }
  if (b.playlists.length) {
    const lib = env.library;
    sections.push({ id: 'playlists', label: 'Playlists', note: 'Same-named playlists are replaced.', items: b.playlists.map((p) => {
      const missing = [];
      if (lib) for (const sec of playlists.SECTIONS) for (const e of (Array.isArray(p.data[sec]) ? p.data[sec] : [])) {
        if (!e || typeof e !== 'object') continue;
        if (e.sequenceName && !lib.sequences.includes(e.sequenceName)) missing.push(e.sequenceName);
        if (e.mediaName && !lib.media.includes(e.mediaName)) missing.push(e.mediaName);
      }
      const n = playlists.SECTIONS.reduce((a, k) => a + (Array.isArray(p.data[k]) ? p.data[k].length : 0), 0);
      return { id: p.name, label: p.name, detail: `${n} item${n === 1 ? '' : 's'}`, checked: !p.name.startsWith('_'),
        warnings: missing.length ? [`not on this player yet: ${[...new Set(missing)].slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}`] : [] };
    }) });
  }
  if (b.presets.length) {
    sections.push({ id: 'presets', label: 'Command presets', note: 'Same-named presets are replaced.', items: b.presets.map((g) => ({
      id: g.name, label: g.name, detail: g.commands.map((c) => c.command).join(', ') + (g.presetSlot ? ` · slot ${g.presetSlot}` : ''), checked: true,
      warnings: g.commands.filter((c) => !cmdKnown(c.command)).map((c) => `"${c.command}" is not a command on this player`) })) });
  }
  if (b.scripts.length) {
    sections.push({ id: 'scripts', label: 'Scripts', note: 'Same-named scripts are replaced.', items: b.scripts.map((x) => ({ id: x.name, label: x.name, detail: `${x.text.split('\n').length} lines`, checked: true })) });
  }
  const outItems = [];
  if (b.outputs && (b.outputs.outputs.length || b.outputs.skipped.length)) {
    outItems.push({ id: 'universes', label: 'E1.31 / DDP controller outputs', detail: `${b.outputs.outputs.length} output${b.outputs.outputs.length === 1 ? '' : 's'} (replaces the current list)`,
      checked: b.outputs.outputs.length > 0, disabled: !b.outputs.outputs.length,
      warnings: b.outputs.skipped.length ? [`${b.outputs.skipped.length} Art-Net/KiNet/Twinkly output${b.outputs.skipped.length === 1 ? '' : 's'} not supported`] : [] });
  }
  if (b.models && b.models.length) outItems.push({ id: 'models', label: 'Pixel overlay models', detail: `${b.models.length} model${b.models.length === 1 ? '' : 's'}`, checked: true });
  if (b.virtualDisplay && b.virtualDisplay.trim()) outItems.push({ id: 'virtualdisplay', label: 'Virtual display map', detail: `${b.virtualDisplay.split('\n').length} lines`, checked: true });
  if (outItems.length) sections.push({ id: 'outputs', label: 'Outputs', items: outItems });
  if (b.pluginSettings.length) {
    sections.push({ id: 'plugins', label: 'Plugin settings', note: 'Restores each plugin\'s settings file; install the plugin itself on the Plugins page.',
      items: b.pluginSettings.map((p) => ({ id: p.name, label: p.name, detail: (env.plugins || []).includes(p.name) ? 'installed' : 'not installed here', checked: true })) });
  }
  if (b.userHolidays && b.userHolidays.length) {
    sections.push({ id: 'holidays', label: 'Custom holidays', items: [{ id: 'user', label: 'Custom holidays', detail: b.userHolidays.map((h) => h && h.name).filter(Boolean).join(', '), checked: true }] });
  }

  const skipped = ['Network and Wi-Fi settings', 'Passwords and email settings'];
  if (b.otherOutputs.length) skipped.push(`Pi/cape pixel and panel outputs (${b.otherOutputs.join(', ')}) — ShowPilot Player sends E1.31/DDP only`);
  if (backup.channelInputs) skipped.push('Channel inputs (bridge mode)');
  if (backup['gpio-input'] && (Array.isArray(backup['gpio-input']) ? backup['gpio-input'].length : true)) skipped.push('GPIO inputs');
  return { meta: b.meta, sections, skipped, warnings: b.warnings };
}

// ------------------------------------------------------------- restore

// selection: { settings: [ids], schedule: [indexes], scheduleMode: 'replace'|'append',
//   playlists: [names], presets: [names], scripts: [names], outputs: [ids], plugins: [names], holidays: ['user'] }
// deps: { config, setTimezone: async (tz) => {}, audioCards: [] }
async function restore(backup, selection = {}, deps) {
  const b = read(backup);
  const sel = (k) => new Set((Array.isArray(selection[k]) ? selection[k] : []).map(String));
  const done = [];
  const problems = [];
  const s = b.settings;
  const { config } = deps;

  const st = sel('settings');
  const patch = {};
  if (st.has('identity')) {
    if (s.HostName) patch.hostName = String(s.HostName).trim().slice(0, 63);
    if (s.HostDescription !== undefined) patch.hostDescription = String(s.HostDescription);
    done.push('name and description');
  }
  if (st.has('location') && s.Latitude && s.Longitude) {
    const lat = parseFloat(s.Latitude), lon = parseFloat(s.Longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) { patch.location = { latitude: lat, longitude: lon }; done.push('location'); }
  }
  if (st.has('multisync')) {
    const remotes = [s.MultiSyncRemotes, s.MultiSyncExtraRemotes].filter(Boolean).join(',').replace(/"/g, '').split(',').map((x) => x.trim()).filter(Boolean);
    patch.multisync = { enabled: truthy(s.MultiSyncEnabled), remotes: [...new Set(remotes)] };
    if ('MultiSyncMulticast' in s) patch.multisync.multicast = truthy(s.MultiSyncMulticast);
    if ('MultiSyncBroadcast' in s) patch.multisync.broadcast = truthy(s.MultiSyncBroadcast);
    done.push('MultiSync');
  }
  if (st.has('mode') && s.fppMode) { patch.mode = /remote/i.test(s.fppMode) ? 'remote' : 'player'; done.push('player mode'); }
  if (st.has('audio') && s.AudioOutput) {
    const card = (deps.audioCards || []).find((c) => c.card === s.AudioOutput);
    if (card) { patch.audioDevice = card.id; done.push('audio output (restart the player to apply)'); } else problems.push(`audio output ${s.AudioOutput} not found`);
  }
  if (Object.keys(patch).length) config.update(patch);
  if (st.has('timezone') && b.timezone) {
    try { await deps.setTimezone(b.timezone); done.push(`timezone ${b.timezone}`); } catch (e) { problems.push(`timezone: ${e.message}`); }
  }

  // Holidays before the schedule that may use them.
  if (sel('holidays').has('user') && b.userHolidays) {
    fs.writeFileSync(path.join(paths.dir('config'), 'user-holidays.json'), JSON.stringify(b.userHolidays, null, 2));
    holidays.reload();
    done.push('custom holidays');
  }

  const sp = sel('playlists');
  let nPl = 0;
  for (const p of b.playlists) {
    if (!sp.has(p.name)) continue;
    try { playlists.save(p.name, p.data); nPl++; } catch (e) { problems.push(`playlist ${p.name}: ${e.message}`); }
  }
  if (nPl) done.push(`${nPl} playlist${nPl === 1 ? '' : 's'}`);

  const ss = sel('schedule');
  if (ss.size) {
    // Re-convert with the holidays now on this player.
    const knownHolidays = new Set(holidays.list().map((h) => h.shortName));
    const picked = [];
    for (const x of b.schedule.filter((y) => ss.has(String(y.index)))) {
      const r = convertScheduleEntry(x.source || {}, { knownHolidays });
      if (r.entry) picked.push(r.entry);
      // e.g. a custom holiday left unticked: the date limit was dropped — say so.
      for (const w of r.warnings) if (!x.warnings.includes(w)) problems.push(`schedule entry ${x.index + 1}: ${w}`);
    }
    const list = selection.scheduleMode === 'append' ? [...scheduler.load(), ...picked] : picked;
    scheduler.save(list);
    done.push(`${picked.length} schedule entr${picked.length === 1 ? 'y' : 'ies'}${selection.scheduleMode === 'append' ? ' (added)' : ''}`);
  }

  const pp = sel('presets');
  const rows = b.presets.filter((g) => pp.has(g.name)).flatMap((g) => g.commands);
  if (rows.length) { presets.merge(rows); done.push(`${pp.size} command preset${pp.size === 1 ? '' : 's'}`); }

  const sc = sel('scripts');
  let nSc = 0;
  for (const x of b.scripts) {
    if (!sc.has(x.name)) continue;
    const f = paths.fileIn('scripts', x.name);
    if (!f) { problems.push(`script ${x.name}: bad name`); continue; }
    fs.writeFileSync(f, x.text.endsWith('\n') ? x.text : x.text + '\n', { mode: 0o755 });
    try { fs.chmodSync(f, 0o755); } catch {}
    nSc++;
  }
  if (nSc) done.push(`${nSc} script${nSc === 1 ? '' : 's'}`);

  const so = sel('outputs');
  if (so.has('universes') && b.outputs && b.outputs.outputs.length) { config.update({ outputs: b.outputs.outputs }); done.push(`${b.outputs.outputs.length} controller outputs`); }
  if (so.has('models') && b.models) { fs.writeFileSync(path.join(paths.dir('config'), 'model-overlays.json'), JSON.stringify({ models: b.models }, null, 2)); done.push('overlay models'); }
  if (so.has('virtualdisplay') && b.virtualDisplay) { fs.writeFileSync(path.join(paths.dir('config'), 'virtualdisplaymap'), b.virtualDisplay); done.push('virtual display map'); }

  const pg = sel('plugins');
  let nPg = 0;
  for (const p of b.pluginSettings) {
    if (!pg.has(p.name)) continue;
    fs.writeFileSync(path.join(paths.dir('config'), 'plugin.' + p.name), p.text.endsWith('\n') ? p.text : p.text + '\n');
    nPg++;
  }
  if (nPg) done.push(`settings for ${nPg} plugin${nPg === 1 ? '' : 's'}`);

  return { restored: done, problems };
}

module.exports = { analyze, restore, read, convertScheduleEntry, fppDays };
