<?php
// ShowPilot Player: stand-in for the parts of FPP's www/common.php that
// plugins call. Written for ShowPilot Player against FPP's documented
// behaviour (same function names, arguments, element ids and generated
// <name>Changed() functions) so plugin pages and their JS keep working.
// Settings helpers read/write the same files FPP uses.
require_once __DIR__ . '/config.php';

if (!function_exists('ReadSettingFromFile')):

// ---------------------------------------------------------------- settings files

function __spp_settings_file($plugin) {
    global $settings;
    if ($plugin === '' || $plugin === null) return $settings['settingsFile'];
    if (!preg_match('/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/', $plugin)) return null;
    return $settings['configDirectory'] . '/plugin.' . $plugin;
}

function custom_parse_ini_file($file) { return __spp_parse_settings($file); }

function ReadSettingFromFile($setting, $plugin = '') {
    $f = __spp_settings_file($plugin);
    if (!$f) return false;
    $all = __spp_parse_settings($f);
    return array_key_exists($setting, $all) ? $all[$setting] : false;
}

// FPP writes key = "value", except values that are JSON objects/arrays.
function WriteSettingToFile($setting, $value, $plugin = '') {
    global $settings, $pluginSettings;
    $f = __spp_settings_file($plugin);
    if (!$f || !preg_match('/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/', $setting)) return false;
    $value = is_bool($value) ? ($value ? '1' : '0') : (string)$value;
    $value = str_replace(array("\r", "\n"), ' ', $value);
    $fp = @fopen($f . '.lock', 'c');
    if ($fp) flock($fp, LOCK_EX);
    $lines = is_readable($f) ? file($f, FILE_IGNORE_NEW_LINES) : array();
    $out = array();
    foreach ($lines as $line) {
        if (preg_match('/^\s*' . preg_quote($setting, '/') . '\s*=/', $line)) continue;
        $out[] = $line;
    }
    $t = ltrim($value);
    $isJson = $t !== '' && ($t[0] === '{' || $t[0] === '[') && json_decode($value) !== null;
    $out[] = $setting . ' = ' . ($isJson ? $value : '"' . $value . '"');
    $tmp = $f . '.tmp' . getmypid();
    file_put_contents($tmp, implode("\n", $out) . "\n");
    $ok = rename($tmp, $f);
    if ($fp) { flock($fp, LOCK_UN); fclose($fp); }
    if ($plugin === '' || $plugin === null) $settings[$setting] = $value;
    elseif (is_array($pluginSettings)) $pluginSettings[$setting] = $value;
    return $ok;
}

function GetSettingValue($setting, $default = '', $plugin = '') {
    $v = ReadSettingFromFile($setting, $plugin);
    return $v === false ? $default : $v;
}

function ParseBooleanValue($value) {
    return $value == '1' || $value === true || $value == 'true' || $value == 'TRUE' || $value == 'ON' || $value == 'on';
}

// ---------------------------------------------------------------- settings.json (plugin setting definitions)

$settingInfos = isset($settingInfos) ? $settingInfos : array();
$settingGroups = isset($settingGroups) ? $settingGroups : array();
$pluginSettingInfos = isset($pluginSettingInfos) ? $pluginSettingInfos : array();
$pluginSettingInfosLoaded = 0;

function LoadSettingInfos() { /* FPP's own settings are not editable from plugin pages here */ }

function LoadPluginSettingInfos($plugin) {
    global $settings, $settingInfos, $settingGroups, $pluginSettingInfos, $pluginSettingInfosLoaded;
    if ($pluginSettingInfosLoaded === $plugin) return;
    $pluginSettingInfosLoaded = $plugin;
    $pluginSettingInfos = array();
    $file = $settings['pluginDirectory'] . '/' . $plugin . '/settings.json';
    if (!preg_match('/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/', $plugin) || !is_readable($file)) return;
    $data = json_decode(file_get_contents($file), true);
    if (!is_array($data)) return;
    $pluginSettingInfos = isset($data['settings']) && is_array($data['settings']) ? $data['settings'] : array();
    $settingInfos = array_merge($settingInfos, $pluginSettingInfos);
    if (isset($data['settingGroups']) && is_array($data['settingGroups'])) $settingGroups = array_merge($settingGroups, $data['settingGroups']);
}

function MergeDefaultsFromPluginSettings($plugin) {
    global $pluginSettingInfos, $pluginSettings;
    LoadPluginSettingInfos($plugin);
    foreach ($pluginSettingInfos as $k => $s) {
        if (!isset($pluginSettings[$k]) && isset($s['default'])) $pluginSettings[$k] = $s['default'];
    }
}

function LoadPluginSettings($pluginName) {
    global $pluginSettings;
    $f = __spp_settings_file($pluginName);
    $pluginSettings = $f ? __spp_parse_settings($f) : array();
    MergeDefaultsFromPluginSettings($pluginName);
    return $pluginSettings;
}

function ShouldPrintSetting($s) {
    global $settings;
    $level = isset($s['level']) ? (int)$s['level'] : 0;
    if ((int)$settings['uiLevel'] < $level) return false;
    if (isset($s['fppModes']) && is_array($s['fppModes']) && !in_array('ALL', $s['fppModes']) && !in_array($settings['fppMode'], $s['fppModes'])) return false;
    if (isset($s['platforms']) && is_array($s['platforms'])) {
        $incl = array_filter($s['platforms'], function ($p) { return $p !== '' && $p[0] !== '!'; });
        if (in_array('!' . $settings['Platform'], $s['platforms'])) return false;
        if ($incl && !in_array('ALL', $incl) && !in_array($settings['Platform'], $incl)) return false;
    }
    if (isset($s['checkFile']) && is_array($s['checkFile'])) {
        $ok = false;
        foreach ($s['checkFile'] as $f) {
            $neg = $f !== '' && $f[0] === '!';
            if ($neg) $f = substr($f, 1);
            if (file_exists($f) !== $neg) $ok = true;
        }
        if (!$ok) return false;
    }
    return true;
}

// ---------------------------------------------------------------- printing helpers

function __spp_attr($s) { return htmlspecialchars((string)$s, ENT_QUOTES); }
function __spp_js($s) { return json_encode((string)$s, JSON_HEX_TAG | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_HEX_AMP); }
function __spp_jsid($setting) { return str_replace('.', '\\\\.', $setting); }

// Current value: the page's $pluginSettings / $settings, else the file, else the default.
function __spp_current($setting, $pluginName, $default) {
    global $settings, $pluginSettings;
    if ($pluginName !== '' && $pluginName !== null) {
        if (is_array($pluginSettings) && array_key_exists($setting, $pluginSettings)) return $pluginSettings[$setting];
        $v = ReadSettingFromFile($setting, $pluginName);
        return $v === false ? $default : $v;
    }
    return isset($settings[$setting]) ? $settings[$setting] : $default;
}

// FPP: a callback name gets "('<setting>');" appended unless it already ends in ")".
function __spp_callback($callbackName, $setting) {
    $callbackName = trim((string)$callbackName);
    if ($callbackName === '') return '';
    if (substr($callbackName, -1) === ')' || substr($callbackName, -2) === ');') return $callbackName . ';';
    return $callbackName . '(' . __spp_js($setting) . ');';
}

// The JS save call FPP pages generate: SetPluginSetting(plugin, key, value, restart, reboot, isBool, callback, fail)
function __spp_save_js($pluginName, $setting, $valueExpr, $restart, $reboot, $isBool, $onSuccess, $onFail = '') {
    $store = ($pluginName !== '' && $pluginName !== null) ? 'pluginSettings' : 'settings';
    $ok = "function(){ if (typeof $store !== 'undefined') { $store" . '[' . __spp_js($setting) . '] = value; } ' . $onSuccess . ' }';
    $fail = $onFail !== '' ? "function(){ $onFail }" : "''";
    if ($pluginName !== '' && $pluginName !== null) {
        return 'SetPluginSetting(' . __spp_js($pluginName) . ', ' . __spp_js($setting) . ", $valueExpr, " . (int)$restart . ', ' . (int)$reboot . ", $isBool, $ok, $fail);";
    }
    return 'SetSetting(' . __spp_js($setting) . ", $valueExpr, " . (int)$restart . ', ' . (int)$reboot . ", false, $isBool, $ok, $fail);";
}

function __spp_changed_name($setting, $changedFunction = '') {
    return $changedFunction !== '' ? $changedFunction : str_replace('.', '', $setting) . 'Changed';
}

function IfSettingEqualPrint($setting, $value, $print, $pluginName = '', $defaultValue = '') {
    if ((string)__spp_current($setting, $pluginName, $defaultValue) === (string)$value) echo $print;
}

function IfSettingInListPrint($setting, $value, $print, $pluginName = '') {
    $cur = explode(',', (string)__spp_current($setting, $pluginName, ''));
    if (in_array((string)$value, $cur, true)) echo $print;
}

function PrintToolTip($setting) { /* FPP shows a help popover here; not needed */ }

function PrintIcon($level) { echo " <i class='fas fa-fw fa-nbsp ui-level-" . (int)$level . "'></i>"; }

function PrintSettingCheckbox($title, $setting, $restart = 0, $reboot = 0, $checkedValue = '1', $uncheckedValue = '0', $pluginName = '', $callbackName = '', $defaultValue = 0, $desc = '', $sData = array()) {
    $fn = __spp_changed_name($setting);
    $id = __spp_jsid($setting);
    $cb = __spp_callback($callbackName, $setting);
    $checkedValue = (string)$checkedValue; $uncheckedValue = (string)$uncheckedValue;
    $cur = __spp_current($setting, $pluginName, $defaultValue ? $checkedValue : $uncheckedValue);
    echo "<script>\nfunction $fn() {\n  var checked = $('#$id').is(':checked') ? 1 : 0;\n  var value = checked ? " . __spp_js($checkedValue) . ' : ' . __spp_js($uncheckedValue) . ";\n  " .
        __spp_save_js($pluginName, $setting, 'value', $restart, $reboot, 'checked', $cb . " if (checked) $('.$id' + 'Child').show(); else $('.$id' + 'Child').hide();",
            "$('#$id').prop('checked', !checked);") . "\n}\n</script>\n";
    $on = isset($sData['onChange']) ? $sData['onChange'] . '();' : "$fn();";
    echo "<input type='checkbox' id='" . __spp_attr($setting) . "' aria-label='" . __spp_attr($setting) . "'" .
        (isset($sData['children']) ? " class='parentSetting'" : '') .
        ((string)$cur === $checkedValue ? ' checked' : '') . " onChange='" . __spp_attr($on) . "'>";
    if ($desc !== '') echo ' ' . $desc;
    echo "\n";
}

function PrintSettingSelectInternal($title, $setting, $restart, $reboot, $defaultValue, $values, $pluginName = '', $callbackName = '', $changedFunction = '', $sData = array(), $multiple = false) {
    $fn = __spp_changed_name($setting, $changedFunction);
    $id = __spp_jsid($setting);
    $cb = __spp_callback($callbackName, $setting);
    $values = is_array($values) ? $values : array();
    $valueExpr = $multiple ? "($('#$id').val() || []).join(',')" : "$('#$id').val()";
    echo "<script>\nfunction $fn() {\n  var value = $valueExpr;\n  " . __spp_save_js($pluginName, $setting, 'value', $restart, $reboot, 'null', $cb) . "\n}\n</script>\n";
    $on = isset($sData['onChange']) ? $sData['onChange'] . '();' : "$fn();";
    $cur = __spp_current($setting, $pluginName, $defaultValue);
    $selected = $multiple ? explode(',', (string)$cur) : array((string)$cur);
    $class = 'form-select col-auto mw-100' . (isset($sData['children']) ? ' parentSetting' : '') . ($multiple ? ' multiSelect' : '');
    echo "<select id='" . __spp_attr($setting) . "' class='$class'" . ($multiple ? ' multiple' : '') . " onChange='" . __spp_attr($on) . "'>\n";
    foreach ($values as $label => $val) {
        echo "<option value='" . __spp_attr($val) . "'" . (in_array((string)$val, $selected, true) ? ' selected' : '') . '>' . __spp_attr($label) . "</option>\n";
    }
    echo "</select>\n";
}

function PrintSettingSelect($title, $setting, $restart = 1, $reboot = 0, $defaultValue = '', $values = array(), $pluginName = '', $callbackName = '', $changedFunction = '', $sData = array()) {
    PrintSettingSelectInternal($title, $setting, $restart, $reboot, $defaultValue, $values, $pluginName, $callbackName, $changedFunction, $sData, false);
}

function PrintSettingMultiSelect($title, $setting, $restart = 1, $reboot = 0, $defaultValue = '', $values = array(), $pluginName = '', $callbackName = '', $changedFunction = '', $sData = array()) {
    PrintSettingSelectInternal($title, $setting, $restart, $reboot, $defaultValue, $values, $pluginName, $callbackName, $changedFunction, $sData, true);
}

// A text box with no save handler (the page saves it itself).
function PrintSettingText($setting, $restart = 1, $reboot = 0, $maxlength = 32, $size = 32, $pluginName = '', $defaultValue = '') {
    echo "<input type='text' id='" . __spp_attr($setting) . "' class='mw-100' maxlength='" . (int)$maxlength . "' size='" . (int)$size .
        "' value='" . __spp_attr(__spp_current($setting, $pluginName, $defaultValue)) . "'>\n";
}

function PrintSettingTextSaved($setting, $restart = 1, $reboot = 0, $maxlength = 32, $size = 32, $pluginName = '', $defaultValue = '', $callbackName = '', $changedFunction = '', $inputType = 'text', $sData = array(), $identType = 'id') {
    $fn = __spp_changed_name($setting, $changedFunction);
    $id = __spp_jsid($setting);
    $cb = __spp_callback($callbackName, $setting);
    $sub = $inputType;
    if ($inputType === 'color' || $inputType === 'datalist') $inputType = 'text';
    $sel = $identType === 'class' ? ".$id" : "#$id";
    echo "<script>\nfunction $fn() {\n  var value = $('$sel').val();\n  " . __spp_save_js($pluginName, $setting, 'value', $restart, $reboot, 'null', $cb) . "\n}\n</script>\n";
    $on = isset($sData['onChange']) ? $sData['onChange'] . '();' : "$fn();";
    $cur = (isset($sData['alwaysReset']) && $sData['alwaysReset']) ? $defaultValue : __spp_current($setting, $pluginName, $defaultValue);
    $limits = $inputType === 'number' ? "max='" . __spp_attr($maxlength) . "' min='" . __spp_attr($size) . "'" : "maxlength='" . (int)$maxlength . "' size='" . (int)$size . "'";
    if (isset($sData['step']) && $sData['step'] != 1) $limits .= " step='" . __spp_attr($sData['step']) . "'";
    $ident = $identType === 'class' ? "class='mw-100 " . __spp_attr($setting) . "'" : "id='" . __spp_attr($setting) . "' class='mw-100" . (isset($sData['children']) ? ' parentSetting' : '') . "'";
    $list = $sub === 'datalist' ? " list='" . __spp_attr($setting) . "_list'" : '';
    echo "<input type='" . __spp_attr($inputType) . "' $ident $limits$list onChange='" . __spp_attr($on) . "' value='" . __spp_attr($cur) . "'>\n";
    if ($sub === 'datalist' && isset($sData['options']) && is_array($sData['options'])) {
        echo "<datalist id='" . __spp_attr($setting) . "_list'>";
        foreach ($sData['options'] as $k => $v) echo "<option value='" . __spp_attr($k) . "'>" . __spp_attr($v) . '</option>';
        echo "</datalist>\n";
    }
    if ($sub === 'color') {
        // FPP uses a colpick widget; a native colour picker writes the same hex value.
        echo "<input type='color' value='#" . __spp_attr(preg_replace('/[^0-9A-Fa-f]/', '', (string)$cur) ?: '800000') . "' onInput=\"$('#$id').val(this.value.substring(1)); $fn();\">\n";
    }
}

function PrintSettingPasswordSaved($setting, $restart = 1, $reboot = 0, $maxlength = 32, $size = 32, $pluginName = '', $defaultValue = '', $callbackName = '', $changedFunction = '') {
    PrintSettingTextSaved($setting, $restart, $reboot, $maxlength, $size, $pluginName, $defaultValue, $callbackName, $changedFunction, 'password', array());
    $s = __spp_attr($setting);
    echo "&nbsp;<input id='{$s}_showHideButton' type='button' class='buttons' value='Show' onclick=\"var x=document.getElementById('$s'),b=this;" .
        "if(x.type==='password'){x.type='text';b.value='Hide';}else{x.type='password';b.value='Show';}\">\n";
}

function PrintSettingSave($title, $setting, $restart = 1, $reboot = 0, $pluginName = '', $callbackName = '') {
    $id = __spp_jsid($setting);
    $cb = __spp_callback($callbackName, $setting);
    echo "<input type='button' class='buttons' value='Save' onClick='" . __spp_attr('var value = $("#' . $id . '").val(); ' . __spp_save_js($pluginName, $setting, 'value', $restart, $reboot, 'null', $cb)) . "'>\n";
}

// One row of a settings.json-driven page.
function PrintSetting($setting, $callback = '', $options = array(), $plugin = '') {
    global $settingInfos, $pluginSettingInfos;
    if ($plugin !== '') LoadPluginSettingInfos($plugin);
    $s = $plugin !== '' ? (isset($pluginSettingInfos[$setting]) ? $pluginSettingInfos[$setting] : null) : (isset($settingInfos[$setting]) ? $settingInfos[$setting] : null);
    if (!$s) { echo "<div class='row'><div class='col'><b>Invalid Setting: " . __spp_attr($setting) . "</b></div></div>\n"; return; }
    if (!ShouldPrintSetting($s)) return;
    $restart = isset($s['restart']) ? $s['restart'] : 0;
    $reboot = isset($s['reboot']) ? $s['reboot'] : 0;
    $desc = isset($s['description']) ? $s['description'] : $setting;
    $default = isset($s['default']) ? $s['default'] : '';
    $labelClass = isset($s['labelClass']) ? $s['labelClass'] : 'col-md-4 col-lg-3';
    $fieldClass = isset($s['fieldClass']) ? $s['fieldClass'] : 'col-md';
    echo "<div class='row' id='" . __spp_attr($setting) . "Row'><div class='printSettingLabelCol $labelClass'><div class='description'>" . $desc . "</div></div><div class='printSettingFieldCol $fieldClass'>";
    $type = isset($s['type']) ? $s['type'] : 'text';
    switch ($type) {
        case 'select':
        case 'datalist':
            if (empty($options)) {
                if (isset($s['optionsURL'])) {
                    $url = preg_match('#^https?://#', $s['optionsURL']) ? $s['optionsURL'] : 'http://127.0.0.1/' . ltrim($s['optionsURL'], '/');
                    $raw = json_decode((string)@file_get_contents($url), true);
                    $options = array();
                    if (!empty($s['optionCanBeBlank'])) $options[''] = '';
                    if (is_array($raw)) {
                        if (array_keys($raw) === range(0, count($raw) - 1)) {
                            foreach ($raw as $item) {
                                $v = (isset($s['optionsKey']) && is_array($item)) ? $item[$s['optionsKey']] : $item;
                                if (is_scalar($v)) $options[$v] = $v;
                            }
                        } else $options = $options + $raw;
                    }
                } elseif (isset($s['optionsCommand'])) {
                    foreach (explode("\n", trim((string)shell_exec($s['optionsCommand']))) as $line) {
                        $p = explode(',', trim($line), 2);
                        if ($p[0] !== '') $options[$p[0]] = isset($p[1]) ? $p[1] : $p[0];
                    }
                } elseif (isset($s['options'])) $options = $s['options'];
            }
            if ($type === 'select') PrintSettingSelect($desc, $setting, $restart, $reboot, $default, $options, $plugin, $callback, '', $s);
            else { $s['options'] = $options; PrintSettingTextSaved($setting, $restart, $reboot, isset($s['maxlength']) ? $s['maxlength'] : 32, isset($s['size']) ? $s['size'] : 32, $plugin, $default, $callback, '', 'datalist', $s); }
            break;
        case 'checkbox':
            PrintSettingCheckbox($desc, $setting, $restart, $reboot, isset($s['checkedValue']) ? $s['checkedValue'] : '1', isset($s['uncheckedValue']) ? $s['uncheckedValue'] : '0', $plugin, $callback, $default !== '' ? $default : 0, '', $s);
            break;
        case 'number':
            PrintSettingTextSaved($setting, $restart, $reboot, isset($s['max']) ? $s['max'] : 99, isset($s['min']) ? $s['min'] : 0, $plugin, $default !== '' ? $default : '0', $callback, '', 'number', $s);
            break;
        case 'password':
            PrintSettingTextSaved($setting, $restart, $reboot, isset($s['maxlength']) ? $s['maxlength'] : 32, isset($s['size']) ? $s['size'] : 32, $plugin, $default, $callback, '', 'password', $s);
            echo " <i class='fas fa-eye' role='button' onClick=\"TogglePasswordHideShow('" . __spp_attr($setting) . "');\"></i>";
            break;
        case 'color':
            PrintSettingTextSaved($setting, $restart, $reboot, 7, 7, $plugin, $default !== '' ? $default : '800000', $callback, '', 'color', $s);
            break;
        case 'time':
        case 'date':
            PrintSettingTextSaved($setting, $restart, $reboot, $type === 'time' ? 8 : 10, $type === 'time' ? 8 : 10, $plugin, $default, $callback, '', 'text', $s);
            break;
        case 'link':
            echo "<a class='buttons' href='" . __spp_attr(isset($s['linkUrl']) ? $s['linkUrl'] : '#') . "'>" . __spp_attr(isset($s['buttonText']) ? $s['buttonText'] : $desc) . '</a>';
            break;
        default:
            PrintSettingTextSaved($setting, $restart, $reboot, isset($s['maxlength']) ? $s['maxlength'] : 32, isset($s['size']) ? $s['size'] : 32, $plugin, $default, $callback, '', 'text', $s);
    }
    if (!empty($s['suffix'])) echo ' ' . $s['suffix'];
    echo "</div></div>\n";
}

function PrintPluginSetting($plugin, $setting, $callback = '', $options = array()) { PrintSetting($setting, $callback, $options, $plugin); }

function PrintSettingGroup($group, $appendData = '', $prependData = '', $indent = 1, $plugin = '', $callback = '', $heading = true) {
    global $settings, $settingGroups;
    if ($plugin !== '') LoadPluginSettingInfos($plugin);
    if (!isset($settingGroups[$group])) { echo '<b>ERROR: Invalid Setting Group: ' . __spp_attr($group) . "</b><br>\n"; return; }
    $g = $settingGroups[$group];
    if (!ShouldPrintSetting($g)) return;
    if ($heading && isset($g['description'])) echo '<h2>' . $g['description'] . "</h2>\n";
    echo "<div class='container-fluid settingsTable" . ($indent ? ' settingsGroupTable' : '') . "'>\n";
    if ($prependData !== '') echo preg_match('/<div class=.?row/', $prependData) ? $prependData : "<div class='row'><div class='col-md'>$prependData</div></div>\n";
    foreach ((isset($g['settings']) ? $g['settings'] : array()) as $setting) PrintSetting($setting, $callback, array(), $plugin);
    if ($appendData !== '') echo preg_match('/<div class=.?row/', $appendData) ? $appendData : "<div class='row'><div class='col-md'>$appendData</div></div>\n";
    echo "</div><br>\n";
}

function PrintPluginSettingGroup($plugin, $group, $appendData = '', $prependData = '', $indent = 1) { PrintSettingGroup($group, $appendData, $prependData, $indent, $plugin); }
function PrintSettingGroupTable($group, $appendData = '', $prependData = '', $indent = 1, $plugin = '') {
    echo "<div class='settingsTable " . __spp_attr($group) . "SettingsTable'>\n";
    PrintSettingGroup($group, $appendData, $prependData, $indent, $plugin);
    echo "</div>\n";
}
function PrintPluginSettingGroupTable($plugin, $group, $appendData = '', $prependData = '', $indent = 1) { PrintSettingGroupTable($group, $appendData, $prependData, $indent, $plugin); }

// ---------------------------------------------------------------- misc

// Long-running pages stream their output (ShowPilot Player passes it on as it comes).
function DisableOutputBuffering() {
    @ini_set('output_buffering', 'off');
    @ini_set('zlib.output_compression', '0');
    @ini_set('implicit_flush', '1');
    while (ob_get_level() > 0) @ob_end_flush();
    ob_implicit_flush(true);
}

function ScriptStream($cmd) { DisableOutputBuffering(); passthru($cmd); }

function GetDirSetting($dir) {
    global $settings;
    $map = array('sequences' => 'sequenceDirectory', 'music' => 'musicDirectory', 'videos' => 'videoDirectory', 'effects' => 'effectDirectory',
        'scripts' => 'scriptDirectory', 'logs' => 'logDirectory', 'uploads' => 'uploadDirectory', 'images' => 'imageDirectory', 'config' => 'configDirectory',
        'playlists' => 'playlistDirectory', 'plugins' => 'pluginDirectory', 'docs' => 'docsDirectory');
    return isset($map[$dir]) ? $settings[$map[$dir]] : '';
}

function ReadTimeZone() { return date_default_timezone_get(); }

endif;
