#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(pwd)"

VERSION="${1:-}"
if [ -z "${VERSION}" ]; then
  if [ -f "package.json" ]; then
    VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.1.7")
  else
    VERSION="0.1.7"
  fi
fi

VERSION="${VERSION#v}"

BINARY_PATH=""
if [ -f "target/release/kanade" ]; then
  BINARY_PATH="target/release/kanade"
elif [ -f "src-tauri/target/release/kanade" ]; then
  BINARY_PATH="src-tauri/target/release/kanade"
else
  echo "Error: Binary not found at target/release/kanade or src-tauri/target/release/kanade." >&2
  echo "Please build the Tauri release binary first ('cargo tauri build' or 'cargo build --release')." >&2
  exit 1
fi

echo "==> Building Arch Linux package (.pkg.tar.zst) for Kanade v${VERSION}..."

BUILD_DIR=$(mktemp -d)
PKG_DIR="${BUILD_DIR}/pkg"

cleanup() {
  rm -rf "${BUILD_DIR}"
}
trap cleanup EXIT

mkdir -p "${PKG_DIR}/usr/bin"
mkdir -p "${PKG_DIR}/usr/share/applications"
mkdir -p "${PKG_DIR}/usr/share/icons/hicolor/32x32/apps"
mkdir -p "${PKG_DIR}/usr/share/icons/hicolor/128x128/apps"
mkdir -p "${PKG_DIR}/usr/share/icons/hicolor/256x256/apps"
mkdir -p "${PKG_DIR}/usr/share/licenses/kanade"

install -Dm755 "${BINARY_PATH}" "${PKG_DIR}/usr/bin/kanade"

if [ -f "packaging/kanade.desktop" ]; then
  install -Dm644 "packaging/kanade.desktop" "${PKG_DIR}/usr/share/applications/kanade.desktop"
fi

if [ -f "src-tauri/icons/32x32.png" ]; then
  install -Dm644 "src-tauri/icons/32x32.png" "${PKG_DIR}/usr/share/icons/hicolor/32x32/apps/kanade.png"
fi
if [ -f "src-tauri/icons/128x128.png" ]; then
  install -Dm644 "src-tauri/icons/128x128.png" "${PKG_DIR}/usr/share/icons/hicolor/128x128/apps/kanade.png"
fi
if [ -f "src-tauri/icons/128x128@2x.png" ]; then
  install -Dm644 "src-tauri/icons/128x128@2x.png" "${PKG_DIR}/usr/share/icons/hicolor/256x256/apps/kanade.png"
fi

if [ -f "LICENSE" ]; then
  install -Dm644 "LICENSE" "${PKG_DIR}/usr/share/licenses/kanade/LICENSE"
fi

PKG_SIZE=$(du -sb "${PKG_DIR}" | awk '{print $1}')
BUILD_DATE=$(date +%s)

cat <<EOF >"${PKG_DIR}/.PKGINFO"
pkgname = kanade
pkgbase = kanade
pkgver = ${VERSION}-1
pkgdesc = Ad-free desktop music streaming powered by YouTube
url = https://github.com/kanadehq/kanade
builddate = ${BUILD_DATE}
packager = Kanade CI <https://github.com/kanadehq/kanade>
size = ${PKG_SIZE}
arch = x86_64
license = GPL-3.0-or-later
depend = mpv
depend = webkit2gtk-4.1
depend = libayatana-appindicator
depend = gtk3
depend = hicolor-icon-theme
EOF

if command -v bsdtar >/dev/null 2>&1; then
  TAR_CMD="bsdtar"
else
  TAR_CMD="tar"
fi

(cd "${PKG_DIR}" && "${TAR_CMD}" -czf .MTREE --format=mtree \
  --options='!all,use-set,type,uid,gid,mode,time,size,md5,sha256,link' \
  .PKGINFO usr 2>/dev/null || true)

OUTPUT_FILE="kanade-${VERSION}-1-x86_64.pkg.tar.zst"
OUTPUT_PATH="${ROOT_DIR}/${OUTPUT_FILE}"

if [ -f "${PKG_DIR}/.MTREE" ]; then
  (cd "${PKG_DIR}" && "${TAR_CMD}" -cf - .PKGINFO .MTREE usr | zstd -c -T0 -19 - >"${OUTPUT_PATH}")
else
  (cd "${PKG_DIR}" && "${TAR_CMD}" -cf - .PKGINFO usr | zstd -c -T0 -19 - >"${OUTPUT_PATH}")
fi

echo "==> Successfully created Arch Linux package: ${OUTPUT_FILE}"
