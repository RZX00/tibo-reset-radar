#!/usr/bin/env sh
set -eu

ENV_FILE=${1:-deploy/.env.production.previous}
COMPOSE_FILE=deploy/compose.production.yml

if [ ! -f "$ENV_FILE" ]; then
  echo "missing rollback environment file: $ENV_FILE" >&2
  exit 1
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config >/dev/null
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

RADAR_PORT=$(sed -n 's/^RADAR_PORT=//p' "$ENV_FILE" | tail -1)
RADAR_PORT=${RADAR_PORT:-4173}
attempt=0
until curl --fail --silent --show-error "http://127.0.0.1:${RADAR_PORT}/api/status" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "rollback did not become healthy on 127.0.0.1:${RADAR_PORT}" >&2
    exit 1
  fi
  sleep 2
done
echo "rollback healthy on 127.0.0.1:${RADAR_PORT}; the SQLite file is untouched by an image change"
