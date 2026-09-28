#!/usr/bin/env sh
set -eu

# Usage: ./start-bundled-guardian.sh [guardian.env]
# An explicit argument or QQ_GUARDIAN_ENV_FILE is required to exist. Without
# either, deploy/native/guardian.env is loaded when present and is optional.
root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
node_bin="$root_dir/runtime/node/bin/node"
environment_required=false

if [ "$#" -gt 1 ]; then
  echo "Usage: $0 [guardian.env]" >&2
  exit 2
fi
if [ "$#" -eq 1 ]; then
  env_file=$1
  environment_required=true
elif [ -n "${QQ_GUARDIAN_ENV_FILE:-}" ]; then
  env_file=$QQ_GUARDIAN_ENV_FILE
  environment_required=true
else
  env_file="$root_dir/deploy/native/guardian.env"
fi

if [ -e "$env_file" ]; then
  if [ ! -f "$env_file" ] || [ ! -r "$env_file" ]; then
    echo "Guardian environment file is not a readable regular file: $env_file" >&2
    exit 2
  fi
  carriage_return=$(printf '\r')
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%"$carriage_return"}
    case "$line" in
      ''|'#'*) continue ;;
      *=*) ;;
      *)
        echo "Invalid environment line in $env_file" >&2
        exit 2
        ;;
    esac
    key=${line%%=*}
    value=${line#*=}
    case "$key" in
      ''|[0-9]*|*[!A-Za-z0-9_]*)
        echo "Invalid environment variable name in $env_file" >&2
        exit 2
        ;;
    esac
    export "$key=$value"
  done < "$env_file"
elif [ "$environment_required" = true ]; then
  echo "Guardian environment file not found: $env_file" >&2
  exit 2
fi

if [ ! -x "$node_bin" ]; then
  echo "Bundled Node.js runtime not found for this platform: $node_bin" >&2
  echo "Use the matching full archive, or run deploy/native/start-guardian.sh with an installed Node.js runtime." >&2
  exit 1
fi

exec "$node_bin" "$root_dir/dist-snowluma/index.mjs"
