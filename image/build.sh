#!/bin/bash
# Build the flashable image with pi-gen in Docker (used by the GitHub
# workflow; also works on any x86_64 Linux box with Docker and binfmt/qemu).
#   image/build.sh [version]
# Output: image/out/ShowPilot-Player-<version>-arm64.img.xz
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
VERSION="${1:-$(node -p "require('${REPO}/package.json').version")}"
WORK="${WORK:-/tmp/spp-pigen}"

mkdir -p "$WORK" && rm -rf "$WORK/pi-gen"
git clone --depth 1 --branch arm64 https://github.com/RPi-Distro/pi-gen.git "$WORK/pi-gen"
cp -r "$HERE/stage-showpilot" "$WORK/pi-gen/"
# The app goes in as tracked files only (no .git, node_modules or local data).
mkdir -p "$WORK/pi-gen/stage-showpilot/01-app/files"   # empty dirs are not in git
git -C "$REPO" archive --format=tar.gz -o "$WORK/pi-gen/stage-showpilot/01-app/files/app.tar.gz" HEAD
cp "$HERE/config" "$WORK/pi-gen/config"
# Only export our stage, not the plain "lite" image from stage2.
touch "$WORK/pi-gen/stage2/SKIP_IMAGES"

cd "$WORK/pi-gen"
./build-docker.sh

mkdir -p "$HERE/out"
IMG="$(ls deploy/*.img.xz | head -1)"
cp "$IMG" "$HERE/out/ShowPilot-Player-${VERSION}-arm64.img.xz"
(cd "$HERE/out" && sha256sum "ShowPilot-Player-${VERSION}-arm64.img.xz" > "ShowPilot-Player-${VERSION}-arm64.img.xz.sha256")
echo "Built $HERE/out/ShowPilot-Player-${VERSION}-arm64.img.xz"
