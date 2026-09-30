#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUNDLE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
PACKAGE=''
INSTALL_ROOT='/opt/qq-guardian/snowluma'
ENV_FILE='/etc/qq-guardian/guardian.env'
SERVICE_USER="${SUDO_USER:-$(id -un)}"
UNATTENDED=0
ACCEPT_EULA=0
ACCEPT_PRIVACY=0
FORCE=0

usage() {
  cat <<'EOF'
Usage:
  sudo sh snowluma-install.sh --package /path/to/SnowLuma-v1.14.20-linux-x64.tar.gz [options]

Options:
  --package PATH          Exact official SnowLuma FULL archive supplied by the operator.
  --install-root PATH     Installation root (default: /opt/qq-guardian/snowluma).
  --environment-file PATH Guardian environment file (default: /etc/qq-guardian/guardian.env).
  --service-user USER     Linux account used by the combined service.
  --accept-eula           Declare acceptance of SnowLuma EULA.
  --accept-privacy        Declare acceptance of SnowLuma Privacy Notice.
  --unattended            No installer prompts; enable and start the systemd service.
  --force                 Replace an existing installation root.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --package) PACKAGE=${2:?--package requires a path}; shift 2 ;;
    --install-root) INSTALL_ROOT=${2:?--install-root requires a path}; shift 2 ;;
    --environment-file) ENV_FILE=${2:?--environment-file requires a path}; shift 2 ;;
    --service-user) SERVICE_USER=${2:?--service-user requires a user}; shift 2 ;;
    --accept-eula) ACCEPT_EULA=1; shift ;;
    --accept-privacy) ACCEPT_PRIVACY=1; shift ;;
    --unattended) UNATTENDED=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Run this installer as root (use sudo)." >&2; exit 1; }
[ -n "$PACKAGE" ] || { echo "Supply the exact official SnowLuma FULL archive with --package." >&2; exit 2; }
[ "$UNATTENDED" -eq 0 ] || { [ "$ACCEPT_EULA" -eq 1 ] && [ "$ACCEPT_PRIVACY" -eq 1 ]; } || {
  echo "--unattended requires --accept-eula and --accept-privacy." >&2
  exit 2
}
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required." >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required." >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "systemctl is required." >&2; exit 1; }

case "$(uname -m)" in
  x86_64|amd64) PLATFORM='linux-x64' ;;
  aarch64|arm64) PLATFORM='linux-arm64' ;;
  *) echo "Unsupported Linux architecture: $(uname -m)" >&2; exit 2 ;;
esac

CHECKSUM_FILE="$SCRIPT_DIR/official-snowluma.sha256"
SIZE_FILE="$SCRIPT_DIR/official-snowluma.size"
EXPECTED_FILE="$(awk '{print $2}' "$CHECKSUM_FILE")"
EXPECTED_SHA="$(awk '{print $1}' "$CHECKSUM_FILE")"
EXPECTED_SIZE="$(tr -d '[:space:]' < "$SIZE_FILE")"

case "$PLATFORM" in
  linux-x64) [ "$EXPECTED_FILE" = 'SnowLuma-v1.14.20-linux-x64.tar.gz' ] || { echo "Bundle upstream manifest/platform mismatch." >&2; exit 1; } ;;
  linux-arm64) [ "$EXPECTED_FILE" = 'SnowLuma-v1.14.20-linux-arm64.tar.gz' ] || { echo "Bundle upstream manifest/platform mismatch." >&2; exit 1; } ;;
esac

[ "$(basename "$PACKAGE")" = "$EXPECTED_FILE" ] || {
  echo "Expected official asset $EXPECTED_FILE." >&2
  exit 1
}
ACTUAL_SIZE="$(wc -c < "$PACKAGE" | tr -d '[:space:]')"
[ "$ACTUAL_SIZE" = "$EXPECTED_SIZE" ] || {
  echo "Official SnowLuma size mismatch: $ACTUAL_SIZE != $EXPECTED_SIZE." >&2
  exit 1
}
ACTUAL_SHA="$(sha256sum "$PACKAGE" | awk '{print $1}')"
[ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || {
  echo "Official SnowLuma SHA-256 mismatch." >&2
  exit 1
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$PACKAGE" -C "$TMP"

[ -f "$TMP/launcher.sh" ] && [ -x "$TMP/node" ] && [ -f "$TMP/index.mjs" ] || {
  echo "Official SnowLuma full archive layout not recognized." >&2
  exit 1
}

if [ "$PLATFORM" = 'linux-x64' ]; then
  for file in     native/snowluma-linux-x64.node     native/snowluma-linux-x64.so     native/websocket-linux-x64.node     native/ffmpeg/ffmpegAddon.linux.x64.node
  do
    [ -f "$TMP/$file" ] || { echo "Official archive missing $file." >&2; exit 1; }
  done
else
  for file in     native/snowluma-linux-arm64.node     native/snowluma-linux-arm64.so     native/websocket-linux-arm64.node     native/ffmpeg/ffmpegAddon.linux.arm64.node
  do
    [ -f "$TMP/$file" ] || { echo "Official archive missing $file." >&2; exit 1; }
  done
fi

if [ -d "$INSTALL_ROOT" ] && [ "$FORCE" -eq 0 ] && [ -n "$(ls -A "$INSTALL_ROOT" 2>/dev/null || true)" ]; then
  echo "Install root is not empty: $INSTALL_ROOT (use --force to replace it)." >&2
  exit 1
fi

mkdir -p "$INSTALL_ROOT"
cp -a "$TMP/." "$INSTALL_ROOT/"

GUARDIAN_ROOT="$INSTALL_ROOT/qq-guardian"
rm -rf "$GUARDIAN_ROOT"
mkdir -p "$GUARDIAN_ROOT"
cp -a "$BUNDLE_ROOT/dist-snowluma" "$GUARDIAN_ROOT/dist-snowluma"
cp "$BUNDLE_ROOT/deploy/native/start-snowluma-guardian.sh" "$GUARDIAN_ROOT/start-snowluma-guardian.sh"
chmod +x "$GUARDIAN_ROOT/start-snowluma-guardian.sh"

STATE_ROOT='/var/lib/qq-guardian'
mkdir -p "$STATE_ROOT/data" "$STATE_ROOT/config" "$(dirname "$ENV_FILE")"

if [ ! -f "$ENV_FILE" ]; then
  {
    printf '%s\n' "SNOWLUMA_ACCEPT_EULA=$([ "$ACCEPT_EULA" -eq 1 ] && echo 1 || echo 0)"
    printf '%s\n' "SNOWLUMA_ACCEPT_PRIVACY=$([ "$ACCEPT_PRIVACY" -eq 1 ] && echo 1 || echo 0)"
    printf '%s\n' 'SNOWLUMA_WS_URL=ws://127.0.0.1:3001/'
    printf '%s\n' 'QQ_GUARDIAN_HTTP_HOST=127.0.0.1'
    printf '%s\n' 'QQ_GUARDIAN_HTTP_PORT=6099'
    printf '%s\n' "QQ_GUARDIAN_DATA_DIR=$STATE_ROOT/data"
    printf '%s\n' "QQ_GUARDIAN_CONFIG_DIR=$STATE_ROOT/config"
  } > "$ENV_FILE"
fi

chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_ROOT" "$STATE_ROOT" 2>/dev/null || true
chmod 700 "$STATE_ROOT" "$STATE_ROOT/data" "$STATE_ROOT/config"
chmod 600 "$ENV_FILE"

SERVICE_FILE='/etc/systemd/system/qq-guardian-snowluma.service'
sed   -e "s|@RUN_USER@|$SERVICE_USER|g"   -e "s|@INSTALL_ROOT@|$INSTALL_ROOT|g"   -e "s|@GUARDIAN_ROOT@|$GUARDIAN_ROOT|g"   -e "s|@ENV_FILE@|$ENV_FILE|g"   -e "s|@START_SCRIPT@|$GUARDIAN_ROOT/start-snowluma-guardian.sh|g"   "$SCRIPT_DIR/qq-guardian-snowluma.service" > "$SERVICE_FILE"

systemctl daemon-reload
if [ "$UNATTENDED" -eq 1 ]; then
  systemctl enable --now qq-guardian-snowluma.service
  echo "Installed and started official SnowLuma + QQ Guardian."
else
  echo "Installed official SnowLuma $EXPECTED_FILE and Guardian overlay."
  echo "Start manually: systemctl enable --now qq-guardian-snowluma.service"
fi
