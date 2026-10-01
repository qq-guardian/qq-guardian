#!/bin/sh
set -eu
PREFIX="${QQ_GUARDIAN_PREFIX:-$HOME/.local/opt/qq-guardian}"
if [ "${1:-}" = "--purge" ]; then
  rm -rf "$PREFIX"
  echo "Removed application, configuration, logs, and data."
  exit 0
fi
rm -rf "$PREFIX/releases" "$PREFIX/current"
echo "Removed application versions. Preserved: $PREFIX/data $PREFIX/config $PREFIX/logs"
