#!/bin/bash -e
# Host side: Node.js (official arm64 build, checksum-verified), the app, the service.
NODE_MAJOR="${NODE_MAJOR:-22}"
BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
SUMS="$(curl -fsSL "${BASE}/SHASUMS256.txt")"
FILE="$(echo "${SUMS}" | awk '/linux-arm64\.tar\.xz$/ {print $2}' | head -1)"
SHA="$(echo "${SUMS}" | awk '/linux-arm64\.tar\.xz$/ {print $1}' | head -1)"
[ -n "${FILE}" ] || { echo "could not find the Node.js arm64 build"; exit 1; }
curl -fsSL -o "${STAGE_WORK_DIR}/${FILE}" "${BASE}/${FILE}"
echo "${SHA}  ${STAGE_WORK_DIR}/${FILE}" | sha256sum -c -
tar -xJf "${STAGE_WORK_DIR}/${FILE}" -C "${ROOTFS_DIR}/usr/local" --strip-components=1 \
	--exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' --exclude='*/share/doc'

install -d "${ROOTFS_DIR}/opt/showpilot-player"
tar -xzf files/app.tar.gz -C "${ROOTFS_DIR}/opt/showpilot-player"
install -m 644 "${ROOTFS_DIR}/opt/showpilot-player/scripts/showpilot-player.service" "${ROOTFS_DIR}/etc/systemd/system/showpilot-player.service"

# Keep the HDMI output (video / virtual matrix) from blanking.
CMDLINE="${ROOTFS_DIR}/boot/firmware/cmdline.txt"
[ -f "${CMDLINE}" ] || CMDLINE="${ROOTFS_DIR}/boot/cmdline.txt"
if [ -f "${CMDLINE}" ] && ! grep -q consoleblank "${CMDLINE}"; then
	sed -i '1 s/$/ consoleblank=0/' "${CMDLINE}"
fi
