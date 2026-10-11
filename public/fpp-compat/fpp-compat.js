// ShowPilot Player: stand-ins for the FPP browser helpers (FPP's www/js/fpp.js)
// that plugin pages call. Same names and arguments; written for ShowPilot
// Player. Needs jQuery, jQuery UI and Bootstrap 5 (loaded by plugin.php).
(function () {
  'use strict';
  var $ = window.jQuery;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  window.settings = window.settings || {};
  window.pluginSettings = window.pluginSettings || {};
  window.hiddenChildren = window.hiddenChildren || {};

  // ---------------------------------------------------------------- notices
  function toast(msg, kind) {
    var box = document.getElementById('spp-toasts');
    if (!box) { box = document.createElement('div'); box.id = 'spp-toasts'; document.body.appendChild(box); }
    var d = document.createElement('div');
    d.className = 'spp-toast' + (kind ? ' ' + kind : '');
    d.textContent = String(msg);
    box.appendChild(d);
    setTimeout(function () { d.remove(); }, kind === 'err' ? 6000 : 3000);
  }
  $.jGrowl = function (msg, opts) {
    var s = (opts && opts.themeState) || '';
    toast($('<div>').html(String(msg)).text(), /danger|error/.test(s) ? 'err' : /detract|warn/.test(s) ? 'warn' : '');
  };

  // ---------------------------------------------------------------- dialogs (Bootstrap modals)
  window.DoModalDialog = function (options) {
    var dlg = $('#' + options.id);
    var isNew = dlg.length === 0;
    if (isNew) {
      dlg = $('#modalDialogBase').clone().attr('id', options.id);
      if (options['class']) dlg.addClass(options['class']).find('.modal-dialog').addClass(options['class']);
      $('body').append(dlg);
      if (typeof options.open === 'function') dlg.on('show.bs.modal', function () { options.open.call(dlg[0]); });
      if (typeof options.close === 'function') dlg.on('hide.bs.modal', function () { options.close.call(dlg[0]); });
      if (typeof options.body !== 'string' && options.body) { dlg.find('.modal-body').append(options.body); $(options.body).removeClass('hidden'); }
      if (typeof options.title !== 'string' && options.title) dlg.find('.modal-title').append(options.title);
    }
    if ('footer' in options || 'buttons' in options) {
      var footer = dlg.find('.modal-footer');
      if (!footer.length) footer = $('<div class="modal-footer"></div>').appendTo(dlg.find('.modal-content'));
      footer.html(options.footer || '');
      $.each(options.buttons || {}, function (label, b) {
        var click = typeof b === 'function' ? b : (b && b.click) || function () {};
        var btn = $('<button type="button" class="buttons btn btn-secondary"></button>').text((b && b.text) || label);
        if (b && b.id) btn.attr('id', b.id);
        if (b && b['class']) btn.addClass(b['class']);
        if (b && b.disabled) btn.prop('disabled', true);
        if (b && b.style) btn.attr('style', b.style);
        btn.on('click', function () { click.call(dlg[0]); });
        footer.append(btn);
      });
    } else if (isNew) dlg.find('.modal-footer').remove();
    if (options.noClose) dlg.find('#modalCloseButton').prop('disabled', true);
    if (typeof options.title === 'string') dlg.find('.modal-title').html(options.title);
    if (typeof options.body === 'string') dlg.find('.modal-body').html(options.body);
    var m = bootstrap.Modal.getOrCreateInstance(dlg[0], { backdrop: options.backdrop !== undefined ? options.backdrop : true, keyboard: options.keyboard !== false });
    m.show();
    if (options.focus) dlg.one('shown.bs.modal', function () { var f = typeof options.focus === 'function' ? options.focus() : options.focus; if (typeof f === 'string') $('#' + f).trigger('focus'); });
  };
  window.CloseModalDialog = function (id) { var el = document.getElementById(id); var m = el && bootstrap.Modal.getInstance(el); if (m) m.hide(); };
  window.EnableModalDialogCloseButton = function (id) {
    $('#' + id).find('#modalCloseButton').prop('disabled', false);
    $('#' + id + 'CloseButton').prop('disabled', false).text('Close');
  };
  window.ProgressDialogDone = function (textId) { window.EnableModalDialogCloseButton(String(textId).replace(/Text$/, '')); };
  window.SetProgressDialogStatus = function (id, status) { $('#' + id + ' .modal-title').text(status); };
  window.DisplayProgressDialog = function (id, title) {
    window.DoModalDialog({ id: id, title: title, noClose: true, backdrop: 'static', keyboard: false, 'class': 'modal-dialog-scrollable modal-lg',
      body: "<textarea style='width:100%;height:50vh' class='form-control font-monospace' disabled id='" + id + "Text'></textarea>",
      buttons: { Close: { text: 'Please Wait', disabled: true, id: id + 'CloseButton', click: function () { window.CloseModalDialog(id); location.reload(); } } } });
  };
  window.DisplayConfirmationDialog = function (id, title, body, yes, yesClass) {
    window.DoModalDialog({ id: id, title: title, body: body, buttons: {
      Yes: { click: function () { window.CloseModalDialog(id); yes(); }, 'class': yesClass || 'btn-primary' },
      No: function () { window.CloseModalDialog(id); } } });
  };
  window.DialogOK = function (title, message) {
    window.DoModalDialog({ id: 'sppDialogOK', title: esc(title || ''), body: String(message || ''), buttons: { OK: function () { window.CloseModalDialog('sppDialogOK'); } } });
  };
  // Plugins' own alert() calls show as a themed dialog instead of the
  // browser's box. (alert() doesn't wait for OK here; plugins only use it to
  // tell the user something, so nothing depends on that. confirm() and
  // prompt() must return an answer right away, so those stay native.)
  var alertCount = 0;
  window.alert = function (message) {
    var id = 'sppAlert' + (++alertCount);
    var t = $('.spp-bar .spp-title').first().text() || 'Notice';
    try {
      window.DoModalDialog({ id: id, title: esc(t), body: '<p style="white-space:pre-wrap;margin:0">' + esc(message == null ? '' : message) + '</p>',
        buttons: { OK: { click: function () { window.CloseModalDialog(id); }, 'class': 'btn-primary' } } });
      $('#' + id).one('hidden.bs.modal', function () { var m = bootstrap.Modal.getInstance(this); if (m) m.dispose(); $(this).remove(); });
    } catch (e) { toast(String(message == null ? '' : message)); }
  };
  window.DialogError = function (title, message) { toast((title ? title + ': ' : '') + $('<div>').html(String(message || '')).text(), 'err'); };

  // FPP's fppDialog() is a modal wrapper with jQuery UI dialog options.
  $.fn.fppDialog = function (opts) {
    if (typeof opts === 'string') return this.dialog(opts === 'close' ? 'close' : opts);
    return this.dialog($.extend({ modal: true, width: 'auto' }, opts || {}));
  };
  $.fn.fppDialogClose = function () { return this.dialog('close'); };

  // ---------------------------------------------------------------- settings
  function flagBanner() {
    var el = document.getElementById('spp-restart');
    if (!el) return;
    var r = parseInt(window.settings.restartFlag || 0, 10), b = parseInt(window.settings.rebootFlag || 0, 10);
    if (!r && !b) { el.innerHTML = ''; return; }
    el.innerHTML = '<span class="spp-flag">' + (b ? 'A plugin asked for a reboot' : 'Restart plugins to apply') + '</span> ' +
      (b ? '<button type="button" class="btn btn-sm btn-outline-secondary" id="spp-flag-dismiss">Dismiss</button> ' : '') +
      '<button type="button" class="btn btn-sm btn-warning" id="spp-restart-btn">' + (b ? 'Reboot' : 'Restart plugins') + '</button>';
    var dis = document.getElementById('spp-flag-dismiss');
    if (dis) dis.onclick = function () { putSetting('/api/settings/rebootFlag', 0).always(function () { window.settings.rebootFlag = 0; flagBanner(); }); };
    document.getElementById('spp-restart-btn').onclick = function () {
      this.disabled = true;
      fetch(b ? '/api/player/system/reboot' : '/api/player/plugins/restart', { method: 'POST' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); if (b) window.settings.rebootFlag = 0; else window.settings.restartFlag = 0; flagBanner(); toast(b ? 'Rebooting' : 'Plugins restarted'); })
        .catch(function (e) { toast('Could not restart: ' + e.message, 'err'); });
    };
  }
  window.CheckRestartRebootFlags = flagBanner;
  $(flagBanner);

  function putSetting(url, value) { return $.ajax({ url: url, data: '' + value, method: 'PUT', contentType: 'text/plain', timeout: 120000 }); }
  window.SetSetting = function (key, value, restart, reboot, hideChange, isBool, callback, failCallback) {
    if (isBool === undefined) isBool = null;
    return putSetting('/api/settings/' + encodeURIComponent(key), value).done(function () {
      window.settings[key] = value;
      if (key !== 'restartFlag' && key !== 'rebootFlag') {
        if (restart > 0 && restart != window.settings.restartFlag) window.SetRestartFlag(restart);
        if (reboot > 0) window.SetRebootFlag();
        if (!hideChange) $.jGrowl(key + (isBool === null ? ' setting saved.' : isBool ? ' Enabled.' : ' Disabled.'), { themeState: isBool === false ? 'detract' : 'success' });
      }
      flagBanner();
      if (typeof callback === 'function') callback(); else if (typeof callback === 'string' && typeof window[callback] === 'function') window[callback]();
    }).fail(function () {
      window.DialogError('Save Setting', 'Failed to save ' + key + ' setting.');
      if (typeof failCallback === 'function') failCallback();
    });
  };
  window.SetPluginSetting = function (plugin, key, value, restart, reboot, isBool, callback, failCallback) {
    // Older ShowPilot Player pages called SetPluginSetting(plugin, key, value, callbackName).
    if (typeof restart === 'string' && restart !== '' && isNaN(restart)) { callback = restart; restart = 0; }
    if (isBool === undefined) isBool = null;
    var url = plugin ? '/api/plugin/' + encodeURIComponent(plugin) + '/settings/' + encodeURIComponent(key) : '/api/settings/' + encodeURIComponent(key);
    return putSetting(url, value).done(function () {
      window.pluginSettings[key] = value;
      if (restart > 0 && restart != window.settings.restartFlag) window.SetRestartFlag(restart);
      if (reboot > 0) window.SetRebootFlag();
      $.jGrowl(key + (isBool === null || isBool === undefined ? ' setting saved.' : isBool ? ' Enabled.' : ' Disabled.'), { themeState: isBool === false || isBool === 0 ? 'detract' : 'success' });
      if (typeof callback === 'function') callback(); else if (typeof callback === 'string' && typeof window[callback] === 'function') window[callback]();
    }).fail(function () {
      window.DialogError('Save Setting', 'Failed to save ' + key + ' setting.');
      if (typeof failCallback === 'function') failCallback();
    });
  };
  window.SetRestartFlag = function (n) {
    n = parseInt(n, 10) || 1;
    if (n === 2 && window.settings.restartFlag == 1) return;
    window.settings.restartFlag = n;
    putSetting('/api/settings/restartFlag', n).always(flagBanner);
  };
  window.SetRebootFlag = function () { window.settings.rebootFlag = 1; putSetting('/api/settings/rebootFlag', 1).always(flagBanner); };
  window.ClearRestartFlag = function () { window.settings.restartFlag = 0; putSetting('/api/settings/restartFlag', 0).always(flagBanner); };
  window.ClearRebootFlag = function () { window.settings.rebootFlag = 0; putSetting('/api/settings/rebootFlag', 0).always(flagBanner); };
  window.SetSettingRestart = function (k, v) { window.SetSetting(k, v, 1, 0); };
  window.SetSettingReboot = function (k, v) { window.SetSetting(k, v, 0, 1); };
  window.reloadSettingsPage = function () { location.reload(); };
  window.ReloadSettingOptions = function () {};
  window.UpdateChildSettingsVisibility = function () {
    window.hiddenChildren = {};
    $('.parentSetting').each(function () { var f = window['Update' + this.id + 'Children']; if (typeof f === 'function') f(2); });
    $('.parentSetting').each(function () { var f = window['Update' + this.id + 'Children']; if (typeof f === 'function') f(1); });
  };
  window.TogglePasswordHideShow = function (setting) {
    var x = document.getElementById(setting);
    if (x) x.type = x.type === 'password' ? 'text' : 'password';
  };
  window.RegexCheckData = function (regexStr, value, desc, hideValue) {
    if (new RegExp(regexStr).test(value)) return true;
    window.DialogError('Invalid value', (hideValue ? 'The value' : '"' + esc(value) + '"') + ' is not valid. ' + (desc || ''));
    return false;
  };

  // ---------------------------------------------------------------- requests
  window.Get = function (url, async, silent) {
    var r = {};
    $.ajax({ url: url, async: !!async, dataType: 'json', success: function (d) { r = d; },
      error: function () { if (!silent) window.DialogError('Error', 'Error loading ' + url); } });
    return r;
  };
  window.Post = function (url, async, data, silent) {
    var r = {};
    $.ajax({ url: url, type: 'POST', async: !!async, data: data, dataType: 'json', contentType: 'application/json', success: function (d) { r = d; },
      error: function () { if (!silent) window.DialogError('Error', 'Error posting to ' + url); } });
    return r;
  };
  window.Put = function (url, async, data, silent) {
    var r = {};
    $.ajax({ url: url, type: 'PUT', async: !!async, data: data, dataType: 'json', contentType: 'application/json', success: function (d) { r = d; },
      error: function () { if (!silent) window.DialogError('Error', 'Error saving to ' + url); } });
    return r;
  };
  window.StreamURL = function (url, id, doneCallback, errorCallback, reqType, postData, postContentType, postProcessData, raw, dataCallback) {
    var out = document.getElementById(id);
    var seen = 0;
    var call = function (cb, arg) { if (typeof cb === 'function') cb(arg); else if (cb && typeof window[cb] === 'function') window[cb](arg); };
    $.ajax(url, {
      type: reqType || 'GET', contentType: postContentType || undefined, data: postData || null, processData: postProcessData !== false, cache: false,
      xhrFields: { onprogress: function (e) {
        var all = e.currentTarget.response || '';
        var chunk = all.substring(seen); seen = all.length;
        if (out) {
          if (out.nodeName === 'TEXTAREA' || out.nodeName === 'INPUT') out.value += chunk;
          else if (raw === true) out.innerHTML += chunk;
          else out.appendChild(document.createTextNode(chunk));
          out.scrollTop = out.scrollHeight;
        }
        if (dataCallback) call(dataCallback, all);
      } }
    }).done(function () { call(doneCallback, id); }).fail(function () { call(errorCallback, id); });
  };

  // ---------------------------------------------------------------- small helpers
  window.SetButtonState = function (el, state) { $(el).prop('disabled', state !== 'enable').toggleClass('disableButtons', state !== 'enable'); };
  window.EnableButtonClass = function (c) { $('.' + c).each(function () { window.SetButtonState(this, 'enable'); }); };
  window.DisableButtonClass = function (c) { $('.' + c).each(function () { window.SetButtonState(this, 'disable'); }); };
  window.getViewport = function () {
    var w = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    return w <= 576 ? 'xs' : w <= 768 ? 'sm' : w <= 992 ? 'md' : w <= 1200 ? 'lg' : w <= 1400 ? 'xl' : 'xxl';
  };
  window.PadLeft = function (s, pad, len) { s = String(s); while (s.length < len) s = pad + s; return s; };
  window.PingIP = function (ip) { if (ip) window.DialogOK('Ping ' + ip, 'Ping is not available in ShowPilot Player.'); };
  window.ViewFileImpl = function (url, file, html) {
    $.get(url, function (text) {
      window.DoModalDialog({ id: 'sppViewFile', title: esc(file || url), 'class': 'modal-xl modal-dialog-scrollable',
        body: html ? String(text) : '<pre class="spp-file">' + esc(text) + '</pre>', buttons: { Close: function () { window.CloseModalDialog('sppViewFile'); } } });
    }, 'text');
  };
  window.ViewFile = function (dir, file) { window.ViewFileImpl('/api/file/' + encodeURIComponent(dir) + '/' + encodeURIComponent(file), file); };
  window.GetHelpPage = window.GetHelpPage || function () {};

  // ---------------------------------------------------------------- FPP command editor
  // Same element ids as FPP: a <select id=commandSelect>, a <table id=tbl> that
  // gets rows <tr id=tbl_arg_N_row> with inputs id=tbl_arg_N, and optional
  // tbl_multisync / tbl_multisyncHosts.
  window.allowMultisyncCommands = window.allowMultisyncCommands || false;
  window.commandList = '';
  window.commandListByName = {};
  window.extraCommands = '';
  window.PopulateCommandListCache = function () {
    if (typeof window.commandList !== 'string') return;
    $.ajax({ dataType: 'json', url: '/api/commands', async: false, success: function (d) {
      window.commandList = d;
      if (window.extraCommands) $.each(window.extraCommands, function (k, v) { window.commandList.push(v); });
      $.each(window.commandList, function (k, v) { window.commandListByName[v.name] = v; });
    } });
  };
  window.LoadCommandList = function (sel, current) {
    if (typeof sel === 'string') sel = $('#' + sel);
    window.PopulateCommandListCache();
    var groups = {};
    $.each(window.commandList || [], function (k, c) { var g = c.category || 'Other'; (groups[g] = groups[g] || []).push(c.name); });
    $.each(Object.keys(groups).sort(), function (i, g) {
      var og = $('<optgroup>').attr('label', g);
      $.each(groups[g], function (j, n) { og.append($('<option>').attr('value', n).text(n)); });
      sel.append(og);
    });
    if (current !== undefined) sel.val(current);
  };
  function listFor(url) {
    var out = [];
    $.ajax({ url: url.charAt(0) === '/' ? url : '/' + url, dataType: 'json', async: false, success: function (d) {
      if (Array.isArray(d)) out = d.map(function (x) { return typeof x === 'object' && x ? (x.name || x.Name || JSON.stringify(x)) : String(x); });
      else if (d && typeof d === 'object') out = Object.keys(d).map(function (k) { return { label: k, value: d[k] }; });
    } });
    return out;
  }
  window.PrintArgInputs = function (tbl, configAdjustable, args, startCount) {
    var n = startCount || 1;
    var table = $('#' + tbl);
    $.each(args || [], function (i, a) {
      var id = tbl + '_arg_' + n;
      var row = $('<tr>').attr('id', id + '_row').addClass('arg_row_' + a.name);
      var label = $('<td>').text((a.description || a.name) + ':');
      var cell = $('<td>');
      var input;
      var def = a['default'] !== undefined ? String(a['default']) : '';
      if (a.type === 'bool') input = $('<input type="checkbox">').prop('checked', def === 'true' || def === '1');
      else if (a.contents || a.contentListUrl) {
        input = $('<select class="form-select form-select-sm">');
        var items = a.contents ? a.contents : listFor(a.contentListUrl);
        if (a.allowBlanks || a.optional) input.append('<option value=""></option>');
        $.each(items, function (j, it) {
          var o = typeof it === 'object' ? it : { label: it, value: it };
          input.append($('<option>').attr('value', o.value).text(o.label));
        });
        if (def !== '') input.val(def);
      } else if (a.type === 'int' || a.type === 'range') {
        input = $('<input type="number" class="form-control form-control-sm">').val(def);
        if (a.min !== undefined) input.attr('min', a.min);
        if (a.max !== undefined) input.attr('max', a.max);
      } else if (a.type === 'color') input = $('<input type="color">').val(def ? '#' + def.replace('#', '') : '#ff0000');
      else input = $('<input type="text" class="form-control form-control-sm">').val(def);
      input.attr('id', id).data('arg-type', a.type).attr('data-arg-type', a.type);
      cell.append(input);
      table.append(row.append(label, cell));
      n++;
    });
    return n;
  };
  window.CommandSelectChanged = function (sel, tbl, configAdjustable, printFunc) {
    for (var x = 1; x < 25; x++) $('#' + tbl + '_arg_' + x + '_row').remove();
    $('#' + tbl + '_multisync_row, #' + tbl + '_multisyncHosts_row, #' + tbl + '_description_row').remove();
    var name = $('#' + sel).val();
    if (!name) return;
    window.PopulateCommandListCache();
    var co = window.commandListByName[name];
    if (!co) return;
    var t = $('#' + tbl);
    if (co.description) t.append($('<tr>').attr('id', tbl + '_description_row').append($('<td colspan="2" class="text-muted small">').text(co.description)));
    (typeof printFunc === 'function' ? printFunc : window.PrintArgInputs)(tbl, configAdjustable, co.args || [], 1);
    if (window.allowMultisyncCommands) {
      t.append($('<tr>').attr('id', tbl + '_multisync_row').append($('<td>').text('Multicast:'), $('<td>').append($('<input type="checkbox">').attr('id', tbl + '_multisync'))));
      t.append($('<tr>').attr('id', tbl + '_multisyncHosts_row').append($('<td>').text('Hosts:'), $('<td>').append($('<input type="text" class="form-control form-control-sm">').attr('id', tbl + '_multisyncHosts'))));
    }
  };
  window.CommandToJSON = function (sel, tbl, json, addArgTypes) {
    var args = [], types = [];
    json = json || {};
    json.command = $('#' + sel).val();
    if (json.command) {
      json.multisyncCommand = $('#' + tbl + '_multisync').is(':checked');
      json.multisyncHosts = String($('#' + tbl + '_multisyncHosts').val() || '').split(',').map(function (h) { return h.trim(); }).filter(Boolean).join(',');
      for (var x = 1; x < 20; x++) {
        var inp = $('#' + tbl + '_arg_' + x);
        if (!inp.length) continue;
        var v = inp.attr('type') === 'checkbox' ? (inp.is(':checked') ? 'true' : 'false') : inp.attr('type') === 'color' ? String(inp.val()).replace('#', '') : inp.val();
        if (Array.isArray(v)) v = v.toString();
        if (v === undefined || v === null) continue;
        args.push(v);
        types.push(inp.data('arg-type'));
      }
    }
    json.args = args;
    if (addArgTypes) json.argTypes = types;
    return json;
  };
  window.PopulateExistingCommand = function (json, sel, tbl, configAdjustable, printFunc) {
    if (!json) return;
    $('#' + sel).val(json.command);
    window.CommandSelectChanged(sel, tbl, configAdjustable, printFunc);
    $('#' + tbl + '_multisync').prop('checked', !!json.multisyncCommand);
    $('#' + tbl + '_multisyncHosts').val(json.multisyncHosts || '');
    $.each(json.args || [], function (i, v) {
      var inp = $('#' + tbl + '_arg_' + (i + 1));
      if (inp.attr('type') === 'checkbox') inp.prop('checked', v === 'true' || v === true || v === '1');
      else if (inp.attr('type') === 'color') inp.val('#' + String(v).replace('#', ''));
      else {
        if (inp.is('select') && v !== '' && !inp.find('option').filter(function () { return this.value == v; }).length) inp.append($('<option>').attr('value', v).text(v));
        inp.val(v);
      }
    });
  };
  window.ShowCommandEditor = function (target, data, callback, cancelCallback, args) {
    if (typeof args !== 'object' || !args) args = { title: 'FPP Command Editor', saveButton: 'Accept Changes', cancelButton: 'Cancel Edit' };
    window.allowMultisyncCommands = true;
    var body = $('<div><select id="sppCmdEditorSelect" class="form-select mb-2"><option value=""></option></select><table id="sppCmdEditorTbl" class="table table-sm"></table></div>');
    var call = function (cb, a, b) { if (typeof cb === 'function') cb(a, b); else if (cb && typeof window[cb] === 'function') window[cb](a, b); };
    $('#sppCmdEditor').remove();
    var buttons = {};
    buttons[args.saveButton || 'Accept Changes'] = { 'class': 'btn-primary', click: function () {
      var json = window.CommandToJSON('sppCmdEditorSelect', 'sppCmdEditorTbl', {});
      window.CloseModalDialog('sppCmdEditor'); call(callback, target, json);
    } };
    buttons[args.cancelButton || 'Cancel Edit'] = function () { window.CloseModalDialog('sppCmdEditor'); call(cancelCallback, target); };
    window.DoModalDialog({ id: 'sppCmdEditor', title: esc(args.title || 'FPP Command Editor'), body: body, buttons: buttons, 'class': 'modal-lg' });
    window.LoadCommandList('sppCmdEditorSelect');
    $('#sppCmdEditorSelect').on('change', function () { window.CommandSelectChanged('sppCmdEditorSelect', 'sppCmdEditorTbl', true); });
    if (data && data.command) window.PopulateExistingCommand(data, 'sppCmdEditorSelect', 'sppCmdEditorTbl', true);
  };
})();
