#!/bin/bash
# Install ShowPilot Player on an existing Raspberry Pi OS (64-bit, Lite
# recommended). Same result as flashing the image. Run as root:
#   curl -fsSL https://raw.githubusercontent.com/ShowPilotFPP/ShowPilot-Player/main/scripts/install.sh | sudo bash
# Re-running it updates to the latest release.
set -euo pipefail
REPO="ShowPilotFPP/ShowPilot-Player"
APP=/opt/showpilot-player
NODE_MAJOR=22

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
[ "$(uname -m)" = aarch64 ] || echo "Warning: built for 64-bit Raspberry Pi OS (aarch64); this is $(uname -m)."
if [ -x /opt/fpp/src/fppd ] || systemctl list-unit-files 2>/dev/null | grep -q '^fppd'; then
  echo "FPP is installed on this system. ShowPilot Player replaces it; use a separate SD card."
  exit 1
fi

echo "== Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends mpv ffmpeg php-cgi php-cli php-curl php-xml git curl ca-certificates xz-utils avahi-daemon alsa-utils jq kbd

echo "== Node.js ${NODE_MAJOR}"
# Needs Node 22.15+ (built-in zstd for compressed .fseq files).
if ! /usr/local/bin/node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a > 22 || (a === 22 && b >= 15) ? 0 : 1)" 2>/dev/null; then
  ARCH=arm64; [ "$(uname -m)" = x86_64 ] && ARCH=x64
  BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  SUMS="$(curl -fsSL "${BASE}/SHASUMS256.txt")"
  FILE="$(echo "${SUMS}" | awk "/linux-${ARCH}\\.tar\\.xz\$/ {print \$2}" | head -1)"
  SHA="$(echo "${SUMS}" | awk "/linux-${ARCH}\\.tar\\.xz\$/ {print \$1}" | head -1)"
  TMP="$(mktemp -d)"
  curl -fsSL -o "${TMP}/${FILE}" "${BASE}/${FILE}"
  echo "${SHA}  ${TMP}/${FILE}" | sha256sum -c -
  tar -xJf "${TMP}/${FILE}" -C /usr/local --strip-components=1 --exclude='*/share/doc'
  rm -rf "${TMP}"
fi
/usr/local/bin/node --version

echo "== ShowPilot Player"
TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=100" | jq -r '[.[] | select(.draft|not) | select(.prerelease|not) | .tag_name] | sort_by(ltrimstr("v") | split(".") | map(tonumber)) | last // empty')"
[ -n "${TAG}" ] || { echo "No releases published yet."; exit 1; }
TMP="$(mktemp -d)"
curl -fsSL -o "${TMP}/app.tgz" "https://codeload.github.com/${REPO}/tar.gz/refs/tags/${TAG}"
NEW="${APP}.next"
rm -rf "${NEW}" && mkdir -p "${NEW}"
tar -xzf "${TMP}/app.tgz" -C "${NEW}" --strip-components=1
(cd "${NEW}" && /usr/local/bin/npm install --omit=dev --no-audit --no-fund)
systemctl stop showpilot-player 2>/dev/null || true
if [ -d "${APP}" ]; then rm -rf "${APP}.previous"; mv "${APP}" "${APP}.previous"; fi
mv "${NEW}" "${APP}"
rm -rf "${TMP}"

echo "== Media folders"
if ! id fpp >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /home/fpp --shell /usr/sbin/nologin fpp
  usermod -aG audio,video,render fpp || true
fi
for d in sequences music videos effects images scripts playlists config logs plugins plugindata upload virtualdisplay_assets; do
  install -d -o fpp -g fpp "/home/fpp/media/${d}"
done

echo "== Service"
install -m 644 "${APP}/scripts/showpilot-player.service" /etc/systemd/system/showpilot-player.service
systemctl daemon-reload
systemctl enable --now showpilot-player
systemctl enable --now avahi-daemon 2>/dev/null || true
echo
echo "ShowPilot Player ${TAG} is running: http://$(hostname).local/  (or http://$(hostname -I | awk '{print $1}')/)"
