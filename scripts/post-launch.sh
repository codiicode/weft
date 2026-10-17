#!/bin/bash
# After `node apps/api/scripts/launch.ts --network mainnet --send`: switch Weft onto the token.
#   bash scripts/post-launch.sh          shows what it will set (nothing changes)
#   bash scripts/post-launch.sh --go     sets the server variables, puts the address on weft.fi, deploys
# Reads the mint and pool from secrets/launch-mainnet.json; the treasury key goes straight from
# secrets/weft-treasury.json to Railway and is never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node-v24.21.0-darwin-arm64/bin:$PATH"
REC=secrets/launch-mainnet.json
[ -f "$REC" ] || { echo "no $REC: launch first"; exit 1; }
MINT=$(node -e 'const r=require("./secrets/launch-mainnet.json"); if(!r.mint||!r.pool||!r.burnTx) throw new Error("launch record incomplete: "+JSON.stringify(r)); console.log(r.mint)')
POOL=$(node -e 'console.log(require("./secrets/launch-mainnet.json").pool)')
DAY=$(date -u +%Y-%m-%d)
echo "mint   $MINT"
echo "pool   $POOL"
echo "start  $DAY (rewards from this UTC day)"
echo "server WEFT_TOKEN_MINT, WEFT_DBC_POOL, WEFT_REWARDS_START, WEFT_TREASURY_KEY (from secrets/weft-treasury.json)"
echo "site   brand.contractAddress = $MINT, then deploy"
[ "${1:-}" = "--go" ] || { echo; echo "Nothing changed. Run with --go."; exit 0; }
railway variables --service weft-api --skip-deploys --set "WEFT_TOKEN_MINT=$MINT" --set "WEFT_DBC_POOL=$POOL" --set "WEFT_REWARDS_START=$DAY" >/dev/null
# the key goes through stdin: never on screen, never in the process list
node -e 'process.stdout.write(JSON.stringify(require("./secrets/weft-treasury.json")))' | railway variables --service weft-api --set-from-stdin WEFT_TREASURY_KEY >/dev/null
echo "server variables set (Railway redeploys the API)"
sed -i '' "s/contractAddress: \"PLACEHOLDER_CONTRACT_ADDRESS_SOLANA\"/contractAddress: \"$MINT\"/" apps/web/src/config/brand.ts
grep -q "$MINT" apps/web/src/config/brand.ts || { echo "brand.ts not updated"; exit 1; }
git add apps/web/src/config/brand.ts && git commit -qm "\$WEFT is live: $MINT" && git push -q origin main
bash scripts/deploy-web.sh >/dev/null 2>&1 && echo "weft.fi shows the address"
