import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Instrument, Signal } from "@weft/strategy";
import { createVenues, OiHistory } from "../src/index.ts";
import { fixture, fixtureRouter, mockFetch, NOW } from "./helpers.ts";

const HOUR = 3_600_000;
const T0 = Math.floor(NOW / HOUR) * HOUR; // aligned to an hour bucket

const dirs: string[] = [];
function tmpFile(name = "oi-history.json") {
  const d = mkdtempSync(join(tmpdir(), "weft-oi-"));
  dirs.push(d);
  return join(d, name);
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));

describe("OiHistory", () => {
  it("keeps one value per hourly bucket (last wins) and needs 24 buckets for a z-score", () => {
    let t = T0;
    const h = new OiHistory({ now: () => t });
    h.record("BTC", 100, t);
    h.record("BTC", 110, t + 10 * 60_000); // same bucket: overwrites
    expect(h.samples("BTC")).toEqual([{ ts: T0, oiUsd: 110 }]);
    const vals = [110];
    for (let k = 1; k < 23; k++) {
      t = T0 + k * HOUR;
      h.record("BTC", 100 + k, t);
      vals.push(100 + k);
    }
    expect(h.samples("BTC")).toHaveLength(23);
    expect(h.zscore("BTC")).toBeNull();
    t = T0 + 23 * HOUR;
    h.record("BTC", 200, t);
    vals.push(200);
    const z = h.zscore("BTC")!;
    expect(z).toBeCloseTo((200 - mean(vals)) / sd(vals), 9);
    expect(z).toBeGreaterThan(2);
    // An explicit current value is scored against the same history.
    expect(h.zscore("BTC", 50)!).toBeLessThan(0);
    expect(h.zscore("ETH")).toBeNull();
  });

  it("flat history scores 0; non-finite and negative values are ignored", () => {
    let t = T0;
    const h = new OiHistory({ now: () => t, minSamples: 3 });
    for (let k = 0; k < 3; k++) h.record("SOL", 5e6, (t = T0 + k * HOUR));
    h.record("SOL", NaN, t);
    h.record("SOL", -1, t);
    expect(h.zscore("SOL")).toBe(0);
  });

  it("is a bounded 30-day ring", () => {
    let t = T0;
    const h = new OiHistory({ now: () => t });
    for (let k = 0; k < 40 * 24; k++) h.record("BTC", 1_000 + k, (t = T0 + k * HOUR));
    const s = h.samples("BTC");
    expect(s).toHaveLength(30 * 24);
    expect(s[0]!.ts).toBe(t - (30 * 24 - 1) * HOUR);
    // A month later without new data, the window is empty again.
    t += 31 * 24 * HOUR;
    expect(h.samples("BTC")).toHaveLength(0);
    expect(h.zscore("BTC")).toBeNull();
  });

  it("persists to JSON (throttled) and reloads", () => {
    const path = tmpFile();
    let t = T0;
    const h = new OiHistory({ path, now: () => t, flushIntervalMs: 2 * HOUR });
    h.observe([{ coin: "BTC", openInterestUsd: 1e9 }, { coin: "xyz:NVDA", openInterestUsd: 5e6 }, { coin: "DEAD", openInterestUsd: 0, isDelisted: true }], t);
    const first = JSON.parse(readFileSync(path, "utf8"));
    expect(first.series).toEqual({ BTC: [[T0 / HOUR, 1e9]], "xyz:NVDA": [[T0 / HOUR, 5e6]] });
    // Within the flush interval nothing is written…
    t = T0 + HOUR;
    h.observe([{ coin: "BTC", openInterestUsd: 1.1e9 }], t);
    expect(JSON.parse(readFileSync(path, "utf8")).series.BTC).toHaveLength(1);
    // …until it elapses (or flush() is called).
    h.flush();
    expect(JSON.parse(readFileSync(path, "utf8")).series.BTC).toHaveLength(2);

    const again = new OiHistory({ path, now: () => t });
    expect(again.samples("BTC").map((s) => s.oiUsd)).toEqual([1e9, 1.1e9]);
    expect(again.samples("xyz:NVDA")).toEqual([{ ts: T0, oiUsd: 5e6 }]);
  });

  it("tolerates a missing or corrupt file", () => {
    const path = tmpFile();
    const errors: unknown[] = [];
    expect(new OiHistory({ path, onError: (e) => errors.push(e) }).size).toBe(0);
    expect(errors).toHaveLength(0); // missing file is not an error
    writeFileSync(path, "{not json");
    const h = new OiHistory({ path, onError: (e) => errors.push(e) });
    expect(h.size).toBe(0);
    expect(errors).toHaveLength(1);
  });
});

describe("funding.oi_zscore_30d via createVenues", () => {
  const sol: Instrument = { kind: "perp", venue: "hyperliquid", symbol: "SOL", assetClass: "crypto" };
  const nvda: Instrument = { kind: "perp", venue: "hyperliquid", dex: "xyz", symbol: "NVDA", assetClass: "equity" };
  const sig = (instrument: Instrument) => ({ id: "f", kind: "funding", params: { instrument } }) as Signal;

  /** Router whose metaAndAssetCtxs OI for every coin is scaled by `scale()`. */
  function scaledRouter(scale: () => number) {
    return mockFetch((url, body) => {
      const r = fixtureRouter(url, body);
      if (body?.type !== "metaAndAssetCtxs") return r;
      const [meta, ctxs] = r as [unknown, { openInterest?: string }[]];
      return [meta, ctxs.map((c) => (c.openInterest != null ? { ...c, openInterest: String(Number(c.openInterest) * scale()) } : c))];
    });
  }

  it("is null until 24 hourly samples exist, then scores the latest OI (core and HIP-3)", async () => {
    let t = T0;
    let k = 0;
    const scale = () => (k < 24 ? 1 + 0.01 * (k % 3) : 1.5); // flat-ish history, then an OI spike
    const path = tmpFile();
    const v = createVenues({ fetch: scaledRouter(scale), now: () => t, retries: 0, oiHistoryPath: path });
    for (k = 0; k < 23; k++) {
      t = T0 + k * HOUR;
      const f = (await v.signals.fetch(sig(sol), t))!.fields;
      expect(f.oi_zscore_30d).toBeNull();
      await v.signals.fetch(sig(nvda), t);
    }
    k = 24;
    t = T0 + 23 * HOUR;
    const f = (await v.signals.fetch(sig(sol), t))!.fields;
    expect(f.oi_zscore_30d).not.toBeNull();
    expect(f.oi_zscore_30d as number).toBeGreaterThan(3);
    expect(f.rate_1h_pct).toBeCloseTo(0.00125, 12); // other fields unchanged
    const n = (await v.signals.fetch(sig(nvda), t))!.fields;
    expect(n.oi_zscore_30d as number).toBeGreaterThan(3);
    expect(v.ctx.oi.samples("SOL")).toHaveLength(24);
    expect(v.ctx.oi.samples("xyz:NVDA")).toHaveLength(24);

    // History survives a restart through the JSON file.
    v.ctx.oi.flush();
    const v2 = createVenues({ fetch: scaledRouter(scale), now: () => t, retries: 0, oiHistoryPath: path });
    expect(v2.ctx.oi.samples("SOL")).toHaveLength(24);
    expect((await v2.signals.fetch(sig(sol), t))!.fields.oi_zscore_30d as number).toBeGreaterThan(3);
  });

  it("market data exposes funding rate and max leverage for perps (core and HIP-3)", async () => {
    const v = createVenues({ fetch: mockFetch(fixtureRouter), now: () => NOW, retries: 0 });
    expect(await v.marketData.getFundingRate(sol)).toEqual({ hourlyRate: 0.0000125, ts: NOW });
    const core = fixture("hl_meta_core.json");
    const solMeta = core[0].universe.find((a: { name: string }) => a.name === "SOL");
    expect(await v.marketData.getMaxLeverage(sol)).toBe(solMeta.maxLeverage);
    const xyz = fixture("hl_meta_xyz.json");
    const i = xyz[0].universe.findIndex((a: { name: string }) => a.name === "xyz:NVDA");
    expect((await v.marketData.getFundingRate(nvda))!.hourlyRate).toBe(Number(xyz[1][i].funding));
    expect(await v.marketData.getMaxLeverage(nvda)).toBe(xyz[0].universe[i].maxLeverage);
    expect(await v.marketData.getFundingRate({ kind: "spot", venue: "hyperliquid", symbol: "HYPE/USDC", assetClass: "crypto" })).toBeNull();
    await expect(v.marketData.getFundingRate({ ...sol, symbol: "NOPE" })).rejects.toThrow(/unknown perp/);
  });
});
