// SMB file sharing of the media folder, like FPP's: the sequences, music,
// videos, scripts, ... folders show up as a network drive (\\<player>\media on
// Windows, smb://<player>.local/media on a Mac, and in Finder's sidebar).
//
// Samba runs as its own service (smbd/nmbd); this module writes its config
// and switches it on and off. The share works as root-equivalent inside the
// media folder (force user = root) because the player itself runs as root
// and owns what it writes; Samba's default `wide links = no` keeps symlinks
// from reaching outside the share. Without a password it is open to anyone
// on the network, like FPP's; with one, it asks for user "fpp" and that
// password (Windows 11 refuses password-less shares by default).
//
// Config: fileShare { enabled, name, requirePassword, passwordSet }.

const fs = require('fs');
const { execFile } = require('child_process');
const paths = require('./paths');

const MARK = '# Managed by ShowPilot Player (Settings → File sharing). Edits here are replaced.';
const DEFAULTS = {
  smbConf: '/etc/samba/smb.conf',
  avahiService: '/etc/avahi/services/showpilot-smb.service',
  run: (cmd, args, input) => new Promise((resolve) => {
    const p = execFile(cmd, args, { timeout: 30000 }, (err, out, errOut) => resolve({ ok: !err, out: String(out || '') + String(errOut || '') }));
    if (input !== undefined) { p.stdin.end(input); }
  }),
  which: (bin) => ['/usr/sbin/', '/usr/bin/', '/sbin/', '/bin/'].some((d) => fs.existsSync(d + bin)),
};

const cleanName = (n) => (String(n || 'media').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'media');

function smbConf({ name, requirePassword, mediaDir }) {
  return `${MARK}
[global]
   workgroup = WORKGROUP
   server string = ShowPilot Player
   server role = standalone server
   map to guest = ${requirePassword ? 'Never' : 'Bad User'}
   server min protocol = SMB2
   log file = /var/log/samba/log.%m
   max log size = 1000
   logging = file
   # Friendlier with macOS Finder (no ._ files, Time Machine style metadata).
   vfs objects = fruit streams_xattr
   fruit:metadata = stream
   fruit:model = MacSamba
   fruit:veto_appledouble = no
   fruit:wipe_intentionally_left_blank_rfork = yes
   fruit:delete_empty_adfiles = yes

[${name}]
   comment = ShowPilot Player media (sequences, music, videos, scripts, ...)
   path = ${mediaDir}
   browseable = yes
   writable = yes
   ${requirePassword ? 'valid users = fpp\n   guest ok = no' : 'guest ok = yes'}
   force user = root
   force group = root
   create mask = 0644
   directory mask = 0755
`;
}

const AVAHI = `<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<!-- Managed by ShowPilot Player: shows the media share in macOS Finder. -->
<service-group>
  <name replace-wildcards="yes">%h</name>
  <service><type>_smb._tcp</type><port>445</port></service>
  <service><type>_device-info._tcp</type><port>0</port><txt-record>model=RackMac</txt-record></service>
</service-group>
`;

class FileShare {
  constructor({ config, log = () => {}, opts = {} }) {
    this.config = config;
    this.log = log;
    this.o = { ...DEFAULTS, ...opts };
    this.lastError = null;
    this.busy = null;
  }

  get cfg() { return { enabled: true, name: 'media', requirePassword: false, passwordSet: false, ...(this.config.get().fileShare || {}) }; }
  installed() { return this.o.which('smbd'); }

  _readConf() { try { return fs.readFileSync(this.o.smbConf, 'utf8'); } catch { return null; } }

  // Make Samba match the settings. Safe to call often: it only writes and
  // restarts when something changed.
  apply() {
    const run = async () => {
      const c = this.cfg;
      if (!this.installed()) return this.status();
      const name = cleanName(c.name);
      const want = smbConf({ name, requirePassword: !!c.requirePassword, mediaDir: paths.MEDIA_DIR });
      const cur = this._readConf();
      try {
        if (c.enabled) {
          let changed = false;
          if (cur !== want) {
            // Keep the system's original once, the first time it is replaced.
            if (cur !== null && !cur.startsWith(MARK) && !fs.existsSync(this.o.smbConf + '.orig')) fs.writeFileSync(this.o.smbConf + '.orig', cur);
            fs.writeFileSync(this.o.smbConf, want);
            changed = true;
          }
          try { if (fs.existsSync(require('path').dirname(this.o.avahiService)) && !fs.existsSync(this.o.avahiService)) fs.writeFileSync(this.o.avahiService, AVAHI); } catch {}
          const active = await this.o.run('systemctl', ['is-active', 'smbd']);
          if (changed || !active.ok || active.out.trim() !== 'active') {
            await this.o.run('systemctl', ['enable', 'smbd', 'nmbd']);
            const r = await this.o.run('systemctl', ['restart', 'smbd', 'nmbd']);
            if (!r.ok) throw new Error(r.out.trim().split('\n').pop() || 'Samba did not start');
            this.log(`file sharing on: \\\\${require('os').hostname()}\\${name}${c.requirePassword ? ' (password)' : ' (no password)'}`);
          }
        } else {
          try { fs.unlinkSync(this.o.avahiService); } catch {}
          const active = await this.o.run('systemctl', ['is-active', 'smbd']);
          if (active.ok && active.out.trim() === 'active') {
            await this.o.run('systemctl', ['disable', '--now', 'smbd', 'nmbd']);
            this.log('file sharing off');
          }
        }
        this.lastError = null;
      } catch (e) { this.lastError = e.message; this.log('file sharing: ' + e.message); }
      return this.status();
    };
    // One at a time: settings saves and the periodic check can overlap.
    this.busy = (this.busy || Promise.resolve()).then(run, run);
    return this.busy;
  }

  // Set the share password (Samba account "fpp"). Empty = no password.
  async setPassword(pw) {
    if (!this.installed()) throw new Error('Samba is not installed yet. Install it under Settings → Updates → System software.');
    pw = String(pw || '');
    if (!pw) {
      this.config.update({ fileShare: { requirePassword: false, passwordSet: false } });
      return this.apply();
    }
    if (pw.length < 4) throw new Error('Use at least 4 characters.');
    const r = await this.o.run('smbpasswd', ['-a', '-s', 'fpp'], `${pw}\n${pw}\n`);
    if (!r.ok) throw new Error('Could not set the password: ' + (r.out.trim().split('\n').pop() || 'smbpasswd failed'));
    await this.o.run('smbpasswd', ['-e', 'fpp']);
    this.config.update({ fileShare: { requirePassword: true, passwordSet: true } });
    return this.apply();
  }

  status() {
    const c = this.cfg;
    const host = require('os').hostname();
    const name = cleanName(c.name);
    return {
      installed: this.installed(), enabled: !!c.enabled, name, requirePassword: !!c.requirePassword, passwordSet: !!c.passwordSet,
      applied: (this._readConf() || '').startsWith(MARK), lastError: this.lastError,
      windows: `\\\\${host}\\${name}`, mac: `smb://${host}.local/${name}`,
    };
  }

  start() {
    this.apply().catch(() => {});
    if (this.config.on) this.config.on('change', () => this.apply().catch(() => {}));
    // Picks up Samba installed later (System software) without a restart.
    this.timer = setInterval(() => { if (this.cfg.enabled && this.installed() && !this.status().applied) this.apply().catch(() => {}); }, 60000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() { clearInterval(this.timer); }
}

module.exports = { FileShare, smbConf, cleanName, MARK };
