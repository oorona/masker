#!/usr/bin/env bash
# Reset the PoC databases to a clean starting state:
#   fintechP  -> reseeded with the canonical (deterministic) production data
#   fintechT  -> emptied (no data)
#   bus       -> emptied (no messages)
#
# Pass-through args go to seed.py, e.g.:  ./db/reset.sh --count 500
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

CONTAINER="${MASKER_CONTAINER:-masker-db}"
# Seeder: the local venv if present, otherwise the `seed` compose service (no
# local Python/Faker needed — e.g. on the deployed home box).
if [ -x ./.venv/bin/python ]; then
  SEED=(./.venv/bin/python db/seed.py)
else
  SEED=(docker compose run --rm masker-seed)
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}\$"; then
  echo "[reset] container '${CONTAINER}' is not running. Start it with: docker compose up -d" >&2
  exit 1
fi

echo "[reset] emptying test DB (fintechT)…"
docker exec "$CONTAINER" psql -U masker -d fintechT -q -c \
  "TRUNCATE bank.transactions, bank.cards, bank.accounts, bank.addresses, bank.customers RESTART IDENTITY CASCADE;"

echo "[reset] clearing the message bus…"
docker exec "$CONTAINER" psql -U masker -d bus -q -c "TRUNCATE mq.messages RESTART IDENTITY;"

echo "[reset] reseeding production DB (fintechP)…"
"${SEED[@]}" "$@"

echo "[reset] done. Current state:"
docker exec "$CONTAINER" psql -U masker -d fintechP -t -A -c "SELECT 'fintechP customers = '||count(*) FROM bank.customers;"
docker exec "$CONTAINER" psql -U masker -d fintechT -t -A -c "SELECT 'fintechT customers = '||count(*) FROM bank.customers;"
docker exec "$CONTAINER" psql -U masker -d bus      -t -A -c "SELECT 'bus messages       = '||count(*) FROM mq.messages;"
