// One log: memory ring (for the UI) + media/logs/showpilot-player.log,
// rotated at 5 MB with one previous copy.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const RING = [];
const MAX_RING = 1000;
const MAX_FILE = 5 * 1024 * 1024;
let file = null;

function logFile() {
  if (!file) file = path.join(paths.dir('logs'), 'showpilot-player.log');
  return file;
}

function write(level, area, msg) {
  const line = `${new Date().toISOString()} [${level}] ${area}: ${msg}`;
  RING.push(line);
  if (RING.length > MAX_RING) RING.splice(0, RING.length - MAX_RING);
  (level === 'error' ? console.error : console.log)(line);
  try {
    const f = logFile();
    try { if (fs.statSync(f).size > MAX_FILE) fs.renameSync(f, f + '.1'); } catch {}
    fs.appendFileSync(f, line + '\n');
  } catch {}
}

module.exports = {
  info: (area, msg) => write('info', area, msg),
  warn: (area, msg) => write('warn', area, msg),
  error: (area, msg) => write('error', area, msg),
  tail: (n = 200) => RING.slice(-n),
  logFile,
};
