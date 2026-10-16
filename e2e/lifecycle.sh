#!/usr/bin/env bash
# Bidshield full lifecycle: fresh chain + wallets + spike proof -> api + web -> product run.
# Usage:  bash e2e/lifecycle.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== [1/3] chain + wallets + spike proof (fresh volumes) ==="
node e2e/spike.mjs

echo
echo "=== [2/3] build + start api (serves web UI on :8080) ==="
docker compose up -d --build api

echo
echo "=== [3/3] product lifecycle: create -> 3 sealed bids -> close -> Vickrey settle -> verify ==="
node e2e/lifecycle.mjs

echo
echo "Stack is up. Open http://127.0.0.1:8080"
echo "Tear down with:  docker compose down -v"
