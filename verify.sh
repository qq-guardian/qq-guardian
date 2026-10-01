#!/bin/sh
set -eu
ROOT="${1:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"
for f in launcher.sh runtime/node/bin/node app/index.mjs config/.env.example logs/.gitkeep RELEASE-MANIFEST.json; do
  [ -e "$ROOT/$f" ] || { echo "Missing $f" >&2; exit 1; }
done
echo "QQ Guardian production package verified: $ROOT"
