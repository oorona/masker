#!/usr/bin/env bash
# Incremental delta sync: pull only NEW production rows into test, masked.
# (Model-free counterpart to the test agent's incremental sync.)
set -euo pipefail
cd "$(dirname "$0")/.."
node --experimental-strip-types pi/tools/sync-delta.mjs "$@"
