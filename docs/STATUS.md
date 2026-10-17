# Status: where Weft stands

_Last updated by the build session. All numbers below were verified by running the code._

## Launch checklist (2026-10-17)

| Step | State |
|---|---|
| All work committed | Done (4ea44ed). No git remote yet: nothing is pushed anywhere. |
| Typecheck + tests | Green: 6 workspaces typecheck, 398 tests pass (2 testnet-only skipped) |
| Simulated data never trades | Server refuses live trades on simulated signals (only `model`); the drafter no longer reaches for `model` |
| Off-site backup | Built (hourly on the volume, R2 copy when `R2_*` is set). R2 keys not set yet. |
| End-to-end with real money | Done earlier on mainnet (Solana buy/sell/fees/close, Hyperliquid deposit/trade/withdraw). Copy trading has not run with real money yet. |
| X account | Not created; `brand.socials.x` and the legal pages' contact point to it |
| Rotate relayer key | Recommended: the key was shown in a session transcript on 2026-10-17 |

## What exists

| Part | What it does | Tests |
|---|---|---|
| `packages/strategy` | The strategy graph: schema (5 products, 13 signal kinds), validation, pure evaluator, risk checks, graph projection, JSON Schema | 38 |
| `packages/venues` | Live market data, catalogs and signal providers: Hyperliquid (perps, HIP-3, spot, HIP-4), Jupiter (tokens, xStocks, prediction markets), Deribit/Derive options, NOAA, FRED, Frankfurter; OI history sampler for z-scores | 83 |
| `packages/engine` | Runtime: tick loop, paper executor (fees, slippage), TP/SL/trailing/time exits, perp funding + liquidation, risk, SQLite persistence, replay, events | 47 |
| `packages/execution` | Live execution: Hyperliquid agent-wallet signing (matches official Python + Rust SDK vectors; testnet confirmed the server recovers our agent address), Jupiter swap builder + transaction inspector, signer interface, Turnkey policy draft | 85 (+2 opt-in live) |
| `apps/api` | HTTP API: markets, library (save/fork), thesis → strategy and plain-language edits (Claude with tools, offline fallback), paper + live deployments, Privy sign-in and ownership, live trading on Hyperliquid with venue reconciliation, leaderboard, SSE, per-user Telegram alerts | 48 |
| `apps/web` | Landing page + product app (`/app`): sign-in (Privy), builder with plain-English rules and "change something", runs, strategies, markets, leaderboard, live setup, settings, ⌘K, notices | typecheck + build |

**Design (Oct 13):** the landing page and app were redesigned to look and read like a hand-made
product: 8 landing sections instead of 15, Inter for UI with Newsreader for display headings, mono only
for addresses, neutral palette where colour means something (blue watches, amber conditions, green and
red trades), no glows, neon, marquee or invented metrics. Strategies are shown as sentences
("When BTC 24h change > 3% → Go long BTC with 8% of the account; stop at −5%") everywhere, with the
diagram and JSON one click away. Engine events are written in plain language. Lighthouse (landing):
accessibility 100, best practices 100, SEO 100, performance 97 desktop / 79 mobile (simulated slow 4G).

**Backtesting:** `POST /backtest` (and the Backtest panel in the app) replays up to 90 days of real
history through the same engine. Perps, HIP-3 stocks and Solana tokens (GeckoTerminal) have price
history; funding is historical for perps. Social/news/model/on-chain signals have no history, so the
panel explains when a trigger couldn't fire. Predictions and options aren't backtestable yet.

**Live trading (Hyperliquid, testnet by default):** each signed-in user gets one agent wallet, held by
Privy (we never see the key). A Privy policy only lets it sign Hyperliquid L1 actions; a withdraw-style
signature is refused ("policy violation", verified). The user links their Hyperliquid account on
`/app/live`, signs `approveAgent` (+ `approveBuilderFee` if a builder is set) in their own wallet, and can
then pick **Live** in the run panel and type `GO LIVE`. Every minute the API compares live runs with
the positions Hyperliquid reports and notes any mismatch on the run. Guards: $100 per live run (default; `WEFT_LIVE_MAX_ALLOCATION_USD`), 3× max leverage, HL
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
npm test                        # 310 tests
```

Set `ANTHROPIC_API_KEY` before starting the API to get full AI generation (Claude Opus 5.5 with market
search and self-correcting validation). Without it, a deterministic template engine is used.

## Real money only (decided 2026-10-14)

The hosted service has no paper trading. Strategies run live on Hyperliquid (perps, HIP-3 stocks, spot)
or as alerts only; backtests on real history are the preview. Solana tokens, prediction markets and
options show prices and charts and can run as alerts until their live trading is built. Paper runs from
before were stopped at startup (history kept). The leaderboard lists only live runs whose owners chose to
share them, in percent. Local development (sign-in off, or `WEFT_ALLOW_PAPER=1`) keeps paper runs.

## Fees and $WEFT (decided 2026-10-15)

Weft charges 0.10% on Hyperliquid (the builder-code maximum on perps; `WEFT_BUILDER_FEE_TENTHS_BPS`,
default 100) and 1% on Solana swaps (`WEFT_SOL_FEE_BPS`, default 100). Half of fees buy back $WEFT, half
is Weft's revenue. Holding $WEFT halves the fee: set `WEFT_TOKEN_MINT` and `WEFT_HOLDER_MIN` (tokens) at
launch (`WEFT_HOLDER_DISCOUNT`, default 0.5); holdings are read on-chain from the user's trading wallet
and Solana wallets linked to their Privy account. Not built yet: the buyback job and its public ledger.

## Hyperliquid live on mainnet (since 2026-10-16)

Verified with real money: a Weft wallet per user (Privy embedded, exportable), gas-free USDC deposits from
Arbitrum (permit signed in the background, `batchedDepositWithPermit` sent by Weft's relayer,
`WEFT_RELAYER_KEY`), agent approval in the background once funds arrive, a 20x ETH long, a venue-side
stop-loss kept in line with the strategy (`NativeStops`, positionTpsl orders), moving the stop, and the sale.
Users who already trade on Hyperliquid can link their own MetaMask/Rabby wallet instead. Leverage: each
market's own max. Stop-loss/take-profit percentages are on the position (`positionPct`), not the price.
Still missing: Weft's builder address (`WEFT_BUILDER_ADDRESS`), so no Hyperliquid fee is taken yet.

## Solana live (open to everyone since 2026-10-16)

Verified with real money on mainnet: buy, sell, the 1% fee into the fee wallet (WSOL/USDC accounts created with
`scripts/fee-accounts.mjs`), and closing emptied token accounts (rent back to the user; one-off cleanup with
`apps/api/scripts/close-empty-accounts.ts`). Swaps and token data use `JUPITER_API_KEY` (api.jup.ag).

Users get a Weft trading wallet on Solana: a Privy embedded wallet they own and can export. They add Weft
as a limited signer (a Privy key quorum + policy that only allows the swap programs); every Jupiter swap is
inspected before signing, sells are clamped to the wallet balance, and one token per wallet per run.
Solana runs have their own engine store (`engine-live-solana.db`), never tied to Hyperliquid's network.

To switch on: `PRIVY_AUTHORIZATION_KEY` (P-256 private key, base64 PKCS8; Weft creates the key quorum
and policy from it on first use), `WEFT_SOL_LIVE=1`, optionally `SOLANA_RPC_URL` (a private RPC is
recommended), `WEFT_SOL_FEE_WALLET` (+ `WEFT_SOL_FEE_BPS`, default 50) for the platform fee, and
`WEFT_SOL_MAX_ALLOCATION_USD`. Not yet: reconciling wallet balances against positions when a user moves
tokens out by hand.

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
4. ~~Private Solana RPC + Jupiter API key~~: done (Helius, Jupiter free key; upgrade the plan if `[jupiter] rate limited` shows in logs).
5. ~~Turnkey account~~: not needed, Solana signing goes through Privy with a swap-only policy.
6. **Hyperliquid builder address** (`WEFT_BUILDER_ADDRESS`, needs ≥100 USDC in perps on that network) and fee
   rate (default 5 bps), and the token-side platform fee (default 50 bps).
7. **Legal review** before any live trading or the token launch (automated trading for others + fee buybacks).
8. **Name**: still "Weft" in `apps/web/src/config/brand.ts`.
9. **Telegram bot** for alerts: create one with @BotFather and set `TELEGRAM_BOT_TOKEN` in `apps/api/.env`.
   Each user then connects their own chat in Settings. `TELEGRAM_CHAT_ID` (optional) receives everything.

## Not built yet (next steps, in order)

1. **Live, next**: first real testnet run by a person end to end (position reconciliation is in; fill-level
   reconciliation from `userFills` is next); mainnet only after that and legal review.
   Solana live via Privy session signers with a policy.
2. Live orders for HIP-4 outcomes (implemented, off by default), Jupiter prediction markets, options venues.
3. Paper engine: resting limit orders; cross-margin liquidation model (today: isolated estimate).
4. Persisted dedupe for Solana swaps, Jupiter Swap V2 migration. (`oi_zscore_30d` fills in ~24h after the API starts observing a market.)
5. Hosting: the web app is a static export (Vercel), the API needs a long-running process (Fly, Railway, a VM).
