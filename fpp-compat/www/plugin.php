<?php
// ShowPilot Player: serves plugin pages the way FPP's plugin.php does.
//   plugin.php?plugin=<dir>&page=<file>[&nopage=1]   run/include the page
//   plugin.php?plugin=<dir>&file=<file>               static file from the plugin
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

if (isset($_GET['file'])) {
    $f = realpath($pdir . '/' . $_GET['file']);
    if (!$f || strpos($f, $pdir . '/') !== 0 || !is_file($f)) { http_response_code(404); exit; }
    $ext = strtolower(pathinfo($f, PATHINFO_EXTENSION));
    $types = array('js' => 'application/javascript', 'css' => 'text/css', 'png' => 'image/png', 'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg', 'gif' => 'image/gif', 'svg' => 'image/svg+xml', 'json' => 'application/json', 'html' => 'text/html');
    header('Content-Type: ' . (isset($types[$ext]) ? $types[$ext] : 'application/octet-stream'));
    readfile($f);
    exit;
}

$page = isset($_GET['page']) ? $_GET['page'] : '';
$target = $page ? realpath($pdir . '/' . $page) : false;
if (!$target || strpos($target, $pdir . '/') !== 0 || !is_file($target)) { http_response_code(404); echo 'Unknown page'; exit; }

$nopage = isset($_GET['nopage']) && $_GET['nopage'] !== '0';
if (!$nopage) {
    $t = htmlspecialchars($plugin, ENT_QUOTES);
    echo "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
         "<title>$t - ShowPilot Player</title>",
         "<link rel=\"stylesheet\" href=\"/fpp-compat/plugin-page.css\">",
         "<script src=\"/vendor/jquery.min.js\"></script><script src=\"/fpp-compat/fpp-compat.js\"></script>",
         "<script>var pluginName=" . json_encode($plugin) . ";</script></head><body>",
         "<header class=\"spp-bar\"><a href=\"/#plugins\">&larr; ShowPilot Player</a><span>$t</span></header><main class=\"spp-plugin\">";
}
chdir($pdir);
include $target;
if (!$nopage) echo "</main></body></html>";
