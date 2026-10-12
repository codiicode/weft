import { instrumentKey, SIGNAL_KIND_NAMES, type Instrument, type RiskCaps, type SignalSnapshot, type Strategy, type TokenFacts } from "@weft/strategy";
import type { MarketData, Quote, SignalProvider, TokenFactsProvider } from "@weft/venues";
import type { DeploymentSnapshot, EngineEvent, Fill } from "./types.ts";
import { MemoryStore } from "./store.ts";
import { createEngine, type EngineOptions } from "./engine.ts";

/** One step of recorded data. */
export interface ReplayFrame {
  /** ms since epoch */
  now: number;
  /** Snapshots by signal id. Missing ids mean "no new data" (the last value is carried, subject to staleness). */
  signals: Record<string, SignalSnapshot | null | undefined>;
  /** Prices by instrumentKey (e.g. "hl:perp:SOL"): a number (mid) or a full quote. Missing keys keep their last price. */
  quotes: Record<string, number | Partial<Quote>>;
}

export interface ReplayOptions {
  allocationUsd?: number;
  caps?: RiskCaps;
  fees?: EngineOptions["fees"];
  slippageBps?: EngineOptions["slippageBps"];
  /** Token safety facts by mint, or a provider. */
  tokenFacts?: Record<string, TokenFacts> | TokenFactsProvider;
  usdPriceInstruments?: Record<string, Instrument>;
}

export interface ReplayResult {
  snapshot: DeploymentSnapshot;
  fills: Fill[];
  events: EngineEvent[];
}

/**
 * Backtest / replay: runs the exact live tick pipeline (same Session, exits,
 * evaluator, risk checks, paper executor) over recorded data with a fake clock
 * and an in-memory store. Live and backtest share all of their code.
 */
export async function replay(strategy: Strategy, timeline: ReplayFrame[], opts: ReplayOptions = {}): Promise<ReplayResult> {
  const first = timeline[0];
  let clock = first?.now ?? 0;
  let frame: ReplayFrame | undefined = first;
  const lastQuotes = new Map<string, Quote>();

  const marketData: MarketData = {
    async getQuote(i: Instrument): Promise<Quote> {
      const key = instrumentKey(i);
      const q = lastQuotes.get(key);
      if (!q) throw new Error(`no recorded price for ${key}`);
      return q;
    },
  };

  const signals: SignalProvider = {
    kinds: SIGNAL_KIND_NAMES.filter((k) => k !== "position"),
    mode: "simulated",
    async fetch(sig) {
      return frame?.signals[sig.id] ?? null;
    },
  };

  const facts = opts.tokenFacts;
  const tokenFacts: TokenFactsProvider | undefined =
    facts == null ? undefined : "getTokenFacts" in facts ? (facts as TokenFactsProvider) : { getTokenFacts: async (mint) => (facts as Record<string, TokenFacts>)[mint] ?? null };

  const store = new MemoryStore({ maxEquitySamples: Math.max(2_000, timeline.length + 10), maxEvents: Math.max(10_000, timeline.length * 50) });
  const engine = createEngine({
    store,
    marketData,
    signalProviders: [signals],
    tokenFacts,
    clock: () => clock,
    fees: opts.fees,
    slippageBps: opts.slippageBps,
    usdPriceInstruments: opts.usdPriceInstruments,
    tickEventIntervalMs: 0,
    warningIntervalMs: 0,
    equitySampleIntervalMs: 0,
  });

  const d = await engine.createDeployment({ strategy, allocationUsd: opts.allocationUsd ?? 10_000, caps: opts.caps });
  for (const f of timeline) {
    frame = f;
    clock = f.now;
    for (const [key, v] of Object.entries(f.quotes)) {
      const q: Quote = typeof v === "number" ? { instrumentKey: key, price: v, ts: f.now, source: "replay" } : { instrumentKey: key, ts: f.now, source: "replay", price: NaN, ...v };
      lastQuotes.set(key, q);
    }
    await engine.tick(d.id, f.now);
  }
  const snapshot = (await engine.getSnapshot(d.id))!;
  return { snapshot, fills: await engine.getFills(d.id), events: await store.listEvents(d.id) };
}
