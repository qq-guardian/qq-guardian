#!/bin/sh
set -eu
PREFIX="${QQ_GUARDIAN_PREFIX:-$HOME/.local/opt/qq-guardian}"
CURRENT="$PREFIX/current"
RELEASES="$PREFIX/releases"
[ -L "$CURRENT" ] || { echo "No versioned installation found: $CURRENT" >&2; exit 1; }
TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  TARGET="$(readlink "$CURRENT" | awk -F/ '{print $NF}')"
  TARGET="$(find "$RELEASES" -maxdepth 1 -mindepth 1 -type d -printf '%f
' | sort -V | awk -v cur="$TARGET" '$0 < cur {prev=$0} END {print prev}')"
fi
[ -n "$TARGET" ] || { echo "No previous release is available." >&2; exit 1; }
[ -d "$RELEASES/$TARGET" ] || { echo "Release not found: $TARGET" >&2; exit 1; }
ln -sfn "$RELEASES/$TARGET" "$CURRENT"
"$CURRENT/verify.sh"
echo "Rolled back to $TARGET"
