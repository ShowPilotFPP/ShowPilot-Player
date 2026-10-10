// FPP-compatible HTTP API: what xLights FPP Connect and plugins depend on.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
process.env.SPP_MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-api-'));
process.env.SPP_PORT = String(30000 + Math.floor(Math.random() * 20000));
process.env.SPP_FPPDIR = path.join(__dirname, '..', 'fpp-compat');
process.env.SPP_AUDIO_NULL = '1';
process.env.SPP_DISPLAY = '0';

const test = require('node:test');
const assert = require('node:assert');

const has = (bin) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const B = `http://127.0.0.1:${process.env.SPP_PORT}`;
let ctx;

test.before(async () => {
  const { main } = require('../server');
  ctx = await main();
  await new Promise((r) => setTimeout(r, 300));
});
test.after(async () => { try { await ctx.player.close(); ctx.multisync.close(); ctx.showpilot.close(); ctx.scheduler.stop(); } catch {} setTimeout(() => process.exit(0), 100); });

test('discovery: system info and multiSyncSystems carry what xLights needs', async () => {
  const info = await (await fetch(`${B}/api/system/info`)).json();
  assert.ok(info.uuid);
  assert.equal(info.majorVersion, 9);
  assert.equal(info.minorVersion, 3);
  const ms = await (await fetch(`${B}/api/fppd/multiSyncSystems`)).json();
  assert.ok(ms.systems.length >= 1);
  assert.ok(ms.systems[0].typeId > 0 && ms.systems[0].typeId < 0x80);
});

test('chunked PATCH upload (FPP Connect) reassembles the file', async () => {
  const data = Buffer.alloc(100000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 255;
  assert.equal((await fetch(`${B}/api/sequence/up/meta`)).status, 404, 'missing file forces an upload');
  const chunk = 40000;
  for (let off = 0; off < data.length; off += chunk) {
    const body = data.subarray(off, off + chunk);
    const r = await fetch(`${B}/api/file/sequences`, { method: 'PATCH', body,
      headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(off), 'Upload-Length': String(data.length), 'Upload-Name': 'up.bin' } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.status, 'OK');
  }
  const got = fs.readFileSync(path.join(process.env.SPP_MEDIA_DIR, 'sequences', 'up.bin'));
  assert.ok(got.equals(data));
  const bad = await fetch(`${B}/api/file/sequences`, { method: 'PATCH', body: Buffer.alloc(1), headers: { 'Upload-Offset': '0', 'Upload-Length': '1', 'Upload-Name': '../evil' } });
  assert.equal(bad.status, 400);
  const late = await fetch(`${B}/api/file/sequences`, { method: 'PATCH', body: Buffer.alloc(1), headers: { 'Upload-Offset': '5', 'Upload-Length': '10', 'Upload-Name': 'never.bin' } });
  assert.equal(late.status, 409);
});

test('playlists and commands', async () => {
  const pl = { name: 'P', mainPlaylist: [{ type: 'pause', duration: 30 }] };
  assert.equal((await fetch(`${B}/api/playlist/P`, { method: 'POST', body: JSON.stringify(pl), headers: { 'Content-Type': 'application/json' } })).status, 200);
  assert.deepEqual(await (await fetch(`${B}/api/playlists`)).json(), ['P']);
  const r = await fetch(`${B}/api/command/Start%20Playlist/P/false`);
  assert.equal(r.status, 200);
  const st = await (await fetch(`${B}/api/fppd/status`)).json();
  assert.equal(st.current_playlist.playlist, 'P');
  assert.equal((await fetch(`${B}/api/command/No%20Such%20Command`)).status, 404);
  await fetch(`${B}/api/playlists/stop`);
});

test('plugin hosting: settings, PHP page, api.php endpoint, command', { skip: !has('php-cgi') && 'php-cgi not installed' }, async () => {
  const dir = path.join(process.env.SPP_MEDIA_DIR, 'plugins', 'fpp-t');
  fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pluginInfo.json'), JSON.stringify({ repoName: 'fpp-t', name: 'T' }));
  fs.writeFileSync(path.join(dir, 'menu.inc'), "<?php $m = [['type'=>'content','page'=>'p.php']]; ?>");
  fs.writeFileSync(path.join(dir, 'p.php'), '<b>v<?php echo getFPPMajorVersion(); ?>:<?php echo ReadSettingFromFile("k","fpp-t"); ?></b>');
  fs.writeFileSync(path.join(dir, 'api.php'), "<?php function getEndpointsfppt(){return [['method'=>'GET','endpoint'=>'echo/:x','callback'=>'tEcho']];} function tEcho(){return json(['x'=>params('x')]);}");
  fs.writeFileSync(path.join(dir, 'commands', 'descriptions.json'), JSON.stringify([{ name: 'T - Touch', script: 't.sh', args: [] }]));
  fs.writeFileSync(path.join(dir, 'commands', 't.sh'), '#!/bin/sh\ntouch "$MEDIADIR/logs/t-touched"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'commands', 'fail.sh'), '#!/bin/sh\necho "No payload specified" >&2\nexit 3\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'commands', 'descriptions.json'), JSON.stringify([{ name: 'T - Touch', script: 't.sh', args: [] }, { name: 'T - Fail', script: 'fail.sh', args: [] }]));
  await ctx.plugins.loadAll();
  await fetch(`${B}/api/plugin/fpp-t/settings/k`, { method: 'PUT', body: 'hello', headers: { 'Content-Type': 'text/plain' } });
  const page = await (await fetch(`${B}/plugin.php?plugin=fpp-t&page=p.php&nopage=1`)).text();
  assert.equal(page, '<b>v10:hello</b>');
  // FPP enables short_open_tag and many plugins write "<?" (e.g. the IFTTT plugin's settings field).
  fs.writeFileSync(path.join(dir, 's.php'), '<? $x = 2; if ($x > 1) { ?>shown<? } ?>|<?= ReadSettingFromFile("k","fpp-t") ?>');
  assert.equal(await (await fetch(`${B}/plugin.php?plugin=fpp-t&page=s.php&nopage=1`)).text(), 'shown|hello');
  assert.deepEqual(await (await fetch(`${B}/api/plugin/fpp-t/echo/abc`)).json(), { x: 'abc' });
  assert.equal((await fetch(`${B}/plugin.php?plugin=fpp-t&page=../../settings`)).status, 404);
  await fetch(`${B}/api/command/T%20-%20Touch`);
  const failed = await fetch(`${B}/api/command/T%20-%20Fail`);
  assert.equal(failed.status, 500);
  assert.match(await failed.text(), /exit 3.*No payload specified/, 'a failing plugin command reports its error');
  assert.ok(fs.existsSync(path.join(process.env.SPP_MEDIA_DIR, 'logs', 't-touched')));
});

test('security: ".." is never a plugin, and bad plugin output cannot crash the player', { skip: !has('php-cgi') && 'php-cgi not installed' }, async () => {
  fs.writeFileSync(path.join(process.env.SPP_MEDIA_DIR, 'upload', 'x.php'), '<?php echo "pwned";');
  for (const u of ['/plugin.php?plugin=..&page=upload/x.php&nopage=1', '/plugin.php?plugin=..&file=plugindata/showpilot-player/sessionSecret', '/plugin.php?plugin=.&page=x.php']) {
    const r = await fetch(B + u);
    assert.equal(r.status, 404, u);
    assert.ok(!(await r.text()).includes('pwned'));
  }
  assert.notEqual((await fetch(`${B}/api/plugin/%2E%2E/x`)).status, 200);
  const del = await fetch(`${B}/api/player/plugins/..`, { method: 'DELETE' });
  assert.notEqual(del.status, 200);
  assert.ok(fs.existsSync(path.join(process.env.SPP_MEDIA_DIR, 'sequences')), 'media folder intact');

  const dir = path.join(process.env.SPP_MEDIA_DIR, 'plugins', 'fpp-bad');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'api.php'), "<?php function getEndpointsfppbad(){return [['method'=>'GET','endpoint'=>'s','callback'=>'b']];} function b(){ header('Status: 42'); return 'x'; }");
  const r = await fetch(`${B}/api/plugin/fpp-bad/s`);
  assert.equal(r.status, 502);
  assert.equal((await fetch(`${B}/api/system/info`)).status, 200, 'player still up');
  assert.equal((await fetch(`${B}/api/command/Stop%20Now/%E0%A4%A`)).status, 400);
});

test('FPP Connect: models, UDP outputs and config files', async () => {
  const j = (r) => r.json();
  const post = (u, body, type = 'application/json') => fetch(B + u, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': type } });
  assert.deepEqual(await j(await fetch(`${B}/api/models`)), []);
  const models = { models: [{ Name: 'Matrix', StartChannel: 1, ChannelCount: 6144, Type: 'Channel', Orientation: 'horizontal', StrandsPerString: 1, StringCount: 32, xLights: true }] };
  assert.equal((await post('/api/models', models)).status, 200);
  assert.equal((await j(await fetch(`${B}/api/models`)))[0].Name, 'Matrix');

  const udp = { channelOutputs: [{ type: 'universes', enabled: 1, startChannel: 1, channelCount: -1, interface: 'eth0', universes: [
    { active: 1, description: 'Roof', id: 1, startChannel: 1, universeCount: 4, channelCount: 510, type: 0, address: '', priority: 0 },
    { active: 1, description: 'Tree', id: 1, startChannel: 2041, universeCount: 1, channelCount: 3000, type: 4, address: '10.0.0.9' },
    { active: 1, description: 'Old', id: 50, startChannel: 5041, universeCount: 1, channelCount: 512, type: 3, address: '10.0.0.8' },
  ] }] };
  const r = await j(await post('/api/channel/output/universeOutputs', udp));
  assert.equal(r.outputs, 2);
  assert.equal(r.skipped, 1);
  const st = await j(await fetch(`${B}/api/player/config`));
  assert.deepEqual(st.outputs.map((o) => [o.type, o.startChannel, o.channelCount || o.universeCount]), [['e131', 1, 4], ['ddp', 2041, 3000]]);
  const back = await j(await fetch(`${B}/api/channel/output/universeOutputs`));
  assert.equal(back.channelOutputs[0].interface, 'eth0', 'FPP-owned keys round-trip');
  assert.equal(back.channelOutputs[0].universes.length, 2);

  assert.equal((await post('/api/configfile/virtualdisplaymap', '# map', 'text/plain')).status, 200);
  assert.equal(await (await fetch(`${B}/api/configfile/virtualdisplaymap`)).text(), '# map');
  assert.equal((await fetch(`${B}/api/configfile/..%2Fsettings`)).status >= 400, true);
});

test('command presets, the commands list and FPP backup restore over HTTP', async () => {
  const J = { 'Content-Type': 'application/json' };
  const list = await (await fetch(`${B}/api/commands`)).json();
  const names = list.map((c) => c.name);
  for (const n of ['URL', 'Trigger Command Preset', 'Trigger Command Preset Slot', 'Run Script', 'Stop Gracefully']) assert.ok(names.includes(n), n);
  assert.ok(list.every((c) => c.category), 'every command has a category');
  const put = await fetch(`${B}/api/player/presets`, { method: 'PUT', headers: J,
    body: JSON.stringify({ presets: [{ name: 'Off', presetSlot: 2, commands: [{ command: 'All Lights Off', args: [] }] }] }) });
  assert.equal(put.status, 200);
  assert.deepEqual(await (await fetch(`${B}/api/commandPresets?names=true`)).json(), ['Off']);
  const fpp = await (await fetch(`${B}/api/commandPresets`)).json();
  assert.equal(fpp.commands[0].presetSlot, 2);
  assert.equal(await (await fetch(`${B}/api/command/Trigger%20Command%20Preset/Off`)).text(), '1 command run');
  const dup = await fetch(`${B}/api/player/presets`, { method: 'PUT', headers: J, body: JSON.stringify({ presets: [{ name: 'A', commands: [] }, { name: 'A', commands: [] }] }) });
  assert.equal(dup.status, 400);

  const backup = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'fpp-backup.json'), 'utf8'));
  const info = await (await fetch(`${B}/api/player/backup/inspect`, { method: 'POST', headers: J, body: JSON.stringify({ backup }) })).json();
  assert.ok(info.sections.some((s) => s.id === 'schedule'));
  const res = await (await fetch(`${B}/api/player/backup/restore`, { method: 'POST', headers: J,
    body: JSON.stringify({ backup, selection: { presets: ['Lights Off'], scripts: ['lights-on.sh'] } }) })).json();
  assert.deepEqual(res.problems, []);
  assert.deepEqual((await (await fetch(`${B}/api/commandPresets?names=true`)).json()).sort(), ['Lights Off', 'Off']);
  assert.deepEqual(await (await fetch(`${B}/api/scripts`)).json(), ['lights-on.sh']);
  const sch = await (await fetch(`${B}/api/player/schedule`)).json();
  assert.equal(sch.entries.length, 0, 'schedule not picked, not touched');
  assert.ok(sch.holidays.some((h) => h.shortName === 'Thanksgiving'));
});
