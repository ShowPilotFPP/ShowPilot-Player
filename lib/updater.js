// In-app updater. Finds the highest release tag on GitHub (list endpoint,
// not /releases/latest, which depends on a manual "latest" flag), downloads
// that tag's tarball, installs dependencies into a fresh directory, then
// swaps directories and exits so systemd restarts us on the new code. The
// previous version is kept beside it for a one-step rollback.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const paths = require('./paths');
const pkg = require('../package.json');

const execFileP = promisify(execFile);
const REPO = 'ShowPilotFPP/ShowPilot-Player';
const RELEASES = `https://api.github.com/repos/${REPO}/releases?per_page=100`;

function cmp(a, b) {
  const pa = String(a).replace(/^v/, '').split('-')[0].split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

let cache = { at: 0, data: null };

async function check(force) {
  if (!force && cache.data && Date.now() - cache.at < 3600000) return cache.data;
  const r = await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ShowPilot-Player' }, signal: AbortSignal.timeout(15000) });
  if (r.status === 404) throw new Error('No releases found on GitHub yet');
  if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
  const list = (await r.json()).filter((x) => !x.draft && !x.prerelease && /^v?\d+\.\d+\.\d+$/.test(x.tag_name));
  list.sort((a, b) => cmp(b.tag_name, a.tag_name));
  const latest = list[0] || null;
  const data = {
    current: pkg.version,
    latest: latest ? latest.tag_name.replace(/^v/, '') : null,
    updateAvailable: !!latest && cmp(latest.tag_name, pkg.version) > 0,
    notes: latest ? latest.body || '' : '',
    url: latest ? latest.html_url : null,
    tag: latest ? latest.tag_name : null,
  };
  cache = { at: Date.now(), data };
  return data;
}

async function apply(onLog = () => {}) {
  const info = await check(true);
  if (!info.updateAvailable) throw new Error('already up to date');
  const appDir = paths.APP_DIR;
  const parent = path.dirname(appDir);
  const base = path.basename(appDir);
  const next = path.join(parent, `${base}.next`);
  const prev = path.join(parent, `${base}.previous`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-update-'));
  try {
    onLog(`downloading ${info.tag}`);
    const r = await fetch(`https://codeload.github.com/${REPO}/tar.gz/refs/tags/${info.tag}`, { signal: AbortSignal.timeout(300000) });
    if (!r.ok) throw new Error(`download HTTP ${r.status}`);
    const tgz = path.join(tmp, 'release.tgz');
    fs.writeFileSync(tgz, Buffer.from(await r.arrayBuffer()));
    fs.rmSync(next, { recursive: true, force: true });
    fs.mkdirSync(next, { recursive: true });
    await execFileP('tar', ['-xzf', tgz, '-C', next, '--strip-components=1']);
    const newPkg = JSON.parse(fs.readFileSync(path.join(next, 'package.json'), 'utf8'));
    if (newPkg.name !== 'showpilot-player') throw new Error('downloaded archive is not ShowPilot Player');
    onLog('installing dependencies');
    await execFileP('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: next, timeout: 600000 });
    onLog('switching versions');
    fs.rmSync(prev, { recursive: true, force: true });
    fs.renameSync(appDir, prev);
    fs.renameSync(next, appDir);
    onLog(`installed ${newPkg.version}; restarting`);
    setTimeout(() => process.exit(0), 500); // systemd Restart=always brings us back
    return { installed: newPkg.version };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function canRollback() { return fs.existsSync(path.join(path.dirname(paths.APP_DIR), `${path.basename(paths.APP_DIR)}.previous`, 'package.json')); }

async function rollback() {
  const appDir = paths.APP_DIR;
  const prev = path.join(path.dirname(appDir), `${path.basename(appDir)}.previous`);
  if (!canRollback()) throw new Error('no previous version');
  const failed = `${appDir}.failed`;
  fs.rmSync(failed, { recursive: true, force: true });
  fs.renameSync(appDir, failed);
  fs.renameSync(prev, appDir);
  setTimeout(() => process.exit(0), 500);
  return { ok: true };
}

module.exports = { check, apply, rollback, canRollback, cmp };
