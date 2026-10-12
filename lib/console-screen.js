// Keep the Linux text console (login prompt, the Pi's IP lines, kernel
// messages) off the HDMI screen of a player that uses it for video or the
// virtual matrix. Whenever the display mpv isn't holding the screen (starting
// up, restarting, screen sleep) the console behind it shows through, so the
// player moves the screen to an empty virtual terminal (tty7, no login on it)
// with the cursor hidden. A keyboard user can still press Ctrl+Alt+F1 for a
// login. Only on a console Pi as root; desktops and tests are left alone.

const fs = require('fs');
const { execFile } = require('child_process');

const VT = 7;
const CLEAR = '\x1b[2J\x1b[H\x1b[?25l'; // clear, home, hide cursor

function applies() {
  if (process.env.SPP_CONSOLE === '0' || process.env.SPP_DISPLAY_VO) return false;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return false;
  if (typeof process.getuid === 'function' && process.getuid() !== 0) return false;
  return fs.existsSync('/dev/tty1');
}

function write(file, data) { try { fs.writeFileSync(file, data); return true; } catch { return false; } }

function hideConsole(log = () => {}) {
  if (!applies()) return Promise.resolve(false);
  write('/sys/class/graphics/fbcon/cursor_blink', '0');
  return new Promise((resolve) => {
    execFile('chvt', [String(VT)], { timeout: 5000 }, (err) => {
      if (!err) {
        write(`/dev/tty${VT}`, CLEAR);
        return resolve(true);
      }
      // No chvt (kbd package): at least wipe what tty1 shows now.
      write('/dev/tty1', CLEAR);
      log('console: chvt not available, cleared tty1 instead (' + err.message + ')');
      resolve(false);
    });
  });
}

module.exports = { hideConsole };
