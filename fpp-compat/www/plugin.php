<?php
// ShowPilot Player: serves plugin pages the way FPP's plugin.php does.
//   plugin.php?plugin=<dir>&page=<file>[&nopage=1]   run/include the page
//   plugin.php?plugin=<dir>&file=<file>               static file from the plugin
// A full page gets what every FPP page has (jQuery, jQuery UI, Bootstrap 5,
// Font Awesome, FPP's JS helpers, the settings/pluginSettings JS arrays, the
// plugin's js/ and css/ files) inside ShowPilot Player's frame and theme.
$nopage = isset($_GET['nopage']) && $_GET['nopage'] !== '0';
$skipJSsettings = 1;
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/common.php';

$plugin = isset($_GET['plugin']) ? $_GET['plugin'] : '';
// Must start with a letter/digit/underscore (no ".", ".." or hidden names), and
// must resolve to a direct child of the plugin folder.
if (!preg_match('/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/', $plugin) || !is_dir("$pluginDirectory/$plugin")) {
    http_response_code(404); echo 'Unknown plugin'; exit;
}
$pdir = realpath("$pluginDirectory/$plugin");
if (!$pdir || dirname($pdir) !== realpath($pluginDirectory)) { http_response_code(404); echo 'Unknown plugin'; exit; }
$pluginName = $plugin;

// A path inside the plugin folder (subfolders allowed, no traversal), or null.
function __spp_plugin_path($pdir, $raw) {
    if (!is_string($raw) || $raw === '' || strpos($raw, "\0") !== false) return null;
    $clean = array();
    foreach (explode('/', str_replace('\\', '/', $raw)) as $part) {
        if ($part === '' || $part === '.') continue;
        if ($part === '..' || preg_replace('/[^A-Za-z0-9_.\- ]/', '', $part) !== $part) return null;
        $clean[] = $part;
    }
    if (!$clean) return null;
    $f = realpath($pdir . '/' . implode('/', $clean));
    return ($f && strpos($f, $pdir . '/') === 0 && is_file($f)) ? $f : null;
}

if (isset($_GET['file'])) {
    $f = __spp_plugin_path($pdir, $_GET['file']);
    if (!$f) { http_response_code(404); exit; }
    $ext = strtolower(pathinfo($f, PATHINFO_EXTENSION));
    $types = array('js' => 'application/javascript', 'css' => 'text/css', 'png' => 'image/png', 'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg', 'gif' => 'image/gif', 'svg' => 'image/svg+xml', 'json' => 'application/json', 'html' => 'text/html',
        'ico' => 'image/x-icon', 'webp' => 'image/webp', 'woff' => 'font/woff', 'woff2' => 'font/woff2', 'ttf' => 'font/ttf',
        'mp3' => 'audio/mpeg', 'wav' => 'audio/wav', 'txt' => 'text/plain', 'md' => 'text/plain');
    header('Content-Type: ' . (isset($types[$ext]) ? $types[$ext] : 'application/octet-stream'));
    readfile($f);
    exit;
}

$page = isset($_GET['page']) ? $_GET['page'] : '';
$target = __spp_plugin_path($pdir, $page);
if (!$target) { http_response_code(404); echo 'Unknown page'; exit; }

LoadPluginSettings($pluginName);

if (!$nopage) {
    $info = @json_decode((string)@file_get_contents("$pdir/pluginInfo.json"), true);
    $title = is_array($info) && !empty($info['name']) ? $info['name'] : $pluginName;
    $cfg = @json_decode((string)@file_get_contents($settings['configDirectory'] . '/showpilot-player.json'), true);
    $theme = is_array($cfg) && isset($cfg['ui']['theme']) && preg_match('/^[a-z-]+$/', $cfg['ui']['theme']) ? $cfg['ui']['theme'] : 'auto';
    $t = htmlspecialchars($title, ENT_QUOTES);
    $p = htmlspecialchars($pluginName, ENT_QUOTES);
    // The player's cache buster (version + newest file time), so plugin pages
    // pick up a new version without a hard refresh.
    $av = getenv('SPP_ASSET_V');
    $v = '?v=' . rawurlencode($av ? $av : (string)@filemtime(__FILE__));
    $reqUri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '';
    echo "<!DOCTYPE html>\n<html lang=\"en\" data-spp-theme=\"" . htmlspecialchars($theme, ENT_QUOTES) . "\"><head><meta charset=\"utf-8\">",
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>$t - ShowPilot Player</title>\n",
        "<script src=\"/theme.js$v\"></script>\n",
        "<link rel=\"stylesheet\" href=\"/vendor/bootstrap/bootstrap.min.css\">\n",
        "<link rel=\"stylesheet\" href=\"/vendor/jquery-ui/jquery-ui.min.css\">\n",
        "<link rel=\"stylesheet\" href=\"/vendor/fontawesome/css/all.min.css\"><link rel=\"stylesheet\" href=\"/vendor/fontawesome/css/v4-shims.min.css\">\n",
        "<link rel=\"stylesheet\" href=\"/themes.css$v\"><link rel=\"stylesheet\" href=\"/vendor/fonts/fonts.css$v\"><link rel=\"stylesheet\" href=\"/fpp-compat/plugin-page.css$v\">\n",
        "<script src=\"/vendor/jquery.min.js\"></script><script src=\"/vendor/jquery-ui/jquery-ui.min.js\"></script>\n",
        "<script src=\"/vendor/bootstrap/bootstrap.bundle.min.js\"></script>\n",
        "<script>\nvar FPP_FULL_VERSION = '10.0', FPP_VERSION = '10.0', FPP_MAJOR_VERSION = 10, FPP_MINOR_VERSION = 0, FPP_VERSION_FLOAT = 10.0, FPP_PATCH_VERSION = 0;\n",
        "var pageName = 'plugin', pluginName = " . json_encode($pluginName) . ";\n",
        "var pluginPage = " . json_encode(preg_replace('/.*page=/', '', $reqUri), JSON_HEX_TAG) . ";\n",
        "var pluginBase = " . json_encode(preg_replace('/^\//', '', preg_replace('/page=.*/', '', $reqUri)), JSON_HEX_TAG) . ";\n",
        "var helpPage = pluginBase + 'nopage=1&page=help/' + pluginPage;\n",
        "var settings = " . json_encode(array_map(function ($x) { return is_array($x) ? $x : (string)$x; }, $settings), JSON_HEX_TAG) . ";\n",
        "var pluginSettings = " . json_encode(array_map(function ($x) { return is_array($x) ? $x : (string)$x; }, (array)$pluginSettings), JSON_HEX_TAG) . ";\n",
        "var hiddenChildren = {};\n</script>\n",
        "<script src=\"/fpp-compat/fpp-compat.js$v\"></script>\n";
    // FPP loads every file in the plugin's js/ and css/ folders on its pages.
    foreach (array('js' => "<script src='/plugin.php?plugin=%s&file=js/%s&nopage=1'></script>\n", 'css' => "<link rel='stylesheet' href='/plugin.php?plugin=%s&file=css/%s&nopage=1'>\n") as $dir => $tpl) {
        if (!is_dir("$pdir/$dir")) continue;
        $files = array_values(array_filter(scandir("$pdir/$dir"), function ($f) use ($pdir, $dir) { return $f[0] !== '.' && is_file("$pdir/$dir/$f"); }));
        sort($files);
        foreach ($files as $f) printf($tpl, rawurlencode($pluginName), rawurlencode($f));
    }
    $icon = file_exists("$pdir/icon.png") || (is_array($info) && !empty($info['iconURL']));
    echo "</head><body class=\"spp-plugin-page\">\n",
        "<header class=\"spp-bar\"><a class=\"spp-back\" href=\"/#plugins\"><i class=\"fas fa-arrow-left\"></i> ShowPilot Player</a>",
        ($icon ? "<img class=\"spp-icon\" src=\"/api/plugin/$p/icon\" alt=\"\">" : ''),
        "<span class=\"spp-title\">$t</span><span class=\"spp-spacer\"></span><span id=\"spp-restart\"></span></header>\n",
        "<div id=\"bodyWrapper\"><div class=\"mainContainer\"><div class=\"pageContent spp-plugin\">\n";
}

// FPP runs plugin pages from its www folder (relative includes like
// "common.php" resolve there; the plugin's own folder is searched too).
chdir(__DIR__);
include $target;

if (!$nopage) {
    // FPP's DoModalDialog() clones this.
    echo "\n</div></div></div>\n",
        "<div class=\"modal fade\" id=\"modalDialogBase\" tabindex=\"-1\" aria-hidden=\"true\"><div class=\"modal-dialog modal-dialog-centered\"><div class=\"modal-content\">",
        "<div class=\"modal-header\"><h3 class=\"modal-title fs-5\"></h3><button type=\"button\" id=\"modalCloseButton\" class=\"btn-close\" data-bs-dismiss=\"modal\" aria-label=\"Close\"></button></div>",
        "<div class=\"modal-body\"></div><div class=\"modal-footer\"></div></div></div></div>\n",
        "<script>if (window.UpdateChildSettingsVisibility) $(UpdateChildSettingsVisibility);</script>\n",
        "</body></html>";
}
