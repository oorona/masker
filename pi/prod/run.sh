#!/usr/bin/env bash
# Production agent: autonomous responder.
#
# IMPORTANT (cost): the agent is only ever invoked when there is an actual pending
# request. Idle polling is done with a cheap SQL count (no model call), so sitting
# idle costs $0 in model tokens. Each real request triggers exactly one agent run,
# whose full trace (thinking + tool calls) is printed by trace.mjs.
set -euo pipefail
cd "$(dirname "$0")"

[ -f ../../.env ] && set -a && . ../../.env && set +a

export PI_AGENT_ID=prod
export PI_DB_ROLE=producer
export PI_PG_URL="${PROD_PG_URL:-postgresql://masker:masker@localhost:5432/fintechP}"
export PI_BUS_URL="${BUS_URL:-postgresql://masker:masker@localhost:5432/bus}"

CONTAINER="${MASKER_CONTAINER:-masker-db}"

# Cheap, model-free check for a pending request addressed to prod.
pending_count() {
  docker exec "$CONTAINER" psql -U masker -d bus -tAc \
    "SELECT count(*) FROM mq.messages WHERE recipient='prod' AND consumed_at IS NULL" 2>/dev/null \
    | tr -d '[:space:]'
}

echo "[prod] data steward online — polling the bus with SQL (no model cost while idle)."
echo "[prod] a model run (with full trace) happens only when a request arrives. Ctrl+C to stop."
while true; do
  if [ "$(pending_count)" = "0" ] || [ -z "$(pending_count)" ]; then
    sleep 2
    continue
  fi
  # A request is waiting — run the agent once and render its trace.
  pi --mode json "There are pending requests in your mailbox. Using only your provided tools, call mailbox_wait to read one, then query_masked to fetch the rows, then mailbox_send to return them to test — narrating each step. Then call mailbox_wait again with timeout_ms 20000 and repeat while requests keep arriving; stop when it returns empty." \
    2>/dev/null | node ./trace.mjs || true
done
