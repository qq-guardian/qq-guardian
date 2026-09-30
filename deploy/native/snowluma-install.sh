#!/bin/sh
set -eu
PACKAGE='';INSTALL_ROOT='/opt/qq-guardian/snowluma';ACCEPT_EULA=0;ACCEPT_PRIVACY=0;UNATTENDED=0
while [ $# -gt 0 ];do case "$1" in --package) PACKAGE=$2;shift 2;;--install-root) INSTALL_ROOT=$2;shift 2;;--accept-eula) ACCEPT_EULA=1;shift;;--accept-privacy) ACCEPT_PRIVACY=1;shift;;--unattended) UNATTENDED=1;shift;;*) echo "Unknown option: $1" >&2;exit 2;;esac;done
[ -n "$PACKAGE" ]||{ echo "--package is required" >&2;exit 2; }
[ "$UNATTENDED" -eq 0 ]||{ [ "$ACCEPT_EULA" -eq 1 ]&&[ "$ACCEPT_PRIVACY" -eq 1 ]; }||{ echo "unattended mode requires both acceptance flags" >&2;exit 2; }
case "$(uname -m)" in x86_64|amd64) PLATFORM=linux-x64;;aarch64|arm64) PLATFORM=linux-arm64;;*) echo "Unsupported Linux architecture" >&2;exit 2;;esac
case "$PLATFORM" in linux-x64) F="SnowLuma-v1.14.20-linux-x64.tar.gz";S=46367860;H="3e358c46e5f3d4eae4ae49b8f6277f65bcb4f33d0391059e034d0a1242b807b2";; linux-arm64) F="SnowLuma-v1.14.20-linux-arm64.tar.gz";S=45811604;H="eec09e50f0420441fe9e3909613109ad208174dcb32669a24ea28fec62a183ba";; esac
[ "$(basename "$PACKAGE")" = "$F" ]||{ echo "Expected $F" >&2;exit 1; }
[ "$(wc -c <"$PACKAGE"|tr -d " ")" = "$S" ]||{ echo "Official SnowLuma size mismatch" >&2;exit 1; }
[ "$(sha256sum "$PACKAGE"|awk "{print $1}")" = "$H" ]||{ echo "Official SnowLuma SHA-256 mismatch" >&2;exit 1; }
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.."&&pwd);TMP=$(mktemp -d);trap "rm -rf \"$TMP\"" EXIT;mkdir -p "$INSTALL_ROOT"
tar -xzf "$PACKAGE" -C "$TMP";[ -f "$TMP/launcher.sh" ]&&[ -x "$TMP/node" ]||{ echo "Official full SnowLuma archive layout not recognized" >&2;exit 1; };cp -a "$TMP/." "$INSTALL_ROOT/"
G="$INSTALL_ROOT/qq-guardian";mkdir -p "$G";cp -a "$ROOT/dist-snowluma" "$G/"
E="$G/guardian.env";: >"$E";[ "$ACCEPT_EULA" -eq 1 ]&&echo SNOWLUMA_ACCEPT_EULA=1>>"$E"||true;[ "$ACCEPT_PRIVACY" -eq 1 ]&&echo SNOWLUMA_ACCEPT_PRIVACY=1>>"$E"||true;echo SNOWLUMA_WS_URL=ws://127.0.0.1:3001/>>"$E"
printf "%s\n" "{"officialRelease":"v1.14.20","asset":"$F","sha256":"$H"}" >"$INSTALL_ROOT/qq-guardian-install.json"
if [ "$UNATTENDED" -eq 1 ];then nohup "$ROOT/deploy/native/start-snowluma-guardian.sh" "$INSTALL_ROOT" "$G" "$E" >/var/log/qq-guardian-snowluma.log 2>&1 &fi
echo "Installed official SnowLuma v1.14.20."
