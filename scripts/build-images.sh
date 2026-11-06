#!/usr/bin/env bash
#
# Build the Globie Keeper images and push them to Docker Hub (DEV_PLAN §2.15).
#
# Two images are built; both are self-contained so a deploy host only pulls:
#   globie-keeper-api   server/Dockerfile      Fastify API, carries db/migrations
#   globie-keeper-web   deploy/Dockerfile.web  Expo web export served by nginx
#
# The compose "proxy" service is stock nginx:alpine with bind-mounted config,
# so there is nothing to build for it.
#
# Usage:
#   scripts/build-images.sh                  # build, tag :latest + :<git-sha>, push
#   scripts/build-images.sh --no-push        # build only
#   TAG=v1.2.3 scripts/build-images.sh       # extra tag; third tag is not added
#   NAMESPACE=someoneelse scripts/build-images.sh
#
# Login is not handled here, because both engines prompt interactively. Do it
# once, naming the registry explicitly:
#   podman login docker.io      # or: docker login docker.io
#
# Note on podman: an unset registries.conf makes even `docker login` fail with
# "no registries found in registries.conf". Create
# ~/.config/containers/registries.conf containing
#   unqualified-search-registries = ["docker.io"]

set -euo pipefail

# podman uses the systemd cgroup manager, which needs a live session bus. When
# DBUS_SESSION_BUS_ADDRESS is a stale abstract socket, every RUN step fails with
# "runc create failed: Process org.freedesktop.systemd1 exited with status 1".
BUS_SOCKET="/run/user/$(id -u)/bus"
if [[ -S "$BUS_SOCKET" && ( -z "${DBUS_SESSION_BUS_ADDRESS:-}" || "$DBUS_SESSION_BUS_ADDRESS" == *abstract=* ) ]]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$BUS_SOCKET"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REGISTRY="${REGISTRY:-docker.io}"
NAMESPACE="${NAMESPACE:-tradex367}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)}"
PUSH=1

for arg in "$@"; do
  case "$arg" in
    --no-push) PUSH=0 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }

# `docker` on this machine is a podman shim; its --version still says podman.
if command -v docker >/dev/null 2>&1 && ! docker --version 2>/dev/null | grep -qi podman; then
  ENGINE=docker
elif command -v podman >/dev/null 2>&1; then
  ENGINE=podman
else
  echo "no container engine found: install docker or podman" >&2
  exit 1
fi

# name:dockerfile — the context is always the repo root.
IMAGES=(
  "globie-keeper-api:server/Dockerfile"
  "globie-keeper-web:deploy/Dockerfile.web"
)

logged_in() {
  local file
  for file in \
    "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/containers/auth.json" \
    "$HOME/.config/containers/auth.json" \
    "$HOME/.docker/config.json"; do
    [[ -f "$file" ]] && grep -q "$REGISTRY" "$file" && return 0
  done
  return 1
}

if (( PUSH )) && ! logged_in; then
  echo "not logged in to $REGISTRY — run: $ENGINE login $REGISTRY" >&2
  exit 1
fi

log "engine $ENGINE, target ${REGISTRY}/${NAMESPACE}, tags latest ${TAG}"

for image in "${IMAGES[@]}"; do
  name="${image%%:*}"
  dockerfile="${image#*:}"
  ref="${REGISTRY}/${NAMESPACE}/${name}"
  log "building ${ref}:${TAG}"
  "$ENGINE" build -f "$dockerfile" -t "${ref}:latest" -t "${ref}:${TAG}" .
done

if (( ! PUSH )); then
  log "built only (--no-push)"
  exit 0
fi

for image in "${IMAGES[@]}"; do
  ref="${REGISTRY}/${NAMESPACE}/${image%%:*}"
  log "pushing ${ref}"
  [[ "$TAG" == latest ]] || "$ENGINE" push "${ref}:${TAG}"
  "$ENGINE" push "${ref}:latest"
done

log "done"
printf '%s\n' "${IMAGES[@]}" | while IFS=: read -r name _; do
  printf '  %s/%s/%s:%s\n' "$REGISTRY" "$NAMESPACE" "$name" "$TAG"
done
