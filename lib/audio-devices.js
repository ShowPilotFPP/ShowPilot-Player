// ALSA sound cards, read from /proc/asound/cards. The player always uses
// ALSA directly (no PipeWire/PulseAudio session exists for a root service on
// Pi OS Lite). "auto" prefers a USB sound card, because on a show Pi an
// attached USB card is the show audio; otherwise the system default.
//
// /proc/asound/cards lines look like:
//  0 [vc4hdmi0       ]: vc4-hdmi - vc4-hdmi-0
//  2 [S3             ]: USB-Audio - Sound Blaster Play! 3

const fs = require('fs');

function cards(text) {
  let t = text;
  if (t === undefined) { try { t = fs.readFileSync('/proc/asound/cards', 'utf8'); } catch { return []; } }
  const out = [];
  for (const line of t.split('\n')) {
    const m = /^\s*(\d+)\s+\[([^\]]+?)\s*\]:\s*(\S+)\s+-\s+(.*)$/.exec(line);
    if (!m) continue;
    out.push({ index: +m[1], card: m[2].trim(), driver: m[3], name: m[4].trim(),
      id: `alsa/plughw:CARD=${m[2].trim()},DEV=0`, usb: /USB/i.test(m[3]) });
  }
  return out;
}

// mpv --audio-device value for a configured choice ('auto' or an id).
function resolve(choice, list = cards()) {
  if (choice && choice !== 'auto') return { id: choice, name: (list.find((c) => c.id === choice) || {}).name || choice };
  const usb = list.find((c) => c.usb);
  if (usb) return { id: usb.id, name: `${usb.name} (USB, automatic)` };
  return { id: 'alsa', name: 'System default (automatic)' };
}

module.exports = { cards, resolve };
