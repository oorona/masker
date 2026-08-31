#!/usr/bin/env bash
# Test agent: interactive. The user drives it ("pull 10 accounts and load them").
# It talks to prod ONLY through the mailbox and stores the masked rows it gets back.
set -euo pipefail
cd "$(dirname "$0")"

[ -f ../../.env ] && set -a && . ../../.env && set +a

export PI_AGENT_ID=test
export PI_DB_ROLE=consumer
export PI_PG_URL="${TEST_PG_URL:-postgresql://masker:masker@localhost:5432/fintechT}"
export PI_BUS_URL="${BUS_URL:-postgresql://masker:masker@localhost:5432/bus}"

exec pi "$@"
