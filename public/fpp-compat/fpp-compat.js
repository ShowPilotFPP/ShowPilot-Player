// ShowPilot Player: small stand-ins for FPP UI helpers that plugin pages call.
(function () {
  function toast(msg, isErr) {
    var d = document.createElement('div');
    d.className = 'spp-toast' + (isErr ? ' err' : '');
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 3500);
  }
  window.SetPluginSetting = function (plugin, setting, value, callback) {
    var url = plugin ? '/api/plugin/' + encodeURIComponent(plugin) + '/settings/' + encodeURIComponent(setting)
                     : '/api/settings/' + encodeURIComponent(setting);
    return fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: String(value) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); toast(setting + ' saved'); if (callback && window[callback]) window[callback](); })
      .catch(function (e) { toast('Could not save ' + setting + ': ' + e.message, true); });
  };
  window.SetSetting = function (setting, value) { return window.SetPluginSetting('', setting, value); };
  window.DialogOK = function (title, msg) { alert((title ? title + '\n\n' : '') + (msg || '')); };
  window.DialogError = function (title, msg) { toast((title ? title + ': ' : '') + (msg || ''), true); };
  window.$.jGrowl = function (msg, opts) { toast(String(msg), opts && /error|danger/.test(opts.themeState || '')); };
  window.Get = function (url, async) { var r = null; $.ajax({ url: url, async: !!async, success: function (d) { r = d; } }); return r; };
  window.Post = function (url, async, data) { var r = null; $.ajax({ url: url, type: 'POST', async: !!async, data: data, success: function (d) { r = d; } }); return r; };
})();
