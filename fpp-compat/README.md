# FPP compatibility shim

Installed by ShowPilot Player to `/opt/fpp` (only when no real FPP is present)
so FPP script/PHP plugins find the paths, shell helpers and PHP includes they
expect. It is not FPP: it holds just enough to run plugin install scripts,
callbacks, settings pages and api.php endpoints. See PRIMER.md "FPP plugins".
