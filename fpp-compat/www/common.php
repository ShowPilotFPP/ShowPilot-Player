<?php
// ShowPilot Player: stand-in for the parts of FPP's www/common.php that
// plugins call. Settings helpers read/write the same files FPP uses.
require_once __DIR__ . '/config.php';

function getFPPMajorVersion() { return 10; }
function getFPPMinorVersion() { return 0; }
function getFPPVersion() { return '10.0'; }
function getFPPVersionTriplet() { return '10.0.0'; }
function getFPPBranch() { return 'showpilot-player'; }

function __spp_settings_file($plugin) {
    global $settings;
    if ($plugin === '' || $plugin === null) return $settings['settingsFile'];
    if (!preg_match('/^[A-Za-z0-9_.-]+$/', $plugin)) return null;
    return $settings['configDirectory'] . '/plugin.' . $plugin;
}

function ReadSettingFromFile($setting, $plugin = '') {
    $f = __spp_settings_file($plugin);
    if (!$f || !is_readable($f)) return false;
    $value = false;
    foreach (file($f, FILE_IGNORE_NEW_LINES) as $line) {
        if (preg_match('/^\s*' . preg_quote($setting, '/') . '\s*=\s*(.*)$/', $line, $m)) {
            $value = trim($m[1]);
            if (strlen($value) >= 2 && $value[0] === '"' && substr($value, -1) === '"') $value = substr($value, 1, -1);
        }
    }
    return $value;
}

function WriteSettingToFile($setting, $value, $plugin = '') {
    $f = __spp_settings_file($plugin);
    if (!$f) return false;
    $lines = is_readable($f) ? file($f, FILE_IGNORE_NEW_LINES) : array();
    $out = array();
    foreach ($lines as $line) {
        if (preg_match('/^\s*' . preg_quote($setting, '/') . '\s*=/', $line)) continue;
        $out[] = $line;
    }
    $out[] = $setting . ' = "' . $value . '"';
    $tmp = $f . '.tmp' . getmypid();
    file_put_contents($tmp, implode("\n", $out) . "\n");
    return rename($tmp, $f);
}

function GetSettingValue($setting, $default = '', $plugin = '') {
    $v = ReadSettingFromFile($setting, $plugin);
    return $v === false ? $default : $v;
}

function __spp_attr($s) { return htmlspecialchars((string)$s, ENT_QUOTES); }

function PrintSettingCheckbox($title, $setting, $restart = 0, $reboot = 0, $checkedValue = '1', $uncheckedValue = '0', $pluginName = '', $callbackName = '', $defaultValue = 0, $desc = '', $sData = array()) {
    $v = ReadSettingFromFile($setting, $pluginName);
    if ($v === false) $v = $defaultValue ? $checkedValue : $uncheckedValue;
    $checked = ((string)$v === (string)$checkedValue) ? ' checked' : '';
    echo '<input type="checkbox" id="' . __spp_attr($setting) . '"' . $checked .
        ' onchange="SetPluginSetting(' . __spp_attr(json_encode($pluginName)) . ',' . __spp_attr(json_encode($setting)) .
        ',this.checked?' . __spp_attr(json_encode((string)$checkedValue)) . ':' . __spp_attr(json_encode((string)$uncheckedValue)) .
        ',' . __spp_attr(json_encode($callbackName)) . ')">';
}

function PrintSettingTextSaved($setting, $restart = 1, $reboot = 0, $maxlength = 32, $size = 32, $pluginName = '', $defaultValue = '', $callbackName = '', $changedFunction = '', $inputType = 'text', $sData = array()) {
    $v = ReadSettingFromFile($setting, $pluginName);
    if ($v === false) $v = $defaultValue;
    echo '<input type="' . __spp_attr($inputType) . '" id="' . __spp_attr($setting) . '" maxlength="' . (int)$maxlength .
        '" size="' . (int)$size . '" value="' . __spp_attr($v) . '" onchange="SetPluginSetting(' .
        __spp_attr(json_encode($pluginName)) . ',' . __spp_attr(json_encode($setting)) . ',this.value,' . __spp_attr(json_encode($callbackName)) . ')">';
}

function PrintSettingSelect($title, $setting, $restart = 1, $reboot = 0, $defaultValue = '', $values = array(), $pluginName = '', $callbackName = '', $changedFunction = '', $sData = array()) {
    $v = ReadSettingFromFile($setting, $pluginName);
    if ($v === false) $v = $defaultValue;
    echo '<select id="' . __spp_attr($setting) . '" onchange="SetPluginSetting(' . __spp_attr(json_encode($pluginName)) . ',' .
        __spp_attr(json_encode($setting)) . ',this.value,' . __spp_attr(json_encode($callbackName)) . ')">';
    foreach ($values as $label => $val) {
        echo '<option value="' . __spp_attr($val) . '"' . ((string)$val === (string)$v ? ' selected' : '') . '>' . __spp_attr($label) . '</option>';
    }
    echo '</select>';
}

function PrintSettingSave($title, $setting, $restart = 1, $reboot = 0, $pluginName = '', $callbackName = '') {
    echo '<input type="button" value="Save" onclick="SetPluginSetting(' . __spp_attr(json_encode($pluginName)) . ',' .
        __spp_attr(json_encode($setting)) . ',document.getElementById(' . __spp_attr(json_encode($setting)) . ').value,' . __spp_attr(json_encode($callbackName)) . ')">';
}
