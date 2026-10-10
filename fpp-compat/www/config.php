<?php
// ShowPilot Player: stand-in for FPP's www/config.php. Provides the $settings
// array and directory globals FPP plugins read, and (unless $skipJSsettings is
// set, as on FPP) the JS settings block pages expect. Not FPP.
require_once __DIR__ . '/fppversion.php';

if (!defined('MINYEAR')) { define('MINYEAR', 2013); define('MAXYEAR', 2099); }

$fppDir = getenv('FPPDIR') ?: '/opt/fpp';
$mediaDirectory = getenv('MEDIADIR') ?: '/home/fpp/media';
if (file_exists("$fppDir/www/media_root.txt")) {
    $mr = trim(file_get_contents("$fppDir/www/media_root.txt"));
    if ($mr !== '') $mediaDirectory = $mr;
}

// Local time like the rest of the system (PHP otherwise uses UTC).
if (!ini_get('date.timezone')) {
    $tz = getenv('TZ');
    if (!$tz && is_readable('/etc/timezone')) $tz = trim(file_get_contents('/etc/timezone'));
    if (!$tz && is_link('/etc/localtime')) $tz = preg_replace('#^.*zoneinfo/#', '', readlink('/etc/localtime'));
    if (!$tz || @date_default_timezone_set($tz) === false) date_default_timezone_set('UTC');
}

// FPP's settings file format: key = "value" (JSON values may be unquoted).
if (!function_exists('__spp_parse_settings')) {
    function __spp_parse_settings($file) {
        $out = array();
        if (!is_readable($file)) return $out;
        foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            if (!preg_match('/^\s*([A-Za-z0-9_.\-]+)\s*=\s*(.*?)\s*$/', $line, $m)) continue;
            $v = $m[2];
            if (strlen($v) >= 2 && $v[0] === '"' && substr($v, -1) === '"') $v = substr($v, 1, -1);
            $out[$m[1]] = $v;
        }
        return $out;
    }
}

$settingsFile = "$mediaDirectory/settings";
$settings = array(
    'fppDir' => $fppDir,
    'fppBinDir' => "$fppDir/src",
    'wwwDir' => "$fppDir/www",
    'mediaDirectory' => $mediaDirectory,
    'configDirectory' => "$mediaDirectory/config",
    'logDirectory' => "$mediaDirectory/logs",
    'playlistDirectory' => "$mediaDirectory/playlists",
    'pluginDirectory' => "$mediaDirectory/plugins",
    'pluginDataDirectory' => "$mediaDirectory/plugindata",
    'musicDirectory' => "$mediaDirectory/music",
    'videoDirectory' => "$mediaDirectory/videos",
    'sequenceDirectory' => "$mediaDirectory/sequences",
    'scriptDirectory' => "$mediaDirectory/scripts",
    'effectDirectory' => "$mediaDirectory/effects",
    'eventDirectory' => "$mediaDirectory/events",
    'imageDirectory' => "$mediaDirectory/images",
    'uploadDirectory' => "$mediaDirectory/upload",
    'docsDirectory' => "$fppDir/docs",
    'bootDirectory' => '/boot/firmware',
    'channelMemoryMapsFile' => "$mediaDirectory/channelmemorymaps",
    'scheduleFile' => "$mediaDirectory/config/schedule.json",
    'settingsFile' => $settingsFile,
    'Platform' => 'Raspberry Pi',
    'Variant' => 'ShowPilot Player',
    'SubPlatform' => 'ShowPilot Player',
    'fppMode' => 'player',
    'HostName' => gethostname(),
    'HostDescription' => '',
    'Title' => 'Falcon Player - FPP (ShowPilot Player)',
    'uiLevel' => 0,
    'Locale' => 'USA',
    'restartFlag' => 0,
    'rebootFlag' => 0,
    'temperatureInF' => 0,
    'ShowPilotPlayer' => 1,
);
// The player's own settings (mode, name, location) win over defaults.
$__spp_cfg = @json_decode((string)@file_get_contents("$mediaDirectory/config/showpilot-player.json"), true);
if (is_array($__spp_cfg)) {
    if (!empty($__spp_cfg['mode'])) $settings['fppMode'] = $__spp_cfg['mode'] === 'remote' ? 'remote' : 'player';
    if (!empty($__spp_cfg['hostName'])) $settings['HostName'] = $__spp_cfg['hostName'];
    if (isset($__spp_cfg['hostDescription'])) $settings['HostDescription'] = $__spp_cfg['hostDescription'];
    if (isset($__spp_cfg['location']['latitude'])) $settings['Latitude'] = (string)$__spp_cfg['location']['latitude'];
    if (isset($__spp_cfg['location']['longitude'])) $settings['Longitude'] = (string)$__spp_cfg['location']['longitude'];
}
$settings['TimeZone'] = date_default_timezone_get();
foreach (__spp_parse_settings($settingsFile) as $k => $v) $settings[$k] = $v;

$pluginDirectory = $settings['pluginDirectory'];
$musicDirectory = $settings['musicDirectory'];
$videoDirectory = $settings['videoDirectory'];
$sequenceDirectory = $settings['sequenceDirectory'];
$playlistDirectory = $settings['playlistDirectory'];
$scriptDirectory = $settings['scriptDirectory'];
$configDirectory = $settings['configDirectory'];
$logDirectory = $settings['logDirectory'];
$uploadDirectory = $settings['uploadDirectory'];
$effectDirectory = $settings['effectDirectory'];
$eventDirectory = $settings['eventDirectory'];
$imageDirectory = $settings['imageDirectory'];
$docsDirectory = $settings['docsDirectory'];
$scheduleFile = $settings['scheduleFile'];
$fppHome = '/home/fpp';
$fppBinDir = $settings['fppBinDir'];
$SUDO = '';

// FPP prints the JS settings block from config.php unless the page opts out.
if (!isset($skipJSsettings) && PHP_SAPI !== 'cli') {
    echo "<!--Falcon Player - FPP-->\n<script type=\"text/javascript\">\n";
    echo "MINYEAR = " . MINYEAR . "; MAXYEAR = " . MAXYEAR . ";\n";
    echo "var FPP_FULL_VERSION = '10.0', FPP_VERSION = '10.0', FPP_MAJOR_VERSION = 10, FPP_MINOR_VERSION = 0, FPP_VERSION_FLOAT = 10.0, FPP_PATCH_VERSION = 0;\n";
    echo "var settings = " . json_encode(array_map(function ($v) { return is_array($v) ? $v : (string)$v; }, $settings), JSON_HEX_TAG) . ";\n";
    echo "</script>\n";
}
