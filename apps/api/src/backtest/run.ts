import { instrumentKey, instrumentLabel, type Instrument, type Signal, type SignalKind, type Strategy } from "@weft/strategy";
import { replay, USDC_MINT, type Fill, type ReplayResult } from "@weft/engine";
import type { CandleInterval, FundingPoint, HistoryProvider, TokenFactsProvider, Candle } from "@weft/venues";
import { buildFrames, referencedRefs, type BuildFramesInput, type InstrumentHistory } from "./frames.ts";

/**
 * POST /backtest: "how would this strategy have done over the last N days?"
 *
 * 1. Collect the instruments the strategy trades or watches, fetch their history
 *    (candles at the interval, 5m bars only when change_5m_pct is used, funding
 *    for perps), all under one deadline.
 * 2. Build ReplayFrames (frames.ts) and run the real engine via `replay()`:
 *    same evaluator, risk checks, paper fills, fees, slippage, funding and exits.
 * 3. Summarize: stats, a downsampled equity curve, fills, trigger fire counts and
 *    a coverage report saying what was historical and what was unknown.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const BACKTEST_INTERVALS = { "1h": HOUR, "15m": 15 * 60_000 } as const;
export type BacktestInterval = keyof typeof BACKTEST_INTERVALS;

export interface BacktestDeps {
  history: HistoryProvider;
  /** Token safety facts for token buys. Live facts are used as an approximation. */
  tokenFacts?: TokenFactsProvider;
  calendar?: BuildFramesInput["calendar"];
  now?: () => number;
}

export interface BacktestRequest {
  strategy: Strategy;
  days: number;
  allocationUsd: number;
  interval: BacktestInterval;
  /** Budget for fetching history, ms (default 14 s). */
  historyBudgetMs?: number;
  maxFrames?: number;
}

export type CoverageStatus = "historical" | "partial" | "unknown" | "engine" | "unused";

export interface SignalCoverage {
  id: string;
  kind: SignalKind;
  label: string;
  status: CoverageStatus;
  /** Referenced fields with the share of frames (0–1) that had a value. */
  fields: { field: string; availability: number }[];
  note?: string;
}

export interface InstrumentCoverage {
  key: string;
  label: string;
  role: "traded" | "signal" | "reference";
  status: "historical" | "unsupported" | "error" | "no_data";
  source?: string;
  bars?: number;
  firstBarAt?: number;
  lastBarAt?: number;
  fundingPoints?: number;
  reason?: string;
}

export interface TriggerCoverage {
  id: string;
  label: string;
  fires: number;
  entry: boolean;
  /** Referenced "signal.field"s that were never available. */
  unknownRefs: string[];
}

export interface BacktestCoverage {
  quality: "full" | "partial" | "none";
  /** One plain-language headline, always present. */
  note: string;
  notes: string[];
  signals: SignalCoverage[];
  instruments: InstrumentCoverage[];
  triggers: TriggerCoverage[];
}

export interface BacktestFill {
  ts: number;
  instrumentKey: string;
  label: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  notionalUsd: number;
  feeUsd: number;
  realizedPnlUsd: number | null;
  fundingUsd: number | null;
  reason: Fill["reason"];
}

export interface BacktestResult {
  strategyId: string;
  name: string;
  interval: BacktestInterval;
  period: { requestedStart: number; start: number; end: number; days: number; frames: number };
  allocationUsd: number;
  stats: {
    endEquityUsd: number;
    returnPct: number;
    maxDrawdownPct: number;
    trades: number;
    closedTrades: number;
    winRatePct: number | null;
    feesUsd: number;
    builderFeesUsd: number;
    /** Net funding paid (positive) or received (negative). */
    fundingUsd: number;
    exposurePct: number;
    openPositions: number;
    rejectedOrders: number;
  };
  equityCurve: [number, number][];
  fills: BacktestFill[];
  fillsTruncated: boolean;
  triggerFires: Record<string, number>;
  rejections: { message: string; count: number }[];
  coverage: BacktestCoverage;
  timing: { historyMs: number; replayMs: number };
}

/* ------------------------------------------------------------------ */
/* Instrument collection                                                 */
/* ------------------------------------------------------------------ */

interface Needed {
  instrument: Instrument;
  role: InstrumentCoverage["role"];
  candles: boolean;
  fine: boolean;
  funding: boolean;
}

const SOL_PERP: Instrument = { kind: "perp", venue: "hyperliquid", symbol: "SOL", assetClass: "crypto" };

function collectInstruments(strategy: Strategy, refs: Set<string>): Map<string, Needed> {
  const out = new Map<string, Needed>();
  const add = (i: Instrument, role: Needed["role"], what: Partial<Pick<Needed, "candles" | "fine" | "funding">>) => {
    const key = instrumentKey(i);
    const prev = out.get(key);
    const rank = { traded: 0, signal: 1, reference: 2 } as const;
    const n: Needed = prev ?? { instrument: i, role, candles: false, fine: false, funding: false };
    if (rank[role] < rank[n.role]) n.role = role;
    n.candles ||= !!what.candles;
    n.fine ||= !!what.fine;
    n.funding ||= !!what.funding;
    out.set(key, n);
  };
  for (const a of strategy.actions) {
    if (a.type === "open") add(a.instrument, "traded", { candles: true, funding: a.instrument.kind === "perp" });
    else if (a.type === "options") for (const l of a.legs) add(l.instrument, "traded", { candles: true });
    else if (a.type === "close" && a.target !== "all") add(a.target.instrument, "traded", { candles: true, funding: a.target.instrument.kind === "perp" });
  }
  for (const s of strategy.signals) {
    if (s.kind === "price") add(s.params.instrument, "signal", { candles: true, fine: refs.has(`${s.id}.change_5m_pct`) });
    else if (s.kind === "funding") add(s.params.instrument, "signal", { funding: true });
    else if ((s.kind === "liquidity" || s.kind === "odds") && s.params.instrument) add(s.params.instrument, "signal", {});
  }
  // Token buys sized in SOL need a SOL/USD price for sizing and risk.
  if (strategy.actions.some((a) => a.type === "open" && a.instrument.kind === "token" && a.instrument.quote === "SOL"))
    add(SOL_PERP, "reference", { candles: true });
  return out;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                               */
/* ------------------------------------------------------------------ */

class Deadline {
  readonly at: number;
  constructor(ms: number) {
    this.at = Date.now() + ms;
  }
  run<T>(p: Promise<T>, what: string): Promise<T> {
    const left = Math.max(0, this.at - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`timed out fetching ${what}`)), left);
      }),
    ]).finally(() => clearTimeout(timer));
  }
}

/** Keep ≤ max points: per bucket keep the min and max (in time order), plus first and last. */
export function downsample(input: [number, number][], max = 300): [number, number][] {
  // One point per timestamp (the last one wins).
  const points: [number, number][] = [];
  for (const p of input) {
    if (points.length && points.at(-1)![0] === p[0]) points[points.length - 1] = p;
    else points.push(p);
  }
  if (points.length <= max) return points;
  const buckets = Math.floor((max - 2) / 2);
  const inner = points.slice(1, -1);
  const size = inner.length / buckets;
  const out: [number, number][] = [points[0]!];
  for (let b = 0; b < buckets; b++) {
    const chunk = inner.slice(Math.floor(b * size), Math.floor((b + 1) * size));
    if (!chunk.length) continue;
    let lo = chunk[0]!;
    let hi = chunk[0]!;
    for (const p of chunk) {
      if (p[1] < lo[1]) lo = p;
      if (p[1] > hi[1]) hi = p;
    }
    if (lo === hi) out.push(lo);
    else out.push(...((lo[0] < hi[0] ? [lo, hi] : [hi, lo]) as [number, number][]));
  }
  out.push(points.at(-1)!);
  return out;
}

export function maxDrawdownPct(points: readonly [number, number][]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const [, v] of points) {
    peak = Math.max(peak, v);
    if (peak > 0) dd = Math.max(dd, ((peak - v) / peak) * 100);
  }
  return dd;
}

const KIND_PHRASE: Partial<Record<SignalKind, string>> = {
  social: "social sentiment",
  news: "news flow",
  post_match: "post matching on X",
  model: "Weft model probabilities",
  token_onchain: "on-chain token data (holders, liquidity, authorities)",
  liquidity: "order-book depth",
  odds: "prediction-market odds",
  forecast: "forecast series",
  macro: "macro series",
};

const FIELD_PHRASE: Record<string, string> = {
  "funding.open_interest_usd": "open interest",
  "funding.oi_zscore_30d": "open-interest z-scores",
  "price.change_5m_pct": "5-minute price changes",
  "price.volume_24h_usd": "24h volume",
};

function unknownPhrase(sig: Signal, field: string, inst: InstrumentCoverage | undefined, instrument: Instrument | undefined): string {
  if (inst && inst.status !== "historical" && (sig.kind === "price" || sig.kind === "funding")) {
    if (inst.status === "unsupported") return instrument?.kind === "outcome" ? "prediction-market prices" : instrument?.kind === "option" ? "option prices" : `${inst.label} prices`;
    return `${inst.label} price history`;
  }
  return FIELD_PHRASE[`${sig.kind}.${field}`] ?? KIND_PHRASE[sig.kind] ?? `${sig.kind} data`;
}

/** "X isn't" / "X and Y aren't" … available historically. */
const unavailable = (phrases: string[]) => {
  const u = [...new Set(phrases)];
  const many = u.length > 1 || /s$/.test(u[0] ?? "");
  return `${ucfirst(joinAnd(u))} ${many ? "aren't" : "isn't"} available historically`;
};

/** Friendlier reason for a failed history fetch. */
const fetchFailure = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  if (/timed out/.test(m)) return "Timed out loading price history";
  if (/HTTP 4|HTTP 5/.test(m)) return "Couldn't load price history (unknown market or venue error)";
  return `Couldn't load price history (${m.slice(0, 80)})`;
};

const joinAnd = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const ucfirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ------------------------------------------------------------------ */
/* Main                                                                  */
/* ------------------------------------------------------------------ */

export async function runBacktest(req: BacktestRequest, deps: BacktestDeps): Promise<BacktestResult> {
  const { strategy } = req;
  const stepMs = BACKTEST_INTERVALS[req.interval];
  const now = (deps.now ?? Date.now)();
  const end = Math.floor(now / stepMs) * stepMs;
  const requestedStart = end - req.days * DAY;
  const fetchStart = requestedStart - DAY - HOUR; // warm-up for 24h changes and volume
  const refs = referencedRefs(strategy);
  const needed = collectInstruments(strategy, refs);

  /* ---- 1. history ---- */
  const t0 = Date.now();
  const deadline = new Deadline(req.historyBudgetMs ?? 14_000);
  const history = new Map<string, InstrumentHistory>();
  const instrumentCov = new Map<string, InstrumentCoverage>();
  await Promise.all(
    [...needed].map(async ([key, n]) => {
      const cov: InstrumentCoverage = { key, label: instrumentLabel(n.instrument), role: n.role, status: "historical" };
      instrumentCov.set(key, cov);
      const reason = deps.history.unsupportedReason(n.instrument);
      if (reason) {
        cov.status = "unsupported";
        cov.reason = reason;
        return;
      }
      if (!n.candles && !n.funding) return;
      try {
        const [main, fine, funding] = await Promise.all([
          n.candles ? deadline.run(deps.history.candles(n.instrument, req.interval as CandleInterval, fetchStart, end), `${cov.label} candles`) : null,
          n.fine
            ? deadline.run(deps.history.candles(n.instrument, "5m", requestedStart - HOUR, end), `${cov.label} 5m candles`).catch(() => null)
            : null,
          n.funding && n.instrument.kind === "perp" ? deadline.run(deps.history.funding(n.instrument, fetchStart, end), `${cov.label} funding`) : null,
        ]);
        const candles: Candle[] = main?.candles ?? [];
        const fundingPts: FundingPoint[] = funding ?? [];
        history.set(key, { instrument: n.instrument, candles, barMs: stepMs, candles5m: fine?.candles, funding: fundingPts });
        cov.source = main?.source ?? (funding ? "hyperliquid:fundingHistory" : undefined);
        if (n.candles) {
          cov.bars = candles.length;
          cov.firstBarAt = candles[0]?.t;
          cov.lastBarAt = candles.at(-1)?.t;
          if (!candles.length) {
            cov.status = "no_data";
            cov.reason = "No price history in this period";
          }
        }
        if (funding) cov.fundingPoints = funding.length;
      } catch (e) {
        cov.status = "error";
        cov.reason = fetchFailure(e);
      }
    })
  );
  const historyMs = Date.now() - t0;

  /* ---- 2. frames ---- */
  // Start where every priced instrument the strategy depends on has data (HL keeps ~5000 bars).
  let start = requestedStart;
  for (const [key, h] of history) {
    const n = needed.get(key);
    if (!n?.candles || !h.candles.length) continue;
    // A late-starting series simply has unknown 24h fields for its first day (reported as partial).
    if (n.role !== "reference") start = Math.max(start, Math.min(h.candles[0]!.t + stepMs, end));
  }
  start = Math.ceil(start / stepMs) * stepMs;
  const maxFrames = req.maxFrames ?? 9_000;
  const { frames, fieldHits } = buildFrames({
    strategy,
    history,
    start,
    end,
    stepMs,
    constantQuotes: { [`sol:token:${USDC_MINT}`]: 1 },
    calendar: deps.calendar,
    maxFrames,
  });

  /* ---- 3. replay ---- */
  const t1 = Date.now();
  const needsFacts = strategy.actions.some((a) => a.type === "open" && a.instrument.kind === "token");
  const result: ReplayResult = await replay(strategy, frames, {
    allocationUsd: req.allocationUsd,
    tokenFacts: needsFacts ? deps.tokenFacts : undefined,
  });
  const replayMs = Date.now() - t1;

  /* ---- 4. summary ---- */
  const { snapshot, fills, events } = result;
  const curve = snapshot.equityCurve;
  const triggerFires: Record<string, number> = Object.fromEntries(strategy.triggers.map((t) => [t.id, 0]));
  const rejectionCounts = new Map<string, { message: string; count: number }>();
  for (const e of events) {
    if (e.type === "trigger_fired") {
      const id = String(e.data?.triggerId ?? "");
      if (id in triggerFires) triggerFires[id]!++;
    } else if (e.type === "rejected") {
      // Group messages that differ only in numbers; show the first one verbatim.
      const k = e.message.replace(/\d+(\.\d+)?/g, "#");
      const r = rejectionCounts.get(k) ?? { message: e.message, count: 0 };
      r.count++;
      rejectionCounts.set(k, r);
    }
  }
  const rejections = [...rejectionCounts.values()].sort((a, b) => b.count - a.count).slice(0, 5);

  // Trades = positions opened; a trade wins when its net P&L (after both fees and funding) is positive.
  const byPos = new Map<string, { open?: Fill; closes: Fill[] }>();
  for (const f of fills) {
    const p = byPos.get(f.positionId) ?? { closes: [] };
    if (f.reason === "entry") p.open = f;
    else p.closes.push(f);
    byPos.set(f.positionId, p);
  }
  const stillOpen = new Set(snapshot.positions.map((p) => p.id));
  let closedTrades = 0;
  let wins = 0;
  const intervals: [number, number][] = [];
  const periodEnd = frames.at(-1)?.now ?? end;
  for (const [id, p] of byPos) {
    if (!p.open) continue;
    const lastClose = p.closes.reduce((m, f) => Math.max(m, f.ts), -Infinity);
    const closed = !stillOpen.has(id) && p.closes.length > 0;
    intervals.push([p.open.ts, closed ? lastClose : periodEnd]);
    if (closed) {
      closedTrades++;
      const net = p.closes.reduce((n, f) => n + (f.realizedPnlUsd ?? 0) - (f.fundingUsd ?? 0), 0) - p.open.feeUsd;
      if (net > 0) wins++;
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let exposed = 0;
  let curS = -Infinity;
  let curE = -Infinity;
  for (const [s, e] of intervals) {
    if (s > curE) {
      if (curE > curS) exposed += curE - curS;
      curS = s;
      curE = e;
    } else curE = Math.max(curE, e);
  }
  if (curE > curS) exposed += curE - curS;
  const span = Math.max(1, periodEnd - (frames[0]?.now ?? start));

  const labels = new Map([...needed].map(([k, n]) => [k, instrumentLabel(n.instrument)]));
  const MAX_FILLS = 500;
  const outFills: BacktestFill[] = fills.slice(-MAX_FILLS).map((f) => ({
    ts: f.ts,
    instrumentKey: f.instrumentKey,
    label: labels.get(f.instrumentKey) ?? f.instrumentKey,
    side: f.side,
    qty: f.qty,
    price: f.price,
    notionalUsd: f.qty * f.price,
    feeUsd: f.feeUsd,
    realizedPnlUsd: f.realizedPnlUsd ?? null,
    fundingUsd: f.fundingUsd ?? null,
    reason: f.reason,
  }));

  const coverage = buildCoverage({
    strategy,
    refs,
    fieldHits,
    frames: frames.length,
    instruments: [...instrumentCov.values()],
    triggerFires,
    trades: intervals.length,
    rejections,
    requestedDays: req.days,
    coveredDays: frames.length ? (periodEnd - frames[0]!.now) / DAY : 0,
    interval: req.interval,
    usedTokenFacts: needsFacts && !!deps.tokenFacts,
  });

  return {
    strategyId: strategy.id,
    name: strategy.name,
    interval: req.interval,
    period: { requestedStart, start: frames[0]?.now ?? start, end: periodEnd, days: frames.length ? (periodEnd - frames[0]!.now) / DAY : 0, frames: frames.length },
    allocationUsd: req.allocationUsd,
    stats: {
      endEquityUsd: snapshot.equityUsd,
      returnPct: snapshot.returnPct,
      maxDrawdownPct: maxDrawdownPct(curve),
      trades: intervals.length,
      closedTrades,
      winRatePct: closedTrades ? (wins / closedTrades) * 100 : null,
      feesUsd: snapshot.feesUsd ?? fills.reduce((n, f) => n + f.feeUsd, 0),
      builderFeesUsd: snapshot.builderFeesUsd ?? 0,
      fundingUsd: snapshot.fundingUsd ?? 0,
      exposurePct: Math.min(100, (exposed / span) * 100),
      openPositions: snapshot.positions.length,
      rejectedOrders: [...rejectionCounts.values()].reduce((a, b) => a + b.count, 0),
    },
    equityCurve: downsample(curve, 300),
    fills: outFills,
    fillsTruncated: fills.length > MAX_FILLS,
    triggerFires,
    rejections,
    coverage,
    timing: { historyMs, replayMs },
  };
}

/* ------------------------------------------------------------------ */
/* Coverage                                                              */
/* ------------------------------------------------------------------ */

export function buildCoverage(x: {
  strategy: Strategy;
  refs: Set<string>;
  fieldHits: Record<string, Record<string, number>>;
  frames: number;
  instruments: InstrumentCoverage[];
  triggerFires: Record<string, number>;
  trades: number;
  rejections: { message: string; count: number }[];
  requestedDays: number;
  coveredDays: number;
  interval: BacktestInterval;
  usedTokenFacts: boolean;
}): BacktestCoverage {
  const { strategy, refs, fieldHits, frames } = x;
  const instByKey = new Map(x.instruments.map((i) => [i.key, i]));
  const notes: string[] = [];

  /* signals */
  const availability = new Map<string, number>(); // "sig.field" → 0..1
  const phraseOf = new Map<string, string>(); // "sig.field" → why unknown
  const signals: SignalCoverage[] = strategy.signals.map((sig) => {
    const label = sig.label ?? sig.id;
    const used = [...refs].filter((r) => r.startsWith(`${sig.id}.`)).map((r) => r.slice(sig.id.length + 1));
    if (sig.kind === "position") return { id: sig.id, kind: sig.kind, label, status: "engine", fields: used.map((field) => ({ field, availability: 1 })) };
    const instrument = "instrument" in sig.params ? (sig.params.instrument as Instrument | undefined) : undefined;
    const inst = instrument ? instByKey.get(instrumentKey(instrument)) : undefined;
    const instReason = inst && inst.status !== "historical" ? inst.reason : undefined;
    const needsPrice = sig.kind === "price" || sig.kind === "funding";
    const fields = used.map((field) => {
      const a = frames ? (fieldHits[sig.id]?.[field] ?? 0) / frames : 0;
      availability.set(`${sig.id}.${field}`, a);
      if (a === 0) phraseOf.set(`${sig.id}.${field}`, unknownPhrase(sig, field, inst, instrument));
      return { field, availability: a };
    });
    let status: CoverageStatus;
    if (!used.length) status = "unused";
    else if (fields.every((f) => f.availability >= 0.95)) status = "historical";
    else if (fields.some((f) => f.availability > 0)) status = "partial";
    else status = "unknown";
    let note: string | undefined;
    if (status === "unknown" || status === "partial") {
      const missing = fields.filter((f) => f.availability === 0).map((f) => phraseOf.get(`${sig.id}.${f.field}`)!);
      note = missing.length ? unavailable(missing) : "Only part of the period has data";
      if (instReason && needsPrice) note = instReason;
    } else if (sig.kind === "calendar" && sig.params.event !== "custom") {
      note = sig.params.event === "fomc" ? "FOMC dates from the Fed's published schedule" : "Dates from Weft's static calendar (estimates)";
    }
    return { id: sig.id, kind: sig.kind, label, status, fields, ...(note ? { note } : {}) };
  });

  /* triggers */
  const entryIds = new Set(strategy.actions.filter((a) => a.type === "open" || a.type === "options").flatMap((a) => a.on));
  const triggers: TriggerCoverage[] = strategy.triggers.map((t) => {
    const unknownRefs = [...refs].filter((r) => (availability.get(r) ?? 1) === 0 && JSON.stringify(t.when).includes(`"${r}"`));
    return { id: t.id, label: t.label ?? t.id, fires: x.triggerFires[t.id] ?? 0, entry: entryIds.has(t.id), unknownRefs };
  });

  /* notes, most important first */
  const entries = triggers.filter((t) => t.entry);
  const blocked = entries.filter((t) => t.fires === 0 && t.unknownRefs.length);
  for (const t of blocked) {
    notes.push(`${unavailable(t.unknownRefs.map((r) => phraseOf.get(r) ?? r))}, so the entry trigger “${t.label}” never fired.`);
  }
  const tradedOpens: Instrument[] = strategy.actions.flatMap((a): Instrument[] => (a.type === "open" ? [a.instrument] : a.type === "options" ? a.legs.map((l) => l.instrument) : []));
  const badTraded = [...new Map(tradedOpens.map((i) => [instrumentKey(i), instByKey.get(instrumentKey(i))])).values()].filter(
    (c): c is InstrumentCoverage => !!c && c.status !== "historical"
  );
  const byReason = new Map<string, string[]>();
  for (const c of badTraded) byReason.set(c.reason ?? "No history", [...(byReason.get(c.reason ?? "No history") ?? []), c.label]);
  for (const [reason, labels] of byReason) notes.push(`${reason}, so ${joinAnd(labels)} trades couldn't be simulated.`);

  const degraded = entries.filter((t) => t.fires > 0 && t.unknownRefs.length);
  for (const t of degraded)
    notes.push(`The entry trigger “${t.label}” fired, but ${joinAnd([...new Set(t.unknownRefs.map((r) => phraseOf.get(r) ?? r))])} was treated as unknown.`);

  if (x.coveredDays > 0 && x.coveredDays < x.requestedDays - 0.5)
    notes.push(
      `Only ${x.coveredDays.toFixed(x.coveredDays < 10 ? 1 : 0)} of the requested ${x.requestedDays} days have ${x.interval} history for every market, so the backtest is shorter.`
    );
  if (!x.frames) notes.push("No history was available for this period.");
  if (!blocked.length && !badTraded.length && x.trades === 0 && x.frames > 0 && entries.every((t) => t.fires === 0))
    notes.push(`No entry conditions were met in this period, so the strategy never traded. That's a real result, not missing data.`);
  // Orders on markets without history are already explained above.
  const realRejections = x.rejections.filter((r) => !/no recorded price/.test(r.message));
  const rejected = realRejections.reduce((n, r) => n + r.count, 0);
  if (rejected && realRejections[0]) notes.push(`${plural(rejected, "order")} ${rejected === 1 ? "was" : "were"} rejected (most often: ${realRejections[0].message.replace(/^\S+ (rejected|not executed): /, "")}).`);
  if (x.usedTokenFacts && entries.some((t) => t.fires > 0)) notes.push("Token safety gates use today's on-chain facts; liquidity and holders may have differed back then.");
  notes.push(`Stops, targets and triggers are checked on ${x.interval} closes; intrabar highs and lows are not simulated.`);

  const anyUnknown = triggers.some((t) => t.unknownRefs.length);
  const allEntriesBlocked = entries.length > 0 && entries.every((t) => t.fires === 0 && t.unknownRefs.length);
  const allTradedBad = tradedOpens.length > 0 && badTraded.length === new Set(tradedOpens.map(instrumentKey)).size;
  const quality: BacktestCoverage["quality"] = !x.frames || allEntriesBlocked || allTradedBad ? "none" : anyUnknown || badTraded.length ? "partial" : "full";
  const note =
    quality === "full"
      ? x.trades === 0
        ? (notes.find((n) => n.startsWith("No entry conditions")) ?? notes[0]!)
        : "Every signal and market this strategy uses has history for this period."
      : (notes[0] ?? "Some data was not available historically.");
  return { quality, note, notes: notes.filter((n) => n !== note), signals, instruments: x.instruments, triggers };
}
