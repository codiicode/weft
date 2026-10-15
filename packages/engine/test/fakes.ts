import { defineStrategy, instrumentKey, SIGNAL_KIND_NAMES, type Instrument, type OutcomeInstrument, type PerpInstrument, type Signal, type SignalKind, type SignalSnapshot, type StrategyInput, type TokenFacts, type TokenInstrument } from "@weft/strategy";
import type { MarketData, Quote, QuoteRequest, SignalProvider, TokenFactsProvider } from "@weft/venues";
import { createEngine, MemoryStore, type EngineOptions, type Store } from "../src/index.ts";

export const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
export const MIN = 60_000;
export const HOUR = 3_600_000;

export const BTC: PerpInstrument = { kind: "perp", venue: "hyperliquid", symbol: "BTC", assetClass: "crypto" };
export const ETH: PerpInstrument = { kind: "perp", venue: "hyperliquid", symbol: "ETH", assetClass: "crypto" };
export const SOL_PERP: PerpInstrument = { kind: "perp", venue: "hyperliquid", symbol: "SOL", assetClass: "crypto" };
export const MINT = "TestMint1111111111111111111111111111111111";
export const TOKEN: TokenInstrument = { kind: "token", chain: "solana", mint: MINT, symbol: "TEST", quote: "SOL", route: "auto", assetClass: "crypto" };
export const YES: OutcomeInstrument = { kind: "outcome", venue: "hyperliquid", market: "test-market", outcome: "YES" };

export class FakeMarket implements MarketData {
  readonly quotes = new Map<string, Partial<Quote> & { price: number }>();
  readonly requests: { key: string; req?: QuoteRequest }[] = [];

  set(i: Instrument | string, q: number | (Partial<Quote> & { price: number })): this {
    this.quotes.set(typeof i === "string" ? i : instrumentKey(i), typeof q === "number" ? { price: q } : q);
    return this;
  }

  async getQuote(i: Instrument, req?: QuoteRequest): Promise<Quote> {
    const key = instrumentKey(i);
    this.requests.push({ key, req });
    const q = this.quotes.get(key);
    if (!q) throw new Error(`no price for ${key}`);
    return { instrumentKey: key, ts: 0, source: "fake", ...q };
  }
}

type FakeValue = Record<string, number | boolean | null> | SignalSnapshot | Error | ((sig: Signal, now: number) => Promise<SignalSnapshot | null>);

/** Returns fields by signal id, stamped `asOf = now` unless a full snapshot is given. */
export class FakeSignals implements SignalProvider {
  readonly mode = "simulated" as const;
  readonly values = new Map<string, FakeValue>();
  calls = 0;
  readonly kinds: readonly SignalKind[];
  constructor(kinds: readonly SignalKind[] = SIGNAL_KIND_NAMES.filter((k) => k !== "position")) {
    this.kinds = kinds;
  }

  set(id: string, v: FakeValue): this {
    this.values.set(id, v);
    return this;
  }

  async fetch(sig: Signal, now: number): Promise<SignalSnapshot | null> {
    this.calls++;
    const v = this.values.get(sig.id);
    if (v == null) return null;
    if (v instanceof Error) throw v;
    if (typeof v === "function") return v(sig, now);
    if ("asOf" in v && "fields" in v) return v as SignalSnapshot;
    return { asOf: now, fields: v as Record<string, number | boolean | null> };
  }
}

export class FakeTokenFacts implements TokenFactsProvider {
  facts: TokenFacts | null = null;
  readonly calls: { mint: string; sizeUsd?: number }[] = [];
  async getTokenFacts(mint: string, opts?: { sizeUsd?: number }) {
    this.calls.push({ mint, sizeUsd: opts?.sizeUsd });
    return this.facts;
  }
}

export const HEALTHY: TokenFacts = {
  liquidity_usd: 400_000,
  top10_holders_pct: 15,
  mint_authority_revoked: true,
  freeze_authority_revoked: true,
  age_minutes: 5_000,
  dev_sold_pct: 0,
  price_impact_bps: 40,
};

export const ZERO_SLIPPAGE = { perp: 0, spot: 0, token: 0, outcome: 0, option: 0 };

/** The schedule the engine tests were written against (builder 5 bps, Solana platform 50 bps). */
export const TEST_FEES = { hyperliquid: { builderBps: 5 }, outcome: { builderBps: 5 }, solana: { platformBps: 50 } };

export function setup(over: Partial<EngineOptions> & { store?: Store } = {}) {
  const clock = { t: T0 };
  const market = new FakeMarket();
  const signals = new FakeSignals();
  const tokenFacts = new FakeTokenFacts();
  const engine = createEngine({
    store: new MemoryStore(),
    marketData: market,
    signalProviders: [signals],
    tokenFacts,
    clock: () => clock.t,
    slippageBps: ZERO_SLIPPAGE,
    // Tests pin their own fee schedule so they check the fee mechanics, not Weft's current prices.
    fees: TEST_FEES,
    ...over,
  });
  return { engine, market, signals, tokenFacts, clock };
}

/** One control signal ("go.value" > 0) opening one action; extra fields merged in. */
export function simpleStrategy(action: Record<string, unknown>, extra: Partial<StrategyInput> = {}) {
  return defineStrategy({
    schemaVersion: 1,
    id: "test-strategy",
    name: "Test",
    thesis: "test",
    signals: [{ id: "go", kind: "macro", params: { series: "GO" } }],
    triggers: [{ id: "entry", when: { op: "gt", left: { ref: "go.value" }, right: { value: 0 } } }],
    actions: [{ id: "open_it", on: ["entry"], type: "open", ...action } as never],
    ...extra,
  });
}

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
