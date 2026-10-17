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

In the Privy dashboard, add the site origin (production: `https://weft.fi`; keep `https://weft-tawny.vercel.app` too) to allowed origins.

## API (Fly.io)

```bash
fly auth login
fly launch --no-deploy --copy-config      # uses fly.toml in the repo root
fly volumes create weft_data --size 1
fly secrets set ANTHROPIC_API_KEY=... PRIVY_APP_ID=... PRIVY_APP_SECRET=... \
  TELEGRAM_BOT_TOKEN=... WEFT_LIVE_ENABLED=1 \
  WEB_ORIGINS=https://weft-tawny.vercel.app,https://weft.fi,https://www.weft.fi,https://app.weft.fi
fly deploy
```

`WEFT_HL_NETWORK` defaults to `testnet` in `fly.toml`. Switch to `mainnet` only after a real testnet run;
live runs are stored per network, so testnet runs never trade on mainnet.

## API (Railway) — live

Project `weft`, service `weft-api`, volume mounted at `/data`, public URL
`https://weft-api-production.up.railway.app`. Build settings live in `railway.json` (Dockerfile, health check `/health`).

```bash
railway up --detach --service weft-api      # deploy the current checkout (respects .gitignore)
railway logs --service weft-api
railway variable set KEY --stdin            # set a secret without it touching the command line
```

Variables: the secrets above, plus `NODE_ENV=production HOST=0.0.0.0 PORT=8787 WEFT_DATA_DIR=/data
WEFT_HL_NETWORK=testnet WEFT_LIVE_ENABLED=1 WEB_ORIGINS=https://weft-tawny.vercel.app`.
`scripts/deploy-web.sh` points the web build at this URL by default.

Only one process may poll a Telegram bot token: while Railway runs the bot, a local API with the same
`TELEGRAM_BOT_TOKEN` will fight it for updates. Use a second bot locally, or leave the token out of `apps/api/.env`.

## Backups

The API snapshots every database in `/data` once an hour (consistent copies via `VACUUM INTO`,
gzipped) into `/data/backups/hourly/<YYYY-MM-DDTHH>`, keeping 24 hours plus one per day for 14 days in
`/data/backups/daily`. The log prints `backup: N files, X MB` after each run. `WEFT_BACKUPS=0` turns it off.

Restore: stop the service, `gunzip` the files of one snapshot into `/data` (replace the `.db` files and
delete their `-wal`/`-shm`), start it again. These live on the same volume as the data, so also turn on
Railway's volume backups (service → Volume → Backups) for a copy outside it.

## Safety switches

- The API refuses to start publicly without `PRIVY_APP_ID` (sign-in). Local mode binds to 127.0.0.1.
- `WEFT_LIVE_ENABLED=0` turns live trading off instantly (every live order is re-checked).
- Caps: `WEFT_LIVE_MAX_ALLOCATION_USD` (per run), `WEFT_LIVE_MAX_TOTAL_USD` (per user), `WEFT_LIVE_MAX_LEVERAGE`.
