// Startup checks for the programs the player depends on. Problems are shown
// on the dashboard instead of the service crash-looping out of sight.

const { execFileSync } = require('child_process');

const DEPS = [
  { bin: 'mpv', why: 'plays audio and video' },
  { bin: 'ffprobe', why: 'reads media details for xLights' },
  { bin: 'php-cgi', why: 'runs FPP plugin pages' },
  { bin: 'git', why: 'installs plugins' },
];

function has(bin) {
  try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; }
}

function missing() { return DEPS.filter((d) => !has(d.bin)); }

module.exports = { missing, DEPS };
