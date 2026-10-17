#!/bin/bash
# Launch $WEFT on mainnet and switch Weft onto it, in one go.
#   bash scripts/launch-weft.sh --dry    the whole run without sending or changing anything
#   bash scripts/launch-weft.sh          LAUNCHES FOR REAL
# 1. apps/api/scripts/launch.ts --send: config, pool + token + 1 SOL dev buy, burn of the dev buy
# 2. scripts/post-launch.sh --go: server variables, treasury key, the address on weft.fi
# Refuses to run twice: a second run would launch a second token.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
export PATH="$HOME/.local/node-v24.21.0-darwin-arm64/bin:$PATH"
DRY=""; [ "${1:-}" = "--dry" ] && DRY=1
REC=secrets/launch-mainnet.json
LOG=secrets/launch-mainnet.log

if [ -f "$REC" ]; then
  echo "\$WEFT has already been launched ($REC exists). Not launching again."
  exit 1
fi

echo "== 1/2 launch =="
cd "$ROOT/apps/api"
set -a; source .env >/dev/null 2>&1; set +a
if [ -n "$DRY" ]; then
  npx tsx scripts/launch.ts --network mainnet 2>&1 | grep -v "bigint: Failed"
  echo; echo "== 2/2 switch Weft onto the token (dry run) =="
  bash "$ROOT/scripts/post-launch.sh" >/dev/null 2>&1 || echo "post-launch.sh --go runs here once the launch record exists"
  echo; echo "Dry run finished. Nothing was sent."
  exit 0
fi
npx tsx scripts/launch.ts --network mainnet --send 2>&1 | grep -v "bigint: Failed" | tee "$ROOT/$LOG" || true
cd "$ROOT"
[ -f "$REC" ] && node -e 'const r=require("./'"$REC"'"); if(!r.burnTx) process.exit(1)' || { echo; echo "The launch did not finish all three steps. Stopping here; nothing on the server was changed."; exit 1; }

echo; echo "== 2/2 switch Weft onto the token =="
bash scripts/post-launch.sh --go 2>&1 | tee -a "$LOG"

MINT=$(node -e 'console.log(require("./'"$REC"'").mint)')
printf %s "$MINT" | pbcopy
echo
echo "\$WEFT is live."
echo "Contract address: $MINT  (copied to the clipboard)"
echo "https://solscan.io/token/$MINT"
