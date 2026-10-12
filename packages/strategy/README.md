# @weft/strategy

The strategy graph: one versioned, typed document that the AI writes, the UI
renders, the runtime executes, and users fork. Everything else builds on this.

```
signals ──refs──▶ triggers ──on──▶ actions
(what we watch)   (when)           (what we do)
```

## Concepts

| Piece | File | What it is |
| --- | --- | --- |
| **Instrument** | `instruments.ts` | Anything tradable: `perp` (Hyperliquid, incl. HIP-3 stocks/commodities), `spot` (Hyperliquid), `token` (any Solana SPL token by **mint**: memecoins, xStocks), `outcome` (HIP-4 / Jupiter prediction markets), `option`. Stocks are an `assetClass`, not a kind. |
| **Signal** | `signals.ts` | Data the strategy watches: `price`, `funding`, `liquidity`, `odds`, `token_onchain`, `social`, `post_match`, `news`, `forecast`, `model`, `calendar`, `macro`, `position`. Each kind declares typed output fields. Signals say *what* to observe, never which provider; that's a runtime concern. |
| **Trigger** | `strategy.ts` + `expr.ts` | A condition over signal fields (`"nino.value"`), in a closed expression language: comparisons, `and`/`or`/`not`, `between`, `crosses_above/below`, arithmetic. Plus `forMinutes` (must hold), `cooldownMinutes`, `maxFires`. |
| **Action** | `actions.ts` | `open` (size, leverage, TP/SL/trailing/time exits), `options` (multi-leg, must be defined-risk), `close` (one instrument or all), `notify` (alerts-only). `on` lists the triggers it listens to. |
| **RiskPolicy** | `strategy.ts` | Caps on position, exposure, leverage, daily loss; mandatory stops; Solana token gates (liquidity, top-10 holders, mint/freeze authority, dev selling, price impact). |
| **Deployment** | `strategy.ts` | A user running a strategy: paper/live, allocation, personal caps. `effectiveRisk()` = the stricter of strategy and user. |

Graph edges are **derived**, never stored (`toGraph()`), so the graph can't drift from the logic.

## Pipeline

```ts
import { validateStrategy, evaluate, checkIntents, initialState } from "@weft/strategy";

const v = validateStrategy(llmOutput);            // zod parse + semantic checks
if (!v.ok) return v.errors;                         // e.g. "pump.sentiment: price signals have no field…"

let state = initialState(v.strategy);
// every tick, the runtime fetches signal values and calls:
const { intents, triggers, state: next } = evaluate(v.strategy, { now, signals, equityUsd, positions }, state);
const { approved, rejected } = checkIntents(intents, { risk, equityUsd, exposureUsd, dailyPnlPct, usdPrices, tokenFacts });
// approved → venue adapters (Hyperliquid, Jupiter…), deduped by intent.key
state = next;
```

Design rules:
- **Pure and deterministic.** `evaluate` and `checkIntents` do no I/O and never read the clock, so live trading, paper trading, backtests and audits run the same code.
- **Unknown is never true.** Missing or stale data (per-kind `maxAgeSeconds`) evaluates to unknown, and unknown never fires.
- **Edge-triggered.** A trigger fires when it *becomes* met, then re-arms once its condition goes false. Cooldowns delay a fire, they don't drop it.
- **Fail closed.** Risk checks reject when data is missing (no price for a native size, no on-chain facts for a token). Exits and alerts are never blocked.
- **Idempotent.** Every intent has a deterministic `key`; the executor must never run the same key twice.
- **Mints, not tickers.** A Solana token is its mint address; `$PUMP` alone is rejected.

## Files

- `src/examples/`: six strategies covering perps, HIP-3, tokens, xStocks, HIP-4 and options. Test fixtures and few-shot examples for the thesis → graph model.
- `strategy.schema.json`: JSON Schema for structured LLM output (`npm run schema -w @weft/strategy` regenerates it).
- `test/`: validation, evaluator semantics (staleness, three-valued logic, `forMinutes`, edges, cooldowns, crossings, reentry), risk checks.

```bash
npm test -w @weft/strategy
npm run typecheck -w @weft/strategy
```
