// FPP script/PHP plugin host (see PRIMER.md "FPP plugins").
// Supported: install from a GitHub/git URL or FPP's plugin catalog,
// scripts/fpp_install.sh / fpp_upgrade.sh / fpp_uninstall.sh, start/stop
// hooks, the callbacks contract (--list, media, playlist, lifecycle,
// synchronous query_next), commands/descriptions.json, menu.inc pages served
// through php-cgi, api.php endpoints, and per-plugin settings files.
// Not supported: native C++ plugins (lib<name>.so loaded into fppd) and
// anything that needs fppd internals. Those plugins are flagged in the UI.

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');
const paths = require('./paths');

const FPPDIR = process.env.SPP_FPPDIR || '/opt/fpp';
const CATALOG_URL = 'https://raw.githubusercontent.com/FalconChristmas/fpp-pluginList/master/pluginList.json';
// Must start with a letter/digit/underscore: rules out ".", ".." and hidden names.
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
// The ShowPilot plugin's features are built in; installing it would run two
// listeners against the same server.
const BUILT_IN = new Set(['showpilot-plugin', 'ShowPilot-plugin']);

function pluginDir(name) { return NAME_RE.test(name || '') ? path.join(paths.dir('plugins'), name) : null; }

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

function run(cmd, args, { cwd, env, timeoutMs = 600000, input } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => { out += '\n[timed out]'; p.kill('SIGKILL'); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: out + e.message }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

function scriptEnv() {
  return {
    FPPDIR, SRCDIR: `${FPPDIR}/src`, MEDIADIR: paths.MEDIA_DIR, PLUGINDIR: paths.dir('plugins'),
    LOGDIR: paths.dir('logs'), CFGDIR: paths.dir('config'), SETTINGSFILE: path.join(paths.MEDIA_DIR, 'settings'),
    CFGFILE: path.join(paths.MEDIA_DIR, 'settings'), FPPUSER: 'fpp', FPPGROUP: 'fpp', SUDO: '',
    SHOWPILOT_PLAYER: '1',
  };
}

// How a callbacks script (or any plugin script) is run, by extension, like
// FPP's scripts/eventScript.
function interpreterFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.sh') return ['/bin/bash', [file]];
  if (ext === '.php') return ['/usr/bin/php', [file]];
  if (ext === '.py') return ['/usr/bin/python3', [file]];
  if (ext === '.pl') return ['/usr/bin/perl', [file]];
  return [file, []];
}

class Plugins extends EventEmitter {
  constructor({ commands, show, player }) {
    super();
    this.commands = commands;
    this.show = show;
    this.player = player;
    this.loaded = new Map(); // name -> { callbacks, types: Set, native }
    this.busy = false;
  }

  // ---------------------------------------------------------------- listing
  list() {
    let dirs = [];
    try { dirs = fs.readdirSync(paths.dir('plugins'), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch {}
    return dirs.sort().map((name) => {
      const dir = pluginDir(name);
      const info = readJson(path.join(dir, 'pluginInfo.json')) || {};
      const l = this.loaded.get(name);
      return {
        name, displayName: info.name || name, author: info.author || '', description: info.description || '',
        homeURL: info.homeURL || '', srcURL: info.srcURL || '',
        version: this._gitRev(dir), callbacks: l ? [...l.types] : [],
        native: l ? l.native : false, pages: this.pages(name),
      };
    });
  }

  _gitRev(dir) {
    try {
      const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
      if (head.startsWith('ref: ')) return fs.readFileSync(path.join(dir, '.git', head.slice(5)), 'utf8').trim().slice(0, 7);
      return head.slice(0, 7);
    } catch { return ''; }
  }

  // Pages from menu.inc, found the same static way FPP's "Open" button does.
  pages(name) {
    const dir = pluginDir(name);
    const out = [];
    for (const f of ['menu.inc', 'status_menu.inc', 'content_menu.inc', 'output_menu.inc', 'help_menu.inc']) {
      let txt = '';
      try { txt = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      const re = /'page'\s*=>\s*'([^']+)'/g;
      let m;
      while ((m = re.exec(txt))) out.push(m[1]);
      const re2 = /[?&]page=([A-Za-z0-9_.-]+)/g;
      while ((m = re2.exec(txt))) out.push(m[1]);
    }
    return [...new Set(out)].filter((p) => NAME_RE.test(p));
  }

  async catalog() {
    const r = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`catalog HTTP ${r.status}`);
    const j = await r.json();
    return (j.pluginList || []).map(([name, infoURL]) => ({ name, infoURL, builtIn: BUILT_IN.has(name) }));
  }

  // ---------------------------------------------------------------- install
  // `src` is a git URL (https://github.com/owner/repo[.git]) or a pluginInfo.json URL.
  async install(src, { branch } = {}) {
    if (this.busy) throw new Error('another plugin operation is running');
    this.busy = true;
    const log = [];
    try {
      let url = String(src || '').trim();
      let info = null;
      if (/pluginInfo\.json$/i.test(url)) {
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`pluginInfo HTTP ${r.status}`);
        info = await r.json();
        url = info.srcURL;
      }
      if (!/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_.\/-]+$/.test(url || '')) throw new Error('give an https git URL or a pluginInfo.json URL');
      const guess = (info && info.repoName) || path.basename(url).replace(/\.git$/i, '');
      if (BUILT_IN.has(guess)) throw new Error('ShowPilot is built into ShowPilot Player; configure it on the ShowPilot page instead');
      if (!NAME_RE.test(guess)) throw new Error('bad plugin name');
      const pick = info ? this._pickVersion(info) : null;
      const br = branch || (pick && pick.branch) || (info && info.branch) || null;

      const tmp = path.join(paths.dir('plugins'), `.install-${Date.now()}`);
      const args = ['clone', '--depth', '1', '--single-branch'];
      if (br) args.push('--branch', br);
      args.push('--', url, tmp);
      const c = await run('git', args, { env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 300000 });
      log.push(c.out);
      if (c.code !== 0) throw new Error('git clone failed: ' + c.out.trim().split('\n').pop());

      const cloned = readJson(path.join(tmp, 'pluginInfo.json')) || {};
      const name = cloned.repoName || guess;
      if (BUILT_IN.has(name)) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('ShowPilot is built in'); }
      const dir = pluginDir(name);
      if (!dir) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('bad repoName in pluginInfo.json'); }
      if (fs.existsSync(dir)) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(`${name} is already installed`); }
      if (pick && pick.sha) await run('git', ['-C', tmp, 'fetch', '--depth', '1', 'origin', pick.sha]).then(() => run('git', ['-C', tmp, 'reset', '--hard', pick.sha]));
      fs.renameSync(tmp, dir);
      for (const f of ['callbacks', 'callbacks.sh', 'fpp_install.sh', 'fpp_uninstall.sh']) { try { fs.chmodSync(path.join(dir, f), 0o755); } catch {} }
      try { for (const f of fs.readdirSync(path.join(dir, 'scripts'))) fs.chmodSync(path.join(dir, 'scripts', f), 0o755); } catch {}

      log.push(await this._installDeps(cloned));
      const r = await this._runLifecycleScript(dir, ['scripts/fpp_install.sh', 'fpp_install.sh']);
      if (r) log.push(r.out, r.code === 0 ? 'install script finished' : `install script exited ${r.code} (plugin kept)`);
      await this.load(name);
      return { name, log: log.filter(Boolean).join('\n') };
    } finally { this.busy = false; }
  }

  // Last versions[] entry meant for FPP 10+ (the plugin API level we emulate).
  _pickVersion(info) {
    const v = Array.isArray(info.versions) ? info.versions : [];
    const num = (s) => { const [a, b] = String(s || '0').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0); return a * 1000 + b; };
    const ok = v.filter((e) => num(e.minFPPVersion) <= num('10.99') && (!e.maxFPPVersion || e.maxFPPVersion === '0' || num(e.maxFPPVersion) >= num('10.0')));
    return ok[ok.length - 1] || v[v.length - 1] || null;
  }

  async _installDeps(info) {
    const d = (info && info.dependencies) || {};
    const out = [];
    if (Array.isArray(d.packages) && d.packages.length) {
      const pkgs = d.packages.filter((p) => /^[a-z0-9][a-z0-9.+-]*$/.test(p));
      if (pkgs.length) {
        const r = await run('apt-get', ['install', '-y', '--no-install-recommends', ...pkgs], { env: { DEBIAN_FRONTEND: 'noninteractive' } });
        out.push(`apt: ${pkgs.join(' ')} -> ${r.code === 0 ? 'ok' : 'failed'}`);
      }
    }
    if (Array.isArray(d.python) && d.python.length) {
      const mods = d.python.filter((p) => /^[A-Za-z0-9_][A-Za-z0-9_.\-<>=]*$/.test(p)); // no leading '-' (option injection)
      if (mods.length) {
        const r = await run('pip3', ['install', '--break-system-packages', ...mods]);
        out.push(`pip: ${mods.join(' ')} -> ${r.code === 0 ? 'ok' : 'failed'}`);
      }
    }
    return out.join('\n');
  }

  _runLifecycleScript(dir, candidates, extraArgs = true) {
    for (const rel of candidates) {
      const f = path.join(dir, rel);
      if (!fs.existsSync(f)) continue;
      const env = scriptEnv();
      const args = extraArgs ? [f, `FPPDIR=${FPPDIR}`, `SRCDIR=${FPPDIR}/src`] : [f];
      return run('/bin/bash', args, { cwd: dir, env });
    }
    return null;
  }

  async update(name) {
    const dir = pluginDir(name);
    if (!dir || !fs.existsSync(dir)) throw new Error('not installed');
    const r = await run('git', ['-C', dir, 'pull', '--ff-only'], { env: { GIT_TERMINAL_PROMPT: '0' } });
    let out = r.out;
    if (r.code !== 0) throw new Error('git pull failed: ' + r.out.trim().split('\n').pop());
    const s = await this._runLifecycleScript(dir, ['scripts/fpp_upgrade.sh', 'scripts/fpp_install.sh', 'fpp_install.sh'], false);
    if (s) out += '\n' + s.out;
    await this.unload(name);
    await this.load(name);
    return { name, log: out };
  }

  async uninstall(name) {
    const dir = pluginDir(name);
    if (!dir || !fs.existsSync(dir)) throw new Error('not installed');
    await this.unload(name);
    const r = await this._runLifecycleScript(dir, ['scripts/fpp_uninstall.sh', 'fpp_uninstall.sh']);
    fs.rmSync(dir, { recursive: true, force: true });
    return { name, log: r ? r.out : '' };
  }

  // ---------------------------------------------------------------- runtime
  _callbacksFile(dir) {
    for (const f of ['callbacks', 'callbacks.sh', 'callbacks.pl', 'callbacks.php', 'callbacks.py']) {
      if (fs.existsSync(path.join(dir, f))) return path.join(dir, f);
    }
    return null;
  }

  async loadAll() {
    let names = [];
    try { names = fs.readdirSync(paths.dir('plugins'), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch {}
    for (const n of names.sort()) await this.load(n).catch((e) => this.emit('log', `plugin ${n}: ${e.message}`));
  }

  async load(name) {
    const dir = pluginDir(name);
    if (!dir) return;
    this._loadCommands(name, dir);
    const cb = this._callbacksFile(dir);
    const entry = { callbacks: cb, types: new Set(), native: false };
    if (cb) {
      const [bin, pre] = interpreterFor(cb);
      const r = await run(bin, [...pre, '--list'], { cwd: dir, env: scriptEnv(), timeoutMs: 10000 });
      for (const t of r.out.trim().split(/[\s,]+/)) {
        if (['media', 'playlist', 'lifecycle'].includes(t)) entry.types.add(t);
        if (t.startsWith('c++')) entry.native = true;
      }
      if (entry.native && !entry.types.size) this.emit('log', `plugin ${name} is a native fppd plugin; its C++ part can't run in ShowPilot Player`);
    }
    this.loaded.set(name, entry);
    if (entry.types.has('lifecycle')) this._callback(name, ['--type', 'lifecycle', 'startup']);
  }

  async unload(name) {
    const e = this.loaded.get(name);
    if (e && e.types.has('lifecycle')) await this._callback(name, ['--type', 'lifecycle', 'shutdown']);
    this.loaded.delete(name);
    this.commands.unregisterSource('plugin:' + name);
  }

  _loadCommands(name, dir) {
    this.commands.unregisterSource('plugin:' + name);
    const list = readJson(path.join(dir, 'commands', 'descriptions.json'));
    if (!Array.isArray(list)) return;
    for (const c of list) {
      if (!c || !c.name || !c.script) continue;
      const script = path.join(dir, 'commands', path.basename(c.script));
      if (!fs.existsSync(script)) continue;
      const { script: _s, name: cname, ...desc } = c;
      this.commands.register(cname, {
        source: 'plugin:' + name, args: desc.args || [], description: desc.description || '', category: desc.category || `Plugin: ${name}`,
        run: async (args) => {
          try { fs.chmodSync(script, 0o755); } catch {}
          const r = await run(script, args, { cwd: path.dirname(script), env: { MEDIADIR: paths.MEDIA_DIR, FPPDIR, SCRIPTDIR: path.dirname(script) + '/' }, timeoutMs: 120000 });
          return `${cname} complete${r.code ? ` (exit ${r.code})` : ''}`;
        },
      });
    }
  }

  // Callbacks for one plugin run one at a time, in event order (as in FPP).
  _callback(name, args, timeoutMs = 10000) {
    const e = this.loaded.get(name);
    if (!e || !e.callbacks) return Promise.resolve();
    const [bin, pre] = interpreterFor(e.callbacks);
    this.chains = this.chains || new Map();
    const prev = this.chains.get(name) || Promise.resolve();
    const next = prev.then(() => run(bin, [...pre, ...args], { cwd: pluginDir(name), env: scriptEnv(), timeoutMs }))
      .then((r) => { if (r.code) this.emit('log', `plugin ${name} callback exited ${r.code}: ${r.out.trim().slice(0, 300)}`); })
      .catch(() => {});
    this.chains.set(name, next);
    return next;
  }

  // Event fan-out. Media/playlist events are fire-and-forget (in order per
  // plugin); query_next is awaited, because plugins use it to insert the
  // next item before the show moves on.
  async emitPlaylist(info) {
    const jobs = [];
    for (const [name, e] of this.loaded) {
      if (!e.types.has('playlist')) continue;
      const p = this._callback(name, ['--type', 'playlist', '--data', JSON.stringify(info)], info.Action === 'query_next' ? 3000 : 10000);
      jobs.push(p);
    }
    if (info.Action === 'query_next') await Promise.all(jobs);
  }

  emitMedia(evt) {
    const data = {
      type: evt.sequence && evt.media ? 'both' : evt.media ? 'media' : 'sequence',
      Sequence: evt.sequence && evt.media ? evt.sequence : '',
      Media: evt.media || '',
      length: evt.durationMs ? String(Math.round(evt.durationMs / 1000)) : '',
    };
    for (const [name, e] of this.loaded) if (e.types.has('media')) this._callback(name, ['--type', 'media', '--data', JSON.stringify(data)]);
  }

  // preStart/postStart/preStop/postStop, alphabetical, in the foreground.
  async hook(which) {
    let names = [];
    try { names = fs.readdirSync(paths.dir('plugins')).filter((n) => !n.startsWith('.')).sort(); } catch {}
    for (const n of names) {
      const f = path.join(paths.dir('plugins'), n, 'scripts', `${which}.sh`);
      if (fs.existsSync(f)) {
        const r = await run('/bin/bash', [f], { cwd: path.dirname(f), env: scriptEnv(), timeoutMs: 60000 });
        if (r.code) this.emit('log', `plugin ${n} ${which}.sh exited ${r.code}`);
      }
    }
  }
}

module.exports = { Plugins, pluginDir, FPPDIR, scriptEnv, run, BUILT_IN };
