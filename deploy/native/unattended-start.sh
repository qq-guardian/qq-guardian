#!/usr/bin/env sh
set -eu

SNOWLUMA_ROOT="\${1:?pass the operator-installed official SnowLuma directory}"
GUARDIAN_RUNTIME="\${2:?pass the Guardian dist-snowluma/index.mjs path}"
ENV_FILE="\${3:-}"

case "$SNOWLUMA_ROOT" in
  /*) ;;
  *) echo "SNOWLUMA_ROOT must be absolute" >&2; exit 2 ;;
esac

[ -f "$SNOWLUMA_ROOT/launcher.sh" ] || { echo "official SnowLuma launcher.sh not found" >&2; exit 1; }
[ -f "$SNOWLUMA_ROOT/index.mjs" ] || { echo "official SnowLuma index.mjs not found" >&2; exit 1; }
[ -f "$GUARDIAN_RUNTIME" ] || { echo "Guardian runtime not found: $GUARDIAN_RUNTIME" >&2; exit 1; }

load_env() {
  file="$1"
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
      *=*) ;;
      *) echo "Invalid environment line in $file" >&2; exit 2 ;;
    esac
    key="\${line%%=*}"
    value="\${line#*=}"
    case "$key" in
      ''|[0-9]*|*[!A-Za-z0-9_]*) echo "Invalid environment variable name in $file" >&2; exit 2 ;;
    esac
    export "$key=$value"
  done < "$file"
}

[ -z "$ENV_FILE" ] || load_env "$ENV_FILE"
SNOWLUMA_ACCEPT_EULA="\${SNOWLUMA_ACCEPT_EULA:-1}"
SNOWLUMA_ACCEPT_PRIVACY="\${SNOWLUMA_ACCEPT_PRIVACY:-1}"
export SNOWLUMA_ACCEPT_EULA SNOWLUMA_ACCEPT_PRIVACY

command -v node >/dev/null 2>&1 || {
  echo "Node.js >=22.13.0 is required for Guardian lite mode" >&2
  exit 127
}

GUARDIAN_ROOT="$(CDPATH= cd -- "$(dirname -- "$GUARDIAN_RUNTIME")/.." && pwd)"
DEFAULT_ENV="$GUARDIAN_ROOT/guardian.env"
[ -n "$ENV_FILE" ] || ENV_FILE="$DEFAULT_ENV"
[ -f "$ENV_FILE" ] && load_env "$ENV_FILE"

(
  cd "$SNOWLUMA_ROOT"
  ./launcher.sh
) &
SNOWLUMA_PID=$!

cleanup() { kill "$SNOWLUMA_PID" 2>/dev/null || true; }
trap cleanup INT TERM EXIT

node "$GUARDIAN_RUNTIME"
