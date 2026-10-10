# ShowPilot Player

A lean show player for xLights light shows, from the [ShowPilot](https://github.com/ShowPilotFPP/ShowPilot) family.

It plays `.fseq` sequences and their audio on one clock, sends the lights to your controllers over DDP or E1.31, plays video and a virtual matrix on HDMI, keeps FPP remotes in sync, and has ShowPilot (viewer voting, jukebox and phone audio) built in. It looks like an FPP to xLights and to FPP plugins, so the tools you already use keep working.

It is an alternative to FPP for shows that drive their pixels over the network. If you need pixel capes, GPIO hardware or FPP's broadcast-audio features, keep using FPP.

## What it does

- **Sequence + audio in sync.** The lights follow the measured audio position, not a guess. Interrupted songs resume at the exact spot.
- **DDP and E1.31 output**, packet-for-packet the same as FPP.
- **Playlists and schedules**: lead-in, main loop and lead-out; shuffle; times by clock or by dusk/sunset.
- **xLights FPP Connect**: add the player in FPP Connect and upload sequences and media as you would to an FPP.
- **FPP MultiSync**: as the player, your FPP remotes (video, matrix, extra outputs) follow it unchanged; it can also run as a remote.
- **Video and virtual matrix** on HDMI, following the same clock.
- **ShowPilot built in**: no plugin to install. Requests, votes, interrupts, cooldowns and phone audio positions.
- **FPP script and PHP plugins** from GitHub or FPP's plugin list (native C++ fppd plugins are not supported).

## Install

### Flash an SD card (recommended)

1. Download `ShowPilot-Player-<version>-arm64.img.xz` from the [latest release](https://github.com/ShowPilotFPP/ShowPilot-Player/releases).
2. Flash it with Raspberry Pi Imager ("Use custom"). In the OS customisation step set your user, password, Wi-Fi (if not wired) and **timezone**.
3. Boot a Raspberry Pi 4 or 5 and open `http://showpilot.local/` (or the Pi's IP address).

Default login on the image if you skip customisation: user `showpilot`, password `showpilot`. Change it.

### Or install on an existing Raspberry Pi OS (64-bit)

```bash
curl -fsSL https://raw.githubusercontent.com/ShowPilotFPP/ShowPilot-Player/main/scripts/install.sh | sudo bash
```

Run the same command again to update, or use **System → Updates** in the web UI.

## First show

1. **Outputs**: add your controllers (DDP or E1.31) and try a test pattern.
2. **System**: pick the audio output and check the timezone.
3. Upload sequences and audio from xLights (FPP Connect) or the **Files** page.
4. **Playlists**: create one and press *Add all sequences*.
5. **Schedule**: set your show times (set your location to use dusk).
6. Optional: **ShowPilot** (server URL + show token), **MultiSync**, **Video & Matrix**, **Plugins**.

There is no volume control on purpose: set the level once at your amplifier or FM transmitter.

## For developers

Node.js 22.15+, mpv, ffmpeg and php-cgi. `npm install`, then `npm test`. Run locally with
`SPP_MEDIA_DIR=/tmp/media SPP_PORT=8080 SPP_FPPDIR=$PWD/fpp-compat SPP_AUDIO_NULL=1 node server.js`.
Architecture and decisions are in [PRIMER.md](PRIMER.md).

MIT licensed.
