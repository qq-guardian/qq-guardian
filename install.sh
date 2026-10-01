#!/bin/sh
set -eu
REPO="${QQ_GUARDIAN_REPOSITORY:-qq-guardian/qq-guardian}"
VERSION="${QQ_GUARDIAN_VERSION:-}"
PREFIX="${QQ_GUARDIAN_PREFIX:-$HOME/.local/opt/qq-guardian}"
YES=0
[ "${1:-}" = "--yes" ] && YES=1
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }
[ -n "$VERSION" ] || VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\\([^"]*\\)".*/\\1/p' | head -n1)"
case "$VERSION" in v*) ;; *) VERSION="v$VERSION";; esac
ARCHIVE="qq-guardian-$VERSION-linux-x64.tar.gz"
BASE="https://github.com/$REPO/releases/download/$VERSION"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$BASE/$ARCHIVE" -o "$TMP/$ARCHIVE"
curl -fsSL "$BASE/$ARCHIVE.sha256" -o "$TMP/$ARCHIVE.sha256"
(cd "$TMP" && sha256sum -c "$ARCHIVE.sha256")
mkdir -p "$PREFIX/releases"
tar -xzf "$TMP/$ARCHIVE" -C "$TMP"
NEW="$(find "$TMP" -maxdepth 1 -type d -name 'qq-guardian-v*' | head -n1)"
[ -n "$NEW" ] || { echo "Archive root not found" >&2; exit 1; }
TARGET="$PREFIX/releases/$VERSION"
rm -rf "$TARGET"
cp -a "$NEW" "$TARGET"
mkdir -p "$PREFIX/data" "$PREFIX/config" "$PREFIX/logs"
rm -rf "$TARGET/data" "$TARGET/config" "$TARGET/logs"
ln -s "$PREFIX/data" "$TARGET/data"; ln -s "$PREFIX/config" "$TARGET/config"; ln -s "$PREFIX/logs" "$TARGET/logs"
ln -sfn "$TARGET" "$PREFIX/current"
"$PREFIX/current/verify.sh"
echo "Installed $VERSION at $PREFIX/current"
echo "Start: $PREFIX/current/launcher.sh"
