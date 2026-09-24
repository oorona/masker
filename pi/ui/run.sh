#!/usr/bin/env bash
# Bus monitor: the web UI showing the two agents talking over the mailbox
# (and, with MASKER_CONTROL=1, the control plane that runs the emulated agents).
set -euo pipefail
cd "$(dirname "$0")"

[ -f ../../.env ] && set -a && . ../../.env && set +a

export BUS_URL="${BUS_URL:-postgresql://masker:masker@localhost:5432/bus}"
export TEST_PG_URL="${TEST_PG_URL:-postgresql://masker:masker@localhost:5432/fintechT}"
export MASKER_PROD_URL="${PROD_PG_URL:-postgresql://masker:masker@localhost:5432/fintechP}"
# MASKER_CONTROL=1 ./pi/ui/run.sh  -> control plane (start/stop the model-free agents,
# seed/reset the DBs from the page). Default: observer next to the real Pi agents.
export MASKER_CONTROL="${MASKER_CONTROL:-0}"
export MASKER_UI_HOST="${MASKER_UI_HOST:-127.0.0.1}"
export MASKER_UI_PORT="${MASKER_UI_PORT:-5055}"

exec node ./server.mjs
