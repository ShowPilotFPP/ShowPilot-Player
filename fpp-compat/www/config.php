<?php
// ShowPilot Player: stand-in for FPP's www/config.php. Provides the $settings
// array and directory globals FPP plugins read. Not FPP.
$fppDir = getenv('FPPDIR') ?: '/opt/fpp';
$mediaDirectory = getenv('MEDIADIR') ?: '/home/fpp/media';
if (file_exists("$fppDir/www/media_root.txt")) {
    $mr = trim(file_get_contents("$fppDir/www/media_root.txt"));
    if ($mr !== '') $mediaDirectory = $mr;
}
$settingsFile = "$mediaDirectory/settings";
$settings = array(
    'fppDir' => $fppDir,
    'fppBinDir' => "$fppDir/src",
    'mediaDirectory' => $mediaDirectory,
    'configDirectory' => "$mediaDirectory/config",
    'logDirectory' => "$mediaDirectory/logs",
    'playlistDirectory' => "$mediaDirectory/playlists",
    'pluginDirectory' => "$mediaDirectory/plugins",
    'musicDirectory' => "$mediaDirectory/music",
    'videoDirectory' => "$mediaDirectory/videos",
    'sequenceDirectory' => "$mediaDirectory/sequences",
    'scriptDirectory' => "$mediaDirectory/scripts",
    'effectDirectory' => "$mediaDirectory/effects",
    'imageDirectory' => "$mediaDirectory/images",
    'uploadDirectory' => "$mediaDirectory/upload",
    'docsDirectory' => "$fppDir/docs",
    'settingsFile' => $settingsFile,
    'Platform' => 'Raspberry Pi',
    'Variant' => 'ShowPilot Player',
    'fppMode' => 'player',
    'HostName' => gethostname(),
    'Title' => 'Falcon Player - FPP (ShowPilot Player)',
    'ShowPilotPlayer' => 1,
);
if (is_readable($settingsFile)) {
    foreach (file($settingsFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        if (!preg_match('/^\s*([A-Za-z0-9_.-]+)\s*=\s*"?(.*?)"?\s*$/', $line, $m)) continue;
        $settings[$m[1]] = $m[2];
    }
}
$pluginDirectory = $settings['pluginDirectory'];
$musicDirectory = $settings['musicDirectory'];
$videoDirectory = $settings['videoDirectory'];
$sequenceDirectory = $settings['sequenceDirectory'];
$playlistDirectory = $settings['playlistDirectory'];
$scriptDirectory = $settings['scriptDirectory'];
$configDirectory = $settings['configDirectory'];
$logDirectory = $settings['logDirectory'];
$uploadDirectory = $settings['uploadDirectory'];
$SUDO = '';
