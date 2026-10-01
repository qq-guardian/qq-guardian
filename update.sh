#!/bin/sh
set -eu
PREFIX="${QQ_GUARDIAN_PREFIX:-$HOME/.local/opt/qq-guardian}"
VERSION="${1:-}"
[ -n "$VERSION" ] || { echo "Usage: ./update.sh vX.Y.Z" >&2; exit 2; }
QQ_GUARDIAN_VERSION="$VERSION" QQ_GUARDIAN_PREFIX="$PREFIX" "$PREFIX/current/install.sh" --yes
