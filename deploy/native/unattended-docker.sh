#!/bin/sh
set -eu
E=${1:-deploy/.env}
[ -f "$E" ]||{ echo "Missing $E" >&2;exit 1; }
: "${SNOWLUMA_ACCEPT_EULA:?Set SNOWLUMA_ACCEPT_EULA=1 after reviewing the official EULA}"
: "${SNOWLUMA_ACCEPT_PRIVACY:?Set SNOWLUMA_ACCEPT_PRIVACY=1 after reviewing the official Privacy Notice}"
export SNOWLUMA_ACCEPT_EULA SNOWLUMA_ACCEPT_PRIVACY
exec docker compose --profile guardian --env-file "$E" -f deploy/compose.yaml up -d --build
