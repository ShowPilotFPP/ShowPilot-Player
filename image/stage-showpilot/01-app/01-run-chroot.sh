#!/bin/bash -e
# Inside the image: users, media folders, dependencies, service.
# A separate "fpp" system user owns /home/fpp/media because FPP plugins and
# xLights expect that path, and Raspberry Pi Imager renames the login user.
if ! id fpp >/dev/null 2>&1; then
	useradd --system --create-home --home-dir /home/fpp --shell /usr/sbin/nologin fpp
	usermod -aG audio,video,render fpp || true
fi
for d in sequences music videos effects images scripts playlists config logs plugins plugindata upload virtualdisplay_assets; do
	install -d -o fpp -g fpp "/home/fpp/media/${d}"
done
# Fail the build, not the show: every runtime dependency must be present.
for bin in mpv ffmpeg ffprobe php-cgi php git curl; do
	command -v "$bin" >/dev/null || { echo "image check: $bin is missing (check stage-showpilot/00-packages)"; exit 1; }
done
cd /opt/showpilot-player
/usr/local/bin/npm install --omit=dev --no-audit --no-fund
/usr/local/bin/node -e "const [a,b]=process.versions.node.split('.').map(Number); if (!(a > 22 || (a === 22 && b >= 15))) { console.error('image check: Node.js too old'); process.exit(1); }"
/usr/local/bin/node --version
systemctl enable showpilot-player.service
systemctl enable avahi-daemon.service || true
