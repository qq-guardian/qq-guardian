#!/usr/bin/env bash
# QG-001: Pin the SnowLuma Docker image to an immutable content digest.
#
# Running with :latest is insecure — the tag can be moved to a different
# (possibly malicious) image layer at any time without warning.  A pinned
# digest (sha256:…) guarantees you run exactly the image you inspected.
#
# Usage:
#   bash deploy/scripts/pin-snowluma-digest.sh [tag]
#
#   tag — optional, defaults to "latest"
#
# The script prints the pinned value and, when an .env file exists beside
# this script's parent directory, offers to update SNOWLUMA_IMAGE in it.

set -euo pipefail

IMAGE="motricseven7/snowluma"
TAG="${1:-latest}"
FULL_REF="${IMAGE}:${TAG}"
ENV_FILE="$(dirname "$(dirname "$0")")/.env"

if ! command -v docker &>/dev/null; then
  echo "Error: docker is not installed or not on PATH." >&2
  exit 1
fi

echo "Pulling ${FULL_REF} to resolve its content digest…"
docker pull "${FULL_REF}" >/dev/null 2>&1

DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' "${FULL_REF}" 2>/dev/null || true)"

if [[ -z "${DIGEST}" ]]; then
  # Fallback: try docker inspect with the image tag directly.
  DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' "${IMAGE}:${TAG}" 2>/dev/null || true)"
fi

if [[ -z "${DIGEST}" ]]; then
  echo "Error: could not determine digest for ${FULL_REF}." >&2
  echo "Try: docker pull ${FULL_REF} && docker inspect ${FULL_REF} | grep -i digest" >&2
  exit 1
fi

echo ""
echo "Pinned digest:"
echo "  ${DIGEST}"
echo ""
echo "Set this in your .env:"
echo "  SNOWLUMA_IMAGE=${DIGEST}"
echo ""

if [[ -f "${ENV_FILE}" ]]; then
  read -r -p "Update SNOWLUMA_IMAGE in ${ENV_FILE} now? [y/N] " ANSWER
  if [[ "${ANSWER}" =~ ^[Yy]$ ]]; then
    if grep -q '^SNOWLUMA_IMAGE=' "${ENV_FILE}"; then
      sed -i "s|^SNOWLUMA_IMAGE=.*|SNOWLUMA_IMAGE=${DIGEST}|" "${ENV_FILE}"
    else
      echo "SNOWLUMA_IMAGE=${DIGEST}" >> "${ENV_FILE}"
    fi
    echo "Updated ${ENV_FILE}."
  fi
fi

echo "Done. After updating .env, run: docker compose pull && docker compose up -d"
