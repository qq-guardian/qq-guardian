#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUNDLE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
SNOWLUMA_ROOT=''
OFFICIAL_PACKAGE=''
ENV_FILE='/etc/qq-guardian/guardian.env'
SERVICE_USER="${SUDO_USER:-$(id -un)}"
UNATTENDED=0
ACCEPT_EULA=0
ACCEPT_PRIVACY=0
FORCE=0

usage() {
  cat <<'EOF'
Usage:
  sudo sh snowluma-install.sh --snowluma-root /opt/snowluma [options]

Required:
  --snowluma-root PATH    Existing official SnowLuma FULL installation root.
  --package PATH          Optional exact official FULL archive; verify only.

Options:
  --environment-file PATH Guardian environment file (default: /etc/qq-guardian/guardian.env).
  --service-user USER     Linux account used by the combined service.
  --accept-eula           Declare acceptance of SnowLuma EULA.
  --accept-privacy        Declare acceptance of SnowLuma Privacy Notice.
  --unattended            No installer prompts; enable and start the supervisor.
  --force                 Replace Guardian overlay files if already installed.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --snowluma-root) SNOWLUMA_ROOT=${2:?--snowluma-root requires a path}; shift 2 ;;
    --package) OFFICIAL_PACKAGE=${2:?--package requires a path}; shift 2 ;;
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
[ -n "$SNOWLUMA_ROOT" ] || { echo "Supply an existing official SnowLuma installation with --snowluma-root." >&2; exit 2; }
[ "$UNATTENDED" -eq 0 ] || { [ "$ACCEPT_EULA" -eq 1 ] && [ "$ACCEPT_PRIVACY" -eq 1 ]; } || {
  echo "--unattended requires --accept-eula and --accept-privacy." >&2
  exit 2
}

case "$(uname -m)" in
  x86_64|amd64) PLATFORM='linux-x64' ;;
  aarch64|arm64) PLATFORM='linux-arm64' ;;
  *) echo "Unsupported Linux architecture: $(uname -m)" >&2; exit 2 ;;
esac

if [ -n "$OFFICIAL_PACKAGE" ]; then
  command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required for archive verification." >&2; exit 1; }
  EXPECTED_FILE="$(awk '{print $2}' "$SCRIPT_DIR/official-snowluma.sha256")"
  EXPECTED_SHA="$(awk '{print $1}' "$SCRIPT_DIR/official-snowluma.sha256")"
  EXPECTED_SIZE="$(tr -d '[:space:]' < "$SCRIPT_DIR/official-snowluma.size")"
  case "$PLATFORM" in
    linux-x64) [ "$EXPECTED_FILE" = 'SnowLuma-v1.14.20-linux-x64.tar.gz' ] || { echo "Bundle upstream manifest/platform mismatch." >&2; exit 1; } ;;
    linux-arm64) [ "$EXPECTED_FILE" = 'SnowLuma-v1.14.20-linux-arm64.tar.gz' ] || { echo "Bundle upstream manifest/platform mismatch." >&2; exit 1; } ;;
  esac
  [ "$(basename "$OFFICIAL_PACKAGE")" = "$EXPECTED_FILE" ] || { echo "Official asset filename mismatch." >&2; exit 1; }
  [ "$(wc -c < "$OFFICIAL_PACKAGE" | tr -d '[:space:]')" = "$EXPECTED_SIZE" ] || { echo "Official SnowLuma size mismatch." >&2; exit 1; }
  [ "$(sha256sum "$OFFICIAL_PACKAGE" | awk '{print $1}')" = "$EXPECTED_SHA" ] || { echo "Official SnowLuma SHA-256 mismatch." >&2; exit 1; }
  echo "✓ official SnowLuma archive verified; installer will not extract or copy it."
fi

[ -x "$SNOWLUMA_ROOT/node" ] || { echo "Official bundled Node.js not found: $SNOWLUMA_ROOT/node" >&2; exit 1; }
[ -x "$SNOWLUMA_ROOT/launcher.sh" ] || { echo "Official SnowLuma launcher.sh not found: $SNOWLUMA_ROOT/launcher.sh" >&2; exit 1; }
[ -f "$SNOWLUMA_ROOT/index.mjs" ] || { echo "Official SnowLuma index.mjs not found." >&2; exit 1; }
[ -f "$SNOWLUMA_ROOT/EULA.md" ] || { echo "Official SnowLuma EULA.md not found." >&2; exit 1; }
[ -f "$SNOWLUMA_ROOT/PRIVACY.md" ] || { echo "Official SnowLuma PRIVACY.md not found." >&2; exit 1; }

if [ "$PLATFORM" = 'linux-x64' ]; then
  for file in     native/snowluma-linux-x64.node     native/snowluma-linux-x64.so     native/websocket-linux-x64.node     native/ffmpeg/ffmpegAddon.linux.x64.node
  do
    [ -f "$SNOWLUMA_ROOT/$file" ] || { echo "Official SnowLuma install missing $file." >&2; exit 1; }
  done
else
  for file in     native/snowluma-linux-arm64.node     native/snowluma-linux-arm64.so     native/websocket-linux-arm64.node     native/ffmpeg/ffmpegAddon.linux.arm64.node
  do
    [ -f "$SNOWLUMA_ROOT/$file" ] || { echo "Official SnowLuma install missing $file." >&2; exit 1; }
  done
fi

GUARDIAN_ROOT="$SNOWLUMA_ROOT/qq-guardian"
[ "$FORCE" -eq 1 ] || [ ! -e "$GUARDIAN_ROOT" ] || {
  echo "Guardian overlay already exists: $GUARDIAN_ROOT (use --force to replace it)." >&2
  exit 1
}

mkdir -p "$GUARDIAN_ROOT"
rm -rf "$GUARDIAN_ROOT/dist-snowluma"
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

chown -R "$SERVICE_USER":"$SERVICE_USER" "$GUARDIAN_ROOT" "$STATE_ROOT" 2>/dev/null || true
chmod 700 "$STATE_ROOT" "$STATE_ROOT/data" "$STATE_ROOT/config"
chmod 600 "$ENV_FILE"

SERVICE_FILE='/etc/systemd/system/qq-guardian-snowluma.service'
sed   -e "s|@RUN_USER@|$SERVICE_USER|g"   -e "s|@INSTALL_ROOT@|$SNOWLUMA_ROOT|g"   -e "s|@GUARDIAN_ROOT@|$GUARDIAN_ROOT|g"   -e "s|@ENV_FILE@|$ENV_FILE|g"   -e "s|@START_SCRIPT@|$GUARDIAN_ROOT/start-snowluma-guardian.sh|g"   "$SCRIPT_DIR/qq-guardian-snowluma.service" > "$SERVICE_FILE"

systemctl daemon-reload
if [ "$UNATTENDED" -eq 1 ]; then
  systemctl enable --now qq-guardian-snowluma.service
  echo "Guardian integration installed and started against the existing official SnowLuma installation."
else
  echo "Guardian integration installed. Start with: systemctl enable --now qq-guardian-snowluma.service"
fi
