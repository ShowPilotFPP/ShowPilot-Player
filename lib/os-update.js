// System software updates without reflashing (the counterpart of FPP's OS
// upgrade): Raspberry Pi OS packages via apt, the packages the player needs,
// and Node.js within its major version. Runs as a background job; the UI
// polls its status and log.
//
// The package list matches scripts/install.sh and image/stage-showpilot/00-packages/00-packages-nr.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PACKAGES = ['mpv', 'ffmpeg', 'php-cgi', 'php-cli', 'php-curl', 'php-xml', 'git', 'curl',
  'ca-certificates', 'xz-utils', 'avahi-daemon', 'alsa-utils', 'jq', 'kbd'];
const NODE_MAJOR = 22;
const NODE_DIR = process.env.SPP_NODE_PREFIX || '/usr/local';
const APT_ENV = { DEBIAN_FRONTEND: 'noninteractive', APT_LISTCHANGES_FRONTEND: 'none' };
const KEEP_CONFIG = ['-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'];

const state = {
  running: false, phase: '', startedAt: null, finishedAt: null,
  ok: null, error: null, log: [], rebootRequired: false, restartNeeded: false, check: null,
};

function log(line) {
  for (const l of String(line).split('\n')) {
    if (!l.trim()) continue;
    state.log.push(l);
  }
  if (state.log.length > 2000) state.log.splice(0, state.log.length - 2000);
}

function run(cmd, args, { env, quiet } = {}) {
  return new Promise((resolve) => {
    if (!quiet) log(`$ ${cmd} ${args.join(' ')}`);
    const p = spawn(cmd, args, { env: { ...process.env, ...APT_ENV, ...env } });
    let out = '';
    const take = (d) => { out += d; if (!quiet) log(d.toString()); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('error', (e) => resolve({ code: -1, out: out + e.message }));
    p.on('close', (code) => resolve({ code, out }));
  });
}

// `apt list --upgradable` lines look like "pkg/stable 1.2-3 arm64 [upgradable from: 1.2-2]".
function parseUpgradable(text) {
  return String(text).split('\n')
    .filter((l) => l.includes('[upgradable from:'))
    .map((l) => {
      const m = /^([^/\s]+)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s*([^\]]+)\]/.exec(l);
      return m ? { name: m[1], to: m[2], from: m[3].trim() } : null;
    })
    .filter(Boolean);
}

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

function nodeArch() { return process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null; }

async function latestNode() {
  const arch = nodeArch();
  if (!arch) return null;
  const base = `https://nodejs.org/dist/latest-v${NODE_MAJOR}.x`;
  const r = await fetch(`${base}/SHASUMS256.txt`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`nodejs.org HTTP ${r.status}`);
  const line = (await r.text()).split('\n').find((l) => l.endsWith(`-linux-${arch}.tar.xz`));
  if (!line) return null;
  const [sha, file] = line.trim().split(/\s+/);
  const version = /^node-v([\d.]+)-/.exec(file)[1];
  return { version, file, sha, url: `${base}/${file}` };
}

async function check() {
  const out = { packages: [], node: { current: process.versions.node, latest: null }, error: null, at: new Date().toISOString() };
  const u = await run('apt-get', ['update', '-q'], { quiet: true });
  if (u.code !== 0) out.error = 'apt-get update failed: ' + u.out.trim().split('\n').pop();
  const l = await run('apt', ['list', '--upgradable'], { quiet: true });
  out.packages = parseUpgradable(l.out);
  try { const n = await latestNode(); if (n) out.node.latest = n.version; } catch (e) { out.node.error = e.message; }
  out.node.updateAvailable = !!out.node.latest && cmpVersion(out.node.latest, out.node.current) > 0;
  state.check = out;
  return out;
}

async function updateNode() {
  const n = await latestNode();
  if (!n || cmpVersion(n.version, process.versions.node) <= 0) { log(`Node.js ${process.versions.node} is current`); return false; }
  log(`Updating Node.js ${process.versions.node} -> ${n.version}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-node-'));
  try {
    const r = await fetch(n.url, { signal: AbortSignal.timeout(600000) });
    if (!r.ok) throw new Error(`download HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const sha = require('crypto').createHash('sha256').update(buf).digest('hex');
    if (sha !== n.sha) throw new Error('Node.js download failed its checksum');
    fs.writeFileSync(path.join(tmp, n.file), buf);
    const x = await run('tar', ['-xJf', path.join(tmp, n.file), '-C', tmp, '--strip-components=1', '--exclude=*/share/doc']);
    if (x.code !== 0) throw new Error('could not unpack Node.js');
    // --remove-destination unlinks first, so replacing the running node binary is safe.
    for (const d of ['bin', 'lib', 'include', 'share']) {
      if (!fs.existsSync(path.join(tmp, d))) continue;
      const c = await run('cp', ['-a', '--remove-destination', path.join(tmp, d), NODE_DIR], { quiet: true });
      if (c.code !== 0) throw new Error(`could not install Node.js (${d})`);
    }
    log(`Node.js ${n.version} installed`);
    return true;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Returns immediately; progress is in status().
function start({ isShowRunning, onRestart } = {}) {
  if (state.running) throw new Error('a system update is already running');
  if (isShowRunning && isShowRunning()) throw new Error('stop the show first: package updates can restart audio and video');
  Object.assign(state, { running: true, phase: 'starting', startedAt: new Date().toISOString(), finishedAt: null, ok: null, error: null, log: [], rebootRequired: false, restartNeeded: false });
  (async () => {
    const step = async (phase, cmd, args) => {
      state.phase = phase;
      const r = await run(cmd, args);
      if (r.code !== 0) {
        if (/Could not get lock|is held by process/.test(r.out)) throw new Error('another package install is running on the Pi; try again in a few minutes');
        throw new Error(`${phase} failed (exit ${r.code})`);
      }
      return r;
    };
    try {
      await step('Refreshing package lists', 'apt-get', ['update', '-q']);
      const up = await step('Upgrading Raspberry Pi OS packages', 'apt-get', ['-y', '-q', ...KEEP_CONFIG, 'full-upgrade']);
      const inst = await step('Installing player packages', 'apt-get', ['install', '-y', '-q', '--no-install-recommends', ...KEEP_CONFIG, ...PACKAGES]);
      await step('Cleaning up', 'apt-get', ['-y', '-q', 'autoremove']);
      // Anything installed (mpv, ffmpeg, php, libraries) takes effect on the next player start.
      if (/^Setting up /m.test(up.out + inst.out)) state.restartNeeded = true;
      state.phase = 'Updating Node.js';
      try { if (await updateNode()) state.restartNeeded = true; } catch (e) { log(`Node.js update skipped: ${e.message}`); }
      state.rebootRequired = fs.existsSync('/run/reboot-required') || fs.existsSync('/var/run/reboot-required');
      state.ok = true;
      state.phase = 'Done';
      log(state.rebootRequired ? 'Done. A reboot is needed to finish (new kernel or firmware).' : state.restartNeeded ? 'Done. The player will restart to use the updated software.' : 'Done.');
    } catch (e) {
      state.ok = false;
      state.error = e.message;
      state.phase = 'Failed';
      log(`Failed: ${e.message}`);
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
      state.check = null;
      if (state.ok && state.restartNeeded && !state.rebootRequired && onRestart) setTimeout(onRestart, 3000);
    }
  })();
  return status();
}

function status() {
  const { log: lines, ...rest } = state;
  return { ...rest, log: lines.slice(-400) };
}

module.exports = { check, start, status, parseUpgradable, cmpVersion, PACKAGES };
