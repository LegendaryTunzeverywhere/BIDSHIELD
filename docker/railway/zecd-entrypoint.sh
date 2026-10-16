#!/bin/sh
# Self-initializing zecd entrypoint for Railway (volumes are per-service there,
# so a separate bootstrap job cannot reach into the datadir). Mirrors the init
# choreography of e2e/spike.mjs: mine-first (the bootstrap job does that), then
# funder restores the canonical all-zero BIP-39 test-vector mnemonic and
# auctioneer generates a fresh wallet. Skips init when the wallet already
# exists (volume survived a redeploy).
set -eu

ZECD_ROLE="${ZECD_ROLE:?set ZECD_ROLE to funder or auctioneer}"
ZECD_BIRTHDAY="${ZECD_BIRTHDAY:-2}"
DATADIR=/var/lib/zecd
WALLET_DIR="$DATADIR/default"
ZEBRA_RPC="${ZEBRA_RPC:-http://zebra:18234/}"

if [ "$ZECD_ROLE" = "funder" ]; then
  CONF=/etc/zecd/zecd.funder.toml
else
  CONF=/etc/zecd/zecd.auctioneer.toml
fi

# zecd init validates the birthday against the chain (z_gettreestate), so the
# regtest chain must already contain that height. On Railway the bootstrap job
# mines the bring-up blocks; wait for it instead of racing it.
wait_for_chain() {
  i=0
  while [ "$i" -lt 900 ]; do
    resp=$(wget -qO- \
      --post-data='{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' \
      --header='Content-Type: application/json' \
      "$ZEBRA_RPC" 2>/dev/null || true)
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
  if [ "$ZECD_ROLE" = "funder" ]; then
    printf '%s\n' "${ZECD_MNEMONIC:?funder service needs ZECD_MNEMONIC}" |
      zecd --datadir "$DATADIR" --conf="$CONF" init --restore --birthday "$ZECD_BIRTHDAY"
  else
    zecd --datadir "$DATADIR" --conf="$CONF" init --wallet default --birthday "$ZECD_BIRTHDAY"
  fi
}

if [ ! -d "$WALLET_DIR" ]; then
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
