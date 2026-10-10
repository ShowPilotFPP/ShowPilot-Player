# ShowPilot Player Primer

Context for anyone (usually Claude) working on ShowPilot Player. Read this before changing code. It supersedes the earlier concept primer that lived outside the repo.

**Status: v0.1.3, first build; first boot on a real Pi 4B done (found the issues fixed in 0.1.3).** Everything below is implemented and covered by tests in a Linux dev environment with mpv on a null audio device. It has **not yet run on a Raspberry Pi**, driven real controllers, played to HDMI, or been built into an SD image (the image workflow runs on GitHub). The Phase 1 measurements below are the next step.

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
- Playlists (FPP JSON format) and a scheduler (clock times or dawn/sunrise/sunset/dusk)
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
- Entry types played: both, sequence, media, pause, command, script, playlist (nested). Others are kept in the file and skipped with a log line.

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
- Optional probes answered harmlessly: `/api/playlists` (array of strings), `/api/cape` 404, `/api/proxies` `[]`, `/api/channel/output/*` 404.

---

## FPP plugins

- **Supported**: install from a git URL or `pluginInfo.json` URL (FPP catalog: `fpp-pluginList/pluginList.json`); `versions[]` entry chosen for FPP 10.x; `dependencies.packages` (apt) and `python` (pip); `scripts/fpp_install.sh` (or root `fpp_install.sh`) run as root with `FPPDIR`/`SRCDIR` env and args; `fpp_upgrade.sh` on update; `fpp_uninstall.sh`; `scripts/{pre,post}{Start,Stop}.sh` at service start/stop (alphabetical, foreground).
- **Callbacks**: `callbacks[.sh|.pl|.php|.py] --list` → `media`, `playlist`, `lifecycle`; events `--type media --data <json>`, `--type playlist --data <GetInfo + Action/Section/Item>` (actions start, playing, stop, query_next), `--type lifecycle startup|shutdown`. **Per plugin, callbacks run one at a time in event order**; `query_next` is awaited (3 s cap).
- **Commands**: `commands/descriptions.json` registered globally (visible in `/api/commands`, usable in playlists/schedules/MultiSync). Run with env `MEDIADIR`, `FPPDIR`, `SCRIPTDIR`.
- **Pages**: `menu.inc` scanned statically for `'page' => '...'`/`?page=`; served via `/plugin.php?plugin=&page=[&nopage=1]` through **php-cgi** running the shim's `plugin.php` (adds a minimal header with jQuery + FPP-like JS helpers unless `nopage`). `&file=` serves static plugin files. Path traversal is refused (realpath check).
- **api.php**: `/api/plugin/<dir>/<endpoint>` runs the shim's `api/plugin-router.php`, which includes the plugin's `api.php`, finds `getEndpoints<dir>()`, matches method + `:params`, provides minimal limonade `params()`, `json()`, `halt()`.
- **Settings**: `media/settings` and `media/config/plugin.<name>` (`key = "value"`), via REST (`/api/plugin/<repo>/settings/<key>`, `/api/settings/<key>`), PHP (`ReadSettingFromFile`/`WriteSettingToFile`, `PrintSetting*` helpers) and shell (`getSetting`/`setSetting` in `/opt/fpp/scripts/common`).
- **Shim**: `fpp-compat/` is copied to `/opt/fpp` at every start unless a real FPP is there (`/opt/fpp/src/fppd`). PHP helpers report FPP **10.0** (plugin API level), while xLights sees 9.3.
- **Not supported**: native `.so` plugins (flagged "has a native fppd part" in the UI). The ShowPilot plugin itself is refused at install (it's built in; two listeners would fight).

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

## Storage and security

- Media tree mirrors FPP: `/home/fpp/media/{sequences,music,videos,effects,images,scripts,playlists,config,logs,plugins,plugindata,upload,virtualdisplay_assets}`. `SPP_MEDIA_DIR` overrides for dev/tests.
- Player settings: `media/config/showpilot-player.json`. Schedule: `media/config/schedule.json`. Log: `media/logs/showpilot-player.log` (5 MB rotate).
- Secrets: `media/plugindata/showpilot-player/` (show token, UI password scrypt hash, session secret).
- Optional admin password protects `/api/player/*` (signed cookie, 30 days, 5 attempts/min). The FPP-compatible API stays open, as on FPP, because xLights and plugins call it without logging in. The Player is meant for a show LAN.
- Every file name from HTTP, MultiSync or playlists goes through `paths.safeName` (bare names only).
- Plugin names must match `^[A-Za-z0-9_][A-Za-z0-9_.-]*$` everywhere (Node and the PHP shim): no `.`, `..` or hidden names. The PHP shim also checks the resolved plugin folder is a direct child of `plugins/`. (A looser `[A-Za-z0-9_.-]+` let `..` through: file reads under the media folder, executing uploaded PHP, and `DELETE /api/player/plugins/..` wiping media. Caught in review before release; regression-tested.)
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

`npm test` (node:test, runs serially): fseq round-trips (none/zstd/zlib, sparse, two zstd frames in one block, meta shape), DDP/E1.31/MultiSync packet bytes, matrix layout, show runner rules with a fake player (lead-in/main/lead-out, insert immediate with exact resume, insert after current, cooldown skip without wrap, graceful stop, repeat), scheduler overnight windows, sun times, real mpv playback (pause/resume event and position, fps, clock vs frame), and the HTTP API (discovery, chunked upload + 400/409 cases, playlists/commands, plugin settings/page/api/command with php-cgi).

Also verified by hand in the dev environment (v0.1.0):
- 40 fps sustained, average frame lateness ~0.5–1 ms, rate 25.000–25.004 ms/frame (no drift), resume lands on the exact frame (frame 160 for a 4.000 s pause).
- On the shared 2-vCPU dev VM the worker timer occasionally woke ~24 ms late (0–2 frames per 300); the counters exposed it and lights recovered on the next frame. **Measure on a Pi.**
- MultiSync remote following crafted FPP master packets: lights within 2 ms, a 3 s master jump picked up immediately, audio follower settled within 15 ms, STOP ends playback. Master packet order/cadence captured and matches FPP.
- Against a real ShowPilot server (main branch): heartbeat registered as `player-0.1.0`, sync-sequences + audio cache upload, Jukebox request queued 3 s before song end and played next, interrupt request played immediately then the schedule song resumed at ~4.5 s, phone WebSocket reported the resumed position (4.958 s), not 0.
- xLights-style 3-chunk PATCH upload byte-identical; Insert Playlist Immediate with a lead-in in the remote playlist resolved the right item.

### Phase 1 measurements still to do (on a Pi 4/5 with USB or HDMI audio)
1. An evening of repeated plays: Dashboard "Late >20 ms (song)" and max lateness per song; tune `Nice`/CPU isolation if needed.
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
- FPP schedule import (FPP `schedule.json` format) for migrating operators.
- Remote mode: optional local schedule fallback when no master is heard.

---

## Version history

| Version | Change | Checked |
|---|---|---|
| 0.1.0 | First build (independent code review before release fixed plugin-name traversal, CGI crash, concurrent player transitions, pip option names, command-arg decoding and scheduler pruning): audio-clocked fseq playback with PLL-disciplined clock and exact resume; DDP/E1.31; playlists, inserts, scheduler with dusk/sunset; MultiSync master/remote + discovery; video and virtual matrix via a display mpv; xLights FPP Connect API; FPP script/PHP plugin host with `/opt/fpp` shim; built-in ShowPilot client and audio daemon; admin UI with optional password, timezone, updater; pi-gen image pipeline, install script, ShipPilot/test/image workflows. | 21 automated tests; manual runs against mpv (null audio), crafted MultiSync packets, and a local ShowPilot server. Not yet run on a Pi. |
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
