# Deploying Weft

Two pieces: the **web app** (static, Vercel) and the **API** (a long-running Node process with a small
SQLite volume: Fly.io or Railway). The API runs the strategy engine on a schedule, so it must stay on.

## Web (Vercel)

```bash
scripts/deploy-web.sh            # production
scripts/deploy-web.sh --preview  # preview URL
```

Before building for production, set in `apps/web/.env.local`:

- `NEXT_PUBLIC_API_URL=https://<your-api-host>` (otherwise the app calls localhost)
- `NEXT_PUBLIC_PRIVY_APP_ID=<privy app id>`

In the Privy dashboard, add the site origin (e.g. `https://weft-tawny.vercel.app`) to allowed origins.

## API (Fly.io)

```bash
fly auth login
fly launch --no-deploy --copy-config      # uses fly.toml in the repo root
fly volumes create weft_data --size 1
fly secrets set ANTHROPIC_API_KEY=... PRIVY_APP_ID=... PRIVY_APP_SECRET=... \
  TELEGRAM_BOT_TOKEN=... WEFT_LIVE_ENABLED=1 \
  WEB_ORIGINS=https://weft-tawny.vercel.app
fly deploy
```

`WEFT_HL_NETWORK` defaults to `testnet` in `fly.toml`. Switch to `mainnet` only after a real testnet run;
live runs are stored per network, so testnet runs never trade on mainnet.

## API (Railway)

New project from this repo, Dockerfile builder, add a volume mounted at `/data`, and set the same
variables as above plus `WEFT_DATA_DIR=/data`. Health check path: `/health`.

## Safety switches

- The API refuses to start publicly without `PRIVY_APP_ID` (sign-in). Local mode binds to 127.0.0.1.
- `WEFT_LIVE_ENABLED=0` turns live trading off instantly (every live order is re-checked).
- Caps: `WEFT_LIVE_MAX_ALLOCATION_USD` (per run), `WEFT_LIVE_MAX_TOTAL_USD` (per user), `WEFT_LIVE_MAX_LEVERAGE`.
