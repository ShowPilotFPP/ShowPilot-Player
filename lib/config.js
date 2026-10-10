// Player settings, stored as one JSON file under media/config so FPP-style
// backups of the config folder carry them. Secrets (the ShowPilot show
// token, the UI password hash) are kept out of this file on purpose — see
// secrets.js.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const EventEmitter = require('events');
const paths = require('./paths');

const FILE = () => path.join(paths.dir('config'), 'showpilot-player.json');

const DEFAULTS = {
  hostName: os.hostname(),
  hostDescription: '',
  uuid: '',                       // generated on first start; xLights requires one
  mode: 'player',                 // 'player' (runs the show) | 'remote' (follows a MultiSync master)

  // Lights are shown for (media time + syncOffsetMs). Positive = lights earlier
  // than the audio. Fixed chain latency (receiver, FM transmitter) is solved
  // here; drift is a bug, not something to tune away.
  syncOffsetMs: 0,
  audioDevice: 'auto',            // mpv --audio-device value
  blankBetweenSequences: true,

  outputs: [],                    // see outputs/index.js for the entry shape
  outputFps: 0,                   // 0 = sequence step time

  multisync: {
    enabled: false,               // send sync as master (player mode)
    multicast: true,
    broadcast: false,
    remotes: [],                  // extra unicast targets
    remoteOffsetMs: 0,            // remote mode: positive adds time, like FPP
  },

  video: {
    enabled: true,                // play the video that goes with a playlist item on HDMI
  },

  matrix: {
    enabled: false,
    startChannel: 1,              // 1-based
    width: 64,
    height: 32,
    colorOrder: 'RGB',
    startCorner: 'TL',            // TL, TR, BL, BR
    orientation: 'horizontal',    // strings run horizontally or vertically
    serpentine: false,
    preferVideo: true,            // a real video beats rendering pixels
  },

  location: { latitude: null, longitude: null }, // for dusk/dawn schedule times

  showpilot: {
    enabled: false,
    serverUrl: '',
    remotePlaylist: '',
    interruptSchedule: false,
    requestFetchTime: 3,
    additionalWaitTime: 0,
    heartbeatIntervalSec: 15,
    statusIntervalMs: 500,
    audioDaemonPort: 8090,
    verboseLogging: false,
  },

  web: { port: 80 },
  updates: { channel: 'stable' },
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function merge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!isObj(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (isObj(v) && isObj(base[k])) out[k] = merge(base[k], v);
    else out[k] = v;
  }
  return out;
}

class Config extends EventEmitter {
  constructor() {
    super();
    this.data = merge(DEFAULTS, {});
  }

  load() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') console.error('[config] unreadable, using defaults:', e.message);
    }
    this.data = merge(DEFAULTS, raw);
    if (!this.data.uuid) {
      // "SP-" prefix: FPP uses M1-/serial-based ids; ours only has to be stable and printable.
      this.data.uuid = 'SP-' + crypto.randomBytes(8).toString('hex').toUpperCase();
      this.save();
    }
    return this.data;
  }

  get() { return this.data; }

  save() {
    const file = FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, file);
  }

  // Shallow-per-section update from the admin UI. Unknown top-level keys are
  // ignored so a bad client can't park arbitrary data in the file.
  update(patch) {
    if (!isObj(patch)) return this.data;
    const next = { ...this.data };
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULTS) || k === 'uuid') continue;
      next[k] = isObj(DEFAULTS[k]) ? merge(this.data[k], v) : v;
    }
    this.data = next;
    this.save();
    this.emit('change', this.data);
    return this.data;
  }
}

module.exports = new Config();
module.exports.DEFAULTS = DEFAULTS;
