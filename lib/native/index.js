// Ports of FPP C++ plugins. A native plugin (libX.so loaded into fppd)
// can't run in ShowPilot Player; for popular ones the C++ part is rebuilt
// here in JavaScript, keyed by the plugin's folder / repoName. The port
// answers the plugin's own API under /api/plugin-apis/<apiPrefix>/..., so
// the plugin's PHP pages work unchanged.
//
// Port interface: { apiPrefix, create({ configDir, runCommand, log }) ->
//   { start(), stop(), handle(method, parts, body) -> [status, json] } }

const PORTS = {
  'fpp-gameday': () => require('./gameday'),
};

function portFor(name) {
  const f = PORTS[String(name || '').toLowerCase()];
  return f ? f() : null;
}

module.exports = { portFor, names: () => Object.keys(PORTS) };
