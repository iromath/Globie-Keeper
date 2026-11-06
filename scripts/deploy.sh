#!/usr/bin/env bash
#
# Deploy the Globie Keeper stack (DEV_PLAN §2.15).
#
# Production is two hostnames behind Cloudflare/Easypanel:
#   https://keeper.globie.ai     -> web   (Expo export in nginx)
#   https://keeperapi.globie.ai  -> api   (Fastify)
# Easypanel runs the containers and terminates TLS; this script is for hosts
# that run docker compose directly (staging, a raw VPS, local prod rehearsal).
#
# Run from a checkout at /opt/supproject (or anywhere; the repo root is derived
# from this file). Migrations run here, before the new API starts. The demo data
# is deliberately NOT seeded: `npm --prefix server run seed` is an explicit,
# destructive-by-intent act that a deploy must never make for you.
#
# Requirements on the host: git, docker with the compose plugin, and a .env at
# the repo root (chmod 600). Node/npm are not needed: the images come prebuilt
# from Docker Hub.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROXY_PORT="${PROXY_PORT:-8080}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PROXY_PORT}/api/health}"

log() { printf '\n==> %s\n' "$*"; }

if [[ ! -f .env ]]; then
  echo "missing .env — copy .env.example, fill in the secrets, then chmod 600 .env" >&2
  exit 1
fi
chmod 600 .env

log "pulling latest main"
if [[ "${SKIP_PULL:-0}" == "1" ]]; then
  echo "skipped (SKIP_PULL=1)"
else
  git pull --ff-only
fi

log "validating compose file"
docker compose config -q

# The images are built and pushed from a dev machine:
#   docker build -f server/Dockerfile          -t tradex367/globie-keeper-api:latest .
#   docker build -f deploy/Dockerfile.web      -t tradex367/globie-keeper-web:latest .
#   docker push tradex367/globie-keeper-api:latest && docker push tradex367/globie-keeper-web:latest
# Both are self-contained (the API image carries db/migrations, the web image
# carries the Expo export), so a deploy host only needs to pull. Set
# API_IMAGE / WEB_IMAGE in .env to pin a digest or a different tag.
log "pulling api and web images"
docker compose pull api web

log "starting Postgres"
docker compose up -d db
for _ in $(seq 1 60); do
  if docker compose exec -T db pg_isready -q; then break; fi
  sleep 2
done
docker compose exec -T db pg_isready -q

log "applying migrations"
docker compose run --rm --no-deps api node dist/db/migrate-cli.js

log "starting api, web, and proxy"
docker compose up -d --remove-orphans api web proxy

log "waiting for $HEALTH_URL"
curl -fsS --retry 12 --retry-delay 5 --retry-connrefused "$HEALTH_URL"
printf '\n'

log "deployed"
