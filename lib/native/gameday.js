// GameDay (github.com/derwin12/fpp-gameday) for ShowPilot Player.
//
// That plugin is all C++ (libfpp-gameday.so, loaded into FPP's fppd), so
// none of it can run here as shipped. This is a straight port of its
// src/FPPProSports.cpp: same ESPN calls, same polling rhythm (5 s live,
// 30 s in the 20 minutes before a game, 10 min otherwise), same score/win
// rules, same config file (config/plugin.fpp-gameday.json) and the same
// API the plugin's own PHP pages call:
//   GET  /api/plugin-apis/ProSportsScoring/config
//   POST /api/plugin-apis/ProSportsScoring/config
//   GET  /api/plugin-apis/ProSportsScoring/status
//   POST /api/plugin-apis/ProSportsScoring/refresh/<league>/<index>
// so the plugin's Settings and Status pages work unchanged.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const LEAGUES = ['nfl', 'ncaa', 'nhl', 'mlb', 'afl'];
const FIELDS = ['teamID', 'teamName', 'teamAbbreviation', 'teamLogo', 'nextEventID', 'nextEventDate', 'gameStatus',
  'oppoID', 'oppoName', 'oppoAbbreviation'];
const ACTIONS = ['winActionType', 'winActionValue', 'touchdownActionType', 'touchdownActionValue',
  'fieldgoalActionType', 'fieldgoalActionValue', 'scoreActionType', 'scoreActionValue'];

const isFootball = (lg) => lg === 'nfl' || lg === 'ncaa';
const espnSport = (lg) => ({ nhl: 'hockey', mlb: 'baseball', afl: 'australian-football' }[lg] || 'football');
const espnLeague = (lg) => (lg === 'ncaa' ? 'college-football' : lg);
const base = (lg) => `https://site.api.espn.com/apis/site/v2/sports/${espnSport(lg)}/${espnLeague(lg)}`;
const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
const str = (v) => (v === undefined || v === null ? '' : String(v));

// The plugin found that ESPN's edge blocks libcurl and PHP's curl but not
// the curl program, so it runs `curl`; do the same, with Node's fetch as a
// fallback when curl isn't installed.
function curlGet(url) {
  return new Promise((resolve) => {
    execFile('curl', ['-s', '--max-time', '10', url], { maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err && err.code === 'ENOENT') {
        fetch(url, { signal: AbortSignal.timeout(10000) }).then((r) => r.text()).then(resolve, () => resolve(''));
        return;
      }
      resolve(err ? '' : String(out || ''));
    });
  });
}

function emptyTeam() {
  const s = {};
  for (const f of FIELDS) s[f] = '';
  for (const f of ACTIONS) s[f] = '';
  s.myScore = 0; s.oppoScore = 0; s.gamePeriod = 0; s.gameClock = '';
  return s;
}

class GameDay {
  constructor({ configDir, runCommand, log, fetchText = curlGet, now = () => Date.now() }) {
    this.file = path.join(configDir, 'plugin.fpp-gameday.json');
    this.runCommand = runCommand;
    this.log = log || (() => {});
    this.fetchText = fetchText;
    this.now = now;
    this.enabled = false;
    this.logLevel = 4;
    this.leagues = {};
    for (const lg of LEAGUES) this.leagues[lg] = [];
    this.timer = null;
    this.running = false;
    this.polling = null;
    this.load();
  }

  // ------------------------------------------------------------ config
  load() {
    let cfg = null;
    try { cfg = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return; }
    this.apply(cfg);
  }

  save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.configJson(), null, 2)); } catch (e) { this.log(`GameDay: could not save config: ${e.message}`); }
  }

  configJson() {
    const cfg = { enabled: this.enabled, logLevel: this.logLevel, leagues: {} };
    for (const lg of LEAGUES) {
      cfg.leagues[lg] = this.leagues[lg].map((s) => {
        const o = {};
        for (const f of FIELDS) o[f] = s[f];
        o.myScore = s.myScore; o.oppoScore = s.oppoScore;
        for (const f of ACTIONS) o[f] = s[f];
        return o;
      });
    }
    return cfg;
  }

  statusJson() {
    const st = { enabled: this.enabled, leagues: {} };
    for (const lg of LEAGUES) {
      st.leagues[lg] = this.leagues[lg].map((s) => ({
        teamID: s.teamID, teamName: s.teamName, teamAbbreviation: s.teamAbbreviation, teamLogo: s.teamLogo,
        nextEventDate: s.nextEventDate, gameStatus: s.gameStatus, oppoName: s.oppoName, oppoAbbreviation: s.oppoAbbreviation,
        myScore: s.myScore, oppoScore: s.oppoScore, gamePeriod: s.gamePeriod, gameClock: s.gameClock,
      }));
    }
    return st;
  }

  apply(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    if ('enabled' in cfg) this.enabled = !!cfg.enabled;
    if ('logLevel' in cfg) this.logLevel = toInt(cfg.logLevel);
    if (!cfg.leagues || typeof cfg.leagues !== 'object') return;
    for (const lg of LEAGUES) {
      const arr = cfg.leagues[lg];
      if (!Array.isArray(arr)) continue;
      const existing = this.leagues[lg];
      this.leagues[lg] = arr.map((lv) => {
        lv = lv || {};
        const id = str(lv.teamID);
        // Keep cached game state for a team that was already tracked.
        const prev = id && existing.find((e) => e.teamID === id);
        const s = prev ? { ...prev } : emptyTeam();
        s.teamID = id;
        for (const f of FIELDS.slice(1)) if (f in lv) s[f] = str(lv[f]);
        if ('myScore' in lv) s.myScore = toInt(lv.myScore);
        if ('oppoScore' in lv) s.oppoScore = toInt(lv.oppoScore);
        for (const f of ACTIONS) if (f in lv) s[f] = str(lv[f]);
        // Older configs: *Sequence fields.
        for (const k of ['win', 'touchdown', 'fieldgoal', 'score']) {
          if (!s[k + 'ActionType'] && str(lv[k + 'Sequence'])) { s[k + 'ActionType'] = 'sequence'; s[k + 'ActionValue'] = str(lv[k + 'Sequence']); }
        }
        return s;
      });
    }
  }

  // ------------------------------------------------------------ ESPN
  async getJson(url) {
    const body = await this.fetchText(url);
    if (!body) return null;
    const t = body.trimStart();
    if (t[0] !== '{' && t[0] !== '[') { this.log(`GameDay: ESPN sent something that isn't JSON for ${url} (${body.length} bytes)`); return null; }
    try { return JSON.parse(body); } catch { return null; }
  }

  async fetchTeamInfo(lg, s) {
    if (!s.teamID) return false;
    const root = await this.getJson(`${base(lg)}/teams/${encodeURIComponent(s.teamID)}`);
    const team = root && root.team;
    if (!team) return false;
    s.teamName = str(team.displayName);
    s.teamAbbreviation = str(team.abbreviation);
    if (Array.isArray(team.logos) && team.logos.length) s.teamLogo = str(team.logos[0].href);
    s.nextEventID = ''; s.nextEventDate = ''; s.gameStatus = ''; s.oppoID = ''; s.oppoName = ''; s.oppoAbbreviation = '';
    const ev = Array.isArray(team.nextEvent) && team.nextEvent[0];
    if (ev) {
      s.nextEventID = str(ev.id);
      s.nextEventDate = str(ev.date);
      const comp = Array.isArray(ev.competitions) && ev.competitions[0];
      if (comp) {
        s.gameStatus = str(comp.status && comp.status.type && comp.status.type.state);
        for (const c of comp.competitors || []) {
          const cid = str(c.team && c.team.id);
          if (cid !== s.teamID) { s.oppoID = cid; s.oppoName = str(c.team.displayName); s.oppoAbbreviation = str(c.team.abbreviation); }
        }
      }
    }
    this.log(`GameDay: [${lg}] ${s.teamName}: next game ${s.nextEventDate || 'none'} ${s.gameStatus}`);
    return true;
  }

  async fetchGameStatus(lg, s) {
    if (!s.nextEventID) return null;
    const root = await this.getJson(`${base(lg)}/scoreboard/${encodeURIComponent(s.nextEventID)}`);
    const comp = root && Array.isArray(root.competitions) && root.competitions[0];
    if (!comp) return null;
    const out = {
      status: str(comp.status && comp.status.type && comp.status.type.state),
      period: toInt(comp.status && comp.status.period),
      clock: str(comp.status && comp.status.displayClock),
      my: 0, oppo: 0,
    };
    for (const c of comp.competitors || []) {
      const score = toInt(c.score);
      if (str(c.team && c.team.id) === s.teamID) out.my = score; else out.oppo = score;
    }
    return out.status ? out : null;
  }

  // When the team endpoint has no next event (AFL): find the game on the league scoreboard.
  async fetchTeamFromScoreboard(lg, s) {
    if (!s.teamID) return false;
    const root = await this.getJson(`${base(lg)}/scoreboard`);
    for (const ev of (root && root.events) || []) {
      const comp = Array.isArray(ev.competitions) && ev.competitions[0];
      if (!comp || !Array.isArray(comp.competitors)) continue;
      if (!comp.competitors.some((c) => str(c.team && c.team.id) === s.teamID)) continue;
      s.nextEventID = str(ev.id);
      s.nextEventDate = str(ev.date);
      s.gameStatus = str(comp.status && comp.status.type && comp.status.type.state);
      for (const c of comp.competitors) {
        const cid = str(c.team && c.team.id);
        if (cid === s.teamID) s.myScore = toInt(c.score);
        else { s.oppoID = cid; s.oppoName = str(c.team.displayName); s.oppoAbbreviation = str(c.team.abbreviation); s.oppoScore = toInt(c.score); }
      }
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ actions
  async trigger(type, value) {
    if (!type || type === 'none' || !value) return;
    let cmd, args;
    if (type === 'sequence') { cmd = 'Insert Playlist Immediate'; args = [value + '.fseq', '0', '0']; }
    else if (type === 'playlist') { cmd = 'Insert Playlist Immediate'; args = [value, '0', '0']; }
    else if (type === 'audio') { cmd = 'Play Media'; args = [value, '1', '0']; }
    else return;
    this.log(`GameDay: playing ${type} ${value}`);
    try { await this.runCommand(cmd, args); } catch (e) { this.log(`GameDay: ${cmd} ${value} failed: ${e.message}`); }
  }

  // One team; returns seconds until it should be looked at again.
  async pollTeam(lg, s) {
    if (s.gameStatus === 'post') { await this.fetchTeamInfo(lg, s); return 600; }
    if (s.gameStatus === 'pre') {
      const t = Date.parse(s.nextEventDate);
      const toGame = Number.isFinite(t) ? (t - this.now()) / 1000 : 99999;
      if (toGame > 1200) return 600;
      const g = await this.fetchGameStatus(lg, s);
      if (g) { s.gameStatus = g.status; s.myScore = g.my; s.oppoScore = g.oppo; s.gamePeriod = g.period; s.gameClock = g.clock; }
      return 30;
    }
    if (s.gameStatus === 'in' || !s.gameStatus) {
      if (!s.nextEventID) {
        await this.fetchTeamInfo(lg, s);
        if (!s.nextEventID) await this.fetchTeamFromScoreboard(lg, s);
        if (!s.nextEventID) return 600;
      }
      const g = await this.fetchGameStatus(lg, s);
      if (!g) return 30;
      const prevMy = s.myScore;
      s.gameStatus = g.status; s.myScore = g.my; s.oppoScore = g.oppo; s.gamePeriod = g.period; s.gameClock = g.clock;
      if (g.status === 'in' || g.status === 'post') {
        const delta = g.my - prevMy;
        if (delta > 0) {
          this.log(`GameDay: [${lg}] ${s.teamName} scored: ${g.my}-${g.oppo}`);
          if (isFootball(lg)) {
            if (delta >= 6) await this.trigger(s.touchdownActionType, s.touchdownActionValue);
            else await this.trigger(s.fieldgoalActionType, s.fieldgoalActionValue);
          } else await this.trigger(s.scoreActionType, s.scoreActionValue);
        }
      }
      if (g.status === 'post') {
        if (g.my > g.oppo) { this.log(`GameDay: [${lg}] ${s.teamName} won ${g.my}-${g.oppo}`); await this.trigger(s.winActionType, s.winActionValue); }
        return 600;
      }
      return g.status === 'in' ? 5 : 600;
    }
    return 600;
  }

  async pollAll() {
    let next = 600;
    for (const lg of LEAGUES) {
      for (const live of [...this.leagues[lg]]) {
        if (!this.running || !this.enabled) return next;
        if (!live.teamID) continue;
        const copy = { ...live };
        const secs = await this.pollTeam(lg, copy);
        next = Math.min(next, secs);
        // Write back the game state; keep actions edited meanwhile.
        const cur = this.leagues[lg].find((t) => t.teamID === copy.teamID);
        if (cur) { for (const f of ACTIONS) copy[f] = cur[f]; Object.assign(cur, copy); }
      }
    }
    this.save();
    return next;
  }

  _schedule(secs) {
    clearTimeout(this.timer);
    if (!this.running) return;
    this.timer = setTimeout(() => this._loop(), secs * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  async _loop() {
    if (!this.running) return;
    if (!this.enabled) return this._schedule(10);
    if (this.polling) return; // a wake-up while a poll runs: it reschedules itself
    let secs = 30;
    this.polling = this.pollAll().then((s) => { secs = s; }, (e) => this.log(`GameDay: poll failed: ${e.message}`));
    await this.polling;
    this.polling = null;
    this._schedule(secs);
  }

  wake() { if (this.running) { clearTimeout(this.timer); setImmediate(() => this._loop()); } }

  start() { if (this.running) return; this.running = true; this.log('GameDay: started (ShowPilot Player port of the C++ plugin)'); this.wake(); }
  stop() { this.running = false; clearTimeout(this.timer); }

  // ------------------------------------------------------------ HTTP
  // parts: path after /api/plugin-apis/ProSportsScoring, split on '/'.
  async handle(method, parts, body) {
    const [action, a2, a3] = parts;
    if (method === 'GET' && action === 'config') return [200, this.configJson()];
    if (method === 'GET' && action === 'status') return [200, this.statusJson()];
    if (method === 'POST' && action === 'config') {
      let cfg = body;
      if (Buffer.isBuffer(cfg) || typeof cfg === 'string') { try { cfg = JSON.parse(String(cfg)); } catch { return [400, { error: 'Invalid JSON' }]; } }
      if (!cfg || typeof cfg !== 'object') return [400, { error: 'Invalid JSON' }];
      this.apply(cfg);
      this.save();
      this.wake();
      return [200, { status: 'ok' }];
    }
    if (method === 'POST' && action === 'refresh' && a2) {
      if (!LEAGUES.includes(a2)) return [400, { error: 'Unknown league' }];
      const idx = toInt(a3);
      const t = this.leagues[a2][idx];
      if (!t) return [400, { error: 'Index out of range' }];
      const copy = { ...t };
      const ok = await this.fetchTeamInfo(a2, copy);
      const cur = this.leagues[a2][idx];
      if (ok && cur && cur.teamID === copy.teamID) {
        for (const f of ACTIONS) copy[f] = cur[f];
        copy.myScore = 0; copy.oppoScore = 0;
        this.leagues[a2][idx] = copy;
      }
      this.save();
      this.wake();
      return [200, { status: ok ? 'ok' : 'error' }];
    }
    return [404, { error: 'Not found' }];
  }
}

module.exports = { GameDay, LEAGUES, apiPrefix: 'ProSportsScoring', create: (opts) => new GameDay(opts) };
