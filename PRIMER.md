# ShowPilot Player Primer

Context for anyone (usually Claude) working on ShowPilot Player. Read this before changing code. It supersedes the earlier concept primer that lived outside the repo.

**Status: v0.3.1.** Running on a Raspberry Pi 4B with real controllers and a USB sound card (0.1.6 timing measured there, see Testing). 0.2.0 adds FPP-style commands and command presets, a reworked scheduler (sequences, repeat-every, holidays) and FPP backup restore; those are covered by automated tests and a browser check, not yet used on a Pi. HDMI video/matrix and a full show night are still to check (Phase 1 list).

---

## What it is

A lean show player in the FPP family. It plays xLights `.fseq` sequences and their audio on one master clock, sends channel data over DDP/E1.31, plays video and a virtual matrix on HDMI, speaks FPP MultiSync, accepts xLights FPP Connect uploads, hosts FPP script/PHP plugins, and has the ShowPilot plugin's behaviour built in. It ships as a flashable Raspberry Pi OS image or an install script.

It is an option, not a replacement for FPP. Operators who need direct pixel output (capes, DPI, PiHat), GPIO hardware, or FPP's broadcast-audio features keep FPP.

### Why it exists

1. FPP has grown far past "play this sequence and this MP3 together"; every extra path is another way for the basic one to break.
2. ShowPilot had to infer FPP's state from outside, and that inference is where its sync bugs lived (example: after an interrupt FPP announced "media started" for the resumed song, the plugin reported 0:00, and phones were off for 10–15 s). Here the lights, speakers, remotes and phone stream follow one internal clock, so there is nothing to infer.

---

## Scope

### In
- `.fseq` v1/v2.0–2.2 playback (none/zstd/zlib, sparse ranges, ESEQ) with audio on one clock
- DDP and E1.31 output (Art-Net: maybe later, on request)
- Playlists (FPP JSON format) and a scheduler (clock times or dawn/sunrise/sunset/dusk, holidays, repeat-every)
- FPP commands and command presets (FPP `commandPresets.json`), runnable from the schedule
- Restore from an FPP backup file, item by item
- Video to HDMI and a virtual matrix, both following the master clock
- FPP MultiSync master and remote
- xLights FPP Connect (discovery + chunked uploads + meta checks)
- ShowPilot integration built in (decided 2026-10: replaces the plugin on this player)
- **FPP script/PHP plugins** (decided 2026-10 by the maintainer: install from GitHub/catalog, install scripts, callbacks, pages, api.php, commands)

### Out (anti-bloat rule — raise explicitly before reopening)
- Native C++ fppd plugins (`lib<name>.so`), anything needing fppd internals
- Direct pixel output from SBC pins, GPIO-driven hardware
- AES67, RTSP, Opus/RTP, video capture, PipeWire graph routing, multi-HDMI layouts
- Volume control (fixed rule across ShowPilot: the level is set at the amp/FM transmitter; Volume commands are accepted as no-ops)
- Anything whose only justification is "FPP has it"

---

## Architecture

```
server.js                 wires everything; HTTP on port 80
lib/engine/player.js      master clock + playback (main thread)
lib/engine/mpv.js         JSON-IPC client for long-lived mpv processes
lib/engine/frame-worker.js  worker thread: owns the fseq + outputs, sends frames on the clock
lib/engine/matrix-writer.js worker thread: writes matrix images to the display mpv FIFO
lib/engine/matrix-map.js  xLights matrix layout -> RGB image
lib/fseq.js               fseq reader (+ writer for tests)
lib/outputs/index.js      DDP + E1.31 packet builders
lib/show.js               show runner: playlists, inserts, resume, graceful stop
lib/playlists.js          FPP playlist JSON storage
lib/scheduler.js, suntimes.js
lib/commands.js           FPP command registry (same names/args as FPP)
lib/multisync.js          FPP MultiSync master/remote + ping discovery
lib/showpilot.js          built-in ShowPilot client + audio position daemon (port 8090)
lib/plugins.js            FPP plugin host
lib/fppcompat/            php-cgi runner, FPP settings-file helper
fpp-compat/               shim installed to /opt/fpp (config.php, common.php, plugin.php, scripts/common ...)
routes/fpp.js             FPP-compatible /api
routes/player.js          admin API for the UI (/api/player)
public/                   admin UI (vanilla JS, no build step); public/vendor/jquery.min.js for plugin pages
image/                    pi-gen stage + build script; scripts/install.sh; scripts/showpilot-player.service
test/                     node:test suites
```

### The clock (the core design)

- One clock per item. `clockSource` is `audio` (audio mpv's measured position), `internal` (no media), or `external` (MultiSync master, remote mode).
- The clock free-runs on `performance.timeOrigin + performance.now()` (same absolute timebase in all threads). The main thread posts **anchors** (`mediaMs`, `at`, `rate`) to the frame worker; the worker computes `frame = floor((mediaMs + (now-at)*rate + syncOffsetMs) / stepMs)`.
- mpv's `time-pos` reports **discipline** the clock like a PLL: each report may slew it by at most **1 ms**; an error of **≥100 ms must persist for two consecutive reports** before the clock jumps. Reason: mpv's reports jitter, and a single stale report right after a seek (we saw `0.0` arrive after a resume) used to yank the lights back. Sound-card drift is parts-per-million, so 1 ms per report tracks it easily.
- After an exact seek, reports below `seekTarget - 250 ms` are ignored (they describe the old position).
- Followers: the display mpv (video) and, in remote mode, the audio mpv are slaved to the clock every 250 ms: <25 ms error → speed 1; up to 1 s → speed nudge (max ±5%); >1 s → exact seek. Same shape as FPP's remote `AdjustSpeed`.

### Lessons from FPP baked in (do not regress)

- **Every mid-file seek is exact** (`seek <s> absolute+exact`, `--hr-seek=yes`), loaded paused, then unpaused. The position we report after a seek is **measured** from mpv, not the requested value. (FPP used KEY_UNIT seeks: 0.1–0.7 s off, 7–11 s on VBR MP3s without a TOC; fixed upstream in FPP commit 755ca65.)
- **Resume is its own event** (`player` emits `resume` with `positionMs`; `start` only for fresh starts). MultiSync sends MEDIA START with the resume seconds; the ShowPilot daemon sends the real position.
- **The audio output stays open** across songs and interrupts (one long-lived mpv with `--idle`); per-file state resets on `loadfile`.
- **Fixed latency is solved with `syncOffsetMs`; drift is a bug.** The UI shows frame-lateness counters so "steady gap vs growing gap" is measurable.

### Frame worker

- **Scheduling rule (0.1.6):** the next wake-up targets `(lastFrameSent + 1) * step`, never "the boundary after now". A tick that fires a hair before a boundary computes the old frame and sends nothing; if the rescheduling then used the current time, it would already be past the boundary and wait a whole frame, sending that frame ~24 ms late (1.5% of frames on a Pi 4).
- **Decoding runs on its own thread** (`decode-worker.js`, 0.1.6): it decompresses the current block and the next two ahead and transfers them in; spent block buffers are sent back for reuse so the timing thread never allocates large buffers (those trigger GC pauses). Blocks outside the window being played are dropped so a late block after a seek can't evict the needed ones. `inlineDecodes` in the stats counts fallbacks on the timing thread and should stay 0.

- Owns the open `FseqFile` and the UDP socket. Schedules itself with `setTimeout` to each frame boundary; never queues frames — a late wake-up sends the frame that is due now.
- Keeps two decoded blocks and **prefetches** the block 3 frames ahead in idle time, so a block boundary never costs a frame.
- Stats every second: fps, avg/max lateness, skipped frames, max decode ms, plus per-sequence totals (`over10`, `over20`, `maxLateMs`). Shown on the Dashboard.

### Display (video + virtual matrix)

- One display mpv (`--force-window --fullscreen`, DRM on a console Pi), started only if `/dev/dri/card*` exists and video or matrix is enabled.
- Video items: audio mpv plays the file's audio (clock master); the display mpv plays it muted as a follower.
- Matrix: display mpv loads a FIFO as `rawvideo` (rgb24, nearest scaling). The frame worker renders the channel range into a SharedArrayBuffer; `matrix-writer.js` (its own thread) writes only the newest image with a non-blocking FIFO, so a stalled reader can never delay lights.
- `matrix.preferVideo`: a video in `videos/` with the same base name as the sequence (or media) plays instead of rendering pixels (sharper; this fixed the pixelated matrix on FPP).

### Show runner (`lib/show.js`)

- Frames stack: base playlist (lead-in → main loop → lead-out) plus inserted frames.
- **Insert Immediate**: pause current song (measured position), play the inserted range, then resume the paused song exactly (`resumed: true`).
- **Insert After Current**: queued in order; runs when the current item ends, then the base continues with its next item. Multiple requests queue naturally (no "ShowPilot Queue" playlist file).
- Item indexes are **FPP global indexes** (lead-in items first, then main, then lead-out), 1-based, as in FPP's insert commands.
- `skip(entry, ctx)` hook (ShowPilot cooldowns): walk forward to the first allowed item in main; never past the end of the loop, never stall.
- `queryNext` hook (plugin `query_next`) is awaited before advancing the base playlist.
- An item with both sequence and media ends when both have ended (FPP "both").
- **Nothing playable → stop, don't spin**: if every item of the running frames has been tried without anything playing (files missing, everything disabled, or only commands/scripts that finish instantly), the show stops and `show.lastProblem` says why ("Nothing in "X" could play (Song.fseq: sequence not found)"). Before 0.3.1 a repeating playlist like that looped up to 1000 times in a burst, re-running its commands, and then sat "running" with nothing playing — the Dashboard said "Playing" and nothing happened. A command-only "trigger" playlist runs its commands once even with Repeat on.
- `POST /api/player/play` returns `{playing: true}`, `{finished: true}` (ran and ended, e.g. a trigger playlist) or a 409 with `lastProblem`; the Dashboard and Playlists pages show that instead of always "Playing".
- Entry types played: both, sequence, media, pause, command, script, playlist (nested). Others are kept in the file and skipped with a log line.

- `stopGracefully(afterLoop)`: plain = finish the current item then lead-out; `afterLoop` = finish the main loop then lead-out (FPP `Stop Gracefully` with `loop=true`). Emits `stopping` (`now` | `graceful` | `afterLoop`) for the reserved presets.
- Playlist commands (Start/Insert/nested playlist entries) accept a **sequence file name ending in `.fseq`** as well as a playlist name, like FPP (`playlists.loadPlayable`); FPP's `/api/playlists/playable` lists playlists then `.fseq` files, so FPP presets and schedules often name a sequence directly. The Player's `/api/playlists/playable` does the same.
- `start()` takes a playlist name **or a playlist object** (scheduled sequences use `playlists.forSequence(seq)`: one item, with the audio named in the fseq header when that file exists; `type: 'sequence'` without it).

### Commands and presets (`lib/commands.js`, `lib/presets.js`)

- Registry entries carry FPP's `/api/commands` description shape: `name, description, category, args[{name, type, description, optional, min, max, default, contentListUrl | contents}]`. The UI builds every command form from this (bool → checkbox, `contents` → select, `contentListUrl` → select filled from that FPP API path, int → number). Plugin commands get category `Plugin: <name>`; ShowPilot's get `ShowPilot`.
- Core commands use FPP's exact names and arg order: Start Playlist, Start Playlist At Item, Insert Playlist After Current/Immediate, Stop Now, **Stop Gracefully (`loop`)**, Stop Gracefully After Loop (old Player name, kept), Next/Prev/Restart Playlist Item, Pause/Resume/Toggle Playlist, All Lights Off, **URL (`name` = URL, `method` GET|POST, `data`; http(s) only, 10 s timeout)**, **Run Script (`script`, `args`, `env` "A=1,B=2")**, **Trigger Command Preset (`name`)**, **Trigger Command Preset Slot (`slot` 1–255)**, Trigger Multiple Command Presets (`NameA`..`NameF`), Restart FPPD, Reboot/Shutdown (`confirm` must be true), Volume* (accepted no-ops).
- Presets are stored as FPP's `media/config/commandPresets.json`: `{commands:[{name, presetSlot, command, args, multisyncCommand, multisyncHosts?}]}`. **Rows that share a `name` are one preset** (run in file order); there is no nested list. A slot fires every row with that slot. `%KEYWORD%` in args is replaced (e.g. `%PLAYLIST_NAME%`). A recursion guard skips a preset already running (a preset that triggers itself runs once).
- Reserved names fired by the player (same as fppd): `FPPD_STARTED`, `FPPD_STOPPED`, `PLAYLIST_STARTED`/`STOPPED` (keyword `PLAYLIST_NAME`), `PLAYLIST_STOPPING_NOW`/`GRACEFULLY`/`AFTER_LOOP`, `MEDIA_STARTED`/`STOPPED` (`MEDIA_NAME`, `SEQUENCE_NAME`). Not fired: `OUTPUTS_*`, `EFUSE_TRIGGERED`, `PLAYLIST_START_TMINUS_NNN`.
- `multisyncCommand: true` sends the command to remotes as an FPP command packet (type 6: byte 7 = arg count, then NUL-terminated hosts, command, args) via `MultiSync.sendCommand`, and also runs it locally.
- API: FPP `GET /api/commandPresets` (`?names=true` → names), `/api/commandPresets/:name`, `/api/scripts`, `/api/playlists/playable` (hides `_`-prefixed internal playlists); FPP's UI saving `POST /api/configfile/commandPresets.json` writes the same file. Player: `GET/PUT /api/player/presets` (grouped `{presets:[{name, presetSlot, commands}]}`; duplicate names rejected), `POST /api/player/presets/run`, `POST /api/player/command` (optional `multisyncCommand`/`multisyncHosts`).

### Scheduler (`lib/scheduler.js`)

- Own format in `media/config/schedule.json` (not FPP's; FPP schedules convert on restore). Entry: `{id, enabled, type: playlist|sequence|command, playlist, sequence, repeat, repeatEvery (min), command, args, multisyncCommand, multisyncHosts, days[0..6], startDate, startDateOffset, endDate, endDateOffset, startTime, startOffset, endTime, endOffset, stopType: graceful|loop|hard}`.
- Times: `HH:MM` (24:00 allowed) or `dawn|sunrise|sunset|dusk` + offset minutes. End ≤ start runs past midnight; the start day is the day that counts.
- Dates: `''`, `YYYY-MM-DD`, `0000-MM-DD` (every year; ranges wrap Dec→Jan), or a holiday shortName (FPP's names, `lib/holidays.js`: US + global fixed/nth-weekday/Easter-based ones, plus `config/user-holidays.json` in FPP format) with a day offset (holidays only, as in FPP). Ranges are checked against the previous and current year so a Thanksgiving+1 → Jan 6 season works across New Year.
- Commands without `repeatEvery` fire once at the start time (window = start + 2 min catch-up); with `repeatEvery` they fire every N minutes until the end. Fired keys `<id>@<startISO>#<n>`, pruned after 3 days. Booting more than 2 minutes after a due time does not fire it.
- Playlists/sequences own the show for their window (first live entry in list order wins). `repeatEvery` on a show = play once, then start again every N minutes while nothing is playing. At the end only **the run this entry started** is stopped — compared by the identity of the show runner's base frame saved after `show.start`, not by name, so a manual start of the same playlist later in the window wins (`hard` → Stop Now, `loop` → after loop, else graceful).
- The occurrence key contains the resolved start time, so editing a live entry, changing the location or dusk drifting changes it. The same entry id + same target is treated as the same window (active switches over, no stop/restart mid-song).
- A one-sided yearly date range stays inside the calendar year, as in FPP (which compares month-day against its literal default bound): "from every year Dec 1" = Dec 1–31; "until every year Jan 6" = Jan 1–6. Holiday lookups are cached (user-holidays file re-read at most every 5 s) because the next-run scan resolves dates for every entry and day.
- `GET /api/player/schedule` → `{entries, upcoming (7 days), next (per-entry next run), holidays, enabled}`.
- UI: entry cards with a plain-language summary, next-run chip, on/off switch, move/copy/edit/delete (each change saves immediately); editor sections What / Days (chips + presets) / Time (clock or sun + plus/minus minutes, with today's resolved time) / Playback (repeat, play once, play once every N; finish song / finish loop / stop now) / Dates (any, date, every year on, holiday ± days). "Coming up" grouped by day.

### FPP backup restore (`lib/fpp-backup.js`)

- Input: FPP's downloaded JSON backup (not zipped). Text files in it are line arrays (`join("\n")` then parse); JSON files are wrapped in a one-element array; settings are `settings.system_settings[0]` (all strings). Any `__fppBlob` reference is rejected (on-device copies only; the user must download from FPP's UI).
- `analyze()` → `{meta, sections[{id, label, note, items[{id, label, detail, checked, disabled, warnings}]}], skipped, warnings}`; `restore(backup, selection)` writes only picked items. Sections: settings (name/description, location, timezone, MultiSync enabled/remotes/multicast/broadcast, player/remote mode, audio output only when a card with that ALSA id exists), schedule (replace or add), playlists, command presets (merge by name), scripts (chmod 755), outputs (universes → E1.31/DDP via `outputs-map`, model overlays, virtual display map), plugin settings files (`config/plugin.<name>`), custom holidays.
- FPP schedule conversion: `playlist == ""` → command; `sequence: 1` → sequence; day codes 0–6, 7 everyday, 8 weekdays, 9 weekend, 10 MWF, 11 TuTh, 12 Sun–Thu, 13 Fri/Sat, 14/15 odd/even (**unsupported → every day + warning**), `0x10000|mask` (Sun 0x4000 … Sat 0x0100); `SunRise/SunSet/Dawn/Dusk` and legacy `25:00:00`/`26:00:00`; offsets kept only on sun times (FPP ignores them on clock times); `repeat` 1 → repeat, ≥100 → every `repeat/100` minutes; dates `2019-01-01`/`2099-12-31` (FPP defaults) → none, monthly `0000-00-DD` unsupported; `stopType` 0/1/2 → graceful/hard/loop.
- Restore re-converts the schedule with the holidays present at that moment; a dropped date limit (e.g. a custom holiday left unticked) is reported in `problems`. Malformed fields (bad `backup_taken`, null playlist items) don't block the rest of the file.
- Never restored: network/Wi-Fi, passwords/email, pixel-string/panel/PWM/other outputs, channel inputs, GPIO, output processors, EEPROM. The UI lists these under "Not restored".
- UI: System → Restore from an FPP backup (file read in the browser, sent to `/api/player/backup/inspect` then `/restore`; that path accepts JSON up to 64 MB).

---

## Formats and protocols (implemented from FPP/xLights source, Oct 2026)

### fseq
- All little-endian. Magic `PSEQ` (legacy `FSEQ` accepted; `ESEQ` effect files). Header: dataOffset u16@4, minor@6, major@7, channelCount u32@10 (stored bytes per frame), frameCount u32@14, stepMs@18.
- v2: byte 20 low nibble = compression (0 none, 1 zstd, 2 zlib); high nibble = block-count bits 8–11 (12-bit count, decode always); byte 21 = block count low; byte 22 = sparse range count; u64 id@24; then 8-byte block entries (firstFrame, compressedLength), then 6-byte sparse ranges (u24 start 0-based, u24 count), then variable headers (u16 total length incl. 4, 2-char code: `mf` media filename, `sp` producer, `ED` v2.2 extended data).
- Block offsets are running sums from dataOffset; **zero-length entries are skipped**; **block 0 holds only 10 frames** — always use the table. zlib blocks are RFC 1950 (`inflateSync`).
- **Node's zstd decoder stops after the first zstd frame**; FPP accepts blocks containing several concatenated frames, so `fseq.js` walks zstd frame headers (RFC 8878) and decodes each when a block comes up short.
- Requires Node **22.15+** for built-in zstd.

### DDP (port 4048)
10-byte header: `0x40` (`0x41` = PUSH on each controller's last packet), sequence 1..15 per packet sent, data type 0, destination 1, offset u32 BE, length u16 BE; ≤1440 data bytes. No separate sync packet. "One-based" mode puts offsets relative to the output.

### E1.31 (port 5568)
126-byte header + data (not padded to 512). CID is FPP's constant `FALCON FPP`; priority default 0 (FPP's effective default); per-universe sequence pre-incremented; multicast `239.255.(u>>8).(u&255)`. Optional 49-byte sync packet after all data packets, once per sync universe.

### MultiSync (UDP 32320, multicast 239.70.80.80)
- Header `FPPD`, type, u16 LE extra length (must match the datagram exactly). Sync packet: action (0 start, 1 stop, 2 sync, 3 open), file type (0 seq, 1 media), u32 frame, f32 seconds, NUL-terminated bare filename; the length counts the NUL.
- Master cadence (verified): seq sync every 4 frames for the first 32 frames, then every 10; media sync when `int(seconds*2)` changes. Order: SEQ OPEN, MEDIA OPEN, SEQ START, MEDIA START, syncs …, STOP.
- Remotes trust `seconds` over `frame`. MEDIA START honours `seconds` (used for exact resume on remotes).
- Ping v4 (359 bytes extra): type <0x80 = "full FPP" to xLights; versions big-endian; mode 2 player / 8 remote / |4 sending; real IPv4; hostname; version string; model; channel ranges; UUID. Reply to discover pings by broadcast and unicast **to port 32320**.
- We report **FPP 9.3** to xLights (`9.3-SPP-<version>`), typeId from the Pi model (generic 0x01 otherwise).

### xLights FPP Connect
- Needs `GET /api/system/info` with a non-empty `uuid`, integer `majorVersion`/`minorVersion`; `GET /api/fppd/multiSyncSystems` with `typeId` (xLights can't read typeId from system/info because of a typo in xLights).
- Before uploading it checks `GET /api/sequence/<n>/meta` (404 forces upload) and `GET /api/media/<n>/meta` (`format.size` compared).
- Uploads: sequential `PATCH /api/file/{sequences|music|videos|effects}` with `Upload-Offset`, `Upload-Length`, `Upload-Name`, 16 MiB chunks; reply `{"status":"OK","file","dir","size"}`. We write to `<name>.part` at the offset and rename when complete (a playing file keeps its old inode). Non-zero offset without a started upload → 409.
- Optional probes answered harmlessly: `/api/playlists` (array of strings), `/api/cape` 404, `/api/proxies` `[]`, pixel/cape `/api/channel/output/*` 404.
- **Other FPP Connect options**: "Models" → `GET/POST /api/models` (GET is called with error reporting on, so it must return 200 with an array); "UDP Out" → `GET/POST /api/channel/output/universeOutputs` (mapped to the Player's outputs); virtual display / submodels / groups → `/api/configfile/<name>` (stored in `media/config/`).

---

## FPP plugins

Goal: every catalog plugin with a script/PHP part works as on FPP. In v0.3.0 all 52 plugins in FPP's catalog were cloned and audited against FPP's www/ and scripts/ (PHP functions, JS helpers, API paths, shell scripts), and their pages smoke-run through the shim; the remaining failures are plugin bugs or missing plugin dependencies, not shim gaps (see the list at the end of this section).

- **Install**: git URL or `pluginInfo.json` URL (FPP catalog: `fpp-pluginList/pluginList.json`); `versions[]` entry chosen for FPP 10.x; `dependencies.packages` (apt) and `python` (pip); `scripts/fpp_install.sh` (or root `fpp_install.sh`) run as root with `FPPDIR`/`SRCDIR` env and args; `fpp_upgrade.sh` on update; `fpp_uninstall.sh`. After install the new plugin's `preStart`/`postStart` hooks run (FPP would need an fppd restart).
- **Start/stop hooks**: `scripts/{pre,post}{Start,Stop}.sh`, alphabetical. Output goes to `logs/plugin-hooks.log` (a file, not a pipe), so a hook that starts a background job (`php loop.php &`, e.g. fpp-nfl) returns as soon as the script itself exits; 60 s cap. **Plugin processes (callbacks, commands, install scripts) resolve on process exit, not on pipe close** — waiting for `close` hung startup forever when a background child inherited the pipe (that was the v0.2 "NFL doesn't work" bug). Native-only plugins (Makefile + .cpp) are skipped for hooks.
- **Restart**: FPP's "Restart FPPD" = `plugins.restart()`: preStop, postStop, preStart, reload (commands, callbacks), postStart; clears `restartFlag`. Reached from `GET/POST /api/system/fppd/restart` (open, like FPP; `scripts/fppd_restart` calls it), `POST /api/player/plugins/restart`, the Plugins page banner and the plugin page header ("Restart plugins to apply", shown when a plugin sets `restartFlag`/`rebootFlag` in `media/settings`). The show keeps playing.
- **Callbacks**: `callbacks[.sh|.pl|.php|.py] --list` → `media`, `playlist`, `lifecycle`; events `--type media --data <json>`, `--type playlist --data <GetInfo + Action/Section/Item>` (actions start, playing, stop, query_next), `--type lifecycle startup|shutdown`. **Per plugin, callbacks run one at a time in event order**; `query_next` is awaited (3 s cap).
- **Commands**: `commands/descriptions.json` registered globally (category `Plugin: <name>`). A command whose script exits non-zero is an error carrying the last lines of its output.
- **Pages** (`fpp-compat/www/plugin.php`, run by php-cgi): full pages get what every FPP page has — jQuery 3.7, jQuery UI 1.13, Bootstrap 5.3 (CSS + bundle JS), Font Awesome 6 (+ v4 shims), `fpp-compat.js`, JS `settings` / `pluginSettings` / `FPP_*` version vars / `pluginPage` / `pluginBase`, every file in the plugin's `js/` and `css/` folders, FPP's `#modalDialogBase`, `UpdateChildSettingsVisibility()` — inside a themed frame (back link, plugin icon, name, restart banner). `$pluginSettings` is loaded (`LoadPluginSettings`, with settings.json defaults) before the page runs. **cwd is the shim's www folder** (as on FPP) and `include_path` contains `/opt/fpp/www`, so `require "common.php"` works. `&nopage=1` runs the page bare; `&file=` serves plugin files (subfolders allowed, traversal refused). Vendored libraries live in `public/vendor/` (MIT/CC/OFL licences alongside).
- **CGI runner** (`lib/fppcompat/php.js`): streams output as it arrives (plugins stream with `DisableOutputBuffering()` + `flush()`; PHP's own output_buffering stays on, as on FPP, so `header()` after output still works); sets `SERVER_ADDR` (old plugins build form URLs from it); **does not kill a script that keeps running**: after 60 s (or when the browser disconnects) the response ends and the script continues, drained, like under Apache. fpp-nfl starts its score-watching loop this way. At most 3 such scripts per plugin page; the oldest is stopped; all stopped on shutdown.
- **PHP shim** (`fpp-compat/www`): `config.php` ($settings incl. directories, `eventDirectory`, `uiLevel` 0, `fppMode`/`HostName`/`Latitude`/`Longitude` from the player config, local `date.timezone`, JS settings block unless `$skipJSsettings`), `fppversion.php` (FPP 10.0: `getFPPVersionFloat` etc.), `common.php`: `ReadSettingFromFile`, `WriteSettingToFile` (JSON values unquoted, like FPP), `LoadPluginSettings`, `ParseBooleanValue`, `PrintSettingGroup`/`PrintSetting` (plugin `settings.json`: select/datalist with options/optionsURL/optionsCommand, checkbox, text, number, password, color, time, date, link), `PrintSettingCheckbox`/`Select`/`MultiSelect`/`Text`/`TextSaved`/`PasswordSaved`/`Save` — same arguments, element ids and generated `<setting>Changed()` functions as FPP, calling `SetPluginSetting(plugin, key, value, restart, reboot, isBool, callback, fail)`; `DisableOutputBuffering`, `ScriptStream`, `GetDirSetting`. Written for ShowPilot Player against FPP's behaviour (not copied).
- **JS shim** (`public/fpp-compat/fpp-compat.js`): `SetSetting`/`SetPluginSetting` (FPP signatures; restart/reboot flags), `SetRestartFlag`/`SetRebootFlag`/`Clear*`, `$.jGrowl`, `DialogOK`/`DialogError`, `DoModalDialog`/`CloseModalDialog`/`DisplayProgressDialog`/`DisplayConfirmationDialog`/`EnableModalDialogCloseButton` (Bootstrap modals), `$.fn.fppDialog` (jQuery UI dialog), `StreamURL`, `Get`/`Post`/`Put`, `Enable/DisableButtonClass`, `getViewport`, `PadLeft`, `RegexCheckData`, `TogglePasswordHideShow`, `ViewFileImpl`, and FPP's command editor (`LoadCommandList`, `CommandSelectChanged`, `PrintArgInputs`, `CommandToJSON`, `PopulateExistingCommand`, `ShowCommandEditor`; same `<tbl>_arg_N` element ids).
- **Shell shim**: `scripts/common` (`getSetting`/`setSetting`), `functions`, `eventScript`, `fppd_restart`, and no-op `ManageApacheContentPolicy.sh` (no CSP is sent) and `update_plugin`.
- **API for plugins** (beyond the FPP API list above): `/api/plugin/<name>/icon` (icon.png, or pluginInfo `iconURL`), `POST /api/plugin/<name>/updates` (`updatesAvailable: 0`), `/api/fppd/schedule`, `/api/overlays/{models,fonts,effects}` → `[]` (pixel overlays are not driven yet; pages load), `/api/commandPresets`, `/api/scripts`, `/api/playlists/playable`. `/api/plugin/<repo>/settings/<key>` GET/PUT, `api.php` endpoints via `api/plugin-router.php` (limonade `params()`, `json()`, `halt()`).
- **PHP settings**: `fpp-compat/etc/php/fpp-compat.ini` via `PHP_INI_SCAN_DIR` (short_open_tag On — many plugins use `<?`; include_path; display_errors Off).
- **Settings files**: `media/settings` and `media/config/plugin.<name>` (`key = "value"`).
- **Shim install**: `fpp-compat/` is copied to `/opt/fpp` at every start unless a real FPP is there (`/opt/fpp/src/fppd`). PHP reports FPP **10.0** (plugin API level), xLights sees 9.3.
- **Plugins page**: cards with the plugin's icon (`/api/plugin/<name>/icon`, initials when there is none), author, version, description, badges (Deprecated, Native part can't run here, Runs in background, N commands), one uniform **Settings** button (first content/output page from menu.inc; title and type are parsed per menu entry) plus Status/Help buttons, project link, update, uninstall. "Browse FPP plugins" shows the catalog with each plugin's pluginInfo (name, author, description, icon; cached 1 h). Search on both.
- **Not supported**: native `.so` fppd plugins (13 in the catalog: ArtNetAdv, HomeAssistant, LoRa, PixelRadio, VideoCapture, arcade, brightness, edmrds, midi, osc, tplink, smpte, vastfmt — their settings pages load, the C++ part can't run); pixel-overlay-driven plugins (Matrix-Message family, matrixtools, Simple-Countdown, WledEffects) until overlays exist; `fppmm`/channel memory maps (model-testing, ScoreBoard). Plugin-side problems seen in the audit: Thingspeak and RadioStation are broken on FPP 10 too; RDS-To-Matrix needs MessageQueue; brp-voting needs its install script's database; Mail/StockTicker need php-imap. The ShowPilot plugin itself is refused at install (built in).

---

## ShowPilot integration (`lib/showpilot.js`)

Wire-compatible with the ShowPilot server's plugin API; the server cannot tell it from the FPP plugin.
- Heartbeat `POST /api/plugin/heartbeat {"pluginVersion":"player-<version>"}`; `playing` on song change (basename without extension) and `''` once when idle; `position` every loop (500 ms) with ms precision from the master clock; `next` = next scheduled item when the base playlist isn't the remote playlist.
- `GET /api/plugin/state`: mode cached ≤60 s; candidates (`winningVote` / `nextRequest` / `raceWinner` incl. PSAs delivered in those slots) fetched only in the last `requestFetchTime` s unless interrupting jukebox/race; 2 s (+extra) hold after queuing.
- Requests resolved **by name** in the live remote playlist (server index only a hint), converted to the FPP global index (lead-in offset included — the FPP plugin got this wrong).
- Interrupt → `insertImmediate`; otherwise `insertAfterCurrent`.
- Cooldowns from `playlistPatches` applied through the show runner's `skip` hook (never edits playlists).
- Sync: `POST /api/plugin/sync-sequences` + audio-cache manifest/link/upload (audio files only; video-to-audio extraction not done yet).
- Bearer token in `media/plugindata/showpilot-player/showToken` (0600), never in config; `redirect: 'manual'` so the token never follows a redirect; server URL must be plain http(s).
- Audio position daemon on `audioDaemonPort` (8090), only while ShowPilot is enabled: `GET /health`, `/status`, `/audio/<name>` (Range), WebSocket `position` (2 Hz), `syncPoint` (≤1/s; suppressed 1000 ms after a start, 300 ms after a resume), `heartbeat` (5 s), `timeReq` → `timeResp`. A resume's first message carries the real position.
- FPP commands registered: "ShowPilot - Turn Viewer Control On/Off", "Switch to Voting/Jukebox/Race Mode", "Turn Interrupt Schedule On/Off".

---

## Admin UI

- Vanilla JS (`public/app.js`), no build step. On phones the menu slides over the page with a dimmed backdrop; tapping outside it, Escape, or picking a page closes it. Pages: Dashboard, Playlists, Files, Schedule, Commands, Outputs, Video & Matrix, MultiSync, ShowPilot, Plugins, System.
- **Themes**: ShowPilot's admin theme set (Stage Dark/Light, Christmas, Halloween, Easter, St. Patrick's, Independence Day, Valentine's) plus Automatic (follows the device). `public/themes.css` is ShowPilot's `public/admin/themes.css` palettes (keep in sync when ShowPilot adds a theme) with aliases to the Player's variable names; `public/theme.js` applies `theme-<name>` on `<html>` and Bootstrap's `data-bs-theme`. The choice is `config.ui.theme` (System page), cached in localStorage to avoid a flash; plugin pages get it from `plugin.php`.
- **Playlists page**: list with item count and length; editor with Play, duplicate/delete menu, Repeat/Shuffle/loop count, Lead-in / Main / Lead-out sections; rows show type icon, title, audio, length, missing-file warning, on/off switch; drag to reorder (across sections too) or arrow buttons; inline item editor with type switch (sequence + audio, sequence only, audio/video, pause, command — using the shared command form, script, nested playlist); an "Add" picker with sequence search (audio from the fseq header is matched automatically) and "Add all sequences". **Changes save automatically** (debounced) in FPP's playlist format.

## Storage and security

- Media tree mirrors FPP: `/home/fpp/media/{sequences,music,videos,effects,images,scripts,playlists,config,logs,plugins,plugindata,upload,virtualdisplay_assets}`. `SPP_MEDIA_DIR` overrides for dev/tests.
- Player settings: `media/config/showpilot-player.json`. Schedule: `media/config/schedule.json`. Command presets: `media/config/commandPresets.json` (FPP format). Custom holidays: `media/config/user-holidays.json`. Log: `media/logs/showpilot-player.log` (5 MB rotate).
- Secrets: `media/plugindata/showpilot-player/` (show token, UI password scrypt hash, session secret).
- Optional admin password protects `/api/player/*` (signed cookie, 30 days, 5 attempts/min). The FPP-compatible API stays open, as on FPP, because xLights and plugins call it without logging in. The Player is meant for a show LAN.
- Every file name from HTTP, MultiSync or playlists goes through `paths.safeName` (bare names only).
- `POST /api/configfile/<name>` (open FPP API) refuses the player's own `showpilot-player.json` and `schedule.json`; FPP-format files such as `commandPresets.json` stay writable.
- Plugin names must match `^[A-Za-z0-9_][A-Za-z0-9_.-]*$` everywhere (Node and the PHP shim): no `.`, `..` or hidden names. The PHP shim also checks the resolved plugin folder is a direct child of `plugins/`. (A looser `[A-Za-z0-9_.-]+` let `..` through: file reads under the media folder, executing uploaded PHP, and `DELETE /api/player/plugins/..` wiping media. Caught in review before release; regression-tested.)
- PHP runs with FPP's settings: `fpp-compat/etc/php/fpp-compat.ini` (installed to `/opt/fpp/etc/php`) is added through `PHP_INI_SCAN_DIR` (set at startup, leading `:` keeps the system ini dir) for php-cgi pages and php CLI plugin scripts, and php-cgi also gets `-d short_open_tag=On`. **Many FPP plugins use `<?` short tags**; without them the code goes to the browser as hidden markup, so settings fields, dropdowns and `if` blocks silently vanish (seen with the IFTTT Webhooks plugin: no key field, empty payload list, test section always shown).
- A plugin command that exits non-zero is an error (HTTP 500 / command failure) carrying the last lines of its output, and is logged as `plugins: <command> (<plugin>) exited with N: ...`.
- Plugin (CGI) output is untrusted: invalid header names and statuses outside 100–599 are dropped/turned into 502, inside a try/catch, because a throw in that event handler would stop the show.
- Player transitions (`play`, `pause`, `stop`, end-of-item) run through one promise chain (`_serial`), because the show runner, MultiSync and HTTP commands can all trigger them and they share one audio mpv.
- The service runs as root (like fppd): port 80, DRM display, plugin install scripts. `Nice=-10` for frame timing.

---

## Image and install

- `image/build.sh` clones pi-gen (`arm64` branch, Trixie default), adds `stage-showpilot` after stage2 (`stage2/SKIP_IMAGES` so only ours exports), puts the app in via `git archive`, and runs `build-docker.sh`. Output `ShowPilot-Player-<version>-arm64.img.xz` + `.sha256`.
- Stage installs apt packages (mpv, ffmpeg, php-cgi/cli/curl/xml, git, avahi, alsa-utils, jq), Node 22 from nodejs.org **with checksum verification**, the app in `/opt/showpilot-player`, the systemd unit, `consoleblank=0`.
- Users: login user `showpilot` (password `showpilot`, change it or set your own in Raspberry Pi Imager), and a separate **system user `fpp`** owning `/home/fpp/media`. Separate because Raspberry Pi Imager's customisation renames the first user and its home, which would break the `/home/fpp/media` path plugins hard-code.
- Hostname `showpilot` (reachable as `showpilot.local` via avahi). Timezone default America/Chicago in the image; set yours in Imager or **System → Timezone** (schedules run in local time).
- `scripts/install.sh`: same result on an existing 64-bit Pi OS; refuses to run where FPP is installed; re-run to update.
- In-app updater: highest semver tag from the GitHub releases list → download tag tarball → `npm install --omit=dev` in `/opt/showpilot-player.next` → swap (keep `.previous`) → exit (systemd restarts). One-step rollback.
- **Updates never need a reflash** (maintainer decision 2026-10: the hour-long image build per release was unacceptable). Two layers, like FPP:
  - **App** — System → Updates (`lib/updater.js`): release tarball, `npm install`, folder swap, restart; seconds; one-step rollback.
  - **System software** — System → System software (`lib/os-update.js`, FPP's "OS upgrade" equivalent): `apt-get update`, `full-upgrade` (keeping existing config files), installs the player's package list, `autoremove`, then Node.js within major 22 (checksum-verified, files replaced with `cp --remove-destination` so the running binary is safe). Background job with a polled log; refused while a show is running; restarts the player when anything was installed; reports when `/run/reboot-required` exists. The package list lives in three places that must match: `lib/os-update.js` `PACKAGES`, `scripts/install.sh`, `image/stage-showpilot/00-packages/00-packages-nr` (pi-gen only reads package lists inside a sub-step folder; at the stage root it is silently ignored, which shipped v0.1.1's image without mpv).
- `.github/workflows/build-image.yml`: on a published release it builds **only if `image/` or `scripts/showpilot-player.service` changed since the previous tag** (otherwise it finishes in seconds with a notice). "Run workflow" with a tag builds one regardless. The image is for first installs only.

---

## Testing

`npm test` (node:test, runs serially): fseq round-trips (none/zstd/zlib, sparse, two zstd frames in one block, meta shape), DDP/E1.31/MultiSync packet bytes, matrix layout, show runner rules with a fake player (lead-in/main/lead-out, insert immediate with exact resume, insert after current, cooldown skip without wrap, graceful stop, repeat), scheduler overnight windows, sun times, FPP backup analyze/restore from a fixture (`test/fixtures/fpp-backup.json`), FPP schedule conversion (day codes, sun times, repeat), holiday/every-year date ranges, repeat-every commands and scheduled sequences, command presets (file format, slots, keywords, loop guard) and their HTTP API, real mpv playback (pause/resume event and position, fps, clock vs frame), and the HTTP API (discovery, chunked upload + 400/409 cases, playlists/commands, plugin settings/page/api/command with php-cgi).

Also verified by hand in the dev environment (v0.1.0):
- 40 fps sustained, average frame lateness ~0.5–1 ms, rate 25.000–25.004 ms/frame (no drift), resume lands on the exact frame (frame 160 for a 4.000 s pause).
- An early dev run showed occasional frames ~24 ms late; this was first blamed on the shared VM, which was wrong. It was a scheduler boundary race (fixed in 0.1.6, see version history): a bare worker timer on the same VM is never more than ~7 ms late.
- MultiSync remote following crafted FPP master packets: lights within 2 ms, a 3 s master jump picked up immediately, audio follower settled within 15 ms, STOP ends playback. Master packet order/cadence captured and matches FPP.
- Against a real ShowPilot server (main branch): heartbeat registered as `player-0.1.0`, sync-sequences + audio cache upload, Jukebox request queued 3 s before song end and played next, interrupt request played immediately then the schedule song resumed at ~4.5 s, phone WebSocket reported the resumed position (4.958 s), not 0.
- xLights-style 3-chunk PATCH upload byte-identical; Insert Playlist Immediate with a lead-in in the remote playlist resolved the right item.

### Measured on a Raspberry Pi 4B (v0.1.6, USB sound card, 2026-10)
- Full song (3138 frames at 40 fps, DDP/E1.31 to real controllers, MultiSync sending): **0 frames over 20 ms late**, average 0.6 ms, worst 5 ms in any second; block decode 4.7 ms on the decode thread. Before the 0.1.6 scheduler fix the same song had 42 of 2894 frames over 20 ms late.
- Lights and USB audio in sync by eye in daylight; a night check is still to do.

### Phase 1 measurements still to do (on a Pi 4/5 with USB or HDMI audio)
1. An evening of repeated plays (single songs done, see above): Dashboard "Late >20 ms (song)" across a whole show night.
2. Lights vs speakers at song start and end with the real audio chain (camera + clap or a light/audio test sequence); set `syncOffsetMs` for the fixed gap; confirm no growing gap.
3. Interrupt/resume by ear and by video.
4. HDMI: video follower and matrix FIFO on DRM (no desktop), including switching between them between songs.
5. xLights FPP Connect discovery and upload against the real xLights.
6. The image workflow's first run; boot the image fresh.

---

## Shipping

- Repo `github.com/ShowPilotFPP/ShowPilot-Player`, ShipPilot slug **`showpilot-player`** (main only; no beta entry yet).
- Every release: bump `package.json` `version` (the UI reads it from the API; there is no separate HTML version span), run `npm test`, `node --check` all `.js`, include `PRIMER.md`, `.release.json` with `repo`, `version`, `commit_message`, `tag`. Tarball excludes `.git`, `node_modules`, `image/out`.
- `.github/workflows/shippilot-release.yml` (same pattern as the other repos; secrets `SHIPPILOT_URL`, `SHIPPILOT_TOKEN` limited to `showpilot-player`), `build-image.yml`, `test.yml`.
- Not mirrored to ShowPilot-Lite or Demo: separate product.

---

## Open items / ideas

- Video files in ShowPilot sync: extract audio for the phone stream (the plugin had `extract_audio.php`).
- Art-Net output if requested.
- Per-output de-duplication (FPP option) if controllers need it.
- Odd/even-day and monthly schedule dates from FPP (converted to every day / no date limit today).
- Pixel overlay models are stored but not run (no overlay commands yet).
- Remote mode: optional local schedule fallback when no master is heard.

---

## Version history

| Version | Change | Checked |
|---|---|---|
| 0.3.1 | Starting a playlist could show "Playing" with nothing playing: a repeating playlist with no playable item (missing files, all disabled, or only commands) spun through its items and then sat idle. It now stops and the reason is shown; command-only playlists run once. The Play buttons report what really happened. Mobile menu closes when tapping outside it (backdrop), on Escape, or when a page is picked. | 37 tests pass (new: nothing-playable stop with reason, trigger playlist runs once); mobile menu checked with touch in a browser. |
| 0.3.0 | FPP plugin compatibility, from an audit of all 52 catalog plugins (see FPP plugins): plugin hooks/processes no longer hang on background children (the fpp-nfl failure), full FPP page environment (Bootstrap 5, jQuery UI, Font Awesome, settings/pluginSettings JS, plugin js/ and css/), FPP-compatible PHP setting printers incl. settings.json groups, FPP JS helpers incl. modals and the command editor, streaming and non-killed long-running plugin pages, SERVER_ADDR, include_path, restart-plugins flow, icon/updates/schedule/overlay API stubs, missing script stubs. Plugins page redesigned (icons, uniform Settings button, catalog with details, search). Playlists page redesigned (drag and drop, inline editor, auto-save). ShowPilot's themes for the admin UI and plugin pages. | 36 tests pass (new: plugin page frame, settings.json group printing, icon route, background-job hook, long-running page keeps running, API stubs). Smoke run of every catalog plugin page: fatals down from 18 to 7, all remaining are plugin bugs/dependencies or no-network in the test box. Pages checked in a browser (desktop/phone, two themes); Dynamic RDS, IFTTT and NFL pages render. |
| 0.2.2 | A preset restored from FPP ("Insert Playlist Immediate" with `Indoor Lightning.fseq`) failed with "playlist not found": FPP's playlist commands take a sequence file name too. Start Playlist, Start Playlist At Item, both Insert commands and nested playlist entries now accept `<name>.fseq`; the playlist picker in command forms lists sequences after playlists, as FPP's does. | New test; 35 pass. |
| 0.2.1 | FPP plugins written with `<?` short tags didn't work (IFTTT Webhooks: no key field, empty payload list, command failing). PHP now runs with FPP's settings (short_open_tag on) for plugin pages and scripts. Failing plugin commands now report their error instead of "complete (exit N)". | The real IFTTT Webhooks plugin rendered its key field and payload list, saved the key, and its command ran through to the IFTTT request (no internet in the test environment). New tests for short tags and plugin command failures; 34 pass. |
| 0.2.0 | FPP-style commands and command presets (Commands page; FPP `commandPresets.json`; URL, Run Script with env, Trigger Command Preset/Slot/Multiple, Stop Gracefully `loop`, Restart/Reboot/Shutdown; reserved event presets; MultiSync command packets). Scheduler: sequences, commands with any args and "repeat every N minutes", play-once-every-N for shows, finish-the-loop stop, holidays and every-year dates. Schedule page redesigned (summaries, next-run, editor sections, coming-up by day). Restore from an FPP backup with per-item selection (System page). | 34 tests pass under UTC and Pacific/Auckland (8 new backup/scheduler/preset tests + an HTTP test); an independent review before release found and fixed: one-sided yearly date ranges running all year, the scheduler stopping a manual start of the same playlist, a live-entry edit restarting the show mid-song, a custom holiday silently dropped on restore, malformed backup fields blocking the whole file, and open writes to the player's own config files; schedule, commands and restore pages checked in a browser at desktop and phone widths. |
| 0.1.0 | First build (independent code review before release fixed plugin-name traversal, CGI crash, concurrent player transitions, pip option names, command-arg decoding and scheduler pruning): audio-clocked fseq playback with PLL-disciplined clock and exact resume; DDP/E1.31; playlists, inserts, scheduler with dusk/sunset; MultiSync master/remote + discovery; video and virtual matrix via a display mpv; xLights FPP Connect API; FPP script/PHP plugin host with `/opt/fpp` shim; built-in ShowPilot client and audio daemon; admin UI with optional password, timezone, updater; pi-gen image pipeline, install script, ShipPilot/test/image workflows. | 21 automated tests; manual runs against mpv (null audio), crafted MultiSync packets, and a local ShowPilot server. Not yet run on a Pi. |
| 0.1.6 | First Pi 4 timing numbers: 40 fps, 0.8 ms average lateness, but 42 of 2894 frames (1.5%) over 20 ms late and 9 ms block decodes on the timing thread. Root cause of the late frames was a scheduler boundary race (see Frame worker → Scheduling rule): wake-ups now target the frame after the last one sent. Block decoding moved to its own thread with buffer recycling; `inlineDecodes` stat added. | 100,000-channel zstd sequence at 40 fps with a pause/resume, 3 runs: 0 frames over 10 ms late (before: 4–12 per run), worst 2.7–6 ms, 0 inline decodes. Playback test now fails if more than one frame is over 20 ms late. 25 tests pass. |
| 0.1.5 | From the first real Pi test: no audio from a USB sound card and no lights. Audio now always uses ALSA (`--ao=alsa`; a root service on Pi OS Lite has no PipeWire/Pulse session, which is what the `pw.conf client.conf` errors were) and "Automatic" prefers a USB sound card from `/proc/asound/cards` (`lib/audio-devices.js`), else the system default; the output setting applies live via mpv's `audio-device` property and shows on the Dashboard. Display mpv uses `--vo=gpu --gpu-context=drm` when there is no desktop (the `XDG_RUNTIME_DIR` error). xLights writes the media's full PC path into the fseq `mf` header (often `C:\...`), which Linux `path.basename` doesn't split: media names now keep only the part after the last `/` or `\\`. Dashboard warns when no controller outputs exist (xLights only sends controllers when FPP Connect "UDP Out" is "All"). FPP-compatible API writes are logged (`fpp-api` lines) so FPP Connect traffic is visible. Dashboard Play dropdown has Playlists and Sequences groups; a sequence plays with its audio. | 25 tests pass (new: USB card preference, Windows/Mac media paths); grouped dropdown checked in the browser. |
| 0.1.4 | xLights FPP Connect with "Models" failed: `GET /api/models` 404. Added `GET/POST /api/models` (stored as `config/model-overlays.json` `{models:[...]}`; GET returns the array; pixel overlays themselves are not run yet), `GET/POST /api/channel/output/universeOutputs` (FPP Connect "UDP Out": E1.31 types 0/1 and DDP 4/5 become the Player's Outputs via `lib/fppcompat/outputs-map.js`; Art-Net/broadcast entries are logged as not sent; FPP-owned keys round-trip from `config/co-universes.json`), `GET/POST /api/configfile/<name>` (virtual display map, submodels, model groups), and `PUT /api/settings/HostDescription` updates the player's description. | New test replays FPP Connect's models/UDP/configfile calls; 23 tests pass. |
| 0.1.3 | First real Pi boot (v0.1.1 image) crash-looped: `spawn mpv ENOENT`. pi-gen ignored the package list because it sat at the stage root instead of a sub-step folder, so mpv, ffmpeg, PHP and avahi were missing. Moved to `stage-showpilot/00-packages/00-packages-nr`; the image build now fails if mpv, ffmpeg, ffprobe, php-cgi, php, git, curl or Node 22.15+ are missing. The player no longer crash-loops when mpv is missing: the web UI stays up and the dashboard shows a red banner (`lib/health.js` + `player.problems`) pointing to System software. HDMI shows "ShowPilot Player is ready" with the address when idle instead of a black screen (mpv `show-text` at OSD level 0, refreshed each minute). Removed `--background=color` (only valid on newer mpv). | Startup without mpv keeps the API up with the warning; display mpv accepts the idle text (vo=null); 22 tests pass. |
| 0.1.2 | System → System software: update Raspberry Pi OS packages, mpv, ffmpeg, PHP and Node.js in place (no reflash), with live log, show-running guard, auto restart and reboot prompt. SD image only rebuilds when the image recipe changes (or by hand), instead of an hour-long build on every release. | Tests pass (22); apt check run on a Linux box; workflow YAML validated. |
| 0.1.1 | Fixes from the first GitHub runs. Dusk/sunset times were wrong when the system timezone differed from the show location's (e.g. a Pi left on UTC): events are now placed within 12 h of the location's solar noon, independent of the system zone. SD image build failed because the empty `stage-showpilot/01-app/files/` folder isn't stored in git; `image/build.sh` now creates it. CI runs the tests in two timezones. | Tests pass under UTC, America/Chicago and Pacific/Auckland; image script runs through to the Docker build. |

---

## Working style

- The maintainer doesn't write code; Claude makes changes and packages ShipPilot tarballs; the maintainer deploys. Paste-ready steps, not "edit line 47".
- Direct and minimal; surgical changes; one coherent feature per version.
- Don't fabricate protocol layouts or APIs — read FPP/xLights source (the sections above cite what was read).
- Measure timing; claims need numbers.
- Comments explain why, not what.
- This primer stays sanitized: no personal names, hostnames, IP addresses, show names or URLs.
