// Ports of native (C++) FPP plugins: GameDay (fpp-gameday).
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { GameDay } = require('../lib/native/gameday');

// A fake ESPN: team info with a next event, and a scoreboard whose state the test moves along.
function fakeEspn() {
  const game = { state: 'pre', my: 0, oppo: 0, period: 0, clock: '' };
  const urls = [];
  const fetchText = async (url) => {
    urls.push(url);
    if (/\/teams\/12$/.test(url)) {
      return JSON.stringify({ team: { id: '12', displayName: 'Kansas City Chiefs', abbreviation: 'KC', logos: [{ href: 'https://x/kc.png' }],
        nextEvent: [{ id: '401', date: new Date(Date.now() + 5 * 60000).toISOString().replace(/\.\d+Z$/, 'Z'),
          competitions: [{ status: { type: { state: game.state } }, competitors: [{ team: { id: '12' } }, { team: { id: '7', displayName: 'Denver Broncos', abbreviation: 'DEN' } }] }] }] } });
    }
    if (/\/scoreboard\/401$/.test(url)) {
      return JSON.stringify({ competitions: [{ status: { type: { state: game.state }, period: game.period, displayClock: game.clock },
        competitors: [{ team: { id: '12' }, score: String(game.my) }, { team: { id: '7' }, score: String(game.oppo) }] }] });
    }
    return '<html>Access Denied</html>';
  };
  return { game, urls, fetchText };
}

test('GameDay port: touchdown, field goal and win run the chosen sequence/playlist like the C++ plugin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-gd-'));
  const espn = fakeEspn();
  const ran = [];
  const gd = new GameDay({ configDir: dir, fetchText: espn.fetchText, runCommand: async (c, a) => ran.push([c, ...a]) });
  const [code] = await gd.handle('POST', ['config'], JSON.stringify({ enabled: true, leagues: { nfl: [{ teamID: '12',
    touchdownActionType: 'sequence', touchdownActionValue: 'TD Dance', fieldgoalActionType: 'playlist', fieldgoalActionValue: 'FG',
    winActionType: 'audio', winActionValue: 'win.mp3' }] } }));
  assert.equal(code, 200);
  const team = gd.leagues.nfl[0];

  // Unknown state: looks the team up, then the game is 5 minutes out.
  assert.equal(await gd.pollTeam('nfl', team), 600, 'pre-game state from team info, polled again later');
  assert.equal(team.teamName, 'Kansas City Chiefs');
  assert.equal(team.oppoName, 'Denver Broncos');
  assert.equal(team.gameStatus, 'pre');
  assert.equal(await gd.pollTeam('nfl', team), 30, 'within 20 minutes of kickoff: every 30 s');

  espn.game.state = 'in';
  assert.equal(await gd.pollTeam('nfl', team), 30, 'kickoff seen (same as the C++: 30 s on that poll)');
  assert.equal(await gd.pollTeam('nfl', team), 5, 'live: every 5 s');
  espn.game.my = 7;
  await gd.pollTeam('nfl', team);
  espn.game.my = 10;
  await gd.pollTeam('nfl', team);
  espn.game.oppo = 3;
  await gd.pollTeam('nfl', team); // opponent scoring runs nothing
  espn.game.state = 'post';
  assert.equal(await gd.pollTeam('nfl', team), 600);
  assert.deepEqual(ran, [
    ['Insert Playlist Immediate', 'TD Dance.fseq', '0', '0'],
    ['Insert Playlist Immediate', 'FG', '0', '0'],
    ['Play Media', 'win.mp3', '1', '0'],
  ]);

  // Saved in FPP's file, and the plugin pages' API answers.
  gd.save();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.fpp-gameday.json'), 'utf8'));
  assert.equal(saved.enabled, true);
  assert.equal(saved.leagues.nfl[0].touchdownActionValue, 'TD Dance');
  const [, st] = await gd.handle('GET', ['status']);
  assert.equal(st.leagues.nfl[0].myScore, 10);
  assert.equal(st.leagues.nfl[0].gameStatus, 'post');
  const [c404] = await gd.handle('GET', ['nope']);
  assert.equal(c404, 404);
});

test('GameDay port: old *Sequence config fields and non-football scoring', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-gd-'));
  fs.writeFileSync(path.join(dir, 'plugin.fpp-gameday.json'), JSON.stringify({ enabled: true, leagues: { nhl: [{ teamID: '12', scoreSequence: 'Goal Horn', gameStatus: 'in', nextEventID: '401' }] } }));
  const espn = fakeEspn();
  espn.game.state = 'in';
  const ran = [];
  const gd = new GameDay({ configDir: dir, fetchText: espn.fetchText, runCommand: async (c, a) => ran.push([c, ...a]) });
  const t = gd.leagues.nhl[0];
  assert.equal(t.scoreActionType, 'sequence');
  espn.game.my = 1;
  await gd.pollTeam('nhl', t);
  assert.deepEqual(ran, [['Insert Playlist Immediate', 'Goal Horn.fseq', '0', '0']]);
  assert.ok(espn.urls.every((u) => u.startsWith('https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/')));
});
