#!/bin/sh
set -eu
mkdir -p "${QQ_GUARDIAN_DATA_DIR:-/data}" "${QQ_GUARDIAN_CONFIG_DIR:-/config}" /logs
exec node /app/index.mjs >> /logs/qq-guardian.log 2>&1
