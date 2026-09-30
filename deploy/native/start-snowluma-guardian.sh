#!/usr/bin/env sh
set -eu

SNOWLUMA_ROOT=${1:?SnowLuma root required}
GUARDIAN_ROOT=${2:?Guardian root required}
ENV_FILE=${3:-${QQ_GUARDIAN_ENV_FILE:-$GUARDIAN_ROOT/guardian.env}}

[ -x "$SNOWLUMA_ROOT/node" ] || { echo "Bundled Node.js runtime not found: $SNOWLUMA_ROOT/node" >&2; exit 1; }
[ -x "$SNOWLUMA_ROOT/launcher.sh" ] || { echo "Official SnowLuma launcher.sh not found" >&2; exit 1; }
[ -f "$GUARDIAN_ROOT/dist-snowluma/index.mjs" ] || { echo "Guardian SnowLuma runtime not found" >&2; exit 1; }
[ -r "$ENV_FILE" ] || { echo "Guardian environment file not readable: $ENV_FILE" >&2; exit 1; }

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|'#'*) continue ;;
    *=*) ;;
    *) echo "Invalid environment line in $ENV_FILE" >&2; exit 2 ;;
  esac
  key=${line%%=*}
  value=${line#*=}
  case "$key" in
    ''|[0-9]*|*[!A-Za-z0-9_]*)
      echo "Invalid environment variable name in $ENV_FILE: $key" >&2
      exit 2
      ;;
  esac
  export "$key=$value"
done < "$ENV_FILE"

"$SNOWLUMA_ROOT/launcher.sh" &
snow_pid=$!
"$SNOWLUMA_ROOT/node" "$GUARDIAN_ROOT/dist-snowluma/index.mjs" &
guardian_pid=$!

cleanup() {
  rc=$?
  kill "$snow_pid" 2>/dev/null || true
  kill "$guardian_pid" 2>/dev/null || true
  wait "$snow_pid" 2>/dev/null || true
  wait "$guardian_pid" 2>/dev/null || true
  exit "$rc"
}
trap cleanup INT TERM EXIT

while kill -0 "$snow_pid" 2>/dev/null && kill -0 "$guardian_pid" 2>/dev/null; do
  sleep 2
done

echo "SnowLuma or Guardian exited; stopping the sibling process and returning failure." >&2
exit 1
