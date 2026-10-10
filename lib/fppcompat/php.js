// Runs FPP-shim PHP (plugin pages, plugin api.php endpoints) through
// php-cgi, the way Apache + mod_php would for FPP:
//   - output is streamed as it arrives (plugins stream logs with flush()),
//   - a script that keeps running is not killed (some plugins start their
//     background loop with an HTTP request, e.g. fpp-nfl's nfl.php); after a
//     while the browser gets what was sent so far and the script carries on.
//     At most a few such scripts per page are kept; the oldest is stopped.

const { spawn } = require('child_process');
const path = require('path');

const PHP_CGI = process.env.SPP_PHP_CGI || 'php-cgi';
const DETACH_AFTER_MS = Number(process.env.SPP_CGI_DETACH_MS) || 60000;
const MAX_LONG_RUNNING = 3;          // per plugin page
const longRunning = new Map();       // key -> [child]

function remember(key, p) {
  const list = (longRunning.get(key) || []).filter((c) => c.exitCode === null && c.signalCode === null);
  list.push(p);
  while (list.length > MAX_LONG_RUNNING) { const old = list.shift(); try { old.kill('SIGTERM'); } catch {} }
  longRunning.set(key, list);
}

function stopAll() {
  for (const list of longRunning.values()) for (const c of list) { try { c.kill('SIGTERM'); } catch {} }
  longRunning.clear();
}

function runPhp(script, req, res, { env = {}, body } = {}) {
  const url = new URL(req.originalUrl || req.url, 'http://localhost');
  const input = body !== undefined ? body : (Buffer.isBuffer(req.body) ? req.body : null);
  const cgiEnv = {
    PATH: process.env.PATH,
    ...(process.env.PHP_INI_SCAN_DIR ? { PHP_INI_SCAN_DIR: process.env.PHP_INI_SCAN_DIR } : {}),
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    GATEWAY_INTERFACE: 'CGI/1.1',
    SERVER_PROTOCOL: 'HTTP/1.1',
    SERVER_SOFTWARE: 'ShowPilot-Player',
    REDIRECT_STATUS: '200',
    REQUEST_METHOD: req.method,
    SCRIPT_FILENAME: script,
    SCRIPT_NAME: '/' + path.basename(script),
    REQUEST_URI: req.originalUrl || req.url,
    QUERY_STRING: url.search.slice(1),
    DOCUMENT_ROOT: path.dirname(script),
    REMOTE_ADDR: ((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''),
    // Old plugins build form URLs from SERVER_ADDR.
    SERVER_ADDR: ((req.socket && req.socket.localAddress) || '127.0.0.1').replace(/^::ffff:/, ''),
    SERVER_NAME: req.hostname || 'localhost',
    SERVER_PORT: String((req.socket && req.socket.localPort) || 80),
    HTTP_HOST: req.headers.host || 'localhost',
    CONTENT_TYPE: req.headers['content-type'] || '',
    CONTENT_LENGTH: input ? String(input.length) : '',
    ...env,
  };
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'content-type' || k === 'content-length') continue;
    cgiEnv['HTTP_' + k.toUpperCase().replace(/-/g, '_')] = String(v);
  }
  const key = `${script}|${url.searchParams.get('plugin') || ''}|${url.searchParams.get('page') || ''}`;
  // short_open_tag: FPP turns it on and many plugins use "<?" (see fpp-compat/etc/php).
  const p = spawn(PHP_CGI, ['-d', 'short_open_tag=On'], { env: cgiEnv, cwd: path.dirname(script) });

  let head = Buffer.alloc(0);   // until the CGI header block is complete
  let started = false;          // response status/headers decided
  let err = '';
  let detached = false;

  // Plugin output is untrusted: a bad status or header must never throw
  // inside these event handlers (that would take the whole player down).
  const startResponse = (headerText) => {
    let status = 200;
    for (const line of headerText.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k) || /[\r\n\0]/.test(v)) continue;
      if (/^status$/i.test(k)) status = parseInt(v, 10) || 200;
      else if (/^(x-powered-by|content-length|transfer-encoding|connection)$/i.test(k)) continue;
      else { try { res.append(k, v); } catch {} }
    }
    if (!(status >= 100 && status <= 599)) status = 502;
    res.status(status);
    if (!res.get('Content-Type')) res.type('text/html');
    started = true;
  };
  const detach = () => {
    if (detached) return;
    detached = true;
    clearTimeout(t);
    remember(key, p);
    p.stdout.removeAllListeners('data');
    p.stdout.on('data', () => {}); // keep draining so the script never blocks on a full pipe
  };

  p.stdout.on('data', (d) => {
    try {
      if (!started) {
        head = Buffer.concat([head, d]);
        let sep = head.indexOf('\r\n\r\n'), skip = 4;
        if (sep < 0) { sep = head.indexOf('\n\n'); skip = 2; }
        if (sep < 0) {
          if (head.length > 65536) { started = true; res.status(502).type('text/plain').end('bad CGI response'); detach(); }
          return;
        }
        startResponse(head.subarray(0, sep).toString('latin1'));
        const rest = head.subarray(sep + skip);
        head = null;
        if (rest.length) res.write(rest);
      } else if (!res.writableEnded) res.write(d);
    } catch {
      try { if (!res.headersSent) res.status(502).type('text/plain').send('bad plugin response'); else res.end(); } catch {}
      detach();
    }
  });
  p.stderr.on('data', (d) => { if (err.length < 8192) err += d; });
  p.on('error', (e) => { clearTimeout(t); try { if (!res.headersSent) res.status(500).send('php-cgi not available: ' + e.message); } catch {} });
  p.on('close', () => {
    clearTimeout(t);
    if (detached) return;
    try {
      if (!started) {
        if (head && head.length) { startResponse(''); res.end(head); } // output without a header block
        else res.status(500).type('text/plain').send(err || 'bad CGI response');
      } else if (!res.writableEnded) res.end();
    } catch {}
  });

  // Like Apache: a script that is still running isn't killed. The browser
  // gets what was sent so far; the script keeps going in the background.
  const t = setTimeout(() => {
    if (p.exitCode !== null) return;
    try { if (!started) res.status(202).type('text/plain').end('started'); else if (!res.writableEnded) res.end(); } catch {}
    detach();
  }, DETACH_AFTER_MS);
  // The browser went away while the script runs: same as above.
  res.on('close', () => { if (p.exitCode === null && p.signalCode === null) detach(); });

  if (input) p.stdin.end(input); else p.stdin.end();
}

module.exports = { runPhp, stopAll };
