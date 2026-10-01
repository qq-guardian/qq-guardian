#!/bin/sh
set -eu
PREFIX="${QQ_GUARDIAN_PREFIX:-$HOME/.local/opt/qq-guardian}"
REPO="${QQ_GUARDIAN_REPOSITORY:-qq-guardian/qq-guardian}"
VERSION="${1:-}"
[ -n "$VERSION" ] || { echo "Usage: ./update.sh vX.Y.Z" >&2; exit 2; }
case "$VERSION" in v*) ;; *) VERSION="v$VERSION";; esac
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
CURRENT="$PREFIX/current"
[ -x "$CURRENT/updater/update.sh" ] || { echo "Installed updater not found: $CURRENT/updater/update.sh" >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
NAME="qq-guardian-$VERSION-linux-x64.tar.gz"
BASE="https://github.com/$REPO/releases/download/$VERSION"
curl -fsSL "$BASE/$NAME" -o "$TMP/$NAME"
curl -fsSL "$BASE/$NAME.sha256" -o "$TMP/$NAME.sha256"
(cd "$TMP" && sha256sum -c "$NAME.sha256")
"$CURRENT/updater/update.sh" "$TMP/$NAME"
