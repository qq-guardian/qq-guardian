#!/usr/bin/env sh
set -eu

# Usage: ./start-guardian.sh /absolute/path/to/guardian.env /path/to/index.mjs
# This launcher works on native Linux and inside the same proot Linux userland
# as Guardian. The environment file is literal KEY=value data, not shell code.
ENV_FILE=${1:?pass the Guardian environment-file path}
RUNTIME_FILE=${2:?pass the standalone Guardian index.mjs path}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js >=22.6.0 is required on PATH for Guardian" >&2
  exit 127
fi

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|'#'*) continue ;;
  esac
  key=${line%%=*}
  value=${line#*=}
  case "$key" in
    ''|[0-9]*|*[!A-Za-z0-9_]*)
      echo "Invalid environment variable name in $ENV_FILE" >&2
      exit 2
      ;;
  esac
  export "$key=$value"
done < "$ENV_FILE"

exec node "$RUNTIME_FILE"
