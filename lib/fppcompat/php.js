// Runs FPP-shim PHP (plugin pages, plugin api.php endpoints) through
// php-cgi, the way Apache + mod_php would for FPP.

const { spawn } = require('child_process');
const path = require('path');

const PHP_CGI = process.env.SPP_PHP_CGI || 'php-cgi';

function runPhp(script, req, res, { env = {}, body } = {}) {
  const url = new URL(req.originalUrl || req.url, 'http://localhost');
  const input = body !== undefined ? body : (Buffer.isBuffer(req.body) ? req.body : null);
  const cgiEnv = {
    PATH: process.env.PATH,
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
    REMOTE_ADDR: (req.socket && req.socket.remoteAddress) || '',
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
  const p = spawn(PHP_CGI, [], { env: cgiEnv, cwd: path.dirname(script) });
  const chunks = [];
  let err = '';
  p.stdout.on('data', (d) => chunks.push(d));
  p.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => p.kill('SIGKILL'), 60000);
  p.on('error', (e) => { clearTimeout(t); if (!res.headersSent) res.status(500).send('php-cgi not available: ' + e.message); });
  // Plugin output is untrusted: a bad status or header must never throw
  // inside this event handler (that would take the whole player down).
  p.on('close', () => {
    clearTimeout(t);
    if (res.headersSent) return;
    try {
      const out = Buffer.concat(chunks);
      let sep = out.indexOf('\r\n\r\n'), skip = 4;
      if (sep < 0) { sep = out.indexOf('\n\n'); skip = 2; }
      if (sep < 0) return res.status(500).type('text/plain').send(err || 'bad CGI response');
      let status = 200;
      for (const line of out.subarray(0, sep).toString('latin1').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k) || /[\r\n\0]/.test(v)) continue;
        if (/^status$/i.test(k)) status = parseInt(v, 10) || 200;
        else if (/^x-powered-by$/i.test(k)) continue;
        else { try { res.append(k, v); } catch {} }
      }
      if (!(status >= 100 && status <= 599)) status = 502;
      res.status(status).send(out.subarray(sep + skip));
    } catch (e) {
      if (!res.headersSent) { try { res.status(502).type('text/plain').send('bad plugin response'); } catch {} }
    }
  });
  if (input) p.stdin.end(input); else p.stdin.end();
}

module.exports = { runPhp };
