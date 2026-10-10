<?php
// ShowPilot Player: stand-in for FPP's www/fppversion.php. ShowPilot Player
// reports itself as FPP 10.0 to plugins (the plugin API level it emulates).
if (!function_exists('getFPPVersion')) {
    function getFPPVersion() { return '10.0'; }
    function getFPPBranch() { return 'showpilot-player'; }
    function getFPPMajorVersion() { return 10; }
    function getFPPMinorVersion() { return 0; }
    function getFPPPatchVersion() { return ''; }
    function getFPPVersionFloat() { return 10.0; }
    function getFPPVersionFloatStr() { return '10.0'; }
    function getFPPVersionTriplet() { return '10.0.0'; }
    function writeFPPVersionJavascriptFunctions() {
        echo "function getFPPVersion() { return '10.0'; }\n";
        echo "function getFPPBranch() { return 'showpilot-player'; }\n";
        echo "function getFPPMajorVersion() { return 10; }\n";
        echo "function getFPPMinorVersion() { return 0; }\n";
        echo "function getFPPPatchVersion() { return ''; }\n";
        echo "function getFPPVersionFloat() { return 10.0; }\n";
        echo "function getFPPVersionTriplet() { return '10.0.0'; }\n";
    }
}
