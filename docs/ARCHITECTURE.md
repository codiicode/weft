# Weft architecture

Weft turns a market thesis into a strategy graph and runs it, non-custodially,
across five products: **perps, stocks, predictions, Solana tokens and options**.

```
                ┌──────────────────────────── apps/web ────────────────────────────┐
                │ Landing page (static)      App: builder · markets · runs · library │
                └───────────────▲───────────────────────────────▲──────────────────┘
                                │ HTTP + SSE                    │ renders @weft/strategy graphs
┌─────────────────────────────── apps/api (Hono) ───────────────────────────────────┐
│ /ai/generate   thesis → strategy (Claude + search_markets/submit_strategy tools,  │
│                deterministic template fallback)                                    │
│ /markets       catalog per product      /strategies  library: save, fork, validate │
│ /deployments   paper runs, controls     /events/stream  live engine events (SSE)   │
└──────────┬───────────────────────────────┬───────────────────────────┬────────────┘
           │                               │                           │
  ┌────────▼────────┐            ┌─────────▼─────────┐        ┌────────▼────────┐
  │ @weft/strategy  │            │   @weft/engine    │        │  @weft/venues   │
  │ schema, validate│◀───────────│ tick loop, paper  │───────▶│ market data,    │
  │ evaluate (pure) │            │ broker, exits,    │        │ catalogs, signal│
  │ risk checks     │            │ persistence (SQL) │        │ providers       │
  │ graph projection│            │ Executor interface│        └────────┬────────┘
  └─────────────────┘            └─────────┬─────────┘                 │ public APIs
                                           │ live intents (later)      │ Hyperliquid · Jupiter
                                  ┌────────▼─────────┐                 │ DexScreener · NOAA
                                  │ @weft/execution  │                 │ Deribit · …
                                  │ Hyperliquid agent│
                                  │ wallet signing,  │
                                  │ Jupiter swaps +  │
                                  │ tx inspection    │
                                  └──────────────────┘
```

## The pipeline, one tick

1. **Signals.** For every signal in the strategy, the engine asks the provider registered for its
   kind (`@weft/venues`) for a snapshot. Missing or stale data is *unknown*.
2. **Evaluate.** `evaluate()` (pure, deterministic) computes trigger states and emits order
   **intents** with idempotency keys. Same code for live, paper, backtest and audit.
3. **Risk.** `checkIntents()` applies the stricter of strategy and user caps: position size,
   exposure, leverage, daily loss, kill switch, and Solana token gates (liquidity, holders,
   mint/freeze authority, dev selling, price impact). Fail-closed. Exits are never blocked.
4. **Execute.** Approved intents go to an `Executor`: paper today; Hyperliquid / Jupiter
   executors in `@weft/execution` for live.
5. **Monitor.** Every tick marks positions and enforces TP / SL / trailing / time exits.

## Products → venues

| Product | Venue | Custody model |
|---|---|---|
| Perps | Hyperliquid | Agent (API) wallet: trades, cannot withdraw |
| Stocks | Hyperliquid HIP-3 perps · tokenized stocks (xStocks) on Solana | Agent wallet · policy wallet |
| Predictions | Hyperliquid HIP-4 · Jupiter prediction markets | Agent wallet · policy wallet |
| Solana tokens | Jupiter (routes pump.fun, Meteora, Raydium LaunchLab…) | Policy wallet: only allow-listed swap programs, proceeds back to the user |
| Options | Deribit / Derive (defined-risk only) | Venue API keys (trade-only) |

## Revenue → token

Every live fill pays a builder fee (Hyperliquid builder codes) or platform fee (Jupiter).
The engine tracks `builderFeesUsd` per deployment; those fees fund on-chain buybacks of the
token, which launches on Solana via a Meteora Dynamic Bonding Curve (configurable).

## Running locally

```bash
npm install
npm run dev -w @weft/api     # API on :8787 (ANTHROPIC_API_KEY enables AI generation)
npm run dev -w @weft/web     # web on :3000 (landing + /app)
npm test                     # all packages
```
