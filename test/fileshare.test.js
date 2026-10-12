// SMB file sharing (lib/fileshare.js) with a fake system: config written once,
// Samba enabled/restarted only when needed, password via smbpasswd, off again.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { FileShare, MARK, cleanName } = require('../lib/fileshare');

function rig(start = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-smb-'));
  fs.mkdirSync(path.join(d, 'avahi'));
  const smbConf = path.join(d, 'smb.conf');
  fs.writeFileSync(smbConf, '[global]\n   workgroup = WORKGROUP\n');
  let data = { fileShare: { enabled: true, name: 'media', ...start } };
  const config = Object.assign(new EventEmitter(), {
    get: () => data,
    update: (p) => { data = { ...data, fileShare: { ...data.fileShare, ...p.fileShare } }; },
  });
  const ran = [];
  let active = false, installed = true;
  const run = async (cmd, args, input) => {
    ran.push([cmd, ...args].join(' ') + (input ? ` <<${JSON.stringify(input)}` : ''));
    if (cmd === 'systemctl' && args[0] === 'is-active') return { ok: active, out: active ? 'active\n' : 'inactive\n' };
    if (cmd === 'systemctl' && args[0] === 'restart') active = true;
    if (cmd === 'systemctl' && args[0] === 'disable') active = false;
    return { ok: true, out: '' };
  };
  const fsh = new FileShare({ config, opts: { smbConf, avahiService: path.join(d, 'avahi', 'smb.service'), run, which: () => installed } });
  return { fsh, ran, smbConf, d, setInstalled: (v) => { installed = v; }, isActive: () => active };
}

test('file sharing: writes the share, keeps the original, restarts only on change', async () => {
  const r = rig();
  const st = await r.fsh.apply();
  const conf = fs.readFileSync(r.smbConf, 'utf8');
  assert.ok(conf.startsWith(MARK));
  assert.match(conf, /\[media\][\s\S]*path = \/home\/fpp\/media|\[media\][\s\S]*path = /);
  assert.match(conf, /guest ok = yes/);
  assert.match(conf, /map to guest = Bad User/);
  assert.equal(fs.readFileSync(r.smbConf + '.orig', 'utf8'), '[global]\n   workgroup = WORKGROUP\n', 'original kept');
  assert.ok(fs.existsSync(path.join(r.d, 'avahi', 'smb.service')), 'advertised for macOS Finder');
  assert.ok(r.ran.includes('systemctl restart smbd nmbd'));
  assert.equal(st.applied, true);
  assert.match(st.windows, /\\\\.+\\media$/);
  const n = r.ran.length;
  await r.fsh.apply();
  assert.ok(!r.ran.slice(n).some((c) => c.startsWith('systemctl restart')), 'nothing changed: no restart');
});

test('file sharing: password via smbpasswd, then off', async () => {
  const r = rig();
  await r.fsh.apply();
  await assert.rejects(r.fsh.setPassword('ab'), /4 characters/);
  await r.fsh.setPassword('show1234');
  assert.ok(r.ran.some((c) => c === 'smbpasswd -a -s fpp <<"show1234\\nshow1234\\n"'));
  const conf = fs.readFileSync(r.smbConf, 'utf8');
  assert.match(conf, /valid users = fpp/);
  assert.match(conf, /map to guest = Never/);
  assert.doesNotMatch(conf, /guest ok = yes/);
  assert.equal(r.fsh.status().requirePassword, true);
  await r.fsh.setPassword('');
  assert.match(fs.readFileSync(r.smbConf, 'utf8'), /guest ok = yes/);
  r.fsh.config.update({ fileShare: { enabled: false } });
  await r.fsh.apply();
  assert.ok(r.ran.includes('systemctl disable --now smbd nmbd'));
  assert.equal(r.isActive(), false);
  assert.ok(!fs.existsSync(path.join(r.d, 'avahi', 'smb.service')));
});

test('file sharing: nothing happens until Samba is installed; names are cleaned', async () => {
  const r = rig();
  r.setInstalled(false);
  const st = await r.fsh.apply();
  assert.equal(st.installed, false);
  assert.equal(r.ran.length, 0);
  assert.equal(fs.readFileSync(r.smbConf, 'utf8'), '[global]\n   workgroup = WORKGROUP\n');
  await assert.rejects(r.fsh.setPassword('show1234'), /not installed/);
  assert.equal(cleanName('my show/../x'), 'myshowx');
  assert.equal(cleanName(''), 'media');
});
