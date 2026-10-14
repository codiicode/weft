import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateStrategy, instrumentKey, type Instrument, type Strategy, type StrategyInput } from "@weft/strategy";
import { calendarFields, parseHlCandles, parseHlFunding, type Catalog, type HistoryProvider, type CandleInterval } from "@weft/venues";
import type { Engine } from "@weft/engine";
import { BarSeries, buildFrames, priceFieldsAt, type InstrumentHistory } from "../src/backtest/frames.ts";
import { downsample, maxDrawdownPct, runBacktest, type BacktestResult } from "../src/backtest/run.ts";
import { StrategyLibrary } from "../src/lib/library.ts";
import { createApp } from "../src/app.ts";

const H = 3_600_000;
const DAY = 24 * H;
const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

// Recorded Hyperliquid responses: 120 hourly BTC bars + funding, 24 hourly xyz:NVDA bars.
const btcRaw = load("hl_candles_btc_1h.json") as { start: number; end: number; candles: { t: number; c: string; v: string }[] };
const btcFundingRaw = load("hl_funding_btc.json") as { funding: { fundingRate: string; time: number }[] };
const nvdaRaw = load("hl_candles_nvda_1h.json") as { start: number; end: number; candles: unknown[] };
const BTC = parseHlCandles(btcRaw.candles as never);
const BTC_FUNDING = parseHlFunding(btcFundingRaw.funding as never);
const NVDA = parseHlCandles(nvdaRaw.candles as never);
const END = btcRaw.end;

const BTC_PERP: Instrument = { kind: "perp", venue: "hyperliquid", symbol: "BTC", assetClass: "crypto" };
const NVDA_PERP: Instrument = { kind: "perp", venue: "hyperliquid", dex: "xyz", symbol: "NVDA", assetClass: "equity" };

/** A HistoryProvider over the recorded fixtures (offline). */
function fakeHistory(): HistoryProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    unsupportedReason(i) {
      if (i.kind === "outcome") return "Prediction-market price history isn't available yet";
      if (i.kind === "option") return "Options price history isn't available yet";
      return null;
    },
    async candles(i, interval: CandleInterval, start, end) {
      const key = instrumentKey(i);
      calls.push(`candles ${key} ${interval}`);
      const src = key === "hl:perp:BTC" ? BTC : key === "hl:perp:xyz:NVDA" ? NVDA : [];
      return { instrumentKey: key, interval, source: "fixture", candles: src.filter((c) => c.t >= start && c.t < end) };
    },
    async funding(i, start, end) {
      calls.push(`funding ${instrumentKey(i)}`);
      return instrumentKey(i) === "hl:perp:BTC" ? BTC_FUNDING.filter((p) => p.time >= start && p.time <= end) : [];
    },
  };
}

const strategy = (s: Partial<StrategyInput>): Strategy => {
  const v = validateStrategy({ schemaVersion: 1, id: "bt-test", name: "BT test", thesis: "test", ...s });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return v.strategy;
};

/** Buy 1h dips in BTC with a 2× perp, 1% target, 2% stop, re-entering after each close. */
const dipBuyer = (extraSignals: StrategyInput["signals"] = [], when?: unknown) =>
  strategy({
    signals: [{ id: "px", kind: "price", params: { instrument: BTC_PERP } }, { id: "fund", kind: "funding", params: { instrument: BTC_PERP } }, ...extraSignals],
    triggers: [{ id: "dip", label: "1h dip", when: (when ?? { op: "lt", left: { ref: "px.change_1h_pct" }, right: { value: -0.25 } }) as never }],
    actions: [
      {
        id: "buy",
        type: "open",
        on: ["dip"],
        instrument: BTC_PERP,
        side: "long",
        size: { unit: "pct_equity", value: 10 },
        leverage: 2,
        exits: { takeProfit: { pct: 0.5 }, stopLoss: { pct: 1 } },
        reentry: "after_close",
      },
    ],
  });

/* ------------------------------------------------------------------ */

describe("frame builder", () => {
  const hist = (s: Strategy): Map<string, InstrumentHistory> =>
    new Map([["hl:perp:BTC", { instrument: BTC_PERP, candles: BTC, barMs: H, funding: BTC_FUNDING }]]);

  it("derives price fields from closed bars only (no look-ahead)", () => {
    const s = new BarSeries(BTC, H);
    const k = 60; // frame at the OPEN of bar k → bar k-1 is the last closed one
    const now = BTC[k]!.t;
    const f = priceFieldsAt(s, null, now)!;
    expect(f.price).toBe(BTC[k - 1]!.c);
    expect(f.change_1h_pct).toBeCloseTo(((BTC[k - 1]!.c - BTC[k - 2]!.c) / BTC[k - 2]!.c) * 100, 10);
    expect(f.change_24h_pct).toBeCloseTo(((BTC[k - 1]!.c - BTC[k - 25]!.c) / BTC[k - 25]!.c) * 100, 10);
    const vol = BTC.slice(k - 24, k).reduce((n, c) => n + c.volUsd!, 0);
    expect(f.volume_24h_usd).toBeCloseTo(vol, 4);
    expect(f.change_5m_pct).toBeNull(); // no 5m bars supplied
    // Before the first bar has closed there is no price at all.
    expect(priceFieldsAt(s, null, BTC[0]!.t)).toBeNull();
    // Without a full day of bars, 24h fields are unknown.
    const early = priceFieldsAt(s, null, BTC[5]!.t)!;
    expect(early.change_24h_pct).toBeNull();
    expect(early.volume_24h_usd).toBeNull();
  });

  it("builds frames with quotes keyed by instrumentKey, funding, calendar and unknown signals", () => {
    const at = new Date(END - 2 * DAY).toISOString();
    const s = dipBuyer([
      { id: "cal", kind: "calendar", params: { event: "custom", at } },
      { id: "mood", kind: "social", params: { cashtags: ["BTC"] } },
    ]);
    const history = hist(s);
    history.set("hl:perp:xyz:NVDA", { instrument: NVDA_PERP, candles: NVDA, barMs: H });
    const { frames, fieldHits } = buildFrames({ strategy: s, history, start: END - 3 * DAY, end: END, stepMs: H, calendar: calendarFields, constantQuotes: { USDC: 1 } });

    expect(frames).toHaveLength(3 * 24 + 1);
    const last = frames.at(-1)!;
    expect(last.now).toBe(END);
    expect(last.quotes["hl:perp:BTC"]).toBe(BTC.at(-1)!.c);
    expect(last.quotes["hl:perp:xyz:NVDA"]).toBe(NVDA.at(-1)!.c);
    expect(last.quotes.USDC).toBe(1);

    const fund = last.signals.fund!.fields;
    const rate = BTC_FUNDING.filter((p) => p.time <= END).at(-1)!.rate;
    expect(fund.rate_1h_pct).toBeCloseTo(rate * 100, 12);
    expect(fund.rate_8h_pct).toBeCloseTo(rate * 800, 12);
    expect(fund.apr_pct).toBeCloseTo(rate * 100 * 24 * 365, 8);
    expect(fund.open_interest_usd).toBeNull();
    expect(fund.oi_zscore_30d).toBeNull();
    expect(last.funding?.["hl:perp:BTC"]).toBe(rate);

    expect(last.signals.cal!.fields.hours_since).toBeCloseTo(48, 6);
    expect(frames[0]!.signals.cal!.fields.hours_until).toBeCloseTo(24, 6);
    expect(last.signals.mood).toBeUndefined();
    expect(fieldHits.mood).toEqual({});
    expect(fieldHits.px!.price).toBe(frames.length);
  });

  it("caps the number of frames", () => {
    const s = dipBuyer();
    expect(buildFrames({ strategy: s, history: hist(s), start: END - 3 * DAY, end: END, stepMs: H, maxFrames: 10 }).frames).toHaveLength(10);
  });
});

describe("helpers", () => {
  it("downsamples to ≤ max points, keeping extremes, first and last", () => {
    const pts: [number, number][] = Array.from({ length: 5_000 }, (_, i) => [i, 100 + Math.sin(i / 50) * 10]);
    pts[2_345] = [2_345, 50];
    const d = downsample(pts, 300);
    expect(d.length).toBeLessThanOrEqual(300);
    expect(d[0]).toEqual(pts[0]);
    expect(d.at(-1)).toEqual(pts.at(-1));
    expect(d.some((p) => p[1] === 50)).toBe(true);
    expect(d.every((p, i) => i === 0 || p[0] > d[i - 1]![0])).toBe(true);
  });

  it("computes max drawdown", () => {
    expect(maxDrawdownPct([[0, 100], [1, 120], [2, 90], [3, 130], [4, 117]])).toBeCloseTo(25, 10);
  });
});

describe("runBacktest", () => {
  const deps = () => ({ history: fakeHistory(), calendar: calendarFields, now: () => END + 5 * 60_000 });

  it("replays a BTC strategy through the engine with fees, funding and exits", async () => {
    const r = await runBacktest({ strategy: dipBuyer(), days: 3, allocationUsd: 10_000, interval: "1h" }, deps());
    expect(r.period.end).toBe(END);
    expect(r.period.frames).toBe(73);
    expect(r.triggerFires.dip).toBeGreaterThan(0);
    expect(r.stats.trades).toBeGreaterThan(0);
    expect(r.fills[0]!.reason).toBe("entry");
    expect(r.fills[0]!.label).toBe("BTC-PERP");
    expect(r.stats.feesUsd).toBeGreaterThan(0);
    expect(r.stats.fundingUsd).not.toBe(0);
    expect(r.stats.exposurePct).toBeGreaterThan(0);
    expect(r.stats.exposurePct).toBeLessThanOrEqual(100);
    expect(r.stats.returnPct).toBeCloseTo(((r.stats.endEquityUsd - 10_000) / 10_000) * 100, 8);
    expect(r.stats.winRatePct).not.toBeNull();
    expect(r.fills.some((f) => ["take_profit", "stop_loss"].includes(f.reason))).toBe(true);
    expect(r.equityCurve.length).toBeLessThanOrEqual(300);
    expect(r.coverage.quality).toBe("full");
    expect(r.coverage.signals.find((s) => s.id === "px")?.status).toBe("historical");
    expect(r.coverage.instruments[0]).toMatchObject({ key: "hl:perp:BTC", status: "historical", role: "traded" });
  });

  it("explains when an entry trigger depends on data that has no history", async () => {
    const s = dipBuyer([{ id: "mood", kind: "social", params: { cashtags: ["BTC"] } }], {
      op: "and",
      args: [
        { op: "lt", left: { ref: "px.change_1h_pct" }, right: { value: -0.25 } },
        { op: "gt", left: { ref: "mood.sentiment" }, right: { value: 0.3 } },
      ],
    });
    const r = await runBacktest({ strategy: s, days: 3, allocationUsd: 10_000, interval: "1h" }, deps());
    expect(r.stats.trades).toBe(0);
    expect(r.coverage.quality).toBe("none");
    expect(r.coverage.note).toBe("Social sentiment isn't available historically, so the entry trigger “1h dip” never fired.");
    expect(r.coverage.signals.find((x) => x.id === "mood")).toMatchObject({ status: "unknown" });
    expect(r.coverage.triggers[0]).toMatchObject({ id: "dip", fires: 0, entry: true, unknownRefs: ["mood.sentiment"] });
  });

  it("reports unsupported products instead of pretending", async () => {
    const yes: Instrument = { kind: "outcome", venue: "hyperliquid", market: "123", outcome: "YES", question: "Fed cuts?" };
    const s = strategy({
      signals: [{ id: "px", kind: "price", params: { instrument: BTC_PERP } }],
      triggers: [{ id: "go", when: { op: "gt", left: { ref: "px.price" }, right: { value: 1 } } }],
      actions: [{ id: "bet", type: "open", on: ["go"], instrument: yes as never, side: "long", size: { unit: "usd", value: 100 }, exits: { stopLoss: { prob: 0.1 } } }],
    });
    const h = fakeHistory();
    const r = await runBacktest({ strategy: s, days: 2, allocationUsd: 10_000, interval: "1h" }, { ...deps(), history: h });
    expect(r.coverage.quality).toBe("none");
    expect(r.coverage.note).toMatch(/^Prediction-market price history isn't available yet, so YES · Fed cuts\? trades couldn't be simulated\.$/);
    expect(r.coverage.instruments.find((i) => i.key.startsWith("hl:outcome"))?.status).toBe("unsupported");
    expect(h.calls.some((c) => c.includes("outcome"))).toBe(false);
    expect(r.stats.trades).toBe(0);
  });

  it("says plainly when nothing fired on complete data", async () => {
    const s = dipBuyer([], { op: "lt", left: { ref: "px.change_24h_pct" }, right: { value: -50 } });
    const r = await runBacktest({ strategy: s, days: 3, allocationUsd: 10_000, interval: "1h" }, deps());
    expect(r.coverage.quality).toBe("full");
    expect(r.coverage.note).toMatch(/^No entry conditions were met/);
  });

  it("shortens the period to the history that exists", async () => {
    // xyz:NVDA has one day of bars, so a 3-day request covers less.
    const s = strategy({
      signals: [{ id: "px", kind: "price", params: { instrument: NVDA_PERP } }],
      triggers: [{ id: "go", when: { op: "gt", left: { ref: "px.price" }, right: { value: 1 } } }],
      actions: [{ id: "buy", type: "open", on: ["go"], instrument: NVDA_PERP, side: "long", size: { unit: "usd", value: 500 }, exits: { stopLoss: { pct: 5 } } }],
    });
    const r = await runBacktest({ strategy: s, days: 3, allocationUsd: 10_000, interval: "1h" }, deps());
    expect(r.period.start).toBeGreaterThan(r.period.requestedStart);
    expect(r.coverage.notes.join(" ")).toMatch(/of the requested 3 days/);
    expect(r.stats.trades).toBe(1);
  });
});

describe("POST /backtest", () => {
  let app: ReturnType<typeof createApp>;
  const emptyCatalog: Catalog = { async list() { return []; } };

  const make = (withBacktest = true) =>
    createApp({
      catalog: emptyCatalog,
      marketData: { async getQuote() { throw new Error("no live data in tests"); } },
      engine: {} as Engine,
      library: new StrategyLibrary(join(mkdtempSync(join(tmpdir(), "weft-bt-")), "lib.db")),
      signalModes: {},
      ...(withBacktest ? { backtest: { history: fakeHistory(), calendar: calendarFields, now: () => END } } : {}),
    });

  beforeEach(() => {
    app = make();
  });

  const post = (body: unknown, a = app) => a.request("/backtest", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  it("runs an inline strategy and returns stats, curve, fills, fire counts and coverage", async () => {
    const res = await post({ strategy: dipBuyer(), days: 3 });
    expect(res.status).toBe(200);
    const r = (await res.json()) as BacktestResult;
    expect(r.interval).toBe("1h");
    expect(r.allocationUsd).toBe(10_000);
    expect(Object.keys(r.stats)).toEqual(
      expect.arrayContaining(["returnPct", "maxDrawdownPct", "trades", "winRatePct", "feesUsd", "fundingUsd", "exposurePct"])
    );
    expect(r.equityCurve.length).toBeGreaterThan(2);
    expect(r.fills.length).toBeGreaterThan(0);
    expect(r.triggerFires.dip).toBeGreaterThan(0);
    expect(r.coverage.note).toBeTruthy();
  });

  it("runs a library strategy by id", async () => {
    const saved = await app.request("/strategies", { method: "POST", body: JSON.stringify({ strategy: dipBuyer() }), headers: { "content-type": "application/json" } });
    const { id } = (await saved.json()) as { id: string };
    const res = await post({ strategyId: id, days: 2, interval: "1h" });
    expect(res.status).toBe(200);
    const r = (await res.json()) as BacktestResult;
    expect(r.strategyId).toBe("bt-test");
    expect(r.period.frames).toBe(49);
    expect(r.coverage.instruments.map((i) => i.key)).toContain("hl:perp:BTC");
    expect(r.coverage.quality).toBe("full");
  });

  it("validates input", async () => {
    expect((await post({ strategyId: "crowded-fade", days: 91 })).status).toBe(400);
    expect((await post({ strategyId: "crowded-fade", days: 0 })).status).toBe(400);
    expect((await post({ strategyId: "crowded-fade", interval: "5m" })).status).toBe(400);
    expect((await post({ days: 5 })).status).toBe(400);
    expect((await post({ strategyId: "nope" })).status).toBe(404);
    expect((await post({ strategy: { name: "broken" } })).status).toBe(422);
    expect((await post({ strategyId: "crowded-fade" }, make(false))).status).toBe(501);
  });
});

describe("charts", () => {
  const listing = { product: "perps" as const, instrument: BTC_PERP, instrumentKey: "hl:perp:BTC", label: "BTC", price: 1, venue: "hyperliquid" };
  const catalog: Catalog = {
    async list() {
      return [listing];
    },
    async find(key: string) {
      return key === listing.instrumentKey ? listing : null;
    },
  };
  const app = createApp({
    catalog,
    marketData: { async getQuote() { throw new Error("no live data in tests"); } },
    engine: {} as Engine,
    library: new StrategyLibrary(join(mkdtempSync(join(tmpdir(), "weft-chart-")), "lib.db")),
    signalModes: {},
    backtest: { history: fakeHistory(), calendar: calendarFields, now: () => END },
  });
  const post = (body: unknown) => app.request("/chart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("serves a week of hourly bars with funding, sized for a chart", async () => {
    const res = await post({ instrument: BTC_PERP, range: "1W", funding: true });
    expect(res.status).toBe(200);
    const d = (await res.json()) as { interval: string; candles: number[][]; funding: number[][]; source: string };
    expect(d.interval).toBe("1h");
    expect(d.candles.length).toBeGreaterThan(24);
    expect(d.candles.length).toBeLessThanOrEqual(168);
    expect(d.candles[0]).toHaveLength(6);
    expect(d.funding.length).toBeGreaterThan(0);
  });

  it("says plainly when a market has no history", async () => {
    const res = await post({ instrument: { kind: "outcome", venue: "jupiter", market: "x", outcome: "YES" }, range: "1D" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { unsupported: boolean }).unsupported).toBe(true);
  });

  it("rejects unknown ranges", async () => {
    expect((await post({ instrument: BTC_PERP, range: "5Y" })).status).toBe(400);
  });

  it("looks up one market by key", async () => {
    expect(((await (await app.request("/market?key=hl:perp:BTC")).json()) as { label: string }).label).toBe("BTC");
    expect((await app.request("/market?key=hl:perp:NOPE")).status).toBe(404);
  });
});
