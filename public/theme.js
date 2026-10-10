// ShowPilot Player themes (the same set as ShowPilot's admin). Shared by the
// admin UI and plugin pages. The choice is saved in the player's settings;
// the browser keeps a copy so pages open in the right theme straight away.
(function () {
  var THEMES = [
    ['auto', 'Automatic (follow this device)'],
    ['stage-dark', 'Stage · Dark'],
    ['stage-light', 'Stage · Light'],
    ['christmas', '🎄 Christmas'],
    ['halloween', '🎃 Halloween'],
    ['easter', '🐰 Easter'],
    ['stpatricks', '☘️ St. Patrick\'s'],
    ['independence', '🎆 Independence Day'],
    ['valentines', '💝 Valentine\'s'],
  ];
  var LIGHT = { 'stage-light': 1, easter: 1 };
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var stored = function () { try { return localStorage.getItem('spp-theme'); } catch (e) { return null; } };
  var chosen = root.getAttribute('data-spp-theme') || stored() || 'auto';
  function resolve(t) { return t === 'auto' || !t ? (mq && !mq.matches ? 'stage-light' : 'stage-dark') : t; }
  function apply(t) {
    var r = resolve(t);
    root.className = root.className.replace(/\btheme-[a-z-]+\b/g, '').trim();
    root.classList.add('theme-' + r);
    var mode = LIGHT[r] ? 'light' : 'dark';
    root.setAttribute('data-bs-theme', mode);
    root.style.colorScheme = mode;
  }
  apply(chosen);
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (chosen === 'auto') apply(chosen); });
  window.SPPTheme = {
    list: THEMES,
    current: function () { return chosen; },
    set: function (t) {
      if (!THEMES.some(function (x) { return x[0] === t; })) t = 'auto';
      chosen = t;
      try { localStorage.setItem('spp-theme', t); } catch (e) {}
      root.setAttribute('data-spp-theme', t);
      apply(t);
    },
  };
})();
