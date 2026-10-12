# Status: where Weft stands

_Last updated by the build session. All numbers below were verified by running the code._

## What exists

| Part | What it does | Tests |
|---|---|---|
| `packages/strategy` | The strategy graph: schema (5 products, 13 signal kinds), validation, pure evaluator, risk checks, graph projection, JSON Schema | 38 |
| `packages/venues` | Live market data, catalogs and signal providers: Hyperliquid (perps, HIP-3, spot, HIP-4), Jupiter (tokens, xStocks, prediction markets), Deribit/Derive options, NOAA, FRED, Frankfurter; OI history sampler for z-scores | 83 |
| `packages/engine` | Runtime: tick loop, paper executor (fees, slippage), TP/SL/trailing/time exits, perp funding + liquidation, risk, SQLite persistence, replay, events | 47 |
| `packages/execution` | Live execution: Hyperliquid agent-wallet signing (matches official Python + Rust SDK vectors; testnet confirmed the server recovers our agent address), Jupiter swap builder + transaction inspector, signer interface, Turnkey policy draft | 85 (+2 opt-in live) |
| `apps/api` | HTTP API: markets, library (save/fork), thesis → strategy (Claude with tools, template fallback), paper + live deployments, Privy sign-in and ownership, live trading on Hyperliquid, leaderboard, SSE, alerts to Telegram/webhooks | 42 |
| `apps/web` | Landing page + product app (`/app`): sign-in (Privy), builder, markets, runs with kill switch, live setup (`/app/live`), library, leaderboard | typecheck + build |

**Backtesting:** `POST /backtest` (and the Backtest panel in the app) replays up to 90 days of real
history through the same engine. Perps, HIP-3 stocks and Solana tokens (GeckoTerminal) have price
history; funding is historical for perps. Social/news/model/on-chain signals have no history, so the
panel explains when a trigger couldn't fire. Predictions and options aren't backtestable yet.

**Live trading (Hyperliquid, testnet by default):** each signed-in user gets one agent wallet, held by
Privy (we never see the key). A Privy policy only lets it sign Hyperliquid L1 actions; a withdraw-style
signature is refused ("policy violation", verified). The user links their Hyperliquid account on
`/app/live`, signs `approveAgent` (+ `approveBuilderFee` if a builder is set) in their own wallet, and can
then pick **Live** in the run panel and type `GO LIVE`. Guards: $100 per live run, 3× max leverage, HL
perps + spot only, one live strategy per coin (positions net per account), owner-only controls.
Revoke any time on Hyperliquid (More → API). Switch with `WEFT_LIVE_ENABLED`, `WEFT_HL_NETWORK`.

**Verified end to end on paper against live data:** BTC perp (2×), HIP-3 NVDA short, JUP token swap
(2 SOL, rug gates passed), ETH call spread on Deribit, HIP-4 outcome (Champions League). Entries, fees,
builder fees, take-profit and time exits all fired correctly.

## Run it

```bash
npm install
npm run dev -w @weft/api        # http://localhost:8787 (data in apps/api/.data)
npm run dev -w @weft/web        # http://localhost:3000 → /app
npm run seed -w @weft/api       # optional: 8 demo paper runs across all products
npm test                        # 268 tests
```

Set `ANTHROPIC_API_KEY` before starting the API to get full AI generation (Claude Opus 5.5 with market
search and self-correcting validation). Without it, a deterministic template engine is used.

## Live vs simulated data

| Signal | Source | Status |
|---|---|---|
| price, funding, liquidity, odds, token_onchain | Hyperliquid, Jupiter, Deribit | **live** |
| forecast | NOAA weekly Niño indices | **live** (Niño 3.4 = +3.3°C right now) |
| macro | Frankfurter FX, FRED (US2Y, US10Y, VIX, …) | **live** |
| calendar | custom times exact; FOMC 2026 official; CPI/earnings/2027 dates estimated | partly static: **verify** |
| social, news, post_match, model | deterministic simulation | **simulated**: needs paid feeds |

## Decisions and accounts needed from you

1. ~~Anthropic API key~~ and ~~Privy app~~: done.
2. **Social data** (X API or a provider like LunarCrush/Kaito): the memecoin "sentiment" signal is simulated today.
3. **Solana indexer** (Helius / Birdeye / GMGN): `dev_sold_pct`, `lp_locked` and smart-wallet buys need one.
   Until then unknown dev selling defaults to 0 (permissive). Set `devSoldPctWhenUnknown: 100` in
   `createVenues()` to fail closed instead.
4. **Private Solana RPC + Jupiter API key**: the public endpoints throttle hard.
5. **Turnkey account** for the Solana policy wallet; then verify `packages/execution/docs/turnkey-policy.md`.
6. **Hyperliquid builder address** (`WEFT_BUILDER_ADDRESS`, needs ≥100 USDC in perps on that network) and fee
   rate (default 5 bps), and the token-side platform fee (default 50 bps).
7. **Legal review** before any live trading or the token launch (automated trading for others + fee buybacks).
8. **Name**: still "Weft" in `apps/web/src/config/brand.ts`.
9. **Telegram bot** for alerts: create one with @BotFather, then set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
   (or `WEFT_ALERT_WEBHOOK_URL` for Discord/Slack). Alerts-only strategies then message you instead of trading.

## Not built yet (next steps, in order)

1. **Live, next**: first real testnet run by a person end to end; reconcile fills from the venue
   (`userFills`) instead of trusting order responses; mainnet only after that and legal review.
   Solana live via Privy session signers with a policy.
2. Live orders for HIP-4 outcomes (implemented, off by default), Jupiter prediction markets, options venues.
3. Paper engine: resting limit orders; cross-margin liquidation model (today: isolated estimate).
4. Persisted dedupe for Solana swaps, Jupiter Swap V2 migration. (`oi_zscore_30d` fills in ~24h after the API starts observing a market.)
5. Hosting: the web app is a static export (Vercel), the API needs a long-running process (Fly, Railway, a VM).
