// ShowPilot Player — entry point. Wires the playback engine, show runner,
// scheduler, MultiSync, ShowPilot client, FPP plugin host, FPP-compatible
// API and the admin UI. See PRIMER.md for the architecture.

const fs = require('fs');
const path = require('path');
const express = require('express');
const EventEmitter = require('events');

const paths = require('./lib/paths');
const config = require('./lib/config');
const log = require('./lib/log');
const { Player } = require('./lib/engine/player');
const { Show } = require('./lib/show');
const { Commands, registerCore } = require('./lib/commands');
const { PresetRunner } = require('./lib/presets');
const { Scheduler } = require('./lib/scheduler');
const { MultiSync } = require('./lib/multisync');
const { ShowPilotClient } = require('./lib/showpilot');
const { Plugins, FPPDIR } = require('./lib/plugins');
const { runPhp, stopAll: stopPhp } = require('./lib/fppcompat/php');
const pkg = require('./package.json');

// Put the FPP shim where plugins look for it, unless a real FPP owns /opt/fpp.
function installFppShim() {
  const src = path.join(__dirname, 'fpp-compat');
  if (FPPDIR !== '/opt/fpp') return; // dev/test: SPP_FPPDIR points at the repo copy
  if (fs.existsSync('/opt/fpp/src/fppd') || fs.existsSync('/opt/fpp/src/fpp')) {
    log.warn('fpp', 'a real FPP is installed in /opt/fpp; plugin shim not installed');
    return;
  }
  try {
    fs.mkdirSync('/opt/fpp/src', { recursive: true });
    fs.cpSync(src, '/opt/fpp', { recursive: true, force: true });
    fs.writeFileSync('/opt/fpp/www/media_root.txt', paths.MEDIA_DIR + '\n');
    for (const f of fs.readdirSync('/opt/fpp/scripts')) fs.chmodSync(path.join('/opt/fpp/scripts', f), 0o755);
  } catch (e) { log.warn('fpp', `could not install the plugin shim: ${e.message}`); }
}

// FPP's PHP settings (short_open_tag etc.) for every php/php-cgi a plugin
// runs. The leading ':' keeps the system's own ini directory.
function phpSettings() {
  const dir = path.join(FPPDIR, 'etc', 'php');
  if (!fs.existsSync(dir)) return;
  const cur = process.env.PHP_INI_SCAN_DIR;
  if (!cur || !cur.split(':').includes(dir)) process.env.PHP_INI_SCAN_DIR = (cur || '') + ':' + dir;
}

async function main() {
  paths.ensureLayout();
  config.load();
  log.info('main', `ShowPilot Player ${pkg.version} starting (media: ${paths.MEDIA_DIR})`);
  installFppShim();
  phpSettings();

  const ctx = new EventEmitter();
  ctx.config = config;
  const commands = new Commands();
  const player = new Player(config);
  const show = new Show(player);
  ctx.commands = commands; ctx.player = player; ctx.show = show;

  player.on('log', (m) => log.info('player', m));
  show.on('log', (m) => log.info('show', m));
  show.on('item', (e) => log.info('show', `${e.resumed ? 'resumed' : 'playing'} ${e.entry.sequenceName || e.entry.mediaName} (${e.frameName})`));

  const plugins = new Plugins({ commands, show, player });
  ctx.plugins = plugins;
  plugins.on('log', (m) => log.info('plugins', m));
  await plugins.hook('preStart');

  await player.start();
  const presetRunner = new PresetRunner({
    commands,
    sendMultisync: (cmd, args, hosts) => ctx.multisync && ctx.multisync.sendCommand(cmd, args, hosts),
    log: (m) => log.info('presets', m),
  });
  ctx.presets = presetRunner;
  const later = (fn) => setTimeout(fn, 500);
  registerCore(commands, { show, player, presets: presetRunner, system: {
    restart: () => later(() => process.exit(0)),
    reboot: () => later(() => require('child_process').execFile('systemctl', ['reboot'], () => {})),
    shutdown: () => later(() => require('child_process').execFile('systemctl', ['poweroff'], () => {})),
  } });
  show.runCommand = (name, args) => commands.run(name, args);

  const multisync = new MultiSync({ config, player, commands });
  ctx.multisync = multisync;
  multisync.on('log', (m) => log.info('multisync', m));
  multisync.start();

  const showpilot = new ShowPilotClient({ config, player, show, commands });
  ctx.showpilot = showpilot;
  showpilot.on('log', (m) => log.info('showpilot', m));
  showpilot.start();

  // Plugin callbacks follow show and media events.
  show.on('playlist', (info) => plugins.emitPlaylist(info).catch(() => {}));
  show.queryNext = (info) => plugins.emitPlaylist({ ...info, Action: 'query_next', Section: 'MainPlaylist', Item: info.index });
  player.on('start', (e) => plugins.emitMedia(e));

  // FPP's reserved command preset names fire on show events.
  show.on('playlist', (info) => {
    if (info.Action === 'start') presetRunner.fire('PLAYLIST_STARTED', { PLAYLIST_NAME: info.name || '' });
    if (info.Action === 'stop') presetRunner.fire('PLAYLIST_STOPPED', { PLAYLIST_NAME: info.name || '' });
  });
  show.on('stopping', (how) => presetRunner.fire(how === 'now' ? 'PLAYLIST_STOPPING_NOW' : how === 'afterLoop' ? 'PLAYLIST_STOPPING_AFTER_LOOP' : 'PLAYLIST_STOPPING_GRACEFULLY'));
  player.on('start', (e) => presetRunner.fire('MEDIA_STARTED', { MEDIA_NAME: e.media || '', SEQUENCE_NAME: e.sequence || '' }));
  for (const ev of ['end', 'stop']) player.on(ev, (e) => presetRunner.fire('MEDIA_STOPPED', { MEDIA_NAME: (e && e.media) || '', SEQUENCE_NAME: (e && e.sequence) || '' }));
  await plugins.loadAll();

  const scheduler = new Scheduler({ show, commands, config, presets: presetRunner });
  ctx.scheduler = scheduler;
  scheduler.multisync = multisync;
  scheduler.on('log', (m) => log.info('schedule', m));
  scheduler.enabled = config.get().mode !== 'remote';
  scheduler.start();

  const { ScreenSleep } = require('./lib/screen-sleep');
  const screen = new ScreenSleep({ config, player, scheduler, log: (m) => log.info('screen', m) });
  ctx.screen = screen;
  // A screen left switched off by a previous run comes back on at start.
  if ((config.get().screenSleep || {}).enabled && (config.get().screenSleep.method || 'hdmi') === 'hdmi') screen._hdmi(true).catch(() => {});
  screen.start();

  const { BackgroundMusic } = require('./lib/bgmusic');
  const bgm = new BackgroundMusic({ config, player, show, commands, resolveMedia: require('./lib/engine/player').resolveMedia });
  bgm.on('log', (m) => log.info('music', m));
  ctx.bgm = bgm;
  bgm.start();

  const { FileShare } = require('./lib/fileshare');
  const fileShare = new FileShare({ config, log: (m) => log.info('fileshare', m) });
  ctx.fileShare = fileShare;
  fileShare.start();
  // Remote mode: the master runs the show. Schedule off, no local shows, and
  // a show that was running here stops when the player becomes a remote.
  show.locked = () => (config.get().mode === 'remote' ? 'This player is in Remote mode and plays what its MultiSync master plays. Switch to Player mode on the MultiSync page to run shows here.' : null);
  config.on('change', (c) => {
    scheduler.enabled = c.mode !== 'remote';
    if (c.mode === 'remote' && show.isRunning()) show.stopNow().catch(() => {});
  });

  // ------------------------------------------------------------ HTTP
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use('/api/player', require('./routes/player')(ctx));
  app.use('/api', require('./routes/fpp')(ctx));
  // Cache buster: page assets are linked as "?v=<version>-<newest file time>",
  // so a new version (or any changed file) is fetched without a hard refresh.
  // Versioned requests are cached for good; anything else is revalidated.
  const ASSET_V = (() => {
    let newest = 0;
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else newest = Math.max(newest, fs.statSync(f).mtimeMs); } };
    try { walk(path.join(__dirname, 'public')); walk(path.join(__dirname, 'fpp-compat', 'www')); } catch {}
    return `${pkg.version}-${Math.floor(newest / 1000).toString(36)}`;
  })();
  ctx.assetVersion = ASSET_V;
  const php = (req, res) => runPhp(path.join(FPPDIR, 'www', 'plugin.php'), req, res, { env: { FPPDIR, MEDIADIR: paths.MEDIA_DIR, SPP_ASSET_V: ASSET_V } });
  app.get('/plugin.php', php);
  app.post('/plugin.php', express.raw({ type: () => true, limit: '16mb' }), php);
  // The admin page carries the saved theme, so it opens in the right theme on
  // every device, before sign-in and after a reboot or update.
  const indexFile = path.join(__dirname, 'public', 'index.html');
  app.get(['/', '/index.html'], (req, res) => {
    let html;
    try { html = fs.readFileSync(indexFile, 'utf8'); } catch { return res.status(500).end(); }
    const t = String((config.get().ui || {}).theme || 'auto');
    html = html.replace('<html lang="en">', `<html lang="en" data-spp-theme="${/^[a-z-]+$/.test(t) ? t : 'auto'}" data-spp-version="${pkg.version}">`)
      .replace(/(src|href)="(\/[^"?#]+\.(?:js|css|svg))"/g, `$1="$2?v=${ASSET_V}"`);
    res.set('Cache-Control', 'no-cache').type('html').send(html);
  });
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    next();
  });
  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', cacheControl: false }));
  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  const port = Number(process.env.SPP_PORT) || config.get().web.port || 80;
  const server = app.listen(port, '0.0.0.0', () => log.info('main', `web UI on port ${port}`));
  server.requestTimeout = 0; // large uploads
  server.on('error', (e) => { log.error('main', `cannot listen on ${port}: ${e.message}`); process.exit(1); });

  await plugins.hook('postStart');
  // Plugins just started fresh; and if the Pi booted minutes ago, the reboot a
  // plugin asked for has happened.
  const justBooted = require('os').uptime() < 600;
  if (justBooted && plugins.rebootFlag()) log.info('plugins', 'cleared the reboot flag (the Pi has rebooted)');
  plugins.clearFlags({ restart: true, reboot: justBooted });
  presetRunner.fire('FPPD_STARTED');

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    log.info('main', `${sig}: shutting down`);
    try { plugins.stopPorts(); } catch {}
    try { await plugins.hook('preStop'); } catch {}
    try { await presetRunner.trigger('FPPD_STOPPED'); } catch {}
    scheduler.stop();
    showpilot.close();
    try { await bgm.close(); } catch {}
    multisync.close();
    try { await show.stopNow(); } catch {}
    try { await player.close(); } catch {}
    try { await plugins.hook('postStop'); } catch {}
    stopPhp();
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return ctx;
}

process.on('unhandledRejection', (e) => log.error('main', `unhandled: ${e && e.stack ? e.stack : e}`));

if (require.main === module) {
  main().catch((e) => { log.error('main', e.stack || e.message); process.exit(1); });
}

module.exports = { main };
