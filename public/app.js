// ShowPilot Player admin UI. Vanilla JS, no build step.
(() => {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (ms) => { if (!ms || ms < 0) ms = 0; const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const bytes = (n) => { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; n = n || 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${u[i]}`; };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function toast(msg, err) {
    const d = document.createElement('div');
    d.className = 'toast' + (err ? ' err' : '');
    d.textContent = msg;
    $('#toasts').appendChild(d);
    setTimeout(() => d.remove(), err ? 6000 : 3000);
  }

  async function api(method, url, body, opts = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      if (body instanceof Blob || body instanceof ArrayBuffer) { init.body = body; }
      else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    }
    Object.assign(init.headers, opts.headers || {});
    const r = await fetch(url, init);
    if (r.status === 401 && url.startsWith('/api/player') && !url.startsWith('/api/player/auth')) { showLogin(); throw new Error('login required'); }
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) throw new Error((data && (data.error || data.Message || data.status)) || `HTTP ${r.status}`);
    return data;
  }
  const P = (path) => '/api/player' + path;
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  let CONFIG = null;
  let LIB = null;
  let STATUS = null;
  const loadConfig = async () => (CONFIG = await api('GET', P('/config')));
  const loadLib = async () => (LIB = await api('GET', P('/library')));
  const saveConfig = async (patch, msg = 'Saved') => { CONFIG = await api('PUT', P('/config'), patch); toast(msg); return CONFIG; };

  // ---------------------------------------------------------------- auth
  function showLogin() { $('#login').hidden = false; $('#loginPw').focus(); }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', P('/auth/login'), { password: $('#loginPw').value });
      $('#login').hidden = true; $('#loginErr').textContent = '';
      route();
    } catch (err) { $('#loginErr').textContent = err.message; }
  });

  // ---------------------------------------------------------------- router
  const PAGES = {};
  const TITLES = { dashboard: 'Dashboard', playlists: 'Playlists', files: 'Files', schedule: 'Schedule', outputs: 'Outputs',
    display: 'Video & Matrix', multisync: 'MultiSync', showpilot: 'ShowPilot', plugins: 'Plugins', system: 'System' };
  let current = null;
  let pageTimer = null;

  async function route() {
    const name = (location.hash.slice(1) || 'dashboard').split('/')[0];
    const page = PAGES[name] ? name : 'dashboard';
    clearInterval(pageTimer); pageTimer = null;
    current = page;
    $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.page === page));
    $('#pageTitle').textContent = TITLES[page];
    $('#side').classList.remove('open');
    const el = $('#page');
    el.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const a = await api('GET', P('/auth'));
      if (!a.loggedIn) { showLogin(); return; }
      await PAGES[page](el);
    } catch (e) { el.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`; }
  }
  window.addEventListener('hashchange', route);
  $('#menuBtn').addEventListener('click', () => $('#side').classList.toggle('open'));

  // Top bar status, refreshed everywhere.
  async function pollStatus() {
    try {
      STATUS = await api('GET', P('/status'));
      const p = STATUS.player;
      const live = p.state === 'playing';
      $('.brand .dot').classList.toggle('live', live);
      const sp = STATUS.showpilot;
      $('#topStatus').innerHTML = [
        live ? `<span class="pill ok">Playing</span> ${esc(p.sequence || p.media)}` : `<span class="pill">Idle</span>`,
        STATUS.mode === 'remote' ? '<span class="pill warn">Remote mode</span>' : '',
        sp.enabled ? `<span class="pill ${sp.connected ? 'ok' : 'bad'}">ShowPilot ${sp.connected ? 'connected' : 'offline'}</span>` : '',
      ].join(' ');
      $('#sideFoot').innerHTML = `v${esc(STATUS.version)} · ${esc(STATUS.hostName)}<br>${STATUS.ips.map(esc).join(', ')}`;
      if (current === 'dashboard') renderNow();
    } catch {}
  }
  setInterval(pollStatus, 1000);

  // ---------------------------------------------------------------- dashboard
  PAGES.dashboard = async (el) => {
    await loadLib();
    el.innerHTML = `
      <div class="grid g2">
        <div class="card now" id="nowCard"></div>
        <div class="card">
          <h3>Start a playlist</h3>
          <div class="row">
            <select id="dashPl">${LIB.playlists.map((n) => `<option>${esc(n)}</option>`).join('') || '<option value="">No playlists yet</option>'}</select>
            <label class="inline"><input type="checkbox" id="dashRepeat" checked> Repeat</label>
            <button class="btn primary" id="dashStart">Start</button>
          </div>
          <p class="muted" id="dashNext"></p>
          <p class="muted" id="dashSched"></p>
        </div>
      </div>
      <div class="card"><h3>Timing</h3><div class="stats" id="timing"></div>
        <p class="dim" style="margin:10px 0 0">Lights follow the audio clock. "Late" is how far after its due time a frame left; frames are never queued, a late wake-up skips straight to the right frame.</p></div>`;
    $('#dashStart').onclick = guard(async () => {
      const n = $('#dashPl').value; if (!n) return;
      await api('POST', P('/play'), { playlist: n, repeat: $('#dashRepeat').checked });
      toast(`Started ${n}`);
    });
    renderNow();
  };

  function renderNow() {
    const card = $('#nowCard');
    if (!card || !STATUS) return;
    const p = STATUS.player, pl = STATUS.playlist;
    const live = p.state === 'playing';
    const pct = p.durationMs ? Math.min(100, (p.positionMs / p.durationMs) * 100) : 0;
    card.innerHTML = `
      <span class="muted">${live ? 'Now playing' : pl.paused ? 'Paused' : 'Idle'}${pl.name && !pl.name.startsWith('_') ? ` · ${esc(pl.name)} (${pl.index}/${pl.size})` : ''}${pl.breadcrumbs && pl.breadcrumbs.length ? ` · interrupted ${esc(pl.breadcrumbs.join(' › '))}` : ''}</span>
      <div class="now-title">${esc(p.sequence || p.media || '—')}</div>
      <div class="muted">${p.sequence && p.media ? esc(p.media) : ''}${p.video ? ` · video ${esc(p.video)}` : ''}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="times"><span>${fmt(p.positionMs)}</span><span>${fmt(p.durationMs)}</span></div>
      <div class="transport">
        <button class="btn" data-t="prev">Prev</button>
        <button class="btn" data-t="pause">${pl.paused ? 'Resume' : 'Pause'}</button>
        <button class="btn" data-t="next">Next</button>
        <button class="btn" data-t="graceful">${pl.stopping ? 'Stopping…' : 'Stop after song'}</button>
        <button class="btn primary" data-t="stop">Stop now</button>
      </div>`;
    $$('[data-t]', card).forEach((b) => (b.onclick = guard(async () => {
      const t = b.dataset.t;
      if (t === 'stop') await api('POST', P('/stop'));
      else if (t === 'graceful') await api('POST', P('/stop'), { graceful: true });
      else await api('POST', P('/' + t));
      pollStatus();
    })));
    const next = STATUS.next;
    const dn = $('#dashNext');
    if (dn) dn.textContent = next ? `Up next: ${next.sequenceName || next.mediaName || next.type}` : '';
    const ds = $('#dashSched');
    if (ds) ds.textContent = STATUS.schedule.active ? `Schedule: ${STATUS.schedule.active.playlist} until ${new Date(STATUS.schedule.active.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'No schedule running';
    const w = p.worker || {};
    const t = $('#timing');
    if (t) t.innerHTML = [
      ['Clock', p.clock], ['Frames/s', w.fps ?? 0], ['Avg late', `${w.avgLateMs ?? 0} ms`], ['Max late (1 s)', `${w.maxLateMs ?? 0} ms`],
      ['Late >20 ms (song)', w.total ? `${w.total.over20} of ${w.total.frames}` : '0'], ['Block decode', `${w.maxDecodeMs ?? 0} ms`],
      ['Display', p.display], ['MultiSync', STATUS.multisync.sending ? 'sending' : STATUS.mode === 'remote' ? `following ${STATUS.multisync.lastMaster || '—'}` : 'off'],
    ].map(([k, v]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
  }

  // ---------------------------------------------------------------- playlists
  const ENTRY_TYPES = ['both', 'sequence', 'media', 'pause', 'command', 'script'];
  let editing = null;

  PAGES.playlists = async (el) => {
    await loadLib();
    const sel = location.hash.split('/')[1] ? decodeURIComponent(location.hash.split('/')[1]) : null;
    el.innerHTML = `
      <div class="grid g2" style="grid-template-columns:minmax(220px,280px) 1fr">
        <div class="card">
          <h3>Playlists</h3>
          <div class="stack" id="plList"></div>
          <div class="row" style="margin-top:12px"><input id="plNew" placeholder="New playlist name"><button class="btn" id="plCreate">Create</button></div>
        </div>
        <div class="card" id="plEditor"><p class="muted">Pick a playlist to edit.</p></div>
      </div>`;
    $('#plList').innerHTML = LIB.playlists.map((n) => `<div class="row"><a href="#playlists/${encodeURIComponent(n)}">${esc(n)}</a></div>`).join('') || '<p class="muted">None yet.</p>';
    $('#plCreate').onclick = guard(async () => {
      const n = $('#plNew').value.trim();
      if (!/^[A-Za-z0-9 _().-]+$/.test(n)) throw new Error('Use letters, numbers, spaces, - _ . ( )');
      await api('POST', `/api/playlist/${encodeURIComponent(n)}`, { name: n, mainPlaylist: [], repeat: 1 });
      location.hash = `#playlists/${encodeURIComponent(n)}`;
    });
    if (sel) await editPlaylist(sel);
  };

  async function editPlaylist(name) {
    editing = await api('GET', `/api/playlist/${encodeURIComponent(name)}`);
    renderEditor();
  }

  function entryRow(e, sec, i) {
    const seqs = LIB.sequences.map((s) => s.name);
    const media = [...LIB.music.map((m) => m.name), ...LIB.videos.map((m) => m.name)];
    const opt = (list, v) => `<option value="">—</option>` + list.map((x) => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('');
    let a = '', b = '';
    if (e.type === 'both' || e.type === 'sequence') a = `<select data-f="sequenceName">${opt(seqs, e.sequenceName)}</select>`;
    if (e.type === 'both' || e.type === 'media') b = `<select data-f="mediaName">${opt(media, e.mediaName)}</select>`;
    if (e.type === 'pause') a = `<input type="number" step="0.1" min="0" data-f="duration" value="${esc(e.duration ?? 5)}" title="seconds">`;
    if (e.type === 'command') { a = `<input data-f="command" value="${esc(e.command || '')}" placeholder="FPP command name">`; b = `<input data-f="argsText" value="${esc((e.args || []).join(' | '))}" placeholder="args separated by |">`; }
    if (e.type === 'script') a = `<select data-f="scriptName">${opt(LIB.scripts, e.scriptName)}</select>`;
    if (!ENTRY_TYPES.includes(e.type)) a = `<span class="dim">${esc(e.type)} (kept, not played)</span>`;
    return `<div class="entry" data-sec="${sec}" data-i="${i}">
      <span class="handle">${i + 1}</span>
      <select class="e-type" data-f="type">${ENTRY_TYPES.map((t) => `<option ${t === e.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <span>${a}</span><span class="e-media">${b}</span>
      <label class="inline e-dur"><input type="checkbox" data-f="enabled" ${e.enabled === 0 || e.enabled === false ? '' : 'checked'}> on</label>
      <span class="row" style="gap:4px"><button class="btn small" data-a="up">↑</button><button class="btn small" data-a="down">↓</button><button class="btn small danger" data-a="del">✕</button></span>
    </div>`;
  }

  function renderEditor() {
    const pl = editing;
    const box = $('#plEditor');
    const sec = (key, title) => `
      <div class="section-title">${title}<span class="spacer"></span><button class="btn small" data-add="${key}">Add item</button></div>
      <div data-section="${key}">${pl[key].map((e, i) => entryRow(e, key, i)).join('') || '<p class="dim">Empty</p>'}</div>`;
    box.innerHTML = `
      <div class="row"><h3 style="margin:0">${esc(pl.name)}</h3><span class="spacer"></span>
        <button class="btn" id="plFill">Add all sequences</button>
        <button class="btn" id="plSave">Save</button><button class="btn primary" id="plStart">Save &amp; start</button></div>
      <div class="row" style="margin-top:10px">
        <label class="inline"><input type="checkbox" id="plRepeat" ${pl.repeat ? 'checked' : ''}> Repeat main section</label>
        <label class="inline"><input type="checkbox" id="plRandom" ${pl.random ? 'checked' : ''}> Shuffle</label>
        <label class="inline">Loops <input type="number" id="plLoops" min="0" value="${pl.loopCount || 0}"></label>
        <span class="spacer"></span><button class="btn small danger" id="plDelete">Delete playlist</button>
      </div>
      ${sec('leadIn', 'Lead-in')}${sec('mainPlaylist', 'Main')}${sec('leadOut', 'Lead-out')}`;
    $$('select,input', box).forEach((inp) => inp.addEventListener('change', () => readEntry(inp)));
    $$('[data-a]', box).forEach((b) => (b.onclick = () => {
      const row = b.closest('.entry'); const s = row.dataset.sec; const i = +row.dataset.i; const list = editing[s];
      if (b.dataset.a === 'del') list.splice(i, 1);
      if (b.dataset.a === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
      if (b.dataset.a === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
      renderEditor();
    }));
    $$('[data-add]', box).forEach((b) => (b.onclick = () => { editing[b.dataset.add].push({ type: 'both', enabled: 1 }); renderEditor(); }));
    $('#plFill').onclick = () => {
      for (const s of LIB.sequences) {
        const media = s.mediaFilename && [...LIB.music, ...LIB.videos].find((m) => m.name === s.mediaFilename);
        editing.mainPlaylist.push(media ? { type: 'both', enabled: 1, sequenceName: s.name, mediaName: media.name, duration: s.durationMs / 1000 } : { type: 'sequence', enabled: 1, sequenceName: s.name, duration: s.durationMs / 1000 });
      }
      renderEditor();
    };
    const save = async () => {
      editing.repeat = $('#plRepeat').checked ? 1 : 0;
      editing.random = $('#plRandom').checked ? 1 : 0;
      editing.loopCount = +$('#plLoops').value || 0;
      editing = await api('POST', `/api/playlist/${encodeURIComponent(editing.name)}`, editing);
      toast('Playlist saved');
    };
    $('#plSave').onclick = guard(save);
    $('#plStart').onclick = guard(async () => { await save(); await api('POST', P('/play'), { playlist: editing.name, repeat: !!editing.repeat }); toast(`Started ${editing.name}`); });
    $('#plDelete').onclick = guard(async () => {
      if (!confirm(`Delete playlist "${editing.name}"?`)) return;
      await api('DELETE', `/api/playlist/${encodeURIComponent(editing.name)}`);
      location.hash = '#playlists';
    });
  }

  function readEntry(inp) {
    const row = inp.closest('.entry');
    if (!row) return;
    const e = editing[row.dataset.sec][+row.dataset.i];
    const f = inp.dataset.f;
    if (f === 'enabled') e.enabled = inp.checked ? 1 : 0;
    else if (f === 'duration') e.duration = +inp.value;
    else if (f === 'argsText') e.args = inp.value.split('|').map((x) => x.trim()).filter(Boolean);
    else e[f] = inp.value || undefined;
    if (f === 'type') {
      if (!e.enabled && e.enabled !== 0) e.enabled = 1;
      renderEditor();
    }
    if (f === 'sequenceName' && e.type === 'both' && !e.mediaName) {
      const s = LIB.sequences.find((x) => x.name === e.sequenceName);
      if (s && s.mediaFilename) { e.mediaName = s.mediaFilename; renderEditor(); }
    }
  }

  // ---------------------------------------------------------------- files
  const folderFor = (name) => {
    const ext = name.toLowerCase().split('.').pop();
    if (ext === 'fseq') return 'sequences';
    if (ext === 'eseq') return 'effects';
    if (['mp4', 'mkv', 'mov', 'avi', 'mpg', 'mpeg', 'webm', 'm4v'].includes(ext)) return 'videos';
    if (['mp3', 'ogg', 'm4a', 'wav', 'flac', 'aac', 'wma', 'opus'].includes(ext)) return 'music';
    if (['sh', 'php', 'py', 'pl'].includes(ext)) return 'scripts';
    if (['png', 'jpg', 'jpeg', 'gif'].includes(ext)) return 'images';
    return null;
  };

  // Same chunked PATCH protocol xLights uses.
  async function upload(file, onProgress) {
    const dir = folderFor(file.name);
    if (!dir) throw new Error(`${file.name}: unsupported file type`);
    const CH = 8 * 1024 * 1024;
    for (let off = 0; off < file.size || off === 0; off += CH) {
      const chunk = file.slice(off, Math.min(file.size, off + CH));
      await api('PATCH', `/api/file/${dir}`, chunk, { headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(off), 'Upload-Length': String(file.size), 'Upload-Name': file.name } });
      onProgress(Math.min(file.size, off + CH) / (file.size || 1));
      if (file.size === 0) break;
    }
  }

  PAGES.files = async (el) => {
    await loadLib();
    const tbl = (title, rows, head) => `<div class="card"><h3>${title}</h3><div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows || '<tr><td class="dim" colspan="9">Nothing here yet.</td></tr>'}</tbody></table></div></div>`;
    el.innerHTML = `
      <div class="card"><div class="drop" id="drop">Drop .fseq, audio, video or script files here, or <label class="inline" style="display:inline;color:var(--blue);cursor:pointer"><u>choose files</u><input type="file" id="pick" multiple hidden></label>
        <div class="progress" id="upProg"></div></div>
        <p class="dim" style="margin:10px 0 0">xLights can also upload straight to this player: add it in FPP Connect like any FPP.</p></div>
      ${tbl('Sequences', LIB.sequences.map((s) => `<tr><td>${esc(s.name)}</td><td>${s.error ? `<span class="pill bad">${esc(s.error)}</span>` : esc(s.mediaFilename || '—')}</td><td class="num">${fmt(s.durationMs)}</td><td class="num">${s.stepMs ? Math.round(1000 / s.stepMs) + ' fps' : ''}</td><td class="num">${s.maxChannel ? s.maxChannel.toLocaleString() + ' ch' : ''}</td><td class="row end"><button class="btn small" data-play-seq="${esc(s.name)}" data-media="${esc(s.mediaFilename || '')}">Play</button><button class="btn small danger" data-del="sequences/${esc(s.name)}">Delete</button></td></tr>`).join(''), '<th>Name</th><th>Media</th><th class="num">Length</th><th class="num">Rate</th><th class="num">Channels</th><th></th>')}
      ${tbl('Audio', LIB.music.map((m) => `<tr><td>${esc(m.name)}</td><td class="num">${bytes(m.size)}</td><td class="row end"><button class="btn small danger" data-del="music/${esc(m.name)}">Delete</button></td></tr>`).join(''), '<th>Name</th><th class="num">Size</th><th></th>')}
      ${tbl('Video', LIB.videos.map((m) => `<tr><td>${esc(m.name)}</td><td class="num">${bytes(m.size)}</td><td class="row end"><button class="btn small danger" data-del="videos/${esc(m.name)}">Delete</button></td></tr>`).join(''), '<th>Name</th><th class="num">Size</th><th></th>')}`;
    const drop = $('#drop');
    const handle = guard(async (files) => {
      for (const f of files) {
        await upload(f, (p) => { $('#upProg').textContent = `${f.name}: ${Math.round(p * 100)}%`; });
        toast(`Uploaded ${f.name}`);
      }
      $('#upProg').textContent = '';
      PAGES.files(el);
    });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handle([...e.dataTransfer.files]); });
    $('#pick').addEventListener('change', (e) => handle([...e.target.files]));
    $$('[data-del]', el).forEach((b) => (b.onclick = guard(async () => {
      const [d, n] = b.dataset.del.split('/');
      if (!confirm(`Delete ${n}?`)) return;
      await api('DELETE', `/api/file/${d}/${encodeURIComponent(n)}`);
      PAGES.files(el);
    })));
    $$('[data-play-seq]', el).forEach((b) => (b.onclick = guard(async () => {
      await api('POST', P('/play'), { sequence: b.dataset.playSeq, media: b.dataset.media || undefined });
      toast(`Playing ${b.dataset.playSeq}`);
    })));
  };

  // ---------------------------------------------------------------- schedule
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const TIME_SPECS = ['dawn', 'sunrise', 'sunset', 'dusk'];
  PAGES.schedule = async (el) => {
    await Promise.all([loadConfig(), loadLib()]);
    let { entries, upcoming } = await api('GET', P('/schedule'));
    const sun = await api('GET', P('/suntimes')).catch(() => ({}));
    const timeField = (v, f) => `<select data-f="${f}Kind"><option value="time" ${TIME_SPECS.includes(v) ? '' : 'selected'}>Time</option>${TIME_SPECS.map((t) => `<option ${t === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <input type="time" data-f="${f}" value="${TIME_SPECS.includes(v) ? '' : esc(v)}" ${TIME_SPECS.includes(v) ? 'hidden' : ''}>`;
    const render = () => {
      el.innerHTML = `
        <div class="card"><h3>Location (for dusk and sunset times)</h3>
          <div class="row"><label>Latitude <input id="lat" value="${esc(CONFIG.location.latitude ?? '')}" placeholder="e.g. 36.1"></label>
          <label>Longitude <input id="lon" value="${esc(CONFIG.location.longitude ?? '')}" placeholder="e.g. -94.1"></label>
          <button class="btn" id="saveLoc">Save location</button>
          <span class="muted">${sun.sunset ? `Today: sunset ${new Date(sun.sunset).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, dusk ${new Date(sun.dusk).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Set a location to use dusk/sunset.'}</span></div></div>
        <div class="card"><div class="row"><h3 style="margin:0">Schedule</h3><span class="spacer"></span><button class="btn" id="addSch">Add entry</button><button class="btn primary" id="saveSch">Save</button></div>
          <p class="dim">Entries higher in the list win when they overlap. An end time before the start runs past midnight.</p>
          <div class="table-wrap"><table><thead><tr><th>On</th><th>What</th><th>Days</th><th>Start</th><th>End</th><th>Dates</th><th></th></tr></thead><tbody>
          ${entries.map((e, i) => `<tr data-i="${i}">
            <td><input type="checkbox" data-f="enabled" ${e.enabled ? 'checked' : ''}></td>
            <td><select data-f="type"><option value="playlist" ${e.type === 'playlist' ? 'selected' : ''}>Playlist</option><option value="command" ${e.type === 'command' ? 'selected' : ''}>Command</option></select>
              ${e.type === 'command' ? `<input data-f="command" value="${esc(e.command)}" placeholder="FPP command">` : `<select data-f="playlist">${LIB.playlists.map((n) => `<option ${n === e.playlist ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
              <label class="inline"><input type="checkbox" data-f="repeat" ${e.repeat ? 'checked' : ''}> repeat</label>`}</td>
            <td>${DAYS.map((d, k) => `<label class="inline" style="display:inline-flex;gap:3px"><input type="checkbox" data-day="${k}" ${e.days.includes(k) ? 'checked' : ''}>${d}</label>`).join(' ')}</td>
            <td>${timeField(e.startTime, 'startTime')} <input type="number" data-f="startOffset" value="${e.startOffset}" title="offset minutes" style="width:70px"></td>
            <td>${e.type === 'command' ? '<span class="dim">—</span>' : `${timeField(e.endTime, 'endTime')} <input type="number" data-f="endOffset" value="${e.endOffset}" title="offset minutes" style="width:70px">
              <select data-f="stopType"><option value="graceful" ${e.stopType === 'graceful' ? 'selected' : ''}>finish song</option><option value="hard" ${e.stopType === 'hard' ? 'selected' : ''}>stop now</option></select>`}</td>
            <td><input type="date" data-f="startDate" value="${esc(e.startDate)}"> <input type="date" data-f="endDate" value="${esc(e.endDate)}"></td>
            <td><button class="btn small" data-mv="-1">↑</button><button class="btn small" data-mv="1">↓</button><button class="btn small danger" data-rm>✕</button></td>
          </tr>`).join('') || '<tr><td colspan="7" class="dim">No entries.</td></tr>'}
          </tbody></table></div></div>
        <div class="card"><h3>Next 7 days</h3>${upcoming.length ? `<table><tbody>${upcoming.map((u) => `<tr><td>${new Date(u.start).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td><td>${u.type === 'command' ? `run ${esc(u.command)}` : `${esc(u.playlist)} until ${new Date(u.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}</td></tr>`).join('')}</tbody></table>` : '<p class="dim">Nothing scheduled.</p>'}</div>`;
      $('#saveLoc').onclick = guard(async () => { await saveConfig({ location: { latitude: $('#lat').value === '' ? null : +$('#lat').value, longitude: $('#lon').value === '' ? null : +$('#lon').value } }); PAGES.schedule(el); });
      $('#addSch').onclick = () => { entries.push({ enabled: true, type: 'playlist', playlist: LIB.playlists[0] || '', repeat: true, days: [0, 1, 2, 3, 4, 5, 6], startTime: 'dusk', startOffset: 0, endTime: '22:00', endOffset: 0, stopType: 'graceful', startDate: '', endDate: '', args: [] }); render(); };
      $$('tr[data-i]', el).forEach((tr) => {
        const e = entries[+tr.dataset.i];
        $$('[data-f]', tr).forEach((inp) => inp.addEventListener('change', () => {
          const f = inp.dataset.f;
          if (f.endsWith('Kind')) { const k = f.slice(0, -4); e[k] = inp.value === 'time' ? '17:00' : inp.value; render(); return; }
          if (inp.type === 'checkbox') e[f] = inp.checked;
          else if (inp.type === 'number') e[f] = +inp.value;
          else e[f] = inp.value;
          if (f === 'type') render();
        }));
        $$('[data-day]', tr).forEach((cb) => cb.addEventListener('change', () => { e.days = $$('[data-day]', tr).filter((c) => c.checked).map((c) => +c.dataset.day); }));
        $('[data-rm]', tr).onclick = () => { entries.splice(+tr.dataset.i, 1); render(); };
        $$('[data-mv]', tr).forEach((b) => (b.onclick = () => { const i = +tr.dataset.i, j = i + +b.dataset.mv; if (j < 0 || j >= entries.length) return; [entries[i], entries[j]] = [entries[j], entries[i]]; render(); }));
      });
      $('#saveSch').onclick = guard(async () => { ({ entries, upcoming } = await api('PUT', P('/schedule'), { entries })); toast('Schedule saved'); render(); });
    };
    render();
  };

  // ---------------------------------------------------------------- outputs
  PAGES.outputs = async (el) => {
    await loadConfig();
    let outs = clone(CONFIG.outputs || []);
    const render = () => {
      el.innerHTML = `
        <div class="card"><h3>Timing</h3><div class="row">
          <label>Lights offset (ms) <input type="number" id="offset" value="${CONFIG.syncOffsetMs}"></label>
          <label class="inline"><input type="checkbox" id="blank" ${CONFIG.blankBetweenSequences ? 'checked' : ''}> Blank lights between sequences</label>
          <button class="btn" id="saveTiming">Save</button></div>
          <p class="dim">Positive shows the lights earlier than the audio. Use it for fixed latency in your audio chain (receiver, FM transmitter); a gap that grows during a song is a bug, not something to tune here.</p></div>
        <div class="card"><div class="row"><h3 style="margin:0">Controllers</h3><span class="spacer"></span>
          <button class="btn" data-add="ddp">Add DDP</button><button class="btn" data-add="e131">Add E1.31</button><button class="btn primary" id="saveOuts">Save</button></div>
          <div class="table-wrap"><table><thead><tr><th>On</th><th>Type</th><th>Description</th><th>IP / multicast</th><th>Start ch</th><th>Channels / universes</th><th></th></tr></thead><tbody>
          ${outs.map((o, i) => `<tr data-i="${i}">
            <td><input type="checkbox" data-f="enabled" ${o.enabled !== false ? 'checked' : ''}></td>
            <td>${o.type === 'ddp' ? 'DDP' : 'E1.31'}</td>
            <td><input data-f="description" value="${esc(o.description || '')}" placeholder="e.g. Roofline controller"></td>
            <td>${o.type === 'e131' ? `<label class="inline"><input type="checkbox" data-f="multicast" ${o.multicast !== false ? 'checked' : ''}> multicast</label>` : ''}<input data-f="ip" value="${esc(o.ip || '')}" placeholder="192.168.x.x" ${o.type === 'e131' && o.multicast !== false ? 'hidden' : ''}></td>
            <td><input type="number" data-f="startChannel" min="1" value="${o.startChannel || 1}"></td>
            <td>${o.type === 'ddp' ? `<input type="number" data-f="channelCount" min="1" value="${o.channelCount || 512}"> ch
              <label class="inline"><input type="checkbox" data-f="ddpOneBased" ${o.ddpOneBased ? 'checked' : ''}> one-based</label>`
              : `univ <input type="number" data-f="universe" min="1" value="${o.universe || 1}" style="width:80px"> × <input type="number" data-f="universeCount" min="1" value="${o.universeCount || 1}" style="width:70px"> of <input type="number" data-f="universeSize" min="1" max="512" value="${o.universeSize || 512}" style="width:80px">`}</td>
            <td><button class="btn small danger" data-rm>✕</button></td></tr>`).join('') || '<tr><td colspan="7" class="dim">No outputs yet. Add the controllers this player should drive.</td></tr>'}
          </tbody></table></div>
          <p class="dim">Packets match FPP's byte for byte (DDP on port 4048 with PUSH on each controller's last packet; E1.31 on 5568).</p></div>
        <div class="card"><h3>Test patterns</h3><p class="muted">Runs only while the show is stopped.</p>
          <div class="row"><button class="btn" data-test="rgbcycle">RGB cycle</button><button class="btn" data-test="chase">Chase</button>
          <button class="btn" data-test="solid" data-color="255,255,255">White</button><button class="btn" data-test="solid" data-color="255,0,0">Red</button>
          <button class="btn" data-test="solid" data-color="0,255,0">Green</button><button class="btn" data-test="solid" data-color="0,0,255">Blue</button>
          <button class="btn primary" data-test="">Off</button></div></div>`;
      $('#saveTiming').onclick = guard(() => saveConfig({ syncOffsetMs: +$('#offset').value || 0, blankBetweenSequences: $('#blank').checked }));
      $$('[data-add]', el).forEach((b) => (b.onclick = () => {
        const last = outs[outs.length - 1];
        outs.push(b.dataset.add === 'ddp' ? { type: 'ddp', enabled: true, ip: '', startChannel: 1, channelCount: 512 } : { type: 'e131', enabled: true, multicast: true, universe: last && last.type === 'e131' ? (last.universe || 1) + (last.universeCount || 1) : 1, universeCount: 1, universeSize: 512, startChannel: 1 });
        render();
      }));
      $$('tr[data-i]', el).forEach((tr) => {
        const o = outs[+tr.dataset.i];
        $$('[data-f]', tr).forEach((inp) => inp.addEventListener('change', () => {
          const f = inp.dataset.f;
          o[f] = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? +inp.value : inp.value.trim();
          if (f === 'multicast') render();
        }));
        $('[data-rm]', tr).onclick = () => { outs.splice(+tr.dataset.i, 1); render(); };
      });
      $('#saveOuts').onclick = guard(async () => { await saveConfig({ outputs: outs }, 'Outputs saved'); outs = clone(CONFIG.outputs); render(); });
      $$('[data-test]', el).forEach((b) => (b.onclick = guard(() => api('POST', P('/test'), { pattern: b.dataset.test || null, color: b.dataset.color ? b.dataset.color.split(',').map(Number) : undefined }))));
    };
    render();
  };

  // ---------------------------------------------------------------- display
  PAGES.display = async (el) => {
    await loadConfig();
    const m = CONFIG.matrix;
    el.innerHTML = `
      <div class="card"><h3>Video</h3>
        <label class="inline"><input type="checkbox" id="vidOn" ${CONFIG.video.enabled ? 'checked' : ''}> Play a playlist item's video on HDMI</label>
        <p class="dim">Video follows the audio clock (speed nudges for small drift, exact seek for large). When MultiSync is on, FPP remotes get the media sync packets and play the same video.</p></div>
      <div class="card"><h3>Virtual matrix</h3>
        <label class="inline"><input type="checkbox" id="mOn" ${m.enabled ? 'checked' : ''}> Show a channel range as a matrix on HDMI</label>
        <div class="fields" style="margin-top:12px">
          <label>Start channel <input type="number" id="mStart" min="1" value="${m.startChannel}"></label>
          <label>Width (pixels) <input type="number" id="mW" min="1" value="${m.width}"></label>
          <label>Height (pixels) <input type="number" id="mH" min="1" value="${m.height}"></label>
          <label>Color order <select id="mOrder">${['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR'].map((o) => `<option ${o === m.colorOrder ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
          <label>Start corner <select id="mCorner">${[['TL', 'Top left'], ['TR', 'Top right'], ['BL', 'Bottom left'], ['BR', 'Bottom right']].map(([v, t]) => `<option value="${v}" ${v === m.startCorner ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label>Strings run <select id="mOrient"><option value="horizontal" ${m.orientation === 'horizontal' ? 'selected' : ''}>Horizontally</option><option value="vertical" ${m.orientation === 'vertical' ? 'selected' : ''}>Vertically</option></select></label>
        </div>
        <div class="row" style="margin-top:12px">
          <label class="inline"><input type="checkbox" id="mSerp" ${m.serpentine ? 'checked' : ''}> Zig-zag (serpentine)</label>
          <label class="inline"><input type="checkbox" id="mPrefer" ${m.preferVideo ? 'checked' : ''}> Prefer a matching video in videos/ (same name as the sequence)</label></div>
        <p class="dim">Matches an xLights matrix model's layout. A real video is sharper than rendered pixels, so it wins when one is found. Matrix and display changes apply after a restart (System page).</p>
        <button class="btn primary" id="saveDisp">Save</button></div>`;
    $('#saveDisp').onclick = guard(() => saveConfig({
      video: { enabled: $('#vidOn').checked },
      matrix: { enabled: $('#mOn').checked, startChannel: +$('#mStart').value, width: +$('#mW').value, height: +$('#mH').value, colorOrder: $('#mOrder').value,
        startCorner: $('#mCorner').value, orientation: $('#mOrient').value, serpentine: $('#mSerp').checked, preferVideo: $('#mPrefer').checked },
    }));
  };

  // ---------------------------------------------------------------- multisync
  PAGES.multisync = async (el) => {
    await loadConfig();
    const ms = CONFIG.multisync;
    const data = await api('GET', P('/multisync'));
    el.innerHTML = `
      <div class="card"><h3>Role</h3>
        <div class="row"><label>Mode <select id="mode"><option value="player" ${CONFIG.mode !== 'remote' ? 'selected' : ''}>Player (runs the show)</option><option value="remote" ${CONFIG.mode === 'remote' ? 'selected' : ''}>Remote (follows a master)</option></select></label></div>
        <div id="playerOpts" ${CONFIG.mode === 'remote' ? 'hidden' : ''} style="margin-top:12px">
          <label class="inline"><input type="checkbox" id="send" ${ms.enabled ? 'checked' : ''}> Send MultiSync to remotes (FPP or ShowPilot Player)</label>
          <div class="row" style="margin-top:8px"><label class="inline"><input type="checkbox" id="mcast" ${ms.multicast !== false ? 'checked' : ''}> Multicast</label>
          <label class="inline"><input type="checkbox" id="bcast" ${ms.broadcast ? 'checked' : ''}> Broadcast</label>
          <label style="flex:1">Extra unicast remotes (comma separated) <input id="remotes" value="${esc((ms.remotes || []).join(', '))}"></label></div></div>
        <div id="remoteOpts" ${CONFIG.mode === 'remote' ? '' : 'hidden'} style="margin-top:12px">
          <label>Remote offset (ms) <input type="number" id="roff" value="${ms.remoteOffsetMs || 0}"></label>
          <p class="dim">The schedule is paused in remote mode; the master decides what plays.</p></div>
        <div class="row" style="margin-top:12px"><button class="btn primary" id="saveMs">Save</button></div></div>
      <div class="card"><div class="row"><h3 style="margin:0">Systems on the network</h3><span class="spacer"></span><button class="btn" id="disc">Discover</button></div>
        <div class="table-wrap"><table><thead><tr><th>Host</th><th>Address</th><th>Mode</th><th>Version</th><th>Model</th><th>Channels</th></tr></thead><tbody>
        ${data.systems.map((s) => `<tr><td>${esc(s.hostname)}${s.local ? ' <span class="pill">this player</span>' : ''}</td><td>${s.local ? esc(s.address) : `<a href="http://${esc(s.address)}/" target="_blank" rel="noopener">${esc(s.address)}</a>`}</td><td>${esc(s.fppModeString)}${s.multisync ? ' (sending)' : ''}</td><td>${esc(s.version)}</td><td>${esc(s.model)}</td><td class="mono">${esc(s.channelRanges)}</td></tr>`).join('')}
        </tbody></table></div><p class="dim">Packets sent: ${data.stats.sent} · received: ${data.stats.received}</p></div>`;
    $('#mode').onchange = () => { $('#playerOpts').hidden = $('#mode').value === 'remote'; $('#remoteOpts').hidden = $('#mode').value !== 'remote'; };
    $('#saveMs').onclick = guard(() => saveConfig({ mode: $('#mode').value, multisync: { enabled: $('#send').checked, multicast: $('#mcast').checked, broadcast: $('#bcast').checked,
      remotes: $('#remotes').value.split(',').map((x) => x.trim()).filter(Boolean), remoteOffsetMs: +$('#roff').value || 0 } }));
    $('#disc').onclick = guard(async () => { await api('POST', P('/multisync/discover')); toast('Discovery ping sent'); setTimeout(() => PAGES.multisync(el), 2000); });
  };

  // ---------------------------------------------------------------- showpilot
  PAGES.showpilot = async (el) => {
    await loadLib();
    const s = await api('GET', P('/showpilot'));
    const st = s.status;
    el.innerHTML = `
      <div class="grid g2">
        <div class="card"><h3>Connection</h3>
          <label class="inline"><input type="checkbox" id="spOn" ${s.enabled ? 'checked' : ''}> Connect to a ShowPilot server</label>
          <div class="stack" style="margin-top:12px">
            <label>Server URL <input id="spUrl" value="${esc(s.serverUrl)}" placeholder="https://your-showpilot-server"></label>
            <label>Show token <input id="spTok" type="password" placeholder="${st.tokenSet ? '•••••• saved (leave blank to keep)' : 'Paste the token from ShowPilot admin'}"></label>
            <label>Remote playlist (songs viewers can request) <select id="spPl"><option value="">—</option>${LIB.playlists.map((n) => `<option ${n === s.remotePlaylist ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
          </div>
          <div class="row" style="margin-top:12px"><button class="btn primary" id="spSave">Save</button><button class="btn" id="spTest">Test connection</button><button class="btn" id="spSync">Sync playlist to ShowPilot</button></div></div>
        <div class="card"><h3>Status</h3>
          <p><span class="pill ${st.connected ? 'ok' : s.enabled ? 'bad' : ''}">${st.connected ? 'Connected' : s.enabled ? 'Not connected' : 'Off'}</span> ${st.mode ? `Viewer mode: <b>${esc(st.mode)}</b>` : ''}</p>
          ${st.lastError ? `<p class="err">${esc(st.lastError)}</p>` : ''}
          <p class="muted">Last contact: ${st.lastOkAt ? new Date(st.lastOkAt).toLocaleTimeString() : 'never'} · Audio clients: ${st.wsClients} on port ${st.daemonPort || '—'}</p>
          <p class="muted">Queued requests: ${st.pending.length ? st.pending.map(esc).join(', ') : 'none'}</p>
          <p class="muted">Cooling down: ${st.cooldowns.length ? st.cooldowns.map((c) => esc(c.name)).join(', ') : 'none'}</p>
          <div class="row">${['ON', 'OFF', 'VOTING', 'JUKEBOX', 'RACE'].map((m) => `<button class="btn small" data-mode="${m}">${m === 'ON' ? 'Viewer control on' : m === 'OFF' ? 'Off' : m[0] + m.slice(1).toLowerCase()}</button>`).join('')}</div></div>
      </div>
      <div class="card"><h3>Request handling</h3><div class="fields">
        <label class="inline"><input type="checkbox" id="spInt" ${s.interruptSchedule ? 'checked' : ''}> Jukebox requests interrupt the schedule</label>
        <label>Ask for the next request (seconds before song end) <input type="number" id="spFetch" min="1" value="${s.requestFetchTime}"></label>
        <label>Extra wait after queuing (s) <input type="number" id="spWait" min="0" value="${s.additionalWaitTime}"></label>
        <label>Heartbeat (s) <input type="number" id="spHb" min="5" value="${s.heartbeatIntervalSec}"></label>
        <label>Audio daemon port <input type="number" id="spPort" min="1024" max="65535" value="${s.audioDaemonPort}"></label>
        <label class="inline"><input type="checkbox" id="spVerbose" ${s.verboseLogging ? 'checked' : ''}> Verbose log</label></div>
        <p class="dim">Built in: replaces the ShowPilot FPP plugin. Interrupted songs resume exactly where they paused, and phones get the real position, not 0:00.</p></div>`;
    const collect = () => {
      const b = { enabled: $('#spOn').checked, serverUrl: $('#spUrl').value, remotePlaylist: $('#spPl').value, interruptSchedule: $('#spInt').checked,
        requestFetchTime: +$('#spFetch').value || 3, additionalWaitTime: +$('#spWait').value || 0, heartbeatIntervalSec: +$('#spHb').value || 15,
        audioDaemonPort: +$('#spPort').value || 8090, verboseLogging: $('#spVerbose').checked };
      if ($('#spTok').value) b.showToken = $('#spTok').value;
      return b;
    };
    $('#spSave').onclick = guard(async () => { await api('PUT', P('/showpilot'), collect()); toast('Saved'); PAGES.showpilot(el); });
    $('#spTest').onclick = guard(async () => { await api('PUT', P('/showpilot'), collect()); await api('POST', P('/showpilot/test')); toast('ShowPilot answered'); PAGES.showpilot(el); });
    $('#spSync').onclick = guard(async () => { const r = await api('POST', P('/showpilot/sync')); toast(`Synced ${r.synced} songs${r.audio && r.audio.uploaded !== undefined ? `; audio: ${r.audio.uploaded} uploaded, ${r.audio.linked} linked` : ''}`); });
    $$('[data-mode]', el).forEach((b) => (b.onclick = guard(async () => { await api('POST', P('/showpilot/mode'), { mode: b.dataset.mode }); toast(`Viewer mode ${b.dataset.mode}`); PAGES.showpilot(el); })));
  };

  // ---------------------------------------------------------------- plugins
  PAGES.plugins = async (el) => {
    const list = await api('GET', P('/plugins'));
    el.innerHTML = `
      <div class="card"><h3>Installed</h3><div class="table-wrap"><table><thead><tr><th>Plugin</th><th>Pages</th><th>Hooks</th><th></th></tr></thead><tbody>
        ${list.map((p) => `<tr><td><b>${esc(p.displayName)}</b> <span class="dim mono">${esc(p.name)} ${esc(p.version)}</span><br><span class="muted">${esc(p.description)}</span>
          ${p.native ? '<br><span class="pill warn">Has a native fppd part that can\'t run here</span>' : ''}</td>
          <td>${p.pages.map((pg) => `<a href="/plugin.php?plugin=${encodeURIComponent(p.name)}&page=${encodeURIComponent(pg)}">${esc(pg)}</a>`).join('<br>') || '<span class="dim">—</span>'}</td>
          <td class="muted">${esc(p.callbacks.join(', ') || '—')}</td>
          <td class="row end"><button class="btn small" data-up="${esc(p.name)}">Update</button><button class="btn small danger" data-rm="${esc(p.name)}">Uninstall</button></td></tr>`).join('') || '<tr><td colspan="4" class="dim">No plugins installed.</td></tr>'}
      </tbody></table></div></div>
      <div class="card"><h3>Install from GitHub</h3><div class="row"><input id="plUrl" style="flex:1;min-width:240px" placeholder="https://github.com/owner/fpp-plugin"><input id="plBranch" placeholder="branch (optional)" style="width:160px"><button class="btn primary" id="plInstall">Install</button></div>
        <p class="dim">Script and PHP plugins work: install scripts, callbacks, settings pages, api.php and plugin commands. Plugins with a native C++ part for fppd install, but that part can't run.</p>
        <pre class="logs mono" id="plLog" hidden></pre></div>
      <div class="card"><div class="row"><h3 style="margin:0">FPP plugin list</h3><span class="spacer"></span><button class="btn" id="plCat">Load list</button></div><div id="catalog"></div></div>`;
    const doInstall = guard(async (url, branch) => {
      $('#plLog').hidden = false; $('#plLog').textContent = `Installing ${url}…`;
      const r = await api('POST', P('/plugins/install'), { url, branch: branch || undefined });
      $('#plLog').textContent = r.log || 'Done';
      toast(`Installed ${r.name}`);
      setTimeout(() => PAGES.plugins(el), 1500);
    });
    $('#plInstall').onclick = () => doInstall($('#plUrl').value.trim(), $('#plBranch').value.trim());
    $$('[data-up]', el).forEach((b) => (b.onclick = guard(async () => { b.disabled = true; const r = await api('POST', P(`/plugins/${encodeURIComponent(b.dataset.up)}/update`)); toast(`Updated ${r.name}`); PAGES.plugins(el); })));
    $$('[data-rm]', el).forEach((b) => (b.onclick = guard(async () => { if (!confirm(`Uninstall ${b.dataset.rm}?`)) return; await api('DELETE', P(`/plugins/${encodeURIComponent(b.dataset.rm)}`)); toast('Uninstalled'); PAGES.plugins(el); })));
    $('#plCat').onclick = guard(async () => {
      $('#catalog').innerHTML = '<p class="muted">Loading…</p>';
      const cat = await api('GET', P('/plugins/catalog'));
      const have = new Set(list.map((p) => p.name.toLowerCase()));
      $('#catalog').innerHTML = `<table><tbody>${cat.map((c) => `<tr><td>${esc(c.name)}</td><td class="row end">${c.builtIn ? '<span class="pill ok">Built in</span>' : have.has(c.name.toLowerCase()) ? '<span class="pill">Installed</span>' : `<button class="btn small" data-cat="${esc(c.infoURL)}">Install</button>`}</td></tr>`).join('')}</tbody></table>`;
      $$('[data-cat]', el).forEach((b) => (b.onclick = () => doInstall(b.dataset.cat)));
    });
  };

  // ---------------------------------------------------------------- system
  PAGES.system = async (el) => {
    await loadConfig();
    const [devices, auth, tz] = await Promise.all([api('GET', P('/audio-devices')).catch(() => []), api('GET', P('/auth')), api('GET', P('/timezone')).catch(() => ({ current: '', zones: [] }))]);
    el.innerHTML = `
      <div class="grid g2">
        <div class="card"><h3>Player</h3><div class="stack">
          <label>Name on the network <input id="host" value="${esc(CONFIG.hostName)}"></label>
          <label>Description <input id="desc" value="${esc(CONFIG.hostDescription)}"></label>
          <label>Audio output <select id="adev"><option value="auto">Automatic</option>${devices.map((d) => `<option value="${esc(d.id)}" ${d.id === CONFIG.audioDevice ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
          <label>Timezone (schedules use local time) <select id="tz">${tz.zones.map((z) => `<option ${z === tz.current ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></label>
          <p class="dim">There is no volume control on purpose: set the level once at your amplifier or transmitter.</p>
          <button class="btn primary" id="saveSys">Save</button></div></div>
        <div class="card"><h3>Admin password</h3><p class="muted">${auth.required ? 'The admin pages need a password.' : 'No password set: anyone on this network can use the admin pages.'}</p>
          <div class="row"><input type="password" id="pw" placeholder="New password (6+ characters)" autocomplete="new-password"><button class="btn" id="setPw">Set</button>${auth.required ? '<button class="btn danger" id="clrPw">Remove</button><button class="btn" id="logout">Sign out</button>' : ''}</div>
          <p class="dim">xLights and FPP plugins use the FPP-compatible API, which stays open like on FPP.</p></div>
        <div class="card"><h3>Updates</h3><div id="upd" class="muted">Checking…</div></div>
        <div class="card"><h3>Power</h3><div class="row"><button class="btn" data-sys="restart">Restart player</button><button class="btn" data-sys="reboot">Reboot</button><button class="btn danger" data-sys="shutdown">Shut down</button></div>
          <p class="dim">Restart applies audio device, display and matrix changes.</p></div>
      </div>
      <div class="card"><div class="row"><h3 style="margin:0">Log</h3><span class="spacer"></span><button class="btn small" id="refLog">Refresh</button></div><pre class="logs mono" id="log"></pre></div>`;
    $('#saveSys').onclick = guard(async () => {
      if ($('#tz').value && $('#tz').value !== tz.current) await api('PUT', P('/timezone'), { timezone: $('#tz').value });
      await saveConfig({ hostName: $('#host').value.trim(), hostDescription: $('#desc').value, audioDevice: $('#adev').value });
    });
    $('#setPw').onclick = guard(async () => { await api('POST', P('/auth/password'), { password: $('#pw').value }); toast('Password set'); PAGES.system(el); });
    if ($('#clrPw')) $('#clrPw').onclick = guard(async () => { if (!confirm('Remove the admin password?')) return; await api('POST', P('/auth/password'), { password: '' }); toast('Password removed'); PAGES.system(el); });
    if ($('#logout')) $('#logout').onclick = guard(async () => { await api('POST', P('/auth/logout')); location.reload(); });
    $$('[data-sys]', el).forEach((b) => (b.onclick = guard(async () => { if (!confirm(`${b.textContent}?`)) return; await api('POST', P(`/system/${b.dataset.sys}`)); toast(`${b.textContent} requested`); })));
    const loadLog = guard(async () => { const r = await api('GET', P('/logs?n=400')); $('#log').textContent = r.lines.join('\n'); $('#log').scrollTop = 1e9; });
    $('#refLog').onclick = loadLog;
    loadLog();
    const upd = async (force) => {
      try {
        const u = await api('GET', P(`/updates${force ? '?force=1' : ''}`));
        $('#upd').innerHTML = `<p>Installed: <b>${esc(u.current)}</b> · Latest: <b>${esc(u.latest || 'unknown')}</b></p>
          <div class="row">${u.updateAvailable ? '<button class="btn primary" id="doUpd">Install update</button>' : '<span class="pill ok">Up to date</span>'}<button class="btn" id="chk">Check again</button>${u.canRollback ? '<button class="btn" id="rb">Roll back</button>' : ''}</div>`;
        $('#chk').onclick = () => upd(true);
        if ($('#doUpd')) $('#doUpd').onclick = guard(async () => { if (!confirm('Install the update? The show stops while the player restarts.')) return; await api('POST', P('/updates/apply')); toast('Updating; the page reconnects when the player is back'); });
        if ($('#rb')) $('#rb').onclick = guard(async () => { if (!confirm('Go back to the previous version?')) return; await api('POST', P('/updates/rollback')); toast('Rolling back'); });
      } catch (e) { $('#upd').innerHTML = `<p class="err">${esc(e.message)}</p><button class="btn" id="chk">Try again</button>`; $('#chk').onclick = () => upd(true); }
    };
    upd(false);
  };

  // ---------------------------------------------------------------- boot
  pollStatus();
  route();
})();
