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

  // In-page confirm dialog (instead of the browser's confirm()). Resolves
  // true for the confirm button, false for Cancel / Escape / clicking outside.
  function ask(message, { title = 'Are you sure?', ok = 'OK', danger = false } = {}) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const wrap = document.createElement('div');
      wrap.className = 'dlg-wrap';
      wrap.innerHTML = `<div class="dlg card" role="alertdialog" aria-modal="true" aria-labelledby="dlgT" aria-describedby="dlgM">
        <h3 id="dlgT">${esc(title)}</h3><p id="dlgM">${esc(message)}</p>
        <div class="dlg-actions"><button type="button" class="btn" data-a="0">Cancel</button><button type="button" class="btn ${danger ? 'bad' : 'primary'}" data-a="1">${esc(ok)}</button></div></div>`;
      const done = (v) => { document.removeEventListener('keydown', key, true); wrap.remove(); if (prev && prev.focus) prev.focus(); resolve(v); };
      const key = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
        else if (e.key === 'Tab') { // keep focus inside the dialog
          const b = $$('button', wrap); const i = b.indexOf(document.activeElement);
          e.preventDefault(); b[(i + (e.shiftKey ? b.length - 1 : 1)) % b.length].focus();
        }
      };
      wrap.addEventListener('click', (e) => { if (e.target === wrap) done(false); const a = e.target.closest('[data-a]'); if (a) done(a.dataset.a === '1'); });
      document.addEventListener('keydown', key, true);
      document.body.appendChild(wrap);
      $('[data-a="1"]', wrap).focus();
    });
  }

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
      window.dispatchEvent(new Event('spp-signed-in'));
      route();
    } catch (err) { $('#loginErr').textContent = err.message; }
  });

  // Audio preview (Files page); stopped when leaving the page.
  const PREVIEW = { audio: null, name: null };
  function stopPreview() {
    const a = PREVIEW.audio;
    PREVIEW.audio = null; PREVIEW.name = null;
    if (!a) return;
    // Detach first: clearing the source fires an 'error' event on the old
    // element, which must not stop the next preview (0.4.1 bug).
    a.onended = a.onerror = a.ontimeupdate = null;
    try { a.pause(); a.removeAttribute('src'); a.load(); } catch {}
  }

  // ---------------------------------------------------------------- router
  const PAGES = {};
  // Menu: ShowPilot's rail with groups that open into sub-pages. A sub-page
  // is "#page/sub"; pages show only their cards marked data-sub="<sub>".
  const ICON = {
    dashboard: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
    show: 'M4 6h16M4 12h10M4 18h7M17 15v6M14 18h6',
    files: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6',
    lights: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z',
    connect: 'M21 12a9 9 0 0 1-15.4 6.4L3 16M3 12a9 9 0 0 1 15.4-6.4L21 8M21 3v5h-5M3 21v-5h5',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  };
  const NAV = [
    { label: 'Dashboard', icon: 'dashboard', page: 'dashboard' },
    { label: 'Show', icon: 'show', items: [['playlists', '', 'Playlists'], ['schedule', '', 'Schedule'], ['commands', '', 'Commands']] },
    { label: 'Files', icon: 'files', page: 'files' },
    { label: 'Lights', icon: 'lights', items: [['outputs', 'controllers', 'Controllers'], ['outputs', 'timing', 'Timing'], ['outputs', 'test', 'Test patterns'], ['display', '', 'Video & Matrix']] },
    { label: 'Connections', icon: 'connect', items: [['showpilot', '', 'ShowPilot'], ['multisync', '', 'MultiSync'], ['plugins', '', 'Plugins']] },
    { label: 'Settings', icon: 'settings', items: [['system', 'general', 'General'], ['system', 'security', 'Password'], ['system', 'updates', 'Updates'], ['system', 'restore', 'FPP backup'], ['system', 'power', 'Power'], ['system', 'log', 'Log']] },
  ];
  const navSvg = (d, w = 20) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  const hashOf = (page, sub) => '#' + page + (sub ? '/' + sub : '');
  $('#nav').innerHTML = NAV.map((g, gi) => g.page
    ? `<a class="spn-item" href="#${g.page}" data-page="${g.page}" title="${esc(g.label)}">${navSvg(ICON[g.icon])}<span class="spn-label">${esc(g.label)}</span></a>`
    : `<button type="button" class="spn-item" data-group="${gi}" aria-expanded="false" title="${esc(g.label)}">${navSvg(ICON[g.icon])}<span class="spn-label">${esc(g.label)}</span>${'<svg class="spn-chev spn-label" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'}</button>
       <div class="spn-sub" data-sub-of="${gi}">${g.items.map(([pg, sub, l]) => `<a class="spn-subitem" href="${hashOf(pg, sub)}" data-page="${pg}" data-sub="${sub}">${esc(l)}</a>`).join('')}</div>`).join('');
  $$('#nav [data-group]').forEach((b) => (b.onclick = () => {
    const sub = $(`#nav [data-sub-of="${b.dataset.group}"]`);
    const open = !sub.classList.contains('open');
    sub.classList.toggle('open', open);
    b.setAttribute('aria-expanded', String(open));
    // Opening a group in the collapsed rail (or the phone menu) goes to its first page.
    if (open && !sub.querySelector('[aria-current="page"]')) location.hash = sub.querySelector('a').getAttribute('href');
  }));
  // Page/sub → where it sits in the menu (for titles and the highlight).
  const navEntry = (page, sub) => {
    for (const g of NAV) {
      if (g.page === page) return { group: null, label: g.label };
      const it = (g.items || []).find(([pg, sb]) => pg === page && (sb === (sub || '') || (!sub && sb === g.items.find((x) => x[0] === page)[1])));
      if (it) return { group: g.label, label: it[2], sub: it[1] };
    }
    return { group: null, label: page };
  };
  let current = null;
  let SUB = '';
  let pageTimer = null;

  async function route() {
    const [name, subRaw] = (location.hash.slice(1) || 'dashboard').split('/');
    const page = PAGES[name] ? name : 'dashboard';
    // Only pages split into sub-pages in the menu use the part after "/" as a
    // sub-page (Playlists uses it for the open playlist).
    const subs = NAV.flatMap((g) => g.items || []).filter(([pg, sb]) => pg === page && sb).map(([, sb]) => sb);
    SUB = subs.length ? (subs.includes(subRaw) ? subRaw : subs[0]) : '';
    clearInterval(pageTimer); pageTimer = null;
    if (page !== 'files') stopPreview();
    LISTS = {};
    current = page;
    const ent = navEntry(page, SUB);
    $$('#nav [data-page]').forEach((a) => {
      const on = a.dataset.page === page && (a.dataset.sub === undefined || a.dataset.sub === SUB || (!a.dataset.sub && !SUB));
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $$('#nav [data-group]').forEach((b) => {
      const sub = $(`#nav [data-sub-of="${b.dataset.group}"]`);
      const has = !!sub.querySelector('[aria-current="page"]');
      b.classList.toggle('on', has);
      if (has) { sub.classList.add('open'); b.setAttribute('aria-expanded', 'true'); }
    });
    $('#pageTitle').textContent = ent.label;
    $('#pageCrumb').textContent = ent.group || '';
    document.title = `${ent.label} · ShowPilot Player`;
    // Sub-pages: only the cards marked for this sub-page show (kept through re-renders).
    $('#subStyle').textContent = SUB ? `#page [data-sub]:not([data-sub~="${SUB.replace(/[^a-z-]/g, '')}"]) { display: none !important; } #page .grid.g2 { grid-template-columns: minmax(0, 1fr); } #page [data-sub] + [data-sub] { margin-top: 20px; }` : '';
    $('#side').classList.remove('open'); document.body.classList.remove('menu-open');
    const el = $('#page');
    el.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const a = await api('GET', P('/auth'));
      if (!a.loggedIn) { showLogin(); return; }
      await PAGES[page](el);
    } catch (e) { el.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`; }
  }
  window.addEventListener('hashchange', route);
  // Mobile menu: tapping outside it (the dimmed page), Escape or picking a page closes it.
  const setMenu = (open) => { $('#side').classList.toggle('open', open); document.body.classList.toggle('menu-open', open); };
  $('#menuBtn').addEventListener('click', (ev) => { ev.stopPropagation(); setMenu(!$('#side').classList.contains('open')); });
  $('#scrim').addEventListener('click', () => setMenu(false));
  $('#scrim').addEventListener('touchstart', (ev) => { ev.preventDefault(); setMenu(false); }, { passive: false });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') setMenu(false); });
  $('#nav').addEventListener('click', (ev) => {
    const a = ev.target.closest('a');
    if (!a) return;
    setMenu(false);
    if (ev.detail > 0) a.blur(); // a mouse click: let the rail collapse when the pointer leaves
  });
  // A theme choice is saved with the player's settings straight away (before
  // 0.4.3 the System page picker only saved on Save, so a reboot or update
  // brought back the old theme).
  async function setTheme(t) {
    if (window.SPPTheme) SPPTheme.set(t);
    for (const id of ['#themeSelect', '#theme']) { const x = $(id); if (x) x.value = t; }
    const c = await api('PUT', P('/config'), { ui: { theme: t } });
    CONFIG = CONFIG ? { ...CONFIG, ui: c.ui } : c;
  }
  // Theme picker in the top bar, like ShowPilot's admin. Saved with the player's settings.
  if (window.SPPTheme) {
    const ts = $('#themeSelect');
    ts.innerHTML = SPPTheme.list.map(([v, l]) => `<option value="${v}">${esc(l.replace(' (follow this device)', ''))}</option>`).join('');
    ts.value = SPPTheme.current();
    ts.onchange = guard(async () => { await setTheme(ts.value); });
  } else $('#themeSelect').hidden = true;
  // "Keep menu open" (ShowPilot's pinned rail), remembered per browser.
  const setPinned = (on) => {
    document.body.classList.toggle('rail-pinned', on);
    const b = $('#spnPin');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    $('.spn-label', b).textContent = on ? 'Collapse menu' : 'Keep menu open';
    $('path', b).setAttribute('d', on ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6');
    try { localStorage.setItem('spp_rail_pinned', on ? '1' : '0'); } catch {}
  };
  const savePinned = (on) => api('PUT', P('/config'), { ui: { railPinned: on } }).catch(() => {});
  try { if (localStorage.getItem('spp_rail_pinned') === '1') setPinned(true); } catch {}
  $('#spnPin').addEventListener('click', (ev) => { const on = !document.body.classList.contains('rail-pinned'); setPinned(on); savePinned(on); if (ev.detail > 0) ev.currentTarget.blur(); });

  // Top bar status, refreshed everywhere.
  async function pollStatus() {
    try {
      STATUS = await api('GET', P('/status'));
      const p = STATUS.player;
      const live = p.state === 'playing';
      $('#liveDot').classList.toggle('live', live);
      const sp = STATUS.showpilot;
      $('#topStatus').innerHTML = [
        live ? `<span class="spn-chip ok"><i class="dot live"></i><span>${esc(p.sequence || p.media)}</span></span>` : '<span class="spn-chip"><i class="dot"></i><span>Idle</span></span>',
        STATUS.mode === 'remote' ? '<span class="spn-chip warn"><span>Remote mode</span></span>' : '',
        sp.enabled ? `<span class="spn-chip ${sp.connected ? 'ok' : 'bad'}"><span>ShowPilot ${sp.connected ? 'connected' : 'offline'}</span></span>` : '',
      ].join('');
      let banner = $('#problems');
      if (!banner) { banner = document.createElement('div'); banner.id = 'problems'; $('.main').insertBefore(banner, $('#page')); }
      banner.innerHTML = (STATUS.problems || []).map((p) => `<div class="problem">${esc(p)}</div>`).join('');
      $('#sideFoot').innerHTML = `${esc(STATUS.hostName)}<br>${STATUS.ips.map(esc).join(', ')}`;
      $('#brandVersion').textContent = 'v' + STATUS.version;
      // The player was updated while this page was open: offer to load the new version.
      const loadedV = document.documentElement.getAttribute('data-spp-version');
      if (loadedV && STATUS.version && loadedV !== STATUS.version && !$('#updNotice')) {
        const n = document.createElement('div');
        n.id = 'updNotice';
        n.className = 'problem upd-notice';
        n.innerHTML = `<span>ShowPilot Player was updated to v${esc(STATUS.version)}.</span><button class="btn primary small" type="button">Reload</button>`;
        $('button', n).onclick = () => location.reload();
        $('.main').insertBefore(n, $('#problems') || $('#page'));
      }
      if (current === 'dashboard') renderNow();
    } catch {}
  }
  setInterval(pollStatus, 1000);

  // ---------------------------------------------------------------- dashboard
  PAGES.dashboard = async (el) => {
    await loadLib();
    el.innerHTML = `
      <div class="dash-row">
        <section class="card spn-onair" id="nowCard" aria-live="polite"></section>
        <section class="card dash-play">
          <h2>Play</h2>
          <div class="row">
            <select id="dashPl" style="max-width:100%">${LIB.playlists.length || LIB.sequences.length ? '' : '<option value="">Nothing uploaded yet</option>'}
              ${LIB.playlists.length ? `<optgroup label="Playlists">${LIB.playlists.map((n) => `<option value="pl:${esc(n)}">${esc(n)}</option>`).join('')}</optgroup>` : ''}
              ${LIB.sequences.length ? `<optgroup label="Sequences">${LIB.sequences.map((s) => `<option value="seq:${esc(s.name)}">${esc(s.name.replace(/\.fseq$/i, ''))}</option>`).join('')}</optgroup>` : ''}
            </select>
            <label class="inline"><input type="checkbox" id="dashRepeat" checked> Repeat</label>
            <button class="btn primary" id="dashStart">Start</button>
          </div>
          <div class="dash-next"><p class="muted" id="dashNext"></p><p class="muted" id="dashSched"></p></div>
        </section>
      </div>
      <div class="card"><h3>Timing</h3><div class="stats" id="timing"></div>
        <p class="dim" style="margin:10px 0 0">Lights follow the audio clock. "Late" is how far after its due time a frame left; frames are never queued, a late wake-up skips straight to the right frame.</p></div>`;
    $('#dashStart').onclick = guard(async () => {
      const v = $('#dashPl').value; if (!v) return;
      const repeat = $('#dashRepeat').checked;
      let r;
      if (v.startsWith('pl:')) {
        r = await api('POST', P('/play'), { playlist: v.slice(3), repeat });
      } else {
        // A standalone sequence plays with the audio named inside it, if that file is here.
        const s = LIB.sequences.find((x) => x.name === v.slice(4));
        const media = s && s.mediaFilename && [...LIB.music, ...LIB.videos].some((m) => m.name === s.mediaFilename) ? s.mediaFilename : undefined;
        r = await api('POST', P('/play'), { sequence: v.slice(4), media, repeat });
      }
      toast(r && r.finished ? `${v.slice(v.indexOf(':') + 1)} ran and finished (nothing in it plays for long)` : `Playing ${v.slice(v.indexOf(':') + 1)}`);
      pollStatus();
    });
    renderNow();
  };

  function renderNow() {
    const card = $('#nowCard');
    if (!card || !STATUS) return;
    const p = STATUS.player, pl = STATUS.playlist;
    const live = p.state === 'playing';
    const pct = p.durationMs ? Math.min(100, (p.positionMs / p.durationMs) * 100) : 0;
    const where = `${pl.name && !pl.name.startsWith('_') ? `${esc(pl.name)} · ${pl.index} of ${pl.size}` : ''}${pl.breadcrumbs && pl.breadcrumbs.length ? ` · interrupted ${esc(pl.breadcrumbs.join(' › '))}` : ''}`;
    // Built once, then updated in place: replacing the buttons every second
    // (as before 0.4.3) swallowed clicks that landed during a refresh, so Stop
    // now sometimes needed several presses.
    if (!card.dataset.built) {
      card.dataset.built = '1';
      card.innerHTML = `
        <span class="spn-tally" id="nTally"><i></i><b>OFF AIR</b></span>
        <span class="muted" id="nWhere"></span>
        <div><h2 class="spn-title" id="nTitle"></h2><div class="spn-artist" id="nArtist"></div></div>
        <div><div class="spn-track"><div class="spn-fill" id="nFill"></div></div>
        <div class="spn-times"><span id="nPos">0:00</span><span id="nDur">0:00</span></div></div>
        <div class="transport">
          <button class="btn" data-t="prev"><i class="fas fa-backward-step"></i> Prev</button>
          <button class="btn" data-t="pause"><i class="fas fa-pause"></i> <span>Pause</span></button>
          <button class="btn" data-t="next"><i class="fas fa-forward-step"></i> Next</button>
          <button class="btn" data-t="graceful"><span>Stop after song</span></button>
          <button class="btn primary" data-t="stop"><i class="fas fa-stop"></i> Stop now</button>
        </div>`;
      $$('[data-t]', card).forEach((b) => (b.onclick = async () => {
        const t = b.dataset.t;
        if (b.disabled) return;
        b.disabled = true;
        try {
          if (t === 'stop') await api('POST', P('/stop'));
          else if (t === 'graceful') await api('POST', P('/stop'), { graceful: true });
          else await api('POST', P('/' + t));
          if (t === 'stop') toast('Stopped');
        } catch (e) { toast(e.message, true); }
        finally { b.disabled = false; pollStatus(); }
      }));
    }
    const tally = $('#nTally');
    tally.className = `spn-tally ${live ? '' : pl.paused ? 'paused' : 'off'}`;
    $('b', tally).textContent = live ? 'ON AIR' : pl.paused ? 'PAUSED' : 'OFF AIR';
    $('#nWhere').innerHTML = where;
    $('#nWhere').hidden = !where;
    const title = $('#nTitle');
    title.textContent = (p.sequence || p.media || 'Nothing playing').replace(/\.fseq$/i, '');
    title.classList.toggle('idle', !(p.sequence || p.media));
    $('#nArtist').textContent = p.sequence || p.media ? `${p.sequence && p.media ? p.media : ''}${p.video ? ` · video ${p.video}` : ''}` : 'The show is idle.';
    $('#nFill').style.width = pct + '%';
    $('#nPos').textContent = fmt(p.positionMs);
    $('#nDur').textContent = fmt(p.durationMs);
    const pb = $('[data-t="pause"]', card);
    $('span', pb).textContent = pl.paused ? 'Resume' : 'Pause';
    $('i', pb).className = `fas fa-${pl.paused ? 'play' : 'pause'}`;
    $('[data-t="graceful"] span', card).textContent = pl.stopping ? 'Stopping…' : 'Stop after song';
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
      ['Output send', w.outputs && w.outputs.sender ? `${w.outputs.sender.maxSendMs.toFixed(1)} ms${w.outputs.pacingMbps ? ` @ ${w.outputs.pacingMbps} Mbit/s` : ' (unpaced)'}` : '—'],
      ['Output frames dropped', w.outputs ? w.outputs.droppedFrames : 0],
      ['Audio out', p.audioOut || '—'], ['Display', p.display], ['Screen', STATUS.screen ? (STATUS.screen.asleep ? 'off (sleeping)' : STATUS.screen.enabled ? 'on' : 'on (no sleep)') : '—'], ['MultiSync', STATUS.multisync.sending ? 'sending' : STATUS.mode === 'remote' ? `following ${STATUS.multisync.lastMaster || '—'}` : 'off'],
    ].map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
  }

  // ---------------------------------------------------------------- playlists
  // FPP playlist format: leadIn / mainPlaylist / leadOut lists of entries.
  const SECTIONS = [['leadIn', 'Lead-in', 'Plays once at the start'], ['mainPlaylist', 'Main', 'The show; repeats if Repeat is on'], ['leadOut', 'Lead-out', 'Plays once when the show stops gracefully']];
  const ITEM_TYPES = [
    ['both', 'Sequence + audio', 'fa-music'], ['sequence', 'Sequence only', 'fa-lightbulb'], ['media', 'Audio / video', 'fa-film'],
    ['pause', 'Pause', 'fa-pause'], ['command', 'Command', 'fa-terminal'], ['script', 'Script', 'fa-scroll'], ['playlist', 'Playlist', 'fa-list'],
  ];
  const TYPE_OF = Object.fromEntries(ITEM_TYPES.map((t) => [t[0], t]));
  const noExt = (n) => String(n || '').replace(/\.(fseq|mp3|m4a|ogg|wav|flac|mp4|mkv|mov|avi)$/i, '');
  const dur = (sec) => { sec = Math.round(sec || 0); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; };

  PAGES.playlists = async (el) => {
    await Promise.all([loadLib(), loadCmds()]);
    const selName = location.hash.split('/')[1] ? decodeURIComponent(location.hash.split('/')[1]) : null;
    let pl = null;          // playlist being edited
    let openItem = null;    // "section:index" with its editor open
    let saveTimer = null;
    let saveState = '';     // '', 'saving', 'saved', 'error'
    let filter = '';
    let summaries = {};

    const seqInfo = (n) => LIB.sequences.find((s) => s.name === n);
    const mediaFor = (seq) => { const s = seqInfo(seq); return s && s.mediaFilename && [...LIB.music, ...LIB.videos].some((m) => m.name === s.mediaFilename) ? s.mediaFilename : ''; };
    const itemSecs = (e) => {
      if (e.type === 'pause') return Number(e.duration) || 0;
      const s = seqInfo(e.sequenceName);
      if (s && s.durationMs) return s.durationMs / 1000;
      return Number(e.duration) || 0;
    };
    const itemTitle = (e) => {
      if (e.type === 'both' || e.type === 'sequence') return noExt(e.sequenceName) || 'No sequence chosen';
      if (e.type === 'media') return noExt(e.mediaName) || 'No file chosen';
      if (e.type === 'pause') return `Pause ${Number(e.duration) || 0} s`;
      if (e.type === 'command') return cmdSummary(e);
      if (e.type === 'script') return e.scriptName ? `${e.scriptName}${e.scriptArgs ? ' ' + e.scriptArgs : ''}` : 'No script chosen';
      if (e.type === 'playlist') return e.name ? `Playlist: ${e.name}` : 'No playlist chosen';
      return `${e.type} (kept, not played here)`;
    };
    const itemSub = (e) => {
      if (e.type === 'both') return e.mediaName ? `with ${e.mediaName}` : 'no audio chosen';
      if (e.type === 'sequence') return 'lights only';
      return '';
    };
    const totals = (p) => {
      const items = SECTIONS.reduce((a, [k]) => a + (p[k] || []).length, 0);
      const secs = SECTIONS.reduce((a, [k]) => a + (p[k] || []).filter((e) => e.enabled !== 0 && e.enabled !== false).reduce((b, e) => b + itemSecs(e), 0), 0);
      return { items, secs };
    };

    const loadSummaries = async () => {
      const names = LIB.playlists;
      const got = await Promise.all(names.map((n) => api('GET', `/api/playlist/${encodeURIComponent(n)}`).catch(() => null)));
      summaries = {};
      names.forEach((n, i) => { if (got[i]) summaries[n] = totals(got[i]); });
    };

    const save = () => {
      clearTimeout(saveTimer);
      saveState = 'saving'; showSaveState();
      saveTimer = setTimeout(async () => {
        try {
          const saved = await api('POST', `/api/playlist/${encodeURIComponent(pl.name)}`, pl);
          pl.playlistInfo = saved.playlistInfo;
          summaries[pl.name] = totals(pl);
          saveState = 'saved';
        } catch (e) { saveState = 'error'; toast('Could not save: ' + e.message, true); }
        showSaveState(); renderList();
      }, 500);
    };
    const showSaveState = () => {
      const s = $('#plSaveState');
      if (!s) return;
      s.className = 'save-state ' + saveState;
      s.textContent = saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'All changes saved' : saveState === 'error' ? 'Not saved' : '';
    };

    const renderList = () => {
      const box = $('#plList');
      if (!box) return;
      const playing = STATUS && STATUS.playlist && STATUS.playlist.name;
      const names = LIB.playlists.filter((n) => !filter || n.toLowerCase().includes(filter.toLowerCase()));
      box.innerHTML = names.map((n) => {
        const s = summaries[n];
        return `<a class="pl-item ${pl && pl.name === n ? 'on' : ''}" href="#playlists/${encodeURIComponent(n)}">
          <span class="pl-name">${esc(n)}</span>
          <span class="pl-meta">${s ? `${s.items} item${s.items === 1 ? '' : 's'} · ${dur(s.secs)}` : ''}${playing === n ? ' <span class="pill ok">Playing</span>' : ''}</span></a>`;
      }).join('') || `<p class="dim" style="padding:8px 4px">${LIB.playlists.length ? 'No match.' : 'No playlists yet.'}</p>`;
    };

    const itemEditor = (e, sec, i) => {
      const seqOpts = (v) => `<option value="">Choose a sequence…</option>${LIB.sequences.map((s) => `<option value="${esc(s.name)}" ${s.name === v ? 'selected' : ''}>${esc(noExt(s.name))}</option>`).join('')}${v && !seqInfo(v) ? `<option selected>${esc(v)}</option>` : ''}`;
      const media = [...LIB.music.map((m) => m.name), ...LIB.videos.map((m) => m.name)];
      const mediaOpts = (v) => `<option value="">${e.type === 'both' ? 'No audio' : 'Choose a file…'}</option>${media.map((m) => `<option ${m === v ? 'selected' : ''}>${esc(m)}</option>`).join('')}${v && !media.includes(v) ? `<option selected>${esc(v)}</option>` : ''}`;
      let fields = '';
      if (e.type === 'both' || e.type === 'sequence') fields += `<label>Sequence <select data-f="sequenceName">${seqOpts(e.sequenceName)}</select></label>`;
      if (e.type === 'both' || e.type === 'media') fields += `<label>${e.type === 'both' ? 'Audio' : 'Audio or video file'} <select data-f="mediaName">${mediaOpts(e.mediaName)}</select></label>`;
      if (e.type === 'pause') fields += `<label>Seconds <input type="number" min="0" step="0.5" data-f="duration" value="${esc(e.duration ?? 5)}"></label>`;
      if (e.type === 'script') fields += `<label>Script <select data-f="scriptName"><option value="">Choose a script…</option>${LIB.scripts.map((s) => `<option ${s === e.scriptName ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
        <label>Arguments <input data-f="scriptArgs" value="${esc(e.scriptArgs || '')}"></label>`;
      if (e.type === 'playlist') fields += `<label>Playlist <select data-f="name"><option value="">Choose…</option>${LIB.playlists.filter((n) => n !== pl.name).map((n) => `<option ${n === e.name ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>`;
      return `<div class="item-edit" data-sec="${sec}" data-i="${i}">
        <div class="seg seg-wrap">${ITEM_TYPES.map(([t, l, ic]) => `<button type="button" data-type="${t}" class="${e.type === t ? 'on' : ''}"><i class="fas ${ic}"></i> ${l}</button>`).join('')}</div>
        ${e.type === 'command' ? '<div class="cmd-form" id="plCmdForm"></div>' : `<div class="fields">${fields}</div>`}
        <div class="row end"><button class="btn small" data-close>Done</button></div></div>`;
    };

    const itemRow = (e, sec, i) => {
      const on = e.enabled !== 0 && e.enabled !== false;
      const t = TYPE_OF[e.type] || [e.type, e.type, 'fa-question'];
      const key = `${sec}:${i}`;
      const missing = ((e.type === 'both' || e.type === 'sequence') && e.sequenceName && !seqInfo(e.sequenceName)) ||
        ((e.type === 'media' || (e.type === 'both' && e.mediaName)) && e.mediaName && ![...LIB.music, ...LIB.videos].some((m) => m.name === e.mediaName));
      return `<div class="pl-row ${on ? '' : 'off'} ${openItem === key ? 'open' : ''}" data-sec="${sec}" data-i="${i}" draggable="true">
        <span class="drag" title="Drag to move"><i class="fas fa-grip-vertical"></i></span>
        <span class="num">${i + 1}</span>
        <span class="ticon t-${esc(e.type)}" title="${esc(t[1])}"><i class="fas ${t[2]}"></i></span>
        <span class="pl-main" data-open><span class="pl-title">${esc(itemTitle(e))}</span>
          <span class="pl-sub">${esc(itemSub(e))}${missing ? ' <span class="pill warn">File missing</span>' : ''}</span></span>
        <span class="pl-dur">${itemSecs(e) ? dur(itemSecs(e)) : ''}</span>
        <label class="switch small" title="${on ? 'Plays' : 'Skipped'}"><input type="checkbox" data-on ${on ? 'checked' : ''}><span></span></label>
        <span class="pl-acts">
          <button class="icon-btn2" data-mv="-1" title="Move up" ${i ? '' : 'disabled'}><i class="fas fa-arrow-up"></i></button>
          <button class="icon-btn2" data-mv="1" title="Move down" ${i < pl[sec].length - 1 ? '' : 'disabled'}><i class="fas fa-arrow-down"></i></button>
          <button class="icon-btn2" data-open title="Edit"><i class="fas fa-pen"></i></button>
          <button class="icon-btn2" data-dup title="Duplicate"><i class="fas fa-clone"></i></button>
          <button class="icon-btn2 danger" data-del title="Remove"><i class="fas fa-trash"></i></button></span>
      </div>${openItem === key ? itemEditor(e, sec, i) : ''}`;
    };

    const renderEditor = () => {
      const box = $('#plEditor');
      if (!pl) {
        box.innerHTML = `<div class="empty big"><i class="fas fa-list-ol"></i><p>${LIB.playlists.length ? 'Pick a playlist to edit, or create a new one.' : 'Create your first playlist.'}</p>
          <p class="dim">A playlist plays its lead-in once, then the main items (repeating if you like), then the lead-out when the show stops.</p></div>`;
        return;
      }
      const t = totals(pl);
      box.innerHTML = `
        <div class="pl-head">
          <div><h2>${esc(pl.name)}</h2><div class="muted">${t.items} item${t.items === 1 ? '' : 's'} · ${dur(t.secs)}${pl.mainPlaylist.length && pl.repeat ? ' per loop' : ''} <span id="plSaveState" class="save-state"></span></div></div>
          <span class="spacer"></span>
          <button class="btn primary" id="plPlay"><i class="fas fa-play"></i> Play</button>
          <div class="menu-wrap"><button class="btn" id="plMore" aria-label="More"><i class="fas fa-ellipsis"></i></button>
            <div class="menu" id="plMenu" hidden><button data-m="dup"><i class="fas fa-clone"></i> Duplicate playlist</button><button data-m="del" class="danger"><i class="fas fa-trash"></i> Delete playlist</button></div></div>
        </div>
        <div class="pl-opts">
          <label class="inline"><span class="switch"><input type="checkbox" id="plRepeat" ${pl.repeat ? 'checked' : ''}><span></span></span> Repeat main</label>
          <label class="inline" title="Play the main items in a new random order on every loop"><span class="switch"><input type="checkbox" id="plRandom" ${pl.random ? 'checked' : ''}><span></span></span> Shuffle each loop</label>
          <label class="inline" ${pl.repeat ? 'hidden' : ''}>Play main <input type="number" id="plLoops" min="1" max="999" value="${Math.max(1, pl.loopCount || 1)}" style="width:70px"> time(s)</label>
        </div>
        ${SECTIONS.map(([k, title, hint]) => `
          <div class="pl-sec" data-section="${k}">
            <div class="pl-sec-head"><b>${title}</b> <span class="dim">${hint}</span><span class="spacer"></span>
              ${k === 'mainPlaylist' && pl.mainPlaylist.length > 1 ? '<button class="btn small" id="plShuffleNow" title="Put the main items in a new random order now (saved)"><i class="fas fa-shuffle"></i> Randomize order</button>' : ''}
              ${k === 'mainPlaylist' && LIB.sequences.length ? '<button class="btn small" id="plFill"><i class="fas fa-wand-magic-sparkles"></i> Add all sequences</button>' : ''}
              <button class="btn small" data-add="${k}"><i class="fas fa-plus"></i> Add</button></div>
            <div class="pl-rows" data-drop="${k}">${pl[k].map((e, i) => itemRow(e, k, i)).join('') || `<div class="pl-empty" data-drop-empty="${k}">${k === 'mainPlaylist' ? 'Add sequences here.' : 'Empty'}</div>`}</div>
          </div>`).join('')}`;
      showSaveState();
      wire();
    };

    // "Add" picker: sequences with search, and the other item kinds.
    const openAdd = (sec, btn) => {
      $$('.add-pop').forEach((x) => x.remove());
      const pop = document.createElement('div');
      pop.className = 'add-pop card';
      pop.innerHTML = `<input placeholder="Search sequences…" id="addQ">
        <div class="add-list" id="addList"></div>
        <div class="add-other">${ITEM_TYPES.filter(([t]) => !['both', 'sequence'].includes(t)).map(([t, l, ic]) => `<button class="btn small" data-kind="${t}"><i class="fas ${ic}"></i> ${l}</button>`).join('')}</div>`;
      btn.closest('.pl-sec-head').after(pop);
      const draw = () => {
        const q = $('#addQ', pop).value.toLowerCase();
        const seqs = LIB.sequences.filter((s) => !q || s.name.toLowerCase().includes(q));
        $('#addList', pop).innerHTML = seqs.map((s) => `<button class="add-seq" data-seq="${esc(s.name)}"><span>${esc(noExt(s.name))}</span><span class="dim">${mediaFor(s.name) ? '<i class="fas fa-music"></i> ' : ''}${s.durationMs ? dur(s.durationMs / 1000) : ''}</span></button>`).join('') || '<p class="dim">No sequences. Upload them on Files or with xLights FPP Connect.</p>';
        $$('[data-seq]', pop).forEach((b) => (b.onclick = () => {
          const m = mediaFor(b.dataset.seq);
          pl[sec].push(m ? { type: 'both', enabled: 1, playOnce: 0, sequenceName: b.dataset.seq, mediaName: m } : { type: 'sequence', enabled: 1, playOnce: 0, sequenceName: b.dataset.seq });
          save(); renderEditor(); toast(`Added ${noExt(b.dataset.seq)}`);
        }));
      };
      $('#addQ', pop).oninput = draw;
      draw();
      $$('[data-kind]', pop).forEach((b) => (b.onclick = () => {
        const t = b.dataset.kind;
        pl[sec].push(t === 'pause' ? { type: 'pause', enabled: 1, duration: 5 } : t === 'command' ? { type: 'command', enabled: 1, command: '', args: [] } : { type: t, enabled: 1 });
        openItem = `${sec}:${pl[sec].length - 1}`;
        renderEditor();
      }));
      $('#addQ', pop).focus();
      setTimeout(() => document.addEventListener('click', function close(ev) { if (!pop.contains(ev.target) && ev.target !== btn) { pop.remove(); document.removeEventListener('click', close); } }), 0);
    };

    let drag = null;
    const wire = () => {
      const box = $('#plEditor');
      $('#plPlay').onclick = guard(async () => { const r = await api('POST', P('/play'), { playlist: pl.name, repeat: !!pl.repeat }); toast(r && r.finished ? `${pl.name} ran and finished` : `Playing ${pl.name}`); });
      $('#plMore').onclick = (ev) => { ev.stopPropagation(); $('#plMenu').hidden = !$('#plMenu').hidden; };
      document.addEventListener('click', () => { if ($('#plMenu')) $('#plMenu').hidden = true; }, { once: true });
      $$('#plMenu [data-m]').forEach((b) => (b.onclick = guard(async () => {
        if (b.dataset.m === 'del') {
          if (!(await ask(`Schedule entries that use "${pl.name}" will stop working.`, { title: 'Delete playlist?', ok: 'Delete', danger: true }))) return;
          await api('DELETE', `/api/playlist/${encodeURIComponent(pl.name)}`);
          toast('Playlist deleted'); location.hash = '#playlists';
        } else {
          let n = `${pl.name} copy`, k = 2;
          while (LIB.playlists.includes(n)) n = `${pl.name} copy ${k++}`;
          await api('POST', `/api/playlist/${encodeURIComponent(n)}`, { ...clone(pl), name: n });
          toast(`Created ${n}`); location.hash = `#playlists/${encodeURIComponent(n)}`;
        }
      })));
      $('#plRepeat').onchange = (ev) => { pl.repeat = ev.target.checked ? 1 : 0; save(); renderEditor(); };
      $('#plRandom').onchange = (ev) => { pl.random = ev.target.checked ? 1 : 0; save(); };
      $('#plLoops').onchange = (ev) => { pl.loopCount = Math.max(1, +ev.target.value || 1); save(); };
      // One-off reorder of Main (unlike the Shuffle switch, which reshuffles every loop while playing).
      if ($('#plShuffleNow')) $('#plShuffleNow').onclick = () => {
        const list = pl.mainPlaylist;
        const before = list.map((e) => JSON.stringify(e)).join('|');
        for (let tries = 0; tries < 5; tries++) {
          for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
          if (list.map((e) => JSON.stringify(e)).join('|') !== before) break; // make sure the order visibly changes
        }
        openItem = null; save(); renderEditor(); toast('Main order randomized');
      };
      if ($('#plFill')) $('#plFill').onclick = () => {
        const have = new Set(pl.mainPlaylist.map((e) => e.sequenceName));
        let n = 0;
        for (const s of LIB.sequences) {
          if (have.has(s.name)) continue;
          const m = mediaFor(s.name);
          pl.mainPlaylist.push(m ? { type: 'both', enabled: 1, playOnce: 0, sequenceName: s.name, mediaName: m } : { type: 'sequence', enabled: 1, playOnce: 0, sequenceName: s.name });
          n++;
        }
        toast(n ? `Added ${n} sequence${n === 1 ? '' : 's'}` : 'Every sequence is already in Main');
        if (n) { save(); renderEditor(); }
      };
      $$('[data-add]', box).forEach((b) => (b.onclick = (ev) => { ev.stopPropagation(); openAdd(b.dataset.add, b); }));
      $$('.pl-row', box).forEach((row) => {
        const sec = row.dataset.sec, i = +row.dataset.i, e = pl[sec][i];
        $('[data-on]', row).onchange = (ev) => { e.enabled = ev.target.checked ? 1 : 0; row.classList.toggle('off', !ev.target.checked); save(); };
        $$('[data-open]', row).forEach((b) => (b.onclick = () => { openItem = openItem === `${sec}:${i}` ? null : `${sec}:${i}`; renderEditor(); }));
        $('[data-del]', row).onclick = () => { pl[sec].splice(i, 1); openItem = null; save(); renderEditor(); };
        $('[data-dup]', row).onclick = () => { pl[sec].splice(i + 1, 0, clone(e)); save(); renderEditor(); };
        $$('[data-mv]', row).forEach((b) => (b.onclick = () => { const j = i + +b.dataset.mv; if (j < 0 || j >= pl[sec].length) return; [pl[sec][i], pl[sec][j]] = [pl[sec][j], pl[sec][i]]; openItem = null; save(); renderEditor(); }));
        row.addEventListener('dragstart', (ev) => { drag = { sec, i }; row.classList.add('dragging'); ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', 'x'); } catch {} });
        row.addEventListener('dragend', () => { drag = null; row.classList.remove('dragging'); $$('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after')); });
        row.addEventListener('dragover', (ev) => { if (!drag) return; ev.preventDefault(); const r = row.getBoundingClientRect(); const after = ev.clientY > r.top + r.height / 2; row.classList.toggle('drop-after', after); row.classList.toggle('drop-before', !after); });
        row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
        row.addEventListener('drop', (ev) => {
          ev.preventDefault(); if (!drag) return;
          const after = row.classList.contains('drop-after');
          const [moved] = pl[drag.sec].splice(drag.i, 1);
          let at = i + (after ? 1 : 0);
          if (drag.sec === sec && drag.i < at) at--;
          pl[sec].splice(at, 0, moved);
          openItem = null; save(); renderEditor();
        });
      });
      $$('[data-drop-empty]', box).forEach((z) => {
        z.addEventListener('dragover', (ev) => { if (drag) { ev.preventDefault(); z.classList.add('over'); } });
        z.addEventListener('dragleave', () => z.classList.remove('over'));
        z.addEventListener('drop', (ev) => { ev.preventDefault(); if (!drag) return; const [moved] = pl[drag.sec].splice(drag.i, 1); pl[z.dataset.dropEmpty].push(moved); save(); renderEditor(); });
      });
      const ed = $('.item-edit', box);
      if (ed) {
        const sec = ed.dataset.sec, i = +ed.dataset.i, e = pl[sec][i];
        $$('[data-type]', ed).forEach((b) => (b.onclick = () => {
          const t = b.dataset.type;
          const keep = { enabled: e.enabled === undefined ? 1 : e.enabled, playOnce: 0 };
          const seq = e.sequenceName;
          for (const k of Object.keys(e)) delete e[k];
          Object.assign(e, { type: t }, keep);
          if ((t === 'both' || t === 'sequence') && seq) e.sequenceName = seq;
          if (t === 'both' && seq) e.mediaName = mediaFor(seq) || undefined;
          if (t === 'pause') e.duration = 5;
          if (t === 'command') { e.command = ''; e.args = []; }
          save(); renderEditor();
        }));
        $$('[data-f]', ed).forEach((inp) => inp.addEventListener('change', () => {
          const f = inp.dataset.f;
          e[f] = f === 'duration' ? Math.max(0, +inp.value || 0) : (inp.value || undefined);
          if (f === 'sequenceName' && e.type === 'both') e.mediaName = mediaFor(inp.value) || e.mediaName;
          if (f === 'sequenceName') { const s = seqInfo(inp.value); if (s && s.durationMs) e.duration = s.durationMs / 1000; }
          save(); renderEditor();
        }));
        if ($('#plCmdForm', ed)) commandForm($('#plCmdForm', ed), e, () => { save(); const row = $(`.pl-row[data-sec="${sec}"][data-i="${i}"] .pl-title`, box); if (row) row.textContent = itemTitle(e); });
        $('[data-close]', ed).onclick = () => { openItem = null; renderEditor(); };
      }
    };

    el.innerHTML = `
      <div class="pl-layout">
        <div class="card pl-side">
          <div class="row"><h3 style="margin:0">Playlists</h3><span class="spacer"></span><button class="btn small primary" id="plNewBtn"><i class="fas fa-plus"></i> New</button></div>
          <form id="plNewForm" class="row" hidden style="margin-top:10px"><input id="plNew" placeholder="Playlist name" style="flex:1;min-width:0"><button class="btn small primary">Create</button></form>
          ${LIB.playlists.length > 6 ? '<input id="plFilter" placeholder="Search" style="width:100%;margin-top:10px">' : ''}
          <div class="pl-list" id="plList"></div>
        </div>
        <div class="card pl-editor" id="plEditor"></div>
      </div>`;
    $('#plNewBtn').onclick = () => { $('#plNewForm').hidden = !$('#plNewForm').hidden; if (!$('#plNewForm').hidden) $('#plNew').focus(); };
    $('#plNewForm').onsubmit = guard(async (ev) => {
      ev.preventDefault();
      const n = $('#plNew').value.trim();
      if (!/^[A-Za-z0-9 _().'&+-]+$/.test(n)) throw new Error('Use letters, numbers, spaces and - _ . ( ) & + \'');
      if (LIB.playlists.includes(n)) throw new Error('A playlist with that name already exists');
      await api('POST', `/api/playlist/${encodeURIComponent(n)}`, { name: n, leadIn: [], mainPlaylist: [], leadOut: [], repeat: 1, loopCount: 0, random: 0 });
      location.hash = `#playlists/${encodeURIComponent(n)}`;
    });
    if ($('#plFilter')) $('#plFilter').oninput = (ev) => { filter = ev.target.value; renderList(); };
    if (selName && LIB.playlists.includes(selName)) {
      try { pl = await api('GET', `/api/playlist/${encodeURIComponent(selName)}`); for (const [k] of SECTIONS) pl[k] = pl[k] || []; } catch { pl = null; }
    }
    renderList();
    renderEditor();
    loadSummaries().then(renderList).catch(() => {});
  };

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

  // Files: like FPP's File Manager, one table at a time with a tab per kind
  // of file (#files/<tab>), a search box, sortable columns and drag-and-drop
  // anywhere on the card.
  const FILE_TABS = [['sequences', 'Sequences'], ['music', 'Audio'], ['videos', 'Video'], ['scripts', 'Scripts']];
  const fdate = (ms) => (ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  PAGES.files = async (el) => {
    await loadLib();
    const want = (location.hash.split('/')[1] || '').toLowerCase();
    let tab = FILE_TABS.some(([k]) => k === want) ? want : 'sequences';
    let q = '';
    let sort = { key: 'name', dir: 1 };
    const lists = () => ({ sequences: LIB.sequences, music: LIB.music, videos: LIB.videos, scripts: LIB.scriptFiles || LIB.scripts.map((n) => ({ name: n })) });
    const COLS = {
      sequences: [['name', 'Name'], ['mediaFilename', 'Media'], ['durationMs', 'Length', 'num'], ['stepMs', 'Rate', 'num'], ['maxChannel', 'Channels', 'num'], ['mtime', 'Modified', 'num']],
      music: [['name', 'Name'], ['size', 'Size', 'num'], ['mtime', 'Modified', 'num']],
      videos: [['name', 'Name'], ['size', 'Size', 'num'], ['mtime', 'Modified', 'num']],
      scripts: [['name', 'Name'], ['size', 'Size', 'num'], ['mtime', 'Modified', 'num']],
    };
    const cell = (k, f) => {
      if (k === 'name') return `<td class="f-name">${esc(f.name)}</td>`;
      if (k === 'mediaFilename') return `<td class="f-media">${f.error ? `<span class="pill bad">${esc(f.error)}</span>` : esc(f.mediaFilename || '—')}</td>`;
      if (k === 'durationMs') return `<td class="num">${fmt(f.durationMs)}</td>`;
      if (k === 'stepMs') return `<td class="num">${f.stepMs ? Math.round(1000 / f.stepMs) + ' fps' : ''}</td>`;
      if (k === 'maxChannel') return `<td class="num">${f.maxChannel ? f.maxChannel.toLocaleString() : ''}</td>`;
      if (k === 'size') return `<td class="num">${f.size !== undefined ? bytes(f.size) : ''}</td>`;
      if (k === 'mtime') return `<td class="num dim">${esc(fdate(f.mtime))}</td>`;
      return '<td></td>';
    };
    const actions = (f) => {
      const n = esc(f.name);
      if (tab === 'sequences') return `<button class="btn small" data-play-seq="${n}" data-media="${esc(f.mediaFilename || '')}" title="Play on the show"><i class="fas fa-play"></i> Play</button><button class="icon-btn2 danger" data-del="sequences/${n}" title="Delete"><i class="fas fa-trash"></i></button>`;
      if (tab === 'music') return `<button class="btn small" data-preview="${n}" title="Listen in this browser (not on the show speakers)"><i class="fas fa-play"></i> Preview</button><a class="icon-btn2" href="/api/file/Music/${encodeURIComponent(f.name)}" download title="Download"><i class="fas fa-download"></i></a><button class="icon-btn2 danger" data-del="music/${n}" title="Delete"><i class="fas fa-trash"></i></button>`;
      if (tab === 'videos') return `<a class="icon-btn2" href="/api/file/Videos/${encodeURIComponent(f.name)}" download title="Download"><i class="fas fa-download"></i></a><button class="icon-btn2 danger" data-del="videos/${n}" title="Delete"><i class="fas fa-trash"></i></button>`;
      return `<a class="icon-btn2" href="/api/file/Scripts/${encodeURIComponent(f.name)}" download title="Download"><i class="fas fa-download"></i></a><button class="icon-btn2 danger" data-del="scripts/${n}" title="Delete"><i class="fas fa-trash"></i></button>`;
    };
    const rows = () => {
      const all = lists()[tab] || [];
      const list = all.filter((f) => !q || `${f.name} ${f.mediaFilename || ''}`.toLowerCase().includes(q.toLowerCase()));
      const k = sort.key;
      list.sort((a, b) => {
        const x = a[k], y = b[k];
        if (typeof x === 'number' || typeof y === 'number') return ((x || 0) - (y || 0)) * sort.dir;
        return String(x || '').localeCompare(String(y || ''), undefined, { numeric: true, sensitivity: 'base' }) * sort.dir;
      });
      return { list, total: all.length };
    };
    const render = () => {
      const L = lists();
      const { list, total } = rows();
      const cols = COLS[tab];
      el.innerHTML = `
        <div class="card files-card" id="drop">
          <div class="row files-head">
            <div class="seg seg-wrap" role="tablist">${FILE_TABS.map(([k, l]) => `<button type="button" role="tab" data-ftab="${k}" aria-selected="${k === tab}" class="${k === tab ? 'on' : ''}">${l} <span class="count">${(L[k] || []).length}</span></button>`).join('')}</div>
            <span class="spacer"></span>
            <input id="fq" type="search" placeholder="Search ${esc(FILE_TABS.find(([k]) => k === tab)[1].toLowerCase())}" value="${esc(q)}">
            <label class="btn primary" for="pick"><i class="fas fa-upload"></i> Upload</label><input type="file" id="pick" multiple hidden>
          </div>
          <div class="progress" id="upProg"></div>
          <div class="table-wrap"><table class="files-table"><thead><tr>${cols.map(([k, l, c]) => `<th class="${c || ''} sortable" data-sort="${k}" aria-sort="${sort.key === k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${l}${sort.key === k ? ` <i class="fas fa-caret-${sort.dir > 0 ? 'up' : 'down'}"></i>` : ''}</th>`).join('')}<th></th></tr></thead>
            <tbody>${list.map((f) => `<tr>${cols.map(([k]) => cell(k, f)).join('')}<td class="f-acts"><div class="row end">${actions(f)}</div></td></tr>`).join('')
              || `<tr><td class="dim" colspan="${cols.length + 1}">${total ? 'No match.' : 'Nothing here yet. Drop files on this card or use Upload.'}</td></tr>`}</tbody></table></div>
          <p class="dim files-foot">${total ? `${list.length === total ? total : `${list.length} of ${total}`} file${total === 1 ? '' : 's'} · ` : ''}Drop .fseq, audio, video or script files anywhere on this card. xLights can also upload straight to this player with FPP Connect.</p>
        </div>`;
      wire();
    };
    const wire = () => {
      $$('[data-ftab]', el).forEach((b) => (b.onclick = () => { tab = b.dataset.ftab; q = ''; sort = { key: 'name', dir: 1 }; history.replaceState(null, '', '#files/' + tab); render(); }));
      $('#fq').oninput = (ev) => { q = ev.target.value; const pos = ev.target.selectionStart; render(); const i = $('#fq'); i.focus(); i.setSelectionRange(pos, pos); };
      $$('[data-sort]', el).forEach((th) => (th.onclick = () => { const k = th.dataset.sort; sort = { key: k, dir: sort.key === k ? -sort.dir : (k === 'mtime' ? -1 : 1) }; render(); }));
      const drop = $('#drop');
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('over'); });
      drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handle([...e.dataTransfer.files]); });
      $('#pick').addEventListener('change', (e) => handle([...e.target.files]));
      $$('[data-del]', el).forEach((b) => (b.onclick = guard(async () => {
        const i = b.dataset.del.indexOf('/');
        const d = b.dataset.del.slice(0, i), n = b.dataset.del.slice(i + 1);
        if (!(await ask(`${n} will be removed from the player.`, { title: 'Delete file?', ok: 'Delete', danger: true }))) return;
        await api('DELETE', `/api/file/${d}/${encodeURIComponent(n)}`);
        if (PREVIEW.name === n) stopPreview();
        await loadLib(); render();
      })));
      $$('[data-play-seq]', el).forEach((b) => (b.onclick = guard(async () => {
        await api('POST', P('/play'), { sequence: b.dataset.playSeq, media: b.dataset.media || undefined });
        toast(`Playing ${b.dataset.playSeq}`);
      })));
      // Audio preview in this browser: one file at a time; the button shows
      // Stop and the elapsed time while it plays.
      const previewBtn = (name) => $$('[data-preview]', el).find((x) => x.dataset.preview === name);
      const resetPreviewBtns = () => $$('[data-preview]', el).forEach((x) => { x.innerHTML = '<i class="fas fa-play"></i> Preview'; x.classList.remove('primary'); });
      if (PREVIEW.audio && PREVIEW.name) { const b = previewBtn(PREVIEW.name); if (b) { b.classList.add('primary'); b.innerHTML = '<i class="fas fa-stop"></i> Stop'; } }
      $$('[data-preview]', el).forEach((b) => (b.onclick = () => {
        const name = b.dataset.preview;
        const same = PREVIEW.name === name;
        stopPreview();
        resetPreviewBtns();
        if (same) return;
        const a = new Audio(`/api/file/Music/${encodeURIComponent(name)}`);
        PREVIEW.audio = a; PREVIEW.name = name;
        b.classList.add('primary');
        b.innerHTML = '<i class="fas fa-stop"></i> Stop';
        const mine = () => PREVIEW.audio === a; // ignore events from a preview that was already replaced
        a.ontimeupdate = () => { const x = previewBtn(name); if (x && mine()) x.innerHTML = `<i class="fas fa-stop"></i> ${fmt(a.currentTime * 1000)}`; };
        a.onended = () => { if (!mine()) return; stopPreview(); resetPreviewBtns(); };
        a.onerror = () => { if (!mine()) return; stopPreview(); resetPreviewBtns(); toast(`Can't play ${name} in this browser`, true); };
        a.play().catch((e) => { if (!mine() || e.name === 'AbortError') return; stopPreview(); resetPreviewBtns(); toast(e.message, true); });
      }));
    };
    const handle = guard(async (files) => {
      for (const f of files) {
        await upload(f, (p) => { const u = $('#upProg'); if (u) u.textContent = `${f.name}: ${Math.round(p * 100)}%`; });
        toast(`Uploaded ${f.name}`);
      }
      // Show the tab of what was uploaded last.
      const last = files[files.length - 1];
      const d = last && folderFor(last.name);
      if (d && FILE_TABS.some(([k]) => k === d)) { tab = d; history.replaceState(null, '', '#files/' + tab); }
      await loadLib(); render();
    });
    render();
  };

  // ---------------------------------------------------------------- commands (shared)
  // FPP-style command picker: a command list grouped by category and a form
  // built from each command's argument descriptions.
  let CMDS = null;
  let LISTS = {};
  const loadCmds = async () => (CMDS = await api('GET', P('/commands')));
  const contentList = (url) => {
    if (!LISTS[url]) {
      LISTS[url] = api('GET', '/' + url.replace(/^\/+/, ''))
        .then((r) => (Array.isArray(r) ? r.map((x) => (typeof x === 'string' ? x : (x && (x.name || x.Name)) || String(x))) : []))
        .catch(() => []);
    }
    return LISTS[url];
  };
  const cmdDesc = (name) => (CMDS || []).find((c) => c.name === name);
  const isTrue = (v) => /^(true|1|yes)$/i.test(String(v));

  // One-line description of a command and its arguments.
  function cmdSummary(c) {
    if (!c || !c.command) return 'No command chosen';
    if (c.command === 'Trigger Command Preset' && c.args && c.args[0]) return `Preset: ${c.args[0]}${c.multisyncCommand ? ' · also on remotes' : ''}`;
    const d = cmdDesc(c.command);
    const parts = (c.args || []).map((v, i) => {
      const a = d && d.args && d.args[i];
      if (a && a.type === 'bool') return isTrue(v) ? (a.description || a.name).toLowerCase() : '';
      if (a && a.default !== undefined && String(a.default) === String(v)) return ''; // defaults add nothing
      return v;
    }).filter((v) => v !== '' && v !== undefined);
    return `${c.command}${parts.length ? ' · ' + parts.join(' · ') : ''}${c.multisyncCommand ? ' · also on remotes' : ''}`;
  }

  // Renders a command form into `box`. `val` ({ command, args, multisyncCommand,
  // multisyncHosts }) is edited in place; onChange runs after each edit.
  function commandForm(box, val, onChange = () => {}, { multisync = true } = {}) {
    const cats = {};
    for (const c of CMDS || []) (cats[c.category || 'Other'] = cats[c.category || 'Other'] || []).push(c);
    const order = ['Playlist', 'Presets', 'Lights', 'System', 'ShowPilot', 'Media'];
    const catNames = Object.keys(cats).sort((a, b) => ((order.indexOf(a) + 1) || 99) - ((order.indexOf(b) + 1) || 99) || a.localeCompare(b));
    const render = () => {
      const d = cmdDesc(val.command);
      val.args = Array.isArray(val.args) ? val.args : [];
      const argDefs = d ? d.args || [] : val.args.map((_, i) => ({ name: `arg${i + 1}`, type: 'string', description: `Argument ${i + 1}` }));
      box.innerHTML = `
        <label>Command <select data-cmd>
          <option value="">Choose a command…</option>
          ${!d && val.command ? `<option selected value="${esc(val.command)}">${esc(val.command)} (not available on this player)</option>` : ''}
          ${catNames.map((cat) => `<optgroup label="${esc(cat)}">${cats[cat].map((c) => `<option ${c.name === val.command ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`).join('')}
        </select></label>
        ${d && d.description ? `<p class="dim cmd-help">${esc(d.description)}</p>` : ''}
        <div class="cmd-args">${argDefs.map((a, i) => argField(a, i)).join('')}</div>
        ${multisync ? `<div class="row cmd-ms"><label class="inline"><input type="checkbox" data-ms ${val.multisyncCommand ? 'checked' : ''}> Also send to MultiSync remotes</label>
          <input data-mshosts placeholder="Only these remotes (blank = all)" value="${esc(val.multisyncHosts || '')}" ${val.multisyncCommand ? '' : 'hidden'} style="flex:1;min-width:180px"></div>` : ''}`;
      $('[data-cmd]', box).onchange = (e) => {
        val.command = e.target.value;
        const nd = cmdDesc(val.command);
        val.args = nd ? (nd.args || []).map((a) => (a.default !== undefined ? String(a.default) : a.type === 'bool' ? 'false' : '')) : [];
        render(); onChange();
      };
      $$('[data-arg]', box).forEach((inp) => {
        const i = +inp.dataset.arg;
        const set = () => { val.args[i] = inp.type === 'checkbox' ? String(inp.checked) : inp.value; trim(); onChange(); };
        inp.addEventListener(inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input', set);
      });
      // Fill lists that come from the API (playlists, scripts, presets).
      $$('[data-list]', box).forEach(async (sel) => {
        const items = await contentList(sel.dataset.list);
        const cur = sel.dataset.cur;
        if (sel.tagName === 'SELECT') {
          sel.innerHTML = `<option value="">Choose…</option>${items.map((n) => `<option ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('')}${cur && !items.includes(cur) ? `<option selected>${esc(cur)}</option>` : ''}`;
        } else {
          const dl = $(`#${sel.getAttribute('list')}`, box);
          if (dl) dl.innerHTML = items.map((n) => `<option value="${esc(n)}">`).join('');
        }
      });
      if ($('[data-ms]', box)) {
        $('[data-ms]', box).onchange = (e) => { val.multisyncCommand = e.target.checked; $('[data-mshosts]', box).hidden = !e.target.checked; onChange(); };
        $('[data-mshosts]', box).oninput = (e) => { val.multisyncHosts = e.target.value; onChange(); };
      }
    };
    // Drop trailing empty optional args, as FPP does.
    const trim = () => { while (val.args.length && val.args[val.args.length - 1] === '') { const d = cmdDesc(val.command); const a = d && d.args && d.args[val.args.length - 1]; if (a && !a.optional) break; val.args.pop(); } };
    const argField = (a, i) => {
      const v = val.args[i] !== undefined ? val.args[i] : (a.default !== undefined ? String(a.default) : '');
      const lab = esc(a.description || a.name) + (a.optional ? ' <span class="dim">(optional)</span>' : '');
      if (a.type === 'bool') return `<label class="inline"><input type="checkbox" data-arg="${i}" ${isTrue(v) ? 'checked' : ''}> ${esc(a.description || a.name)}</label>`;
      if (a.contents && a.contents.length) return `<label>${lab}<select data-arg="${i}">${a.contents.map((o) => `<option ${String(o) === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
      if (a.contentListUrl) return `<label>${lab}<select data-arg="${i}" data-list="${esc(a.contentListUrl)}" data-cur="${esc(v)}"><option>${esc(v)}</option></select></label>`;
      if (a.type === 'int' || a.type === 'range') return `<label>${lab}<input type="number" data-arg="${i}" value="${esc(v)}" ${a.min !== undefined ? `min="${a.min}"` : ''} ${a.max !== undefined ? `max="${a.max}"` : ''}></label>`;
      return `<label>${lab}<input data-arg="${i}" value="${esc(v)}"></label>`;
    };
    // Fill in defaults so a freshly picked command is complete.
    const d0 = cmdDesc(val.command);
    if (d0) (d0.args || []).forEach((a, i) => { if (val.args[i] === undefined && !a.optional) val.args[i] = a.default !== undefined ? String(a.default) : a.type === 'bool' ? 'false' : ''; });
    render();
  }

  // ---------------------------------------------------------------- commands page
  PAGES.commands = async (el) => {
    await loadCmds();
    let { presets, reserved } = await api('GET', P('/presets'));
    let editing = null; // index into presets, or 'new'
    let draft = null;
    const quick = { command: '', args: [] };
    const RES_HELP = {
      FPPD_STARTED: 'when the player starts', FPPD_STOPPED: 'when the player shuts down',
      PLAYLIST_STARTED: 'when a playlist starts', PLAYLIST_STOPPED: 'when a playlist stops',
      PLAYLIST_STOPPING_NOW: 'on Stop Now', PLAYLIST_STOPPING_GRACEFULLY: 'on a graceful stop', PLAYLIST_STOPPING_AFTER_LOOP: 'on stop after loop',
      MEDIA_STARTED: 'when each song starts', MEDIA_STOPPED: 'when each song ends',
    };
    const savePresets = async () => { ({ presets, reserved } = await api('PUT', P('/presets'), { presets })); };

    const presetView = (p, i) => `
      <div class="item" data-i="${i}">
        <div class="item-main">
          <div class="item-title">${esc(p.name)} ${p.presetSlot ? `<span class="pill">Slot ${p.presetSlot}</span>` : ''} ${RES_HELP[p.name] ? `<span class="pill ok">Runs ${esc(RES_HELP[p.name])}</span>` : ''}</div>
          <ol class="cmd-list">${p.commands.map((c) => `<li>${esc(cmdSummary(c))}</li>`).join('')}</ol>
        </div>
        <div class="item-actions"><button class="btn small" data-run>Run</button><button class="btn small" data-edit>Edit</button><button class="btn small danger" data-del aria-label="Delete">Delete</button></div>
      </div>`;

    const editorView = () => `
      <div class="item editing">
        <div class="fields">
          <label>Preset name <input id="pName" list="pReserved" value="${esc(draft.name)}" placeholder="e.g. Lights off">
            <datalist id="pReserved">${reserved.map((n) => `<option value="${esc(n)}">${esc(RES_HELP[n] || '')}</option>`).join('')}</datalist></label>
          <label>Slot number <span class="dim">(optional)</span><input type="number" id="pSlot" min="0" max="255" value="${draft.presetSlot || ''}" placeholder="none"></label>
        </div>
        <p class="dim">Name a preset after a player event (pick from the list) to run it automatically, e.g. PLAYLIST_STOPPED.</p>
        <div id="pCmds"></div>
        <div class="row"><button class="btn" id="pAdd">+ Add a command</button><span class="spacer"></span>
          <button class="btn" id="pCancel">Cancel</button><button class="btn primary" id="pSave">Save preset</button></div>
      </div>`;

    const renderCmds = () => {
      const box = $('#pCmds');
      box.innerHTML = draft.commands.map((_, j) => `<div class="sub" data-j="${j}"><div class="sub-head"><b>${j + 1}</b><span class="spacer"></span>
        <button class="btn small" data-up ${j ? '' : 'disabled'}>↑</button><button class="btn small" data-down ${j < draft.commands.length - 1 ? '' : 'disabled'}>↓</button>
        <button class="btn small danger" data-x>Remove</button></div><div class="cmd-form"></div></div>`).join('') || '<p class="dim">No commands yet.</p>';
      $$('.sub', box).forEach((sub) => {
        const j = +sub.dataset.j;
        commandForm($('.cmd-form', sub), draft.commands[j]);
        $('[data-x]', sub).onclick = () => { draft.commands.splice(j, 1); renderCmds(); };
        $('[data-up]', sub).onclick = () => { [draft.commands[j - 1], draft.commands[j]] = [draft.commands[j], draft.commands[j - 1]]; renderCmds(); };
        $('[data-down]', sub).onclick = () => { [draft.commands[j + 1], draft.commands[j]] = [draft.commands[j], draft.commands[j + 1]]; renderCmds(); };
      });
    };

    const render = () => {
      el.innerHTML = `
        <div class="card"><h3>Run a command now</h3><div id="quick" class="cmd-form"></div>
          <div class="row end" style="margin-top:10px"><span class="muted" id="quickOut"></span><span class="spacer"></span><button class="btn primary" id="quickRun">Run</button></div></div>
        <div class="card"><div class="row"><h3 style="margin:0">Command presets</h3><span class="spacer"></span><button class="btn primary" id="newP" ${editing !== null ? 'disabled' : ''}>New preset</button></div>
          <p class="dim">A preset is a named list of commands. Run it from here, from the schedule, a playlist, a plugin or xLights with "Trigger Command Preset". The file is FPP's <code>commandPresets.json</code>, so FPP presets restore as-is.</p>
          <div class="items">${editing === 'new' ? editorView() : ''}${presets.map((p, i) => (editing === i ? editorView() : presetView(p, i))).join('') || (editing === null ? '<p class="dim">No presets yet.</p>' : '')}</div></div>`;
      commandForm($('#quick'), quick);
      $('#quickRun').onclick = guard(async () => {
        if (!quick.command) throw new Error('choose a command');
        const r = await api('POST', P('/command'), quick);
        $('#quickOut').textContent = String(r.result).slice(0, 200);
      });
      $('#newP').onclick = () => { editing = 'new'; draft = { name: '', presetSlot: 0, commands: [{ command: '', args: [] }] }; render(); };
      $$('.item[data-i]', el).forEach((row) => {
        const i = +row.dataset.i;
        $('[data-run]', row).onclick = guard(async () => { const r = await api('POST', P('/presets/run'), { name: presets[i].name }); toast(`${presets[i].name}: ${r.result}`); });
        $('[data-edit]', row).onclick = () => { editing = i; draft = clone(presets[i]); render(); };
        $('[data-del]', row).onclick = guard(async () => { if (!(await ask(`The preset "${presets[i].name}" and its commands will be removed.`, { title: 'Delete preset?', ok: 'Delete', danger: true }))) return; presets.splice(i, 1); await savePresets(); toast('Preset deleted'); render(); });
      });
      if (editing !== null) {
        renderCmds();
        $('#pAdd').onclick = () => { draft.commands.push({ command: '', args: [] }); renderCmds(); };
        $('#pCancel').onclick = () => { editing = null; render(); };
        $('#pSave').onclick = guard(async () => {
          draft.name = $('#pName').value.trim();
          draft.presetSlot = parseInt($('#pSlot').value, 10) || 0;
          draft.commands = draft.commands.filter((c) => c.command);
          if (!draft.name) throw new Error('give the preset a name');
          if (!draft.commands.length) throw new Error('add at least one command');
          const prev = presets.slice();
          if (editing === 'new') presets.push(draft); else presets[editing] = draft;
          try { await savePresets(); } catch (e) { presets = prev; throw e; }
          editing = null; toast('Preset saved'); render();
        });
        $('#pName').focus();
      }
    };
    render();
  };

  // ---------------------------------------------------------------- schedule
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const SUNS = { sunrise: 'Sunrise', sunset: 'Sunset', dawn: 'Dawn', dusk: 'Dusk' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAY_PRESETS = [['Every day', [0, 1, 2, 3, 4, 5, 6]], ['Weekdays', [1, 2, 3, 4, 5]], ['Weekends', [0, 6]], ['Fri & Sat', [5, 6]], ['Sun–Thu', [0, 1, 2, 3, 4]]];
  const clock = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  const hm = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const timeText = (spec, off) => {
    if (SUNS[spec]) return `${SUNS[spec]}${off ? ` ${off > 0 ? '+' : '−'}${Math.abs(off)} min` : ''}`;
    return clock(spec) + (off ? ` ${off > 0 ? '+' : '−'}${Math.abs(off)} min` : '');
  };
  const daysText = (days) => {
    const k = [...days].sort().join();
    const hit = DAY_PRESETS.find(([, d]) => d.join() === k);
    return hit ? hit[0] : days.length ? days.map((d) => DAYS[d]).join(', ') : 'No days';
  };

  PAGES.schedule = async (el) => {
    await Promise.all([loadConfig(), loadLib(), loadCmds()]);
    let view = await api('GET', P('/schedule'));
    const [sun, tzInfo] = await Promise.all([api('GET', P('/suntimes')).catch(() => ({})), api('GET', P('/timezone')).catch(() => ({ current: '' }))]);
    let editing = null; // entry id, or 'new'
    let draft = null;
    let showLoc = false;
    let allUpcoming = false;
    const HOL = Object.fromEntries((view.holidays || []).map((h) => [h.shortName, h.name]));

    const dateText = (spec, off) => {
      if (!spec) return '';
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(spec);
      if (m && m[1] === '0000') return `${MONTHS[+m[2] - 1]} ${+m[3]}`;
      if (m) return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
      return `${HOL[spec] || spec}${off ? ` ${off > 0 ? '+' : '−'}${Math.abs(off)} day${Math.abs(off) === 1 ? '' : 's'}` : ''}`;
    };
    const title = (e) => (e.type === 'command' ? cmdSummary(e) : e.type === 'sequence' ? e.sequence.replace(/\.fseq$/i, '') : e.playlist) || 'Nothing chosen';
    const summary = (e) => {
      const parts = [daysText(e.days)];
      if (e.type === 'command') {
        parts.push(e.repeatEvery ? `every ${e.repeatEvery} min from ${timeText(e.startTime, e.startOffset)} to ${timeText(e.endTime, e.endOffset)}` : `at ${timeText(e.startTime, e.startOffset)}`);
      } else {
        parts.push(`${timeText(e.startTime, e.startOffset)} – ${timeText(e.endTime, e.endOffset)}`);
        parts.push(e.repeatEvery ? `plays once, again every ${e.repeatEvery} min` : e.repeat ? 'repeats' : 'plays once');
        parts.push(e.stopType === 'hard' ? 'stops right at the end' : e.stopType === 'loop' ? 'then finishes the loop' : 'then finishes the song');
      }
      return parts.join(' · ');
    };
    const datesLine = (e) => {
      if (!e.startDate && !e.endDate) return '';
      if (e.startDate && e.endDate) return `${dateText(e.startDate, e.startDateOffset)} → ${dateText(e.endDate, e.endDateOffset)}`;
      return e.startDate ? `From ${dateText(e.startDate, e.startDateOffset)}` : `Until ${dateText(e.endDate, e.endDateOffset)}`;
    };
    const whenNext = (e) => {
      const n = view.next[e.id];
      if (!e.enabled) return '<span class="pill">Off</span>';
      if (!n) return '<span class="pill warn">Not in the next year</span>';
      if (n.live) return '<span class="pill ok">On now</span>';
      const d = new Date(n.start);
      const today = new Date(); const tom = new Date(Date.now() + 86400000);
      const day = d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === tom.toDateString() ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      return `<span class="pill">Next: ${day} ${hm(d)}</span>`;
    };
    const ICON = { playlist: 'Playlist', sequence: 'Sequence', command: 'Command' };

    const save = async (entries, msg) => { view = await api('PUT', P('/schedule'), { entries }); if (msg) toast(msg); };

    // ---- editor pieces
    const timePicker = (key) => {
      const spec = draft[key + 'Time'], off = draft[key + 'Offset'];
      const kind = SUNS[spec] ? spec : 'time';
      return `<div class="timepick" data-tp="${key}">
        <select data-kind>${[['time', 'Clock time'], ...Object.entries(SUNS)].map(([v, l]) => `<option value="${v}" ${v === kind ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input type="time" data-clock value="${kind === 'time' ? esc(spec) : ''}" ${kind === 'time' ? '' : 'hidden'}>
        <span class="off" ${kind === 'time' ? 'hidden' : ''}><select data-sign><option value="1" ${off >= 0 ? 'selected' : ''}>plus</option><option value="-1" ${off < 0 ? 'selected' : ''}>minus</option></select>
          <input type="number" data-off min="0" max="720" value="${Math.abs(off) || 0}"> min</span>
        ${kind !== 'time' && sun[kind] ? `<span class="dim" data-today>today ${hm(+new Date(sun[kind]) + off * 60000)}</span>` : ''}</div>`;
    };
    const datePicker = (key) => {
      const spec = draft[key + 'Date'], off = draft[key + 'DateOffset'];
      const kind = !spec ? 'none' : /^0000-/.test(spec) ? 'yearly' : /^\d{4}-/.test(spec) ? 'date' : 'holiday';
      const mm = kind === 'yearly' ? +spec.slice(5, 7) : 12, dd = kind === 'yearly' ? +spec.slice(8, 10) : 1;
      return `<div class="datepick" data-dp="${key}">
        <select data-kind>${[['none', key === 'start' ? 'Any time' : 'No end'], ['date', 'A date'], ['yearly', 'Every year on'], ['holiday', 'A holiday']].map(([v, l]) => `<option value="${v}" ${v === kind ? 'selected' : ''}>${l}</option>`).join('')}</select>
        ${kind === 'date' ? `<input type="date" data-date value="${esc(spec)}">` : ''}
        ${kind === 'yearly' ? `<select data-mon>${MONTHS.map((m, i) => `<option value="${i + 1}" ${i + 1 === mm ? 'selected' : ''}>${m}</option>`).join('')}</select><input type="number" data-day min="1" max="31" value="${dd}" style="width:70px">` : ''}
        ${kind === 'holiday' ? `<select data-hol>${(view.holidays || []).map((h) => `<option value="${esc(h.shortName)}" ${h.shortName === spec ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}</select>
          <select data-sign><option value="1" ${off >= 0 ? 'selected' : ''}>plus</option><option value="-1" ${off < 0 ? 'selected' : ''}>minus</option></select><input type="number" data-off min="0" max="366" value="${Math.abs(off) || 0}" style="width:70px"> days` : ''}
      </div>`;
    };

    const editorView = () => {
      const e = draft;
      const show = e.type !== 'command';
      const repeatMode = e.repeatEvery ? 'every' : e.repeat ? 'repeat' : 'once';
      return `<div class="sch-editor">
        <div class="ed-sec"><div class="ed-label">What</div><div class="ed-body">
          <div class="seg" data-seg="type">${['playlist', 'sequence', 'command'].map((t) => `<button type="button" data-v="${t}" class="${e.type === t ? 'on' : ''}">${ICON[t]}</button>`).join('')}</div>
          ${e.type === 'playlist' ? `<select id="edPl"><option value="">Choose a playlist…</option>${LIB.playlists.map((n) => `<option ${n === e.playlist ? 'selected' : ''}>${esc(n)}</option>`).join('')}${e.playlist && !LIB.playlists.includes(e.playlist) ? `<option selected>${esc(e.playlist)}</option>` : ''}</select>` : ''}
          ${e.type === 'sequence' ? `<select id="edSeq"><option value="">Choose a sequence…</option>${LIB.sequences.map((s) => `<option value="${esc(s.name)}" ${s.name === e.sequence ? 'selected' : ''}>${esc(s.name.replace(/\.fseq$/i, ''))}</option>`).join('')}${e.sequence && !LIB.sequences.some((s) => s.name === e.sequence) ? `<option selected>${esc(e.sequence)}</option>` : ''}</select>
            <p class="dim">Plays with the audio named in the sequence, if that file is on the player.</p>` : ''}
          ${e.type === 'command' ? '<div id="edCmd" class="cmd-form"></div>' : ''}
        </div></div>
        <div class="ed-sec"><div class="ed-label">Days</div><div class="ed-body">
          <div class="chips">${DAYS.map((d, k) => `<button type="button" class="chip ${e.days.includes(k) ? 'on' : ''}" data-day="${k}">${d}</button>`).join('')}</div>
          <div class="row quick">${DAY_PRESETS.map(([l, d]) => `<button type="button" class="btn small" data-days="${d.join(',')}">${l}</button>`).join('')}</div>
        </div></div>
        <div class="ed-sec"><div class="ed-label">${show ? 'Time' : 'When'}</div><div class="ed-body">
          <div class="tp-row"><span class="tp-lab">${show ? 'Starts' : 'At'}</span>${timePicker('start')}</div>
          ${!show ? `<label class="inline"><input type="checkbox" id="edEvery" ${e.repeatEvery ? 'checked' : ''}> Run again every <input type="number" id="edEveryN" min="1" max="1440" value="${e.repeatEvery || 30}" style="width:80px"> minutes</label>` : ''}
          ${show || e.repeatEvery ? `<div class="tp-row"><span class="tp-lab">${show ? 'Ends' : 'Until'}</span>${timePicker('end')}</div>` : ''}
          ${show ? '<p class="dim">An end time earlier than the start runs past midnight.</p>' : ''}
        </div></div>
        ${show ? `<div class="ed-sec"><div class="ed-label">Playback</div><div class="ed-body">
          <label>While on <select id="edRepeat">
            <option value="repeat" ${repeatMode === 'repeat' ? 'selected' : ''}>Repeat until the end time</option>
            <option value="once" ${repeatMode === 'once' ? 'selected' : ''}>Play once</option>
            <option value="every" ${repeatMode === 'every' ? 'selected' : ''}>Play once, then again every…</option></select></label>
          ${repeatMode === 'every' ? `<label class="inline"><input type="number" id="edEveryN" min="1" max="1440" value="${e.repeatEvery || 30}" style="width:80px"> minutes</label>` : ''}
          <div class="ed-sub">At the end time</div>
          <div class="seg" data-seg="stopType">${[['graceful', 'Finish the song'], ['loop', 'Finish the loop'], ['hard', 'Stop right away']].map(([v, l]) => `<button type="button" data-v="${v}" class="${e.stopType === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        </div></div>` : ''}
        <div class="ed-sec"><div class="ed-label">Dates</div><div class="ed-body">
          <div class="tp-row"><span class="tp-lab">From</span>${datePicker('start')}</div>
          <div class="tp-row"><span class="tp-lab">Until</span>${datePicker('end')}</div>
          <p class="dim">Holidays and "every year" dates repeat each season, e.g. Thanksgiving plus 1 day until every year on Jan 6.</p>
        </div></div>
        <div class="ed-foot"><span class="muted" id="edSummary">${esc(summary(e))}</span><span class="spacer"></span>
          <label class="inline"><input type="checkbox" id="edOn" ${e.enabled ? 'checked' : ''}> Enabled</label>
          <button class="btn" id="edCancel">Cancel</button><button class="btn primary" id="edSave">Save</button></div>
      </div>`;
    };

    const wireEditor = () => {
      const box = $('.sch-editor', el);
      const upd = () => { $('#edSummary').textContent = summary(draft); };
      $$('[data-seg]', box).forEach((seg) => $$('button', seg).forEach((b) => (b.onclick = () => {
        draft[seg.dataset.seg] = b.dataset.v;
        if (seg.dataset.seg === 'type') { draft.repeatEvery = 0; render(); } else { $$('button', seg).forEach((x) => x.classList.toggle('on', x === b)); upd(); }
      })));
      if ($('#edPl')) $('#edPl').onchange = (ev) => { draft.playlist = ev.target.value; upd(); };
      if ($('#edSeq')) $('#edSeq').onchange = (ev) => { draft.sequence = ev.target.value; upd(); };
      if ($('#edCmd')) commandForm($('#edCmd'), draft, upd);
      $$('[data-day]', box).forEach((b) => (b.onclick = () => {
        const k = +b.dataset.day;
        draft.days = draft.days.includes(k) ? draft.days.filter((d) => d !== k) : [...draft.days, k].sort();
        b.classList.toggle('on'); upd();
      }));
      $$('[data-days]', box).forEach((b) => (b.onclick = () => { draft.days = b.dataset.days.split(',').map(Number); $$('[data-day]', box).forEach((c) => c.classList.toggle('on', draft.days.includes(+c.dataset.day))); upd(); }));
      $$('[data-tp]', box).forEach((tp) => {
        const key = tp.dataset.tp;
        $('[data-kind]', tp).onchange = (ev) => {
          const v = ev.target.value;
          draft[key + 'Time'] = v === 'time' ? (key === 'start' ? '17:00' : '22:00') : v;
          if (v === 'time') draft[key + 'Offset'] = 0;
          render();
        };
        $('[data-clock]', tp).oninput = (ev) => { if (ev.target.value) { draft[key + 'Time'] = ev.target.value; upd(); } };
        const off = () => { draft[key + 'Offset'] = (+$('[data-sign]', tp).value) * (Math.abs(parseInt($('[data-off]', tp).value, 10)) || 0); upd(); };
        $('[data-sign]', tp).onchange = off; $('[data-off]', tp).oninput = off;
      });
      $$('[data-dp]', box).forEach((dp) => {
        const key = dp.dataset.dp;
        $('[data-kind]', dp).onchange = (ev) => {
          const v = ev.target.value;
          const y = new Date().getFullYear();
          draft[key + 'Date'] = v === 'none' ? '' : v === 'date' ? `${y}-12-01` : v === 'yearly' ? (key === 'start' ? '0000-11-25' : '0000-01-06') : (key === 'start' ? 'Thanksgiving' : 'NewYearsDay');
          draft[key + 'DateOffset'] = 0;
          render();
        };
        const set = () => {
          if ($('[data-date]', dp)) draft[key + 'Date'] = $('[data-date]', dp).value;
          if ($('[data-mon]', dp)) draft[key + 'Date'] = `0000-${String($('[data-mon]', dp).value).padStart(2, '0')}-${String(Math.min(31, Math.max(1, +$('[data-day]', dp).value || 1))).padStart(2, '0')}`;
          if ($('[data-hol]', dp)) { draft[key + 'Date'] = $('[data-hol]', dp).value; draft[key + 'DateOffset'] = (+$('[data-sign]', dp).value) * (Math.abs(parseInt($('[data-off]', dp).value, 10)) || 0); }
          upd();
        };
        $$('input, select:not([data-kind])', dp).forEach((i) => i.addEventListener('input', set));
        $$('select:not([data-kind])', dp).forEach((i) => i.addEventListener('change', set));
      });
      if ($('#edRepeat')) $('#edRepeat').onchange = (ev) => { const v = ev.target.value; draft.repeat = v === 'repeat'; draft.repeatEvery = v === 'every' ? (draft.repeatEvery || 30) : 0; render(); };
      if ($('#edEvery')) $('#edEvery').onchange = (ev) => { draft.repeatEvery = ev.target.checked ? (+$('#edEveryN').value || 30) : 0; render(); };
      if ($('#edEveryN')) $('#edEveryN').oninput = (ev) => { if (draft.type !== 'command' || $('#edEvery').checked) { draft.repeatEvery = Math.max(1, +ev.target.value || 1); upd(); } };
      $('#edOn').onchange = (ev) => { draft.enabled = ev.target.checked; };
      $('#edCancel').onclick = () => { editing = null; render(); };
      $('#edSave').onclick = guard(async () => {
        if (draft.type === 'playlist' && !draft.playlist) throw new Error('choose a playlist');
        if (draft.type === 'sequence' && !draft.sequence) throw new Error('choose a sequence');
        if (draft.type === 'command' && !draft.command) throw new Error('choose a command');
        if (!draft.days.length) throw new Error('pick at least one day');
        const list = view.entries.slice();
        if (editing === 'new') list.push(draft); else list[list.findIndex((x) => x.id === editing)] = draft;
        await save(list, 'Schedule saved');
        editing = null; render();
      });
      box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };

    const entryView = (e, i) => `
      <div class="sch ${e.enabled ? '' : 'off'}" data-id="${esc(e.id)}">
        <label class="switch" title="${e.enabled ? 'On' : 'Off'}"><input type="checkbox" data-toggle ${e.enabled ? 'checked' : ''}><span></span></label>
        <div class="sch-main">
          <div class="sch-title"><span class="tag tag-${e.type}">${ICON[e.type]}</span> ${esc(title(e))}</div>
          <div class="sch-sum">${esc(summary(e))}</div>
          ${datesLine(e) ? `<div class="sch-dates dim">${esc(datesLine(e))}</div>` : ''}
        </div>
        <div class="sch-side">${whenNext(e)}
          <div class="sch-btns"><button class="btn small" data-mv="-1" ${i ? '' : 'disabled'} aria-label="Move up">↑</button><button class="btn small" data-mv="1" ${i < view.entries.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button>
          <button class="btn small" data-dup>Copy</button><button class="btn small" data-edit>Edit</button><button class="btn small danger" data-del>Delete</button></div></div>
      </div>`;

    const upcomingView = () => {
      if (!view.upcoming.length) return '<p class="dim">Nothing scheduled in the next 7 days.</p>';
      const groups = new Map();
      const today = new Date().toDateString(), tom = new Date(Date.now() + 86400000).toDateString();
      const LIMIT = 12;
      const list = allUpcoming ? view.upcoming : view.upcoming.slice(0, LIMIT);
      for (const u of list) {
        const d = new Date(u.start);
        const k = d.toDateString();
        const label = (k === today ? 'Today · ' : k === tom ? 'Tomorrow · ' : '') + d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
        if (!groups.has(k)) groups.set(k, { label, items: [] });
        groups.get(k).items.push(u);
      }
      return [...groups.values()].map((g) => `<div class="up-day">${esc(g.label)}</div>${g.items.map((u) => `
        <div class="up-row"><span class="up-time">${hm(u.start)}${u.end ? ` – ${hm(u.end)}` : ''}</span>
        <span class="tag tag-${u.type}">${ICON[u.type]}</span><span class="up-what">${esc(u.type === 'command' ? cmdSummary({ command: u.name, args: u.args }) : u.name.replace(/\.fseq$/i, ''))}${u.repeatEvery ? ` <span class="dim">every ${u.repeatEvery} min</span>` : ''}</span>
        ${u.live ? '<span class="pill ok">On now</span>' : ''}</div>`).join('')}`).join('')
        + (view.upcoming.length > LIMIT ? `<button class="btn small" id="moreUp" style="margin-top:10px">${allUpcoming ? 'Show less' : `Show all ${view.upcoming.length}`}</button>` : '');
    };

    const render = () => {
      const loc = CONFIG.location || {};
      const hasLoc = loc.latitude !== null && loc.latitude !== undefined && loc.longitude !== null && loc.longitude !== undefined;
      el.innerHTML = `
        ${CONFIG.mode === 'remote' ? '<div class="card notice">This player is in remote mode, so the schedule does not run. Switch to player mode on the MultiSync page.</div>' : ''}
        <div class="card sch-info"><div class="row">
          <div class="info-bits">
            ${sun.sunset ? `<span><span class="dim">Sunset</span> ${hm(sun.sunset)}</span><span><span class="dim">Dusk</span> ${hm(sun.dusk)}</span><span><span class="dim">Sunrise</span> ${hm(sun.sunrise)}</span>` : '<span class="pill warn">Set your location to use sunset and dusk times</span>'}
            <span><span class="dim">Timezone</span> ${esc(tzInfo.current || '')}</span>
          </div><span class="spacer"></span><button class="btn small" id="locBtn">${hasLoc ? 'Location' : 'Set location'}</button></div>
          <div id="locForm" ${showLoc ? '' : 'hidden'} style="margin-top:12px"><div class="row">
            <label>Latitude <input id="lat" value="${esc(loc.latitude ?? '')}" placeholder="e.g. 36.1"></label>
            <label>Longitude <input id="lon" value="${esc(loc.longitude ?? '')}" placeholder="e.g. -94.1"></label>
            <button class="btn" id="geo" type="button">Use this device's location</button><button class="btn primary" id="saveLoc">Save</button></div>
            <p class="dim">Change the timezone under Settings → General.</p></div></div>
        <div class="grid sch-grid">
          <div class="card"><div class="row"><h3 style="margin:0">Schedule</h3><span class="spacer"></span>
            <button class="btn" id="addCmd" ${editing ? 'disabled' : ''}>Add command</button><button class="btn primary" id="addShow" ${editing ? 'disabled' : ''}>Add show</button></div>
            <p class="dim">When two entries overlap, the higher one wins.</p>
            <div class="sch-list">${editing === 'new' ? editorView() : ''}${view.entries.map((e, i) => (editing === e.id ? editorView() : entryView(e, i))).join('')}
            ${!view.entries.length && editing !== 'new' ? '<div class="empty"><p>Nothing scheduled yet.</p><p class="dim">Add a show to start a playlist at dusk, or a command to run at a set time.</p></div>' : ''}</div></div>
          <div class="card"><h3>Coming up</h3>${upcomingView()}</div>
        </div>`;

      $('#locBtn').onclick = () => { showLoc = !showLoc; $('#locForm').hidden = !showLoc; };
      if ($('#moreUp')) $('#moreUp').onclick = () => { allUpcoming = !allUpcoming; render(); };
      $('#geo').onclick = () => {
        if (!navigator.geolocation) return toast('This browser cannot share its location', true);
        navigator.geolocation.getCurrentPosition((p) => { $('#lat').value = p.coords.latitude.toFixed(4); $('#lon').value = p.coords.longitude.toFixed(4); }, (e) => toast(e.message, true));
      };
      $('#saveLoc').onclick = guard(async () => { await saveConfig({ location: { latitude: $('#lat').value === '' ? null : +$('#lat').value, longitude: $('#lon').value === '' ? null : +$('#lon').value } }); PAGES.schedule(el); });
      const blank = (type) => ({ enabled: true, type, playlist: type === 'playlist' ? (LIB.playlists[0] || '') : '', sequence: '', repeat: true, repeatEvery: 0,
        command: '', args: [], multisyncCommand: false, multisyncHosts: '', days: [0, 1, 2, 3, 4, 5, 6],
        startTime: type === 'command' ? '23:00' : 'dusk', startOffset: 0, endTime: '22:00', endOffset: 0, stopType: 'graceful',
        startDate: '', startDateOffset: 0, endDate: '', endDateOffset: 0 });
      $('#addShow').onclick = () => { editing = 'new'; draft = blank('playlist'); render(); };
      $('#addCmd').onclick = () => { editing = 'new'; draft = blank('command'); render(); };
      $$('.sch[data-id]', el).forEach((row) => {
        const id = row.dataset.id;
        const i = view.entries.findIndex((x) => x.id === id);
        const e = view.entries[i];
        $('[data-toggle]', row).onchange = guard(async (ev) => { const list = clone(view.entries); list[i].enabled = ev.target.checked; await save(list, ev.target.checked ? 'Entry on' : 'Entry off'); render(); });
        $('[data-edit]', row).onclick = () => { editing = id; draft = clone(e); render(); };
        $('[data-dup]', row).onclick = () => { editing = 'new'; draft = { ...clone(e), id: undefined }; render(); };
        $('[data-del]', row).onclick = guard(async () => { if (!(await ask(`"${title(e)}" will be removed from the schedule.`, { title: 'Delete schedule entry?', ok: 'Delete', danger: true }))) return; const list = view.entries.filter((x) => x.id !== id); await save(list, 'Entry deleted'); render(); });
        $$('[data-mv]', row).forEach((b) => (b.onclick = guard(async () => {
          const j = i + +b.dataset.mv; if (j < 0 || j >= view.entries.length) return;
          const list = view.entries.slice(); [list[i], list[j]] = [list[j], list[i]]; await save(list); render();
        })));
      });
      if (editing) wireEditor();
    };
    render();
    pageTimer = setInterval(async () => { if (editing) return; try { view = await api('GET', P('/schedule')); render(); } catch {} }, 30000);
  };

  // ---------------------------------------------------------------- outputs
  PAGES.outputs = async (el) => {
    await loadConfig();
    let outs = clone(CONFIG.outputs || []);
    const render = () => {
      el.innerHTML = `
        <div class="card" data-sub="timing"><h3>Timing</h3><div class="row">
          <label>Lights offset (ms) <input type="number" id="offset" value="${CONFIG.syncOffsetMs}"></label>
          <label class="inline"><input type="checkbox" id="blank" ${CONFIG.blankBetweenSequences ? 'checked' : ''}> Blank lights between sequences</label>
          <label>Pacing (Mbit/s per controller) <input type="number" id="pacing" min="0" max="1000" step="5" value="${CONFIG.outputPacingMbps ?? 90}" style="width:90px"></label>
          <button class="btn" id="saveTiming">Save</button></div>
          <p class="dim">Positive offset shows the lights earlier than the audio. Use it for fixed latency in your audio chain (receiver, FM transmitter); a gap that grows during a song is a bug, not something to tune here.</p>
          <p class="dim">Pacing spreads each controller's packets out like FPP does (90 by default). Without it a big matrix's frame leaves at gigabit speed and the switch drops packets on the way to a 100 Mbit device (DDP errors, stale lines). 0 turns it off.</p></div>
        <div class="card" data-sub="controllers"><div class="row"><h3 style="margin:0">Controllers</h3><span class="spacer"></span>
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
        <div class="card" data-sub="test"><h3>Test patterns</h3><p class="muted">Runs only while the show is stopped.</p>
          <div class="row"><button class="btn" data-test="rgbcycle">RGB cycle</button><button class="btn" data-test="chase">Chase</button>
          <button class="btn" data-test="solid" data-color="255,255,255">White</button><button class="btn" data-test="solid" data-color="255,0,0">Red</button>
          <button class="btn" data-test="solid" data-color="0,255,0">Green</button><button class="btn" data-test="solid" data-color="0,0,255">Blue</button>
          <button class="btn primary" data-test="">Off</button></div></div>`;
      $('#saveTiming').onclick = guard(() => saveConfig({ syncOffsetMs: +$('#offset').value || 0, blankBetweenSequences: $('#blank').checked, outputPacingMbps: Math.max(0, +$('#pacing').value || 0) }));
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
    const ss = CONFIG.screenSleep || {};
    el.innerHTML = `
      <div class="card"><h3>Video</h3>
        <label class="inline"><input type="checkbox" id="vidOn" ${CONFIG.video.enabled ? 'checked' : ''}> Play a playlist item's video on HDMI</label>
        <label class="inline"><input type="checkbox" id="vidAddr" ${CONFIG.video.idleAddress ? 'checked' : ''}> Show this player's address on the screen when nothing is playing (otherwise the screen stays black)</label>
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
        <p class="dim">Matches an xLights matrix model's layout. A real video is sharper than rendered pixels, so it wins when one is found. Changes apply right away.</p>
        <button class="btn primary" id="saveDisp">Save</button></div>
      <div class="card"><div class="row"><h3 style="margin:0">Screen sleep</h3><span class="spacer"></span><span id="ssState"></span></div>
        <p class="muted">Turns the HDMI screen off when nothing has played for a while, and back on when something plays. Most PC monitors go into standby when the signal stops.</p>
        <label class="inline"><input type="checkbox" id="ssOn" ${ss.enabled ? 'checked' : ''}> Turn the screen off when idle</label>
        <div class="fields" style="margin-top:12px">
          <label>Turn off after (minutes) <input type="number" id="ssMin" min="1" max="240" value="${ss.idleMinutes || 5}"></label>
          <label>How <select id="ssMethod"><option value="hdmi" ${ss.method !== 'command' ? 'selected' : ''}>Switch the HDMI signal off</option><option value="command" ${ss.method === 'command' ? 'selected' : ''}>Run my commands</option></select></label>
        </div>
        <div class="fields" id="ssCmds" style="margin-top:12px" ${ss.method === 'command' ? '' : 'hidden'}>
          <label>Command to turn it off <input id="ssSleepCmd" class="mono" value="${esc(ss.sleepCommand || '')}" placeholder="e.g. ddcutil setvcp D6 05"></label>
          <label>Command to turn it on <input id="ssWakeCmd" class="mono" value="${esc(ss.wakeCommand || '')}" placeholder="e.g. ddcutil setvcp D6 01"></label>
        </div>
        <label class="inline" style="margin-top:12px"><input type="checkbox" id="ssShows" ${ss.keepAwakeDuringShows !== false ? 'checked' : ''}> Keep it on through scheduled shows, and wake it 2 minutes before one starts</label>
        <p class="dim">A sleeping monitor takes a few seconds to wake. During scheduled shows it stays on, so the first song isn't missed; a song started by hand wakes it right away.</p>
        <div class="row"><button class="btn primary" id="saveSS">Save</button><span class="spacer"></span><button class="btn" id="ssSleep"><i class="fas fa-moon"></i> Turn off now</button><button class="btn" id="ssWake"><i class="fas fa-sun"></i> Turn on now</button></div></div>`;
    const ssState = () => {
      const st = STATUS && STATUS.screen;
      const box = $('#ssState');
      if (!box || !st) return;
      box.innerHTML = st.asleep ? '<span class="pill">Screen off</span>' : `<span class="pill ok">Screen on</span>${st.enabled && !st.keepAwake && st.idleForMs != null ? ` <span class="dim">idle ${Math.floor(st.idleForMs / 60000)} of ${st.idleMinutes} min</span>` : st.keepAwake ? ` <span class="dim">${esc(st.keepAwake)}</span>` : ''}`
        + (st.lastError ? ` <span class="pill warn" title="${esc(st.lastError)}">last switch failed</span>` : '');
    };
    ssState();
    pageTimer = setInterval(ssState, 2000);
    $('#ssMethod').onchange = () => { $('#ssCmds').hidden = $('#ssMethod').value !== 'command'; };
    $('#saveSS').onclick = guard(() => saveConfig({ screenSleep: { enabled: $('#ssOn').checked, idleMinutes: Math.max(1, +$('#ssMin').value || 5), method: $('#ssMethod').value,
      keepAwakeDuringShows: $('#ssShows').checked, sleepCommand: $('#ssSleepCmd').value.trim(), wakeCommand: $('#ssWakeCmd').value.trim() } }));
    const ssDo = (what) => guard(async () => {
      const r = await api('POST', P('/screen/' + what));
      if (STATUS) STATUS.screen = r.status;
      ssState();
      if (r.result && r.result.ok === false) toast(`Couldn't switch the screen: ${r.result.out || 'failed'}`, true);
      else toast(what === 'sleep' ? 'Screen off' : 'Screen on');
    });
    $('#ssSleep').onclick = ssDo('sleep');
    $('#ssWake').onclick = ssDo('wake');
    $('#saveDisp').onclick = guard(() => saveConfig({
      video: { enabled: $('#vidOn').checked, idleAddress: $('#vidAddr').checked },
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
    $('#spSync').onclick = guard(async () => { const r = await api('POST', P('/showpilot/sync')); toast(`Synced ${r.synced} songs${r.removed ? `, removed ${r.removed} no longer in the playlist` : ''}${r.audio && r.audio.uploaded !== undefined ? `; audio: ${r.audio.uploaded} uploaded, ${r.audio.linked} linked` : ''}`); });
    $$('[data-mode]', el).forEach((b) => (b.onclick = guard(async () => { await api('POST', P('/showpilot/mode'), { mode: b.dataset.mode }); toast(`Viewer mode ${b.dataset.mode}`); PAGES.showpilot(el); })));
  };

  // ---------------------------------------------------------------- plugins
  const initials = (name) => String(name || '?').replace(/^fpp[-_ ]?(plugin[-_ ]?)?/i, '').split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  const pluginIcon = (src, name) => `<span class="pg-icon">${src ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<span>${esc(initials(name))}</span></span>`;
  const PAGE_LABEL = { content: 'Settings', output: 'Settings', status: 'Status', help: 'Help' };

  PAGES.plugins = async (el) => {
    let list = await api('GET', P('/plugins'));
    let catalog = null;
    let tab = 'installed';
    let q = '';
    const pageUrl = (p, pg) => `/plugin.php?plugin=${encodeURIComponent(p.name)}&page=${encodeURIComponent(pg.page)}`;

    const installedCard = (p) => {
      // One uniform Settings button: the first setup page (content/output),
      // else the first page. Other pages become small buttons.
      const pages = p.pages || [];
      const main = pages.find((x) => x.type === 'content' || x.type === 'output') || pages[0];
      const others = pages.filter((x) => x !== main);
      const badges = [
        p.deprecated ? '<span class="pill warn">Deprecated</span>' : '',
        p.native && p.ported ? '<span class="pill ok" title="This plugin\'s C++ part (made for FPP\'s fppd) is rebuilt in ShowPilot Player, so the whole plugin works here.">Runs natively in ShowPilot Player</span>'
          : p.native ? '<span class="pill warn" title="This plugin has a part that runs inside FPP\'s fppd. That part can\'t run in ShowPilot Player.">Native part can\'t run here</span>' : '',
        p.hooks && p.hooks.includes('postStart') ? '<span class="pill" title="Starts a background task when the player starts">Runs in background</span>' : '',
        p.commands && p.commands.length ? `<span class="pill" title="${esc(p.commands.join(', '))}">${p.commands.length} command${p.commands.length === 1 ? '' : 's'}</span>` : '',
      ].join('');
      return `<div class="pg-card" data-name="${esc(p.name)}">
        <div class="pg-top">${pluginIcon(p.icon ? `/api/plugin/${encodeURIComponent(p.name)}/icon` : '', p.displayName)}
          <div class="pg-info"><div class="pg-name">${esc(p.displayName)}</div>
            <div class="pg-by dim">${p.author ? esc(p.author.replace(/\s*\(.*\)\s*$/, '')) + ' · ' : ''}<span class="mono">${esc(p.name)}${p.version ? ' @ ' + esc(p.version) : ''}</span></div></div></div>
        <p class="pg-desc">${esc(p.description || 'No description.')}</p>
        ${badges ? `<div class="pg-badges">${badges}</div>` : ''}
        <div class="pg-actions">
          ${main ? `<a class="btn primary small" href="${pageUrl(p, main)}"><i class="fas fa-gear"></i> Settings</a>` : '<span class="btn small" aria-disabled="true" title="This plugin has no settings page"><i class="fas fa-gear"></i> No settings</span>'}
          ${others.map((x) => { const l = PAGE_LABEL[x.type]; const dup = !l || l === 'Settings' || others.filter((o) => PAGE_LABEL[o.type] === l).length > 1; return `<a class="btn small" href="${pageUrl(p, x)}" title="${esc(x.title)}">${esc(dup ? x.title : l)}</a>`; }).join('')}
          <span class="spacer"></span>
          ${p.homeURL ? `<a class="icon-btn2" href="${esc(p.homeURL)}" target="_blank" rel="noopener" title="Project page"><i class="fas fa-arrow-up-right-from-square"></i></a>` : ''}
          <button class="icon-btn2" data-up="${esc(p.name)}" title="Update"><i class="fas fa-rotate"></i></button>
          <button class="icon-btn2 danger" data-rm="${esc(p.name)}" title="Uninstall"><i class="fas fa-trash"></i></button>
        </div></div>`;
    };

    const catalogCard = (c, have) => `<div class="pg-card small">
        <div class="pg-top">${pluginIcon(c.icon, c.displayName)}
          <div class="pg-info"><div class="pg-name">${esc(c.displayName)}</div><div class="pg-by dim">${esc((c.author || '').replace(/\s*\(.*\)\s*$/, ''))}</div></div></div>
        <p class="pg-desc">${esc(c.description || '')}</p>
        <div class="pg-actions">${c.deprecated ? '<span class="pill warn">Deprecated</span>' : ''}<span class="spacer"></span>
          ${c.homeURL ? `<a class="icon-btn2" href="${esc(c.homeURL)}" target="_blank" rel="noopener" title="Project page"><i class="fas fa-arrow-up-right-from-square"></i></a>` : ''}
          ${c.builtIn ? '<span class="pill ok">Built in</span>' : have ? '<span class="pill ok"><i class="fas fa-check"></i> Installed</span>' : `<button class="btn small primary" data-cat="${esc(c.infoURL)}"><i class="fas fa-download"></i> Install</button>`}</div></div>`;

    const render = () => {
      const restart = STATUS && STATUS.pluginRestart;
      const reboot = STATUS && STATUS.rebootNeeded;
      const have = new Set(list.map((p) => p.name.toLowerCase()));
      const match = (x) => !q || `${x.displayName} ${x.name} ${x.description} ${x.author}`.toLowerCase().includes(q.toLowerCase());
      el.innerHTML = `
        ${reboot ? `<div class="card notice row"><span><i class="fas fa-power-off"></i> A plugin asked for a reboot.</span><span class="spacer"></span><button class="btn small" id="pgRbDismiss">Dismiss</button><button class="btn primary small" id="pgReboot">Reboot</button></div>` : ''}
        ${restart ? `<div class="card notice row"><span><i class="fas fa-rotate"></i> A plugin setting changed that needs the plugins restarted.</span><span class="spacer"></span><button class="btn primary small" id="pgRestart">Restart plugins</button></div>` : ''}
        <div class="row tabs-row">
          <div class="seg"><button type="button" data-tab="installed" class="${tab === 'installed' ? 'on' : ''}">Installed (${list.length})</button><button type="button" data-tab="browse" class="${tab === 'browse' ? 'on' : ''}">Browse FPP plugins</button><button type="button" data-tab="url" class="${tab === 'url' ? 'on' : ''}">Install from URL</button></div>
          <span class="spacer"></span>${tab !== 'url' ? `<input id="pgQ" placeholder="Search" value="${esc(q)}" style="width:200px">` : ''}
        </div>
        ${tab === 'installed' ? `<div class="pg-grid">${list.filter(match).map(installedCard).join('') || `<div class="empty"><p>${list.length ? 'No match.' : 'No plugins installed yet.'}</p>${list.length ? '' : '<p class="dim">Browse FPP\'s plugin list to add one.</p>'}</div>`}</div>
          <p class="dim" style="margin-top:14px">FPP script and PHP plugins run here: settings pages, commands, callbacks, background tasks and api.php. Parts written for FPP's fppd in C++ can't run.</p>` : ''}
        ${tab === 'browse' ? `<div id="pgCat">${catalog ? `<div class="pg-grid">${catalog.filter(match).map((c) => catalogCard(c, have.has(c.repoName.toLowerCase()) || have.has(c.name.toLowerCase()))).join('') || '<p class="dim">No match.</p>'}</div>` : '<p class="muted">Loading FPP\'s plugin list…</p>'}</div>` : ''}
        ${tab === 'url' ? `<div class="card"><h3>Install from a git URL</h3><div class="row"><input id="plUrl" style="flex:1;min-width:240px" placeholder="https://github.com/owner/fpp-plugin"><input id="plBranch" placeholder="branch (optional)" style="width:160px"><button class="btn primary" id="plInstall">Install</button></div>
          <p class="dim">A GitHub repository, or a link to a plugin's pluginInfo.json.</p></div>` : ''}
        <div class="card" id="plLogCard" hidden><div class="row"><h3 style="margin:0" id="plLogTitle">Installing…</h3><span class="spacer"></span><button class="btn small" id="plLogClose">Close</button></div><pre class="logs mono" id="plLog"></pre></div>`;
      $$('[data-tab]', el).forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); if (tab === 'browse' && !catalog) loadCatalog(); }));
      if ($('#pgQ')) $('#pgQ').oninput = (ev) => { q = ev.target.value; const pos = ev.target.selectionStart; render(); const i = $('#pgQ'); i.focus(); i.setSelectionRange(pos, pos); };
      if ($('#pgReboot')) $('#pgReboot').onclick = guard(async () => { if (!(await ask('The show stops while the Pi restarts.', { title: 'Reboot?', ok: 'Reboot', danger: true }))) return; await api('POST', P('/system/reboot')); toast('Rebooting'); });
      if ($('#pgRbDismiss')) $('#pgRbDismiss').onclick = guard(async () => { await fetch('/api/settings/rebootFlag', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: '0' }); if (STATUS) STATUS.rebootNeeded = false; render(); });
      if ($('#pgRestart')) $('#pgRestart').onclick = guard(async () => { $('#pgRestart').disabled = true; await api('POST', P('/plugins/restart')); toast('Plugins restarted'); if (STATUS) STATUS.pluginRestart = false; render(); });
      if ($('#plInstall')) $('#plInstall').onclick = () => doInstall($('#plUrl').value.trim(), $('#plBranch').value.trim());
      $$('[data-cat]', el).forEach((b) => (b.onclick = () => { b.disabled = true; doInstall(b.dataset.cat); }));
      $$('[data-up]', el).forEach((b) => (b.onclick = guard(async () => {
        b.disabled = true; b.innerHTML = '<i class="fas fa-rotate fa-spin"></i>';
        try { const r = await api('POST', P(`/plugins/${encodeURIComponent(b.dataset.up)}/update`)); toast(/Already up to date/i.test(r.log || '') ? `${r.name} is up to date` : `Updated ${r.name}`); list = await api('GET', P('/plugins')); }
        finally { render(); }
      })));
      $$('[data-rm]', el).forEach((b) => (b.onclick = guard(async () => {
        if (!(await ask(`${b.dataset.rm} will be removed. Its settings file is kept.`, { title: 'Uninstall plugin?', ok: 'Uninstall', danger: true }))) return;
        await api('DELETE', P(`/plugins/${encodeURIComponent(b.dataset.rm)}`)); toast('Uninstalled');
        list = await api('GET', P('/plugins')); render();
      })));
      if ($('#plLogClose')) $('#plLogClose').onclick = () => { $('#plLogCard').hidden = true; };
    };
    const loadCatalog = guard(async () => {
      try { catalog = await api('GET', P('/plugins/catalog')); }
      catch (e) { catalog = []; toast('Could not load FPP\'s plugin list: ' + e.message, true); }
      if (tab === 'browse') render();
    });
    const doInstall = guard(async (url, branch) => {
      if (!url) throw new Error('Enter a URL');
      $('#plLogCard').hidden = false; $('#plLogTitle').textContent = 'Installing…'; $('#plLog').textContent = `Installing ${url}…`;
      $('#plLogCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      try {
        const r = await api('POST', P('/plugins/install'), { url, branch: branch || undefined });
        list = await api('GET', P('/plugins'));
        tab = 'installed'; render();
        $('#plLogCard').hidden = false; $('#plLogTitle').textContent = `Installed ${r.name}`; $('#plLog').textContent = r.log || 'Done';
        toast(`Installed ${r.name}`);
      } catch (e) { $('#plLogTitle').textContent = 'Install failed'; $('#plLog').textContent = e.message; throw e; }
    });
    render();
  };

  // ---------------------------------------------------------------- FPP backup restore
  function wireRestore() {
    let backup = null;
    let info = null;
    const body = $('#bkBody');
    const render = () => {
      if (!info) { body.innerHTML = ''; return; }
      const m = info.meta;
      body.innerHTML = `
        <div class="bk-meta">${m.hostName ? `From <b>${esc(m.hostName)}</b>` : 'FPP backup'}${m.platform ? ` · ${esc(m.platform)}` : ''}${m.taken ? ` · taken ${new Date(m.taken).toLocaleString()}` : ''}</div>
        ${info.warnings.map((w) => `<p class="warn-text">${esc(w)}</p>`).join('')}
        <div class="row bk-bulk"><button class="btn small" id="bkAll">Select everything</button><button class="btn small" id="bkNone">Select nothing</button></div>
        ${info.sections.map((sec) => `
          <div class="bk-sec" data-sec="${esc(sec.id)}">
            <label class="inline bk-head"><input type="checkbox" data-secall> <b>${esc(sec.label)}</b> <span class="dim" data-count></span></label>
            ${sec.note ? `<p class="dim bk-note">${esc(sec.note)}</p>` : ''}
            ${sec.id === 'schedule' ? `<div class="seg bk-mode" data-mode><button type="button" data-v="replace" class="on">Replace my schedule</button><button type="button" data-v="append">Add to my schedule</button></div>` : ''}
            <div class="bk-items">${sec.items.map((it) => `
              <label class="bk-item ${it.disabled ? 'disabled' : ''}"><input type="checkbox" data-item="${esc(it.id)}" ${it.checked && !it.disabled ? 'checked' : ''} ${it.disabled ? 'disabled' : ''}>
                <span><span class="bk-label">${esc(it.label)}</span>${it.detail ? ` <span class="dim">— ${esc(it.detail)}</span>` : ''}
                ${(it.warnings || []).map((w) => `<span class="warn-text">${esc(w)}</span>`).join('')}</span></label>`).join('')}</div>
          </div>`).join('')}
        ${info.skipped.length ? `<div class="bk-skip"><b>Not restored</b><ul>${info.skipped.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        <div class="row end"><span class="muted" id="bkSel"></span><span class="spacer"></span><button class="btn" id="bkCancel">Cancel</button><button class="btn primary" id="bkGo">Restore selected</button></div>
        <div id="bkResult"></div>`;
      const count = () => {
        let total = 0;
        $$('.bk-sec', body).forEach((sec) => {
          const boxes = $$('[data-item]:not(:disabled)', sec);
          const on = boxes.filter((b) => b.checked).length;
          total += on;
          const all = $('[data-secall]', sec);
          all.checked = on > 0 && on === boxes.length; all.indeterminate = on > 0 && on < boxes.length; all.disabled = !boxes.length;
          $('[data-count]', sec).textContent = boxes.length > 1 ? `${on} of ${boxes.length}` : '';
        });
        $('#bkSel').textContent = `${total} item${total === 1 ? '' : 's'} selected`;
        $('#bkGo').disabled = !total;
      };
      $$('.bk-sec', body).forEach((sec) => {
        $('[data-secall]', sec).onchange = (e) => { $$('[data-item]:not(:disabled)', sec).forEach((b) => { b.checked = e.target.checked; }); count(); };
        $$('[data-item]', sec).forEach((b) => (b.onchange = count));
        const mode = $('[data-mode]', sec);
        if (mode) $$('button', mode).forEach((b) => (b.onclick = () => $$('button', mode).forEach((x) => x.classList.toggle('on', x === b))));
      });
      $('#bkAll').onclick = () => { $$('[data-item]:not(:disabled)', body).forEach((b) => { b.checked = true; }); count(); };
      $('#bkNone').onclick = () => { $$('[data-item]', body).forEach((b) => { b.checked = false; }); count(); };
      $('#bkCancel').onclick = () => { backup = null; info = null; $('#bkFile').value = ''; $('#bkName').textContent = ''; render(); };
      $('#bkGo').onclick = guard(async () => {
        const selection = {};
        $$('.bk-sec', body).forEach((sec) => { selection[sec.dataset.sec] = $$('[data-item]:checked', sec).map((b) => b.dataset.item); });
        const mode = $('[data-mode] .on', body);
        selection.scheduleMode = mode ? mode.dataset.v : 'replace';
        if (selection.schedule && selection.schedule.length && selection.scheduleMode === 'replace' && !(await ask('Your current schedule will be replaced with the selected entries.', { title: 'Replace schedule?', ok: 'Replace', danger: true }))) return;
        $('#bkGo').disabled = true;
        try {
          const r = await api('POST', P('/backup/restore'), { backup, selection });
          $('#bkResult').innerHTML = `<div class="bk-done"><b>Restored:</b> ${esc(r.restored.join(', ') || 'nothing')}${r.problems.length ? `<br><span class="warn-text">${esc(r.problems.join('; '))}</span>` : ''}</div>`;
          toast('Backup restored');
          loadConfig().catch(() => {});
        } finally { $('#bkGo').disabled = false; }
      });
      count();
    };
    $('#bkFile').onchange = guard(async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      $('#bkName').textContent = f.name;
      body.innerHTML = '<p class="muted">Reading…</p>';
      try {
        try { backup = JSON.parse(await f.text()); } catch { throw new Error('That file is not JSON. Choose the .json backup file FPP downloads.'); }
        info = await api('POST', P('/backup/inspect'), { backup });
        render();
      } catch (err) { backup = null; info = null; body.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
    });
  }

  // ---------------------------------------------------------------- system
  PAGES.system = async (el) => {
    await loadConfig();
    const [ad, auth, tz] = await Promise.all([api('GET', P('/audio-devices')).catch(() => ({ devices: [], auto: '' })), api('GET', P('/auth')), api('GET', P('/timezone')).catch(() => ({ current: '', zones: [] }))]);
    el.innerHTML = `
      <div class="grid g2">
        <div class="card" data-sub="general"><h3>Player</h3><div class="stack">
          <label>Name on the network <input id="host" value="${esc(CONFIG.hostName)}"></label>
          <label>Description <input id="desc" value="${esc(CONFIG.hostDescription)}"></label>
          <label>Audio output <select id="adev"><option value="auto">Automatic — ${esc(ad.auto || 'USB card if present')}</option>${ad.devices.map((d) => `<option value="${esc(d.id)}" ${d.id === CONFIG.audioDevice ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
          <label>Theme <select id="theme">${(window.SPPTheme ? SPPTheme.list : [['auto', 'Automatic']]).map(([v, l]) => `<option value="${v}" ${v === ((CONFIG.ui && CONFIG.ui.theme) || 'auto') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label>Timezone (schedules use local time) <select id="tz">${tz.zones.map((z) => `<option ${z === tz.current ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></label>
          <p class="dim">There is no volume control on purpose: set the level once at your amplifier or transmitter.</p>
          <button class="btn primary" id="saveSys">Save</button></div></div>
        <div class="card" data-sub="security"><h3>Admin password</h3><p class="muted">${auth.required ? 'The admin pages need a password.' : 'No password set: anyone on this network can use the admin pages.'}</p>
          <div class="row"><input type="password" id="pw" placeholder="New password (6+ characters)" autocomplete="new-password"><button class="btn" id="setPw">Set</button>${auth.required ? '<button class="btn danger" id="clrPw">Remove</button><button class="btn" id="logout">Sign out</button>' : ''}</div>
          <p class="dim">xLights and FPP plugins use the FPP-compatible API, which stays open like on FPP.</p></div>
        <div class="card" data-sub="updates"><h3>Player software</h3><div id="upd" class="muted">Checking…</div></div>
        <div class="card" data-sub="updates"><h3>System software</h3><div id="sysUpd" class="muted">Raspberry Pi OS packages, mpv, ffmpeg, PHP and Node.js. Updated in place, no reflashing.</div>
          <div class="row" style="margin-top:10px"><button class="btn" id="sysChk">Check</button><button class="btn primary" id="sysRun">Update system software</button></div>
          <pre class="logs mono" id="sysLog" hidden style="margin-top:10px;max-height:260px"></pre></div>
        <div class="card" data-sub="power"><h3>Power</h3><div class="row"><button class="btn" data-sys="restart">Restart player</button><button class="btn" data-sys="reboot">Reboot</button><button class="btn danger" data-sys="shutdown">Shut down</button></div>
          <p class="dim">Restart applies audio device, display and matrix changes.</p></div>
      </div>
      <div class="card" id="restoreCard" data-sub="restore"><h3>Restore from an FPP backup</h3>
        <p class="muted">Bring over playlists, the schedule, command presets, scripts, controller outputs and settings from a Falcon Player backup. You pick what to restore; network settings and passwords are never touched.</p>
        <div class="row"><label class="btn" for="bkFile" style="display:inline-flex">Choose backup file…</label><input type="file" id="bkFile" accept=".json,application/json" hidden><span class="dim" id="bkName">In FPP: Content Setup → File Manager → Backups, or Status/Control → Backups → Download.</span></div>
        <div id="bkBody"></div></div>
      <div class="card" data-sub="log"><div class="row"><h3 style="margin:0">Log</h3><span class="spacer"></span><button class="btn small" id="refLog">Refresh</button></div><pre class="logs mono" id="log"></pre></div>`;
    $('#theme').onchange = guard(async (ev) => { await setTheme(ev.target.value); });
    $('#saveSys').onclick = guard(async () => {
      if ($('#tz').value && $('#tz').value !== tz.current) await api('PUT', P('/timezone'), { timezone: $('#tz').value });
      await saveConfig({ hostName: $('#host').value.trim(), hostDescription: $('#desc').value, audioDevice: $('#adev').value, ui: { theme: $('#theme').value } });
    });
    $('#setPw').onclick = guard(async () => { await api('POST', P('/auth/password'), { password: $('#pw').value }); toast('Password set'); PAGES.system(el); });
    if ($('#clrPw')) $('#clrPw').onclick = guard(async () => { if (!(await ask('Anyone on your network will be able to open this admin page.', { title: 'Remove the admin password?', ok: 'Remove', danger: true }))) return; await api('POST', P('/auth/password'), { password: '' }); toast('Password removed'); PAGES.system(el); });
    if ($('#logout')) $('#logout').onclick = guard(async () => { await api('POST', P('/auth/logout')); location.reload(); });
    $$('[data-sys]', el).forEach((b) => (b.onclick = guard(async () => { if (!(await ask(b.dataset.sys === 'shutdown' ? 'The player turns off. You will need to unplug it and plug it back in to start it again.' : 'The show stops while the player restarts.', { title: `${b.textContent.trim()}?`, ok: b.textContent.trim(), danger: true }))) return; await api('POST', P(`/system/${b.dataset.sys}`)); toast(`${b.textContent} requested`); })));
    // System software update: check, run, then follow the log until it finishes.
    const sysShow = (st) => {
      const box = $('#sysUpd'), lg = $('#sysLog');
      if (!box) return;
      if (st.log && st.log.length) { lg.hidden = false; lg.textContent = st.log.join('\n'); lg.scrollTop = 1e9; }
      if (st.running) box.innerHTML = `<span class="pill warn">${esc(st.phase)}…</span>`;
      else if (st.ok === true) box.innerHTML = st.rebootRequired ? '<span class="pill warn">Updated — reboot to finish</span> <button class="btn small" id="sysReboot">Reboot now</button>'
        : st.restartNeeded ? '<span class="pill ok">Updated — player restarting</span>' : '<span class="pill ok">Up to date</span>';
      else if (st.ok === false) box.innerHTML = `<span class="pill bad">Failed</span> ${esc(st.error)}`;
      if ($('#sysReboot')) $('#sysReboot').onclick = guard(async () => { await api('POST', P('/system/reboot')); toast('Rebooting'); });
      $('#sysRun').disabled = !!st.running; $('#sysChk').disabled = !!st.running;
    };
    const sysPoll = async () => {
      try { const st = await api('GET', P('/system-update')); sysShow(st); if (st.running && current === 'system') setTimeout(sysPoll, 1500); }
      catch { if (current === 'system') setTimeout(sysPoll, 3000); } // the player may be restarting
    };
    $('#sysChk').onclick = guard(async () => {
      $('#sysUpd').textContent = 'Checking… (about a minute)'; $('#sysChk').disabled = true;
      try {
        const c = await api('POST', P('/system-update/check'));
        const n = c.packages.length;
        $('#sysUpd').innerHTML = `${n ? `<b>${n}</b> package${n === 1 ? '' : 's'} can be updated` : 'All packages are current'} · Node.js ${esc(c.node.current)}${c.node.updateAvailable ? ` → <b>${esc(c.node.latest)}</b>` : c.node.latest ? ' (current)' : ' (couldn\'t check for a newer version)'}${c.error ? `<br><span class="err">${esc(c.error)}</span>` : ''}`;
      } finally { $('#sysChk').disabled = false; }
    });
    $('#sysRun').onclick = guard(async () => {
      if (!(await ask('It can take several minutes. The show must be stopped.', { title: 'Update system software now?', ok: 'Update' }))) return;
      sysShow(await api('POST', P('/system-update')));
      setTimeout(sysPoll, 1500);
    });
    sysPoll();
    wireRestore();
    const loadLog = guard(async () => { const r = await api('GET', P('/logs?n=400')); $('#log').textContent = r.lines.join('\n'); $('#log').scrollTop = 1e9; });
    $('#refLog').onclick = loadLog;
    loadLog();
    const upd = async (force) => {
      try {
        const u = await api('GET', P(`/updates${force ? '?force=1' : ''}`));
        $('#upd').innerHTML = `<p>Installed: <b>${esc(u.current)}</b> · Latest: <b>${esc(u.latest || 'unknown')}</b></p>
          <div class="row">${u.updateAvailable ? '<button class="btn primary" id="doUpd">Install update</button>' : '<span class="pill ok">Up to date</span>'}<button class="btn" id="chk">Check again</button>${u.canRollback ? '<button class="btn" id="rb">Roll back</button>' : ''}</div>`;
        $('#chk').onclick = () => upd(true);
        if ($('#doUpd')) $('#doUpd').onclick = guard(async () => { if (!(await ask('The show stops while the player restarts.', { title: 'Install the update?', ok: 'Install' }))) return; await api('POST', P('/updates/apply')); toast('Updating; the page reconnects when the player is back'); });
        if ($('#rb')) $('#rb').onclick = guard(async () => { if (!(await ask('The player restarts on the version it had before the last update.', { title: 'Go back to the previous version?', ok: 'Roll back', danger: true }))) return; await api('POST', P('/updates/rollback')); toast('Rolling back'); });
      } catch (e) { $('#upd').innerHTML = `<p class="err">${esc(e.message)}</p><button class="btn" id="chk">Try again</button>`; $('#chk').onclick = () => upd(true); }
    };
    upd(false);
  };

  // ---------------------------------------------------------------- boot
  // The theme is saved with the player's settings; follow it on every device.
  const followSavedTheme = () => api('GET', P('/config')).then((c) => { CONFIG = CONFIG || c; if (window.SPPTheme && c.ui && c.ui.theme && c.ui.theme !== SPPTheme.current()) { SPPTheme.set(c.ui.theme); const ts = $('#themeSelect'); if (ts) ts.value = c.ui.theme; } if (c.ui && typeof c.ui.railPinned === 'boolean') setPinned(c.ui.railPinned); }).catch(() => {});
  followSavedTheme();
  window.addEventListener('spp-signed-in', followSavedTheme);
  pollStatus();
  route();
})();
