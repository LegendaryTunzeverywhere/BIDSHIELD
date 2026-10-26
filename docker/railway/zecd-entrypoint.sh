#!/bin/sh
# Self-initializing zecd entrypoint for Railway (volumes are per-service there,
# so a separate bootstrap job cannot reach into the datadir). Mirrors the init
# choreography of e2e/spike.mjs: mine-first (the bootstrap job does that), then
# restore the service's seed from ZECD_MNEMONIC (funder: declared in
# .railway/railway.ts; auctioneer: a Railway service variable — the phrase
# lives in .env locally, never in the pushed repo). A fresh volume without the
# variable fails fast rather than minting a wallet nobody holds. Skips init
# when the wallet already exists (volume survived a redeploy).
set -eu

ZECD_ROLE="${ZECD_ROLE:?set ZECD_ROLE to funder or auctioneer}"
ZECD_BIRTHDAY="${ZECD_BIRTHDAY:-2}"
# Defaults keep the original one-zecd-per-service Railway image working; the
# all-in-one image sets both variables to its /data/<role> paths.
DATADIR="${ZECD_DATADIR:-/var/lib/zecd}"
WALLET_DIR="$DATADIR/default"
ZEBRA_RPC="${ZEBRA_RPC:-http://zebra:18234/}"

if [ -n "${ZECD_CONF:-}" ]; then
  CONF="$ZECD_CONF"
elif [ "$ZECD_ROLE" = "funder" ]; then
  CONF=/etc/zecd/zecd.funder.toml
else
  CONF=/etc/zecd/zecd.auctioneer.toml
fi

mkdir -p "$DATADIR"

# zecd init validates the birthday against the chain (z_gettreestate), so the
# regtest chain must already contain that height. On Railway the bootstrap job
# mines the bring-up blocks; wait for it instead of racing it.
wait_for_chain() {
  i=0
  while [ "$i" -lt 900 ]; do
    if command -v curl >/dev/null 2>&1; then
      resp=$(curl -fsS --max-time 5 \
        -H 'Content-Type: application/json' \
        --data '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' \
        "$ZEBRA_RPC" 2>/dev/null || true)
    else
      resp=$(wget -qO- \
        --post-data='{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' \
        --header='Content-Type: application/json' \
        "$ZEBRA_RPC" 2>/dev/null || true)
    fi
    height=$(printf '%s' "$resp" | sed -n 's/.*"result":[[:space:]]*\([0-9][0-9]*\).*/\1/p')
    if [ -n "$height" ] && [ "$height" -ge "$ZECD_BIRTHDAY" ]; then
      echo "zebra height $height >= birthday $ZECD_BIRTHDAY"
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done
  echo "zebra never reached height $ZECD_BIRTHDAY" >&2
  exit 1
}

init_wallet() {
  printf '%s\n' "$ZECD_MNEMONIC" |
    zecd --datadir "$DATADIR" --conf="$CONF" init --restore --birthday "$ZECD_BIRTHDAY"
}

if [ ! -d "$WALLET_DIR" ]; then
  # Never mint an un-held key: a fresh wallet must restore the service's
  # baked seed (set as ZECD_MNEMONIC on the Railway service — this repo does
  # not carry the auctioneer phrase). Existing volumes skip this branch.
  if [ -z "${ZECD_MNEMONIC:-}" ]; then
    echo "ZECD_MNEMONIC not set for role=$ZECD_ROLE; refusing to create a random wallet" >&2
    echo "set it: dashboard -> service -> Variables -> ZECD_MNEMONIC, or" >&2
    echo "  railway variable set ZECD_MNEMONIC=\"<BIP-39 phrase>\" --service $ZECD_ROLE" >&2
    exit 1
  fi
  wait_for_chain
  attempt=1
  while [ "$attempt" -le 3 ]; do
    echo "zecd-init role=$ZECD_ROLE attempt=$attempt"
    if init_wallet; then
      break
    fi
    echo "zecd-init failed; wiping $DATADIR and retrying"
    rm -rf "$DATADIR"/* "$DATADIR"/.[!.]* 2>/dev/null || true
    attempt=$((attempt + 1))
    sleep 2
  done
  if [ ! -d "$WALLET_DIR" ]; then
    echo "zecd-init failed after 3 attempts" >&2
    exit 1
  fi
  echo "zecd-init role=$ZECD_ROLE done"
else
  echo "zecd-init role=$ZECD_ROLE skipped (wallet present)"
fi

exec zecd --datadir "$DATADIR" --conf="$CONF"
