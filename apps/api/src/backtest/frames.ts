import { exprRefs, instrumentKey, type Instrument, type Signal, type SignalSnapshot, type Strategy } from "@weft/strategy";
import type { ReplayFrame } from "@weft/engine";
import type { Candle, FundingPoint } from "@weft/venues";

/**
 * Turns recorded history into `ReplayFrame`s for `replay()`.
 *
 * At each frame time `now` only bars that have CLOSED by `now` are used (no
 * look-ahead). Fields that can't be derived historically are left null, which
 * the evaluator treats as unknown: a condition on them never fires.
 *
 * Derived per kind:
 * - price:    price (last close), change_5m/1h/24h_pct, volume_24h_usd (sum of bar USD volume)
 * - funding:  rate_1h_pct, rate_8h_pct, apr_pct from the hourly rate; OI fields null
 * - calendar: from `calendarFields` (custom `at` exact; fomc/cpi/earnings from the static table)
 * - position: produced by the engine itself
 * - everything else: null
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface InstrumentHistory {
  instrument: Instrument;
  /** Bars at the frame interval (or coarser/finer: `barMs` says). Sorted by open time. */
  candles: Candle[];
  barMs: number;
  /** Optional 5m bars, only needed for change_5m_pct. */
  candles5m?: Candle[];
  /** Hourly funding (perps). */
  funding?: FundingPoint[];
}

export interface BuildFramesInput {
  strategy: Strategy;
  /** By instrumentKey. Instruments without history are simply absent. */
  history: ReadonlyMap<string, InstrumentHistory>;
  start: number;
  end: number;
  stepMs: number;
  /** Fixed quotes added to every frame (e.g. USDC = 1). */
  constantQuotes?: Record<string, number>;
  /** calendar fields (inject `calendarFields` from @weft/venues). */
  calendar?: (params: Extract<Signal, { kind: "calendar" }>["params"], now: number) => SignalSnapshot["fields"] | null;
  maxFrames?: number;
}

export interface BuiltFrames {
  frames: ReplayFrame[];
  /** Per signal id → field → number of frames with a non-null value. */
  fieldHits: Record<string, Record<string, number>>;
}

/* ------------------------------------------------------------------ */
/* Bar series with O(log n) lookups                                     */
/* ------------------------------------------------------------------ */

export class BarSeries {
  readonly bars: Candle[];
  readonly barMs: number;
  private readonly volPrefix: number[];
  private readonly volKnown: boolean;

  constructor(bars: readonly Candle[], barMs: number) {
    this.bars = [...bars].sort((a, b) => a.t - b.t);
    this.barMs = barMs;
    this.volPrefix = [0];
    let known = this.bars.length > 0;
    for (const b of this.bars) {
      if (b.volUsd == null) known = false;
      this.volPrefix.push(this.volPrefix.at(-1)! + (b.volUsd ?? 0));
    }
    this.volKnown = known;
  }

  /** Index of the last bar that closed at or before `t`, or -1. */
  lastClosed(t: number): number {
    let lo = 0;
    let hi = this.bars.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.bars[mid]!.t + this.barMs <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** Close of the last bar closed by `t`; null if none, or if that bar is older than `maxAgeMs`. */
  closeAt(t: number, maxAgeMs = Infinity): number | null {
    const i = this.lastClosed(t);
    if (i < 0) return null;
    const b = this.bars[i]!;
    return t - (b.t + this.barMs) <= maxAgeMs ? b.c : null;
  }

  /** First close time, or null. */
  firstClose(): number | null {
    const b = this.bars[0];
    return b ? b.t + this.barMs : null;
  }

  /** USD volume of bars closing in (t − windowMs, t]; null without full coverage or volume data. */
  volumeUsd(t: number, windowMs: number): number | null {
    if (!this.volKnown) return null;
    const first = this.bars[0];
    if (!first || first.t > t - windowMs) return null;
    const hi = this.lastClosed(t);
    const lo = this.lastClosed(t - windowMs);
    if (hi < 0) return null;
    return this.volPrefix[hi + 1]! - this.volPrefix[lo + 1]!;
  }
}

const pct = (to: number | null, from: number | null) => (to == null || from == null || from === 0 ? null : ((to - from) / from) * 100);

/** Latest funding point at or before `t` (within 3h), else null. Points must be sorted. */
export function fundingAt(points: readonly FundingPoint[], t: number): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.time <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const p = ans >= 0 ? points[ans] : undefined;
  return p && t - p.time <= 3 * HOUR ? p.rate : null;
}

/* ------------------------------------------------------------------ */
/* Field derivation                                                      */
/* ------------------------------------------------------------------ */

type Fields = SignalSnapshot["fields"];

export function priceFieldsAt(main: BarSeries, fine: BarSeries | null, now: number): Fields | null {
  // Treat a market as "no data" once its last bar is older than a day (delisted, no trades).
  const price = main.closeAt(now, DAY);
  if (price == null) return null;
  // Lookbacks tolerate a few missing bars (thin GeckoTerminal pools skip bars without trades).
  const tol = Math.max(main.barMs * 3, HOUR);
  const fivePrev = fine ? fine.closeAt(now - 5 * 60_000, 10 * 60_000) : null;
  const fiveNow = fine ? fine.closeAt(now, 10 * 60_000) : null;
  return {
    price,
    change_5m_pct: fiveNow != null && fivePrev != null ? pct(fiveNow, fivePrev) : null,
    change_1h_pct: pct(price, main.closeAt(now - HOUR, tol)),
    change_24h_pct: pct(price, main.closeAt(now - DAY, tol)),
    volume_24h_usd: main.volumeUsd(now, DAY),
  };
}

export function fundingFieldsAt(points: readonly FundingPoint[], now: number): Fields | null {
  const h = fundingAt(points, now);
  if (h == null) return null;
  return {
    rate_1h_pct: h * 100,
    rate_8h_pct: h * 100 * 8,
    apr_pct: h * 100 * 24 * 365,
    // Hyperliquid has no public open-interest history.
    open_interest_usd: null,
    oi_zscore_30d: null,
  };
}

/** "sig.field" refs used by the strategy's triggers. */
export function referencedRefs(strategy: Strategy): Set<string> {
  const out = new Set<string>();
  for (const t of strategy.triggers) for (const r of exprRefs(t.when)) out.add(r.ref);
  return out;
}

/* ------------------------------------------------------------------ */
/* Frames                                                                */
/* ------------------------------------------------------------------ */

export function buildFrames(input: BuildFramesInput): BuiltFrames {
  const { strategy, history, start, end, stepMs } = input;
  const maxFrames = input.maxFrames ?? 10_000;

  const series = new Map<string, { main: BarSeries; fine: BarSeries | null; funding: FundingPoint[] }>();
  for (const [key, h] of history) {
    series.set(key, {
      main: new BarSeries(h.candles, h.barMs),
      fine: h.candles5m?.length ? new BarSeries(h.candles5m, 5 * 60_000) : null,
      funding: [...(h.funding ?? [])].sort((a, b) => a.time - b.time),
    });
  }

  const fieldHits: Record<string, Record<string, number>> = {};
  const hit = (sigId: string, fields: Fields | null) => {
    const m = (fieldHits[sigId] ??= {});
    if (!fields) return;
    for (const [f, v] of Object.entries(fields)) if (v != null) m[f] = (m[f] ?? 0) + 1;
  };
  for (const s of strategy.signals) fieldHits[s.id] = {};

  const frames: ReplayFrame[] = [];
  for (let now = start; now <= end && frames.length < maxFrames; now += stepMs) {
    const signals: ReplayFrame["signals"] = {};
    for (const sig of strategy.signals) {
      let fields: Fields | null = null;
      switch (sig.kind) {
        case "price": {
          const s = series.get(instrumentKey(sig.params.instrument));
          fields = s ? priceFieldsAt(s.main, s.fine, now) : null;
          break;
        }
        case "funding": {
          const s = series.get(instrumentKey(sig.params.instrument));
          fields = s ? fundingFieldsAt(s.funding, now) : null;
          break;
        }
        case "calendar":
          fields = input.calendar ? input.calendar(sig.params, now) : null;
          break;
        default:
          // position: the engine produces it. Everything else: unknown historically.
          fields = null;
      }
      if (sig.kind === "position") continue;
      hit(sig.id, fields);
      if (fields) signals[sig.id] = { asOf: now, fields };
    }

    const quotes: ReplayFrame["quotes"] = { ...input.constantQuotes };
    const funding: Record<string, number> = {};
    for (const [key, s] of series) {
      const px = s.main.closeAt(now, DAY);
      if (px != null) quotes[key] = px;
      if (s.funding.length) {
        const r = fundingAt(s.funding, now);
        if (r != null) funding[key] = r;
      }
    }
    frames.push({ now, signals, quotes, ...(Object.keys(funding).length ? { funding } : {}) });
  }
  return { frames, fieldHits };
}
