// Screen sleep: switch the HDMI screen off when nothing has been shown for a
// while, and back on when something plays. Made for a virtual matrix or video
// screen that would otherwise sit lit all night.
//
// Awake while: something plays (or a test pattern runs), a scheduled show's
// window is open, or one starts within WAKE_EARLY_MS (a sleeping monitor takes
// a few seconds to come back; waking before the first song means it isn't
// missed). Asleep after `idleMinutes` with none of that.
//
// Methods:
//   hdmi    - the player lets go of the screen (stops its display mpv), then
//             the HDMI signal is switched off: the kernel console's
//             framebuffer is blanked with power-down (fb0/blank = 4), which on
//             a Pi's KMS driver turns the output off; `vcgencmd display_power`
//             is the fallback (older firmware display stack). A PC monitor
//             then shows "no signal" and goes into its own standby.
//             Many PC monitors drop and re-assert HDMI hotplug when they go
//             into standby; the Pi's KMS driver takes that as a new screen and
//             switches the output back on (monitor wakes to a black console).
//             So hdmi sleep needs `vc4.force_hotplug=3` (both HDMI ports always
//             "connected"): ensureHotplug() adds it to cmdline.txt, applies it
//             live through the module parameter when the kernel allows, and
//             otherwise reports that one reboot is needed.
//   command - your own commands (e.g. ddcutil, cec-ctl, a smart plug URL via curl).

const { exec } = require('child_process');
const fs = require('fs');

const TICK_MS = 5000;
const WAKE_EARLY_MS = 2 * 60000;
const FB_BLANK = '/sys/class/graphics/fb0/blank';
const HOTPLUG_ARG = 'vc4.force_hotplug=3';
const CMDLINES = ['/boot/firmware/cmdline.txt', '/boot/cmdline.txt'];
const HOTPLUG_PARAM = '/sys/module/vc4/parameters/force_hotplug';
const PROC_CMDLINE = '/proc/cmdline';

function sh(cmd, timeoutMs = 10000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs }, (err, out, errOut) => resolve({ ok: !err, out: String(out || '') + String(errOut || ''), code: err ? err.code : 0 }));
  });
}

class ScreenSleep {
  constructor({ config, player, scheduler, log = () => {}, now = () => Date.now(), shell = sh, fbPath = FB_BLANK, hotplug = {} }) {
    this.config = config;
    this.player = player;
    this.scheduler = scheduler;
    this.log = log;
    this.now = now;
    this.sh = shell;
    this.fbPath = fbPath;
    this.hotplug = { cmdlines: CMDLINES, param: HOTPLUG_PARAM, procCmdline: PROC_CMDLINE, ...hotplug };
    this.needsReboot = false;
    this.asleep = false;
    this.busy = null;
    this.lastActive = now();
    this.lastError = null;
    this.reason = '';
    if (player) player.on('activity', () => this.activity());
  }

  get cfg() { return this.config.get().screenSleep || {}; }

  start() {
    this.ensureHotplug();
    if (this.config.on) this.config.on('change', () => this.ensureHotplug());
    this.timer = setInterval(() => this.tick().catch(() => {}), TICK_MS);
    if (this.timer.unref) this.timer.unref();
  }
  stop() { clearInterval(this.timer); }

  // Why the screen must stay on right now ('' = nothing).
  keepAwakeReason() {
    const p = this.player;
    if (p && p.state !== 'idle') return 'playing';
    if (p && p.testing) return 'test pattern';
    const sch = this.scheduler;
    // A remote (MultiSync follower) doesn't run its own schedule: entries
    // left in it (an FPP backup restore, an earlier player setup) must not
    // keep its screen on all evening. Its songs come from the master.
    if (sch && sch.enabled !== false && this.cfg.keepAwakeDuringShows !== false) {
      if (sch.active && sch.active.entry && sch.active.entry.type !== 'command') return 'show window';
      try {
        const now = this.now();
        const runs = sch.nextRuns(2, new Date(now));
        const types = Object.fromEntries((sch.load ? sch.load() : []).map((e) => [e.id, e.type]));
        for (const [id, r] of Object.entries(runs)) {
          if (types[id] === 'command') continue;
          if (+r.start - now <= WAKE_EARLY_MS && (!r.end || +r.end > now)) return 'show starting';
        }
      } catch {}
    }
    return '';
  }

  activity() {
    this.lastActive = this.now();
    if (this.asleep && this.cfg.enabled) this.wake('activity').catch(() => {});
  }

  async tick() {
    const c = this.cfg;
    if (!c.enabled) { if (this.asleep) await this.wake('turned off'); return; }
    const why = this.keepAwakeReason();
    if (why) { this.lastActive = this.now(); if (this.asleep) await this.wake(why); return; }
    const idleMs = Math.max(1, Number(c.idleMinutes) || 5) * 60000;
    if (!this.asleep && this.now() - this.lastActive >= idleMs) await this.sleep('idle');
  }

  async sleep(reason = 'manual') {
    if (this.busy) await this.busy;
    if (this.asleep) return { ok: true };
    this.busy = (async () => {
      const c = this.cfg;
      let r;
      if ((c.method || 'hdmi') === 'command') r = await this._cmd(c.sleepCommand);
      else {
        if (this.player) await this.player.suspendDisplay();
        r = await this._hdmi(false);
      }
      this.asleep = true; // even if switching off failed: the player let go of the screen
      this.reason = reason;
      this.lastError = r.ok ? null : r.out.trim().slice(0, 300) || 'failed';
      this.log(`screen off (${reason})${r.ok ? '' : ': ' + this.lastError}`);
      return r;
    })();
    try { return await this.busy; } finally { this.busy = null; }
  }

  async wake(reason = 'manual') {
    if (this.busy) await this.busy;
    if (!this.asleep) { this.lastActive = this.now(); return { ok: true }; }
    this.busy = (async () => {
      const c = this.cfg;
      let r;
      if ((c.method || 'hdmi') === 'command') r = await this._cmd(c.wakeCommand);
      else {
        r = await this._hdmi(true);
        if (this.player) await this.player.resumeDisplay();
      }
      this.asleep = false;
      this.lastActive = this.now();
      this.reason = reason;
      this.lastError = r.ok ? null : r.out.trim().slice(0, 300) || 'failed';
      this.log(`screen on (${reason})${r.ok ? '' : ': ' + this.lastError}`);
      return r;
    })();
    try { return await this.busy; } finally { this.busy = null; }
  }

  async _hdmi(on) {
    // 1. Framebuffer blank with power-down (Pi OS with the KMS driver).
    //    Switching off always passes through "on" first: the kernel skips a
    //    blank to the state it thinks it is already in, and that state can be
    //    stale (the output was switched back on underneath it, e.g. by a
    //    hotplug before force_hotplug was set). On a lit screen it's a no-op.
    try {
      if (fs.existsSync(this.fbPath)) {
        if (!on) fs.writeFileSync(this.fbPath, '0');
        fs.writeFileSync(this.fbPath, on ? '0' : '4');
        return { ok: true, out: '' };
      }
    } catch (e) { /* not allowed / not there: try the next way */ }
    // 2. Firmware display stack.
    const r = await this.sh(`vcgencmd display_power ${on ? 1 : 0}`);
    if (r.ok) return r;
    return { ok: false, out: 'could not switch the HDMI output (no framebuffer console and vcgencmd failed). Use "Run my commands" instead.' };
  }

  // Keep the Pi from switching HDMI back on when the monitor's standby
  // toggles hotplug. Only for hdmi sleep; returns the state for status().
  ensureHotplug() {
    const c = this.cfg;
    const h = this.hotplug;
    if (!c.enabled || (c.method || 'hdmi') !== 'hdmi') { this.needsReboot = false; return; }
    let running = '';
    try { running = fs.readFileSync(h.procCmdline, 'utf8'); } catch { return; } // not Linux / not a Pi
    if (/\bvc4\.force_hotplug=/.test(running)) { this.needsReboot = false; return; }
    const file = h.cmdlines.find((f) => fs.existsSync(f));
    if (!file) return; // not a Raspberry Pi boot partition
    try {
      const txt = fs.readFileSync(file, 'utf8');
      if (!/\bvc4\.force_hotplug=/.test(txt)) {
        const lines = txt.split('\n');
        lines[0] = lines[0].replace(/\s+$/, '') + ' ' + HOTPLUG_ARG;
        fs.writeFileSync(file, lines.join('\n'));
        this.log(`added ${HOTPLUG_ARG} to ${file} (monitor standby won't switch HDMI back on)`);
      }
    } catch (e) { this.log(`could not update ${file}: ${e.message}`); return; }
    // Live, when the kernel exposes the parameter as writable: no reboot.
    try {
      fs.writeFileSync(h.param, '3');
      if (String(fs.readFileSync(h.param, 'utf8')).trim() === '3') {
        if (this.needsReboot !== false) this.log('force_hotplug applied without a reboot');
        this.needsReboot = false;
        return;
      }
    } catch {}
    if (!this.needsReboot) this.log('one reboot is needed for screen sleep to keep the monitor off');
    this.needsReboot = true;
  }

  async _cmd(cmd) {
    if (!cmd || !String(cmd).trim()) return { ok: false, out: 'no command set' };
    return this.sh(String(cmd));
  }

  status() {
    const c = this.cfg;
    return {
      enabled: !!c.enabled, asleep: this.asleep, method: c.method || 'hdmi', idleMinutes: Number(c.idleMinutes) || 5,
      keepAwake: this.keepAwakeReason(), idleForMs: this.asleep ? null : this.now() - this.lastActive,
      lastError: this.lastError, needsReboot: this.needsReboot,
    };
  }
}

module.exports = { ScreenSleep, WAKE_EARLY_MS };
