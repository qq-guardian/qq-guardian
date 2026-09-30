#!/bin/sh
set -eu
S=${1:?SnowLuma root required};G=${2:?Guardian root required};E=${3:?Guardian environment file required}
[ -x "$S/node" ]||{ echo "Bundled node not found; use official full package" >&2;exit 1; }
[ -x "$S/launcher.sh" ]||{ echo "launcher.sh not found" >&2;exit 1; }
while IFS= read -r line||[ -n "$line" ];do case "$line" in ""|"#"*)continue;;*=*)export "$line";;*)echo "Invalid environment line" >&2;exit 2;;esac;done <"$E"
(cd "$S"&&./launcher.sh)&P=$!;trap "kill $P 2>/dev/null||true" INT TERM EXIT;exec "$S/node" "$G/dist-snowluma/index.mjs"
