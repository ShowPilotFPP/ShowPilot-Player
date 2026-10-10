<?php
// ShowPilot Player: runs a plugin's api.php endpoints (FPP routes them at
// /api/plugin/<dir>/<endpoint> through limonade). Minimal limonade helpers
// are provided: params(), json(), halt().
$skipJSsettings = 1;
require_once dirname(__DIR__) . '/config.php';
require_once dirname(__DIR__) . '/common.php';

$GLOBALS['__spp_params'] = array();
if (!function_exists('params')) { function params($n = null) { $p = $GLOBALS['__spp_params']; return $n === null ? $p : (isset($p[$n]) ? $p[$n] : null); } }
if (!function_exists('json')) { function json($d, $o = 0) { header('Content-Type: application/json'); return json_encode($d, $o); } }
if (!function_exists('halt')) { function halt($c = 500, $m = '') { http_response_code(is_int($c) ? $c : 500); echo is_string($c) ? $c : $m; exit; } }
if (!function_exists('render')) { function render($s) { return $s; } }

$plugin = getenv('SPP_PLUGIN');
$endpoint = trim((string)getenv('SPP_ENDPOINT'), '/');
$method = $_SERVER['REQUEST_METHOD'];
if (!preg_match('/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/', $plugin)) { http_response_code(404); exit; }
$pd = realpath("$pluginDirectory/$plugin");
if (!$pd || dirname($pd) !== realpath($pluginDirectory)) { http_response_code(404); exit; }
$api = "$pd/api.php";
if (!is_file($api)) { http_response_code(404); echo json_encode(array('status' => 'no api.php')); exit; }

$before = get_defined_functions()['user'];
chdir(dirname($api));
include $api;
$fn = 'getEndpoints' . str_replace('-', '', $plugin);
if (!function_exists($fn)) {
    $fn = null;
    foreach (array_diff(get_defined_functions()['user'], $before) as $f) if (stripos($f, 'getendpoints') === 0) { $fn = $f; break; }
}
if (!$fn) { http_response_code(404); exit; }

foreach (call_user_func($fn) as $ep) {
    if (strtoupper($ep['method']) !== $method) continue;
    $parts = explode('/', trim($ep['endpoint'], '/'));
    $have = $endpoint === '' ? array() : explode('/', $endpoint);
    if (count($parts) !== count($have)) continue;
    $params = array(); $ok = true;
    foreach ($parts as $i => $seg) {
        if ($seg !== '' && $seg[0] === ':') $params[substr($seg, 1)] = urldecode($have[$i]);
        elseif ($seg !== $have[$i]) { $ok = false; break; }
    }
    if (!$ok) continue;
    $GLOBALS['__spp_params'] = $params;
    $out = call_user_func($ep['callback']);
    if ($out !== null) echo $out;
    exit;
}
http_response_code(404);
echo json_encode(array('status' => 'not found'));
