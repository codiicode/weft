# @weft/engine

The runtime for deployed strategies: a tick loop, a paper broker with realistic
fills and exits, risk checks, persistence and an event stream. Everything
executes on **paper** today; live execution plugs in later through the same
`Executor` interface.

```ts
import { createEngine, SqliteStore } from "@weft/engine";

const engine = createEngine({
  store: new SqliteStore("./weft.db"),
  marketData,                 // @weft/venues MarketData
  signalProviders,            // @weft/venues SignalProvider[] (first provider per kind wins)
  tokenFacts,                 // optional TokenFactsProvider, required for token buys to pass risk
});
const d = await engine.createDeployment({ strategy, allocationUsd: 10_000, caps: { maxDailyLossPct: 5 } });
engine.start();                                  // ticks every deployment every intervalSec (default 30 s)
engine.subscribe((e) => sse.send(e));            // live events
await engine.getSnapshot(d.id);                  // equity, positions, triggers, signal values, curve
await engine.kill(d.id);                         // close everything at market, status "killed"
await engine.shutdown();                         // stop scheduling, wait for in-flight ticks
```

The engine itself does no network I/O and holds no keys: prices, signals and
token facts come only from the injected providers.

## The tick pipeline (`src/tick.ts`)

One tick of one deployment, in order:

1. **Mark & exit.** Quote every open instrument (`getQuotes` if available, else parallel `getQuote`), update
   mark, unrealized P&L and `peakPrice`, then run exits *before* anything else:
   stop-loss → trailing stop → take-profit → time exit. A position without a fresh quote this tick is not
   exited on stale data.
1b. **Perps (paper).** Accrue funding on open perps for the time since the last accrual at the current hourly
   rate (`MarketData.getFundingRate`, optional): `qty × mark × rate × hours`, longs pay when the rate is positive.
   It is booked to cash and realized P&L at once (`Position.fundingPaidUsd`, snapshot `fundingUsd`, closing
   `Fill.fundingUsd`), with a `notify` event (`data.funding`) at most once per clock hour per position. Then, before
   any other exit, a position whose mark crossed its `liquidationPrice` is closed **at that price** with reason
   `liquidation` (taker fee, no builder fee) plus a `warning` event (`data.liquidation`).
2. **Signals.** Fetch every signal from the provider registered for its kind, in parallel with a timeout.
   Failures and timeouts become `warning` events (rate-limited) and the signal is unknown. The last good
   snapshot is carried forward, so a blip does not flip a trigger, while the evaluator's per-kind
   staleness budget still turns old data into unknown. `position` signals are produced by the engine
   (`open`, `size_usd`, `pnl_pct`, `pnl_usd`, `hours_open`; optionally filtered by instrument).
3. **Evaluate.** `evaluate()` from `@weft/strategy` (pure, deterministic). `trigger_met` / `trigger_fired`
   events on transitions, an `intent` event per intent.
4. **Risk.** `checkIntents()` with `effectiveRisk(strategy.risk, deployment.caps)`, current equity, exposure
   (Σ margin × leverage), daily P&L % ((realized today + unrealized) / equity at start of the UTC day),
   `usdPrices` (SOL, USDC and native-sized instruments, from MarketData) and `tokenFacts` per mint for
   token buys (fetched with the order's USD size). Rejections become `rejected` events.
5. **Execute** approved intents through the `Executor`, closes first. Every intent key is recorded and never
   executed twice. `close` closes the target (`"all"` or an instrumentKey) by `fraction`; `notify` becomes a
   `notify` event; `options` opens each leg as a position sharing a `group`.
6. **Persist** everything in one atomic `Store.commit`, sample the equity curve, emit a (rate-limited)
   `tick` event, then publish the tick's events to subscribers.

The same `Session` + `runTick` code runs live and in `replay()`.

## Position math

- `pnl = qty × (mark − entry) × dir` (dir +1 long, −1 short). Perps: `qty = margin × leverage / entry`, so
  P&L on margin is multiplied by leverage. `Position.sizeUsd` is margin / cost basis.
- `equity = cash + Σ margin + Σ unrealized` and `= allocation + realizedPnlUsd + unrealizedPnlUsd`.
  `realizedPnlUsd` is net of every fee paid, including entry fees of still-open positions.
  `Fill.realizedPnlUsd` on a closing fill is gross P&L minus that fill's fee.
- Exit levels: `pct` = price move from entry (in favour for TP, against for SL), **not** leveraged ROE.
  `price` / `prob` are absolute (long TP when mark ≥ level, SL when mark ≤ level; mirrored for shorts).
  Trailing: long exits at `peak × (1 − t%)`, short at `trough × (1 + t%)`.
- Options groups exit together on premium: `pct` = group P&L / net premium paid, `price` = net value of one
  spread unit (Σ dir × premium × ratio), trailing on that unit value, time exit from open.
  Sizing: debit spreads buy `budget / net debit` units; credit structures size on gross premium.

## Paper fill model (`PaperExecutor`)

Fill price, first available of: size-aware `quote.fillPrice` → mid ± `quote.priceImpactBps` → ask/bid →
mid ± a per-kind slippage model (perp 2 bps, spot 5, token 30, outcome 50, option 50; configurable via
`slippageBps`). Outcome prices are clamped to [0.001, 0.999].
Opens are rejected when slippage from mid exceeds `order.maxSlippageBps` (defaults to the risk policy) or
quoted impact exceeds `order.maxPriceImpactBps`. Limit orders fill only at or through `limitPrice`; otherwise
they are skipped with a `rejected` event (`data.pending = true`), no resting orders yet. Closes are never
blocked by slippage limits; the kill switch falls back to the last mark if the feed is down.

## Fees (`src/fees.ts`, override with `createEngine({ fees })`)

| Product | Default |
| --- | --- |
| Hyperliquid perps & spot | taker 4.5 bps + builder 5 bps on notional, each side |
| HIP-4 / Jupiter outcomes | 0 bps to open (close configurable, default 0) + builder 5 bps |
| Solana tokens | platform 50 bps + $0.002 network fee per swap |
| Options | 3 bps of contracts × strike (or `perContractUsd`), capped at 12.5% of premium |

`builderFeesUsd` on the snapshot is Weft's take (Hyperliquid builder fee + Solana platform fee); it later
funds token buybacks. `feesUsd` is everything paid.

## Persistence (`Store`)

`Store` is a small async interface: `commit(batch)` applies one tick's changes atomically (deployment record,
runtime state incl. `EvalState`, position upserts/deletes, fills, events, executed intent keys, an equity
sample), plus readers. Two implementations:

- `MemoryStore`: tests, replays, ephemeral dev.
- `SqliteStore(path)`: Node's built-in `node:sqlite`, one file, WAL; tables `deployments`, `eval_state`,
  `positions` (open only), `fills`, `events`, `intent_keys`, `equity_samples`, JSON columns. Events and
  equity samples are bounded per deployment (`maxEvents` 10 000, `maxEquitySamples` 2 000).

A failed tick commits nothing but an `error` event, so a crash mid-tick re-runs cleanly from the last
committed state. Executed intent keys are committed with the fills they produced.

## Scheduler

`start()` scans every `schedulerResolutionMs` (1 s) and ticks each running deployment whose `intervalSec`
has elapsed. Ticks of the same deployment never overlap (per-deployment lock; a stuck tick is skipped, not
queued), errors are isolated per deployment, and `shutdown()` waits for in-flight work. `pause` / `resume` /
`stop` change status; `kill` closes all positions at market (reason `"kill"`) and sets `"killed"`.

## Replay / backtest

```ts
const { snapshot, fills, events } = await replay(strategy, [
  { now, signals: { sol_funding: { asOf: now, fields: { rate_8h_pct: 0.15, oi_zscore_30d: 2.5 } } }, quotes: { "hl:perp:SOL": 150 } },
  // …
], { allocationUsd: 10_000 });
```

Same engine, `MemoryStore`, a fake clock, MarketData backed by the recorded quotes (keyed by instrumentKey,
carried forward) and a provider that serves the recorded snapshots.

## Live execution later

The engine core decides *what* to trade and keeps the books; an `Executor` decides *how* it fills:

```ts
interface Executor {
  readonly mode: "paper" | "live";
  execute(req: OrderRequest, now: number): Promise<ExecutionResult>; // filled | rejected | pending
}
```

`PaperExecutor` is the only implementation now. `HyperliquidExecutor` (perps, spot, HIP-4, builder code)
and `JupiterExecutor` (Solana swaps, platform fee) will implement the same interface and be passed as
`createEngine({ executor })`, without touching the tick pipeline. They must use `OrderRequest.clientId` as
the venue client order id (Hyperliquid `cloid`) so a retried request can never fill twice, and live mode
should persist the intent key before sending (paper commits it with the fill).

## Perp funding & liquidation (`src/perps.ts`)

On by default for paper executors (`createEngine({ perpRealism })`, off for live executors: the venue does both).

- **Funding**: Hyperliquid pays hourly; the engine accrues continuously at the current rate. If the rate feed fails
  the accrual waits and the next good rate covers the gap. Without `getFundingRate` nothing accrues. Positions
  persisted before this existed start accruing on their next tick (no back-charge). Replays take
  `ReplayFrame.funding` (rate per instrumentKey, carried forward).
- **Liquidation**: isolated-margin estimate, `long: entry × (1 − 1/L) / (1 − mm)`, `short: entry × (1 + 1/L) / (1 + mm)`,
  with maintenance `mm = 1 / (2 × max leverage)` (`MarketData.getMaxLeverage`, optional; 3 % if unknown). 1× longs
  have none. Checked on the tick's mark (allMids), before stop-losses.

## Known gaps

- Liquidation is estimated per position (isolated): cross-margin sharing, funding eroding margin and Hyperliquid's
  backstop liquidation are not modelled. Funding uses the mark rather than the oracle price, and the kill switch does
  not accrue the few seconds since the last tick.
- Limit orders do not rest; unfilled limits are skipped.
- `native` sizes on non-token instruments are valued as `native × price` and treated as margin, matching
  `checkIntents`.
- Options short legs book premium as margin (P&L is exact, cash usage is conservative).
