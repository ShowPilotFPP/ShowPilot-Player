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

// Warn about missing controller outputs only where they are expected: a
// MultiSync remote or a screen-only player (virtual matrix / video on HDMI)
// legitimately has none.
const NO_OUTPUTS = 'No controller outputs are set up, so no lights are sent. Add them under Lights \u2192 Controllers, or in xLights FPP Connect set this player\'s "UDP Out" to "All".';
function outputProblems(cfg) {
  if ((cfg.outputs || []).some((o) => o.enabled !== false)) return [];
  if (cfg.mode === 'remote') return [];
  if (cfg.matrix && cfg.matrix.enabled) return [];
  return [NO_OUTPUTS];
}

module.exports = { outputProblems, missing, DEPS };
