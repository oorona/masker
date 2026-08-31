#!/usr/bin/env bash
# Baseline sync: make the test DB a fully-masked mirror of production.
# (Node resolves `pg` relative to the script's location under pi/, so this works
# from any working directory.)
set -euo pipefail
cd "$(dirname "$0")/.."
node --experimental-strip-types pi/tools/sync-baseline.mjs "$@"
