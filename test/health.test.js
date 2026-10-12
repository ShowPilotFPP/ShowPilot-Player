// Dashboard problems: the "no controller outputs" warning only where outputs are expected.
const test = require('node:test');
const assert = require('node:assert');
const { outputProblems } = require('../lib/health');

test('no-outputs warning: shown for a lights player, not for a remote or a screen-only player', () => {
  assert.equal(outputProblems({ mode: 'player', outputs: [], matrix: { enabled: false } }).length, 1);
  assert.equal(outputProblems({ mode: 'player', outputs: [{ type: 'ddp', enabled: false }], matrix: { enabled: false } }).length, 1, 'all outputs switched off');
  assert.deepEqual(outputProblems({ mode: 'player', outputs: [{ type: 'ddp' }], matrix: { enabled: false } }), []);
  assert.deepEqual(outputProblems({ mode: 'remote', outputs: [], matrix: { enabled: false } }), [], 'MultiSync remote');
  assert.deepEqual(outputProblems({ mode: 'player', outputs: [], matrix: { enabled: true } }), [], 'virtual matrix only');
});

test('ShowPilot client is off in remote mode (the master talks to ShowPilot)', async () => {
  const { EventEmitter } = require('events');
  const { ShowPilotClient } = require('../lib/showpilot');
  let mode = 'remote';
  const cfg = { showpilot: { enabled: true, serverUrl: 'http://127.0.0.1:9', statusIntervalMs: 500 } };
  const config = Object.assign(new EventEmitter(), { get: () => ({ ...cfg, mode }) });
  const c = new ShowPilotClient({ config, player: new EventEmitter(), show: {}, commands: { register() {} } });
  assert.equal(c.active(), false);
  assert.equal(c.enabled(), false);
  assert.equal(await c.api('GET', '/api/plugin/health'), null, 'no request leaves a remote');
  assert.match(c.lastError, /Remote mode/);
  assert.equal(c.status().remoteMode, true);
  mode = 'player';
  assert.equal(c.active(), true);
});
