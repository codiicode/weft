import { describe, expect, it } from "vitest";
import { classifyHip3 } from "../src/hyperliquid/classify.ts";
import { outcomeCtxMap, parsePerpMarkets, parseSpotMarkets, resolveSpotCoin, splitCoin } from "../src/hyperliquid/parse.ts";
import { outcomeCoin, parseKv, parseOutcomes, resolveOutcomeRef } from "../src/hyperliquid/outcomes.ts";
import { fixture } from "./helpers.ts";

describe("perps", () => {
  const core = parsePerpMarkets(fixture("hl_meta_core.json"), null);

  it("maps core metaAndAssetCtxs", () => {
    const btc = core.find((m) => m.coin === "BTC")!;
    expect(btc.dex).toBeNull();
    expect(btc.assetClass).toBe("crypto");
    expect(btc.maxLeverage).toBe(40);
    expect(btc.price).toBe(82720.5); // midPx preferred over markPx
    expect(btc.markPx).toBe(82719);
    expect(btc.funding).toBeCloseTo(0.0000098673, 12);
    expect(btc.openInterestUsd).toBeCloseTo(38142.9102 * 82719, 3);
    expect(btc.change24hPct).toBeCloseTo(((82720.5 - 83050) / 83050) * 100, 9);
    expect(core.find((m) => m.coin === "MATIC")!.isDelisted).toBe(true);
  });

  it("classifies HIP-3 builder-dex markets", () => {
    const xyz = parsePerpMarkets(fixture("hl_meta_xyz.json"), "xyz", new Set(core.map((m) => m.symbol)));
    const cls = Object.fromEntries(xyz.map((m) => [m.symbol, m.assetClass]));
    expect(cls).toEqual({ XYZ100: "index", NVDA: "equity", GOLD: "commodity", JPY: "fx", BRENTOIL: "commodity", SPCX: "equity" });
    const nvda = xyz.find((m) => m.symbol === "NVDA")!;
    expect(nvda.coin).toBe("xyz:NVDA");
    expect(nvda.dex).toBe("xyz");
    expect(nvda.name).toBe("NVIDIA");
    const hyna = parsePerpMarkets(fixture("hl_meta_hyna.json"), "hyna", new Set(["BTC", "ETH", "KPEPE"]));
    expect(Object.fromEntries(hyna.map((m) => [m.symbol, m.assetClass]))).toEqual({ BTC: "crypto", "1000PEPE": "crypto", GOLD: "commodity" });
  });

  it("classifies unknown tickers by heuristics", () => {
    expect(classifyHip3("WHEAT")).toBe("commodity");
    expect(classifyHip3("US500")).toBe("index");
    expect(classifyHip3("SOMENEWCO")).toBe("equity");
    expect(classifyHip3("HYPE", new Set(["HYPE"]))).toBe("crypto");
    expect(splitCoin("xyz:NVDA")).toEqual({ dex: "xyz", symbol: "NVDA" });
  });
});

describe("spot", () => {
  const spot = parseSpotMarkets(fixture("hl_spot.json"));
  it("names pairs from token indices and resolves symbols to coins", () => {
    expect(spot.map((s) => [s.coin, s.pair])).toEqual([
      ["PURR/USDC", "PURR/USDC"],
      ["@107", "HYPE/USDC"],
    ]);
    expect(resolveSpotCoin(spot, "HYPE/USDC")?.coin).toBe("@107");
    expect(resolveSpotCoin(spot, "hype")?.coin).toBe("@107");
    expect(resolveSpotCoin(spot, "@107")?.pair).toBe("HYPE/USDC");
    expect(resolveSpotCoin(spot, "NOPE/USDC")).toBeNull();
  });
});

describe("HIP-4 outcomes", () => {
  const meta = fixture("hl_outcomeMeta.json");
  const markets = parseOutcomes(meta, outcomeCtxMap(fixture("hl_spot.json")), fixture("hl_allMids.json"));
  const byId = new Map(markets.map((m) => [m.id, m]));

  it("encodes coins as #(10*id+side)", () => {
    expect(outcomeCoin(11382, 0)).toBe("#113820");
    expect(outcomeCoin(11382, 1)).toBe("#113821");
    expect(parseKv("perp:xyz:CL|threshold:91.196")).toEqual({ perp: "xyz:CL", threshold: "91.196" });
  });

  it("renders templated questions", () => {
    expect(byId.get(11255)!.question).toBe("CL above 91.196 at 2026-10-12 21:00 UTC?");
    expect(byId.get(11382)!.question).toBe("BTC above 83,988 at 2026-10-13 06:00 UTC?");
    expect(byId.get(3601)!.question).toBe("Federal Reserve's Open Market Committee October 2026 decision: cut?");
    expect(byId.get(11389)!.question).toBe("BTC price at 2026-10-13 06:00 UTC: 82,308–85,667?");
    expect(byId.get(10824)!.question).toBe("RB Leipzig vs PSV Eindhoven (UEFA Champions League): RB Leipzig wins?");
    expect(byId.get(8565)!.sides.map((s) => s.name)).toEqual(["LAR", "BUF"]);
  });

  it("attaches mids, 24h change and volume from allMids + spot ctxs", () => {
    const m = byId.get(3600)!;
    expect(m.sides[0].coin).toBe("#36000");
    expect(m.sides[0].mid).toBe(0.834705);
    expect(m.sides[0].change24hPp).toBeCloseTo((0.834705 - 0.84217) * 100, 9);
    expect(m.volume24hUsd).toBeCloseTo(100374.7701 + 19302.2299, 4);
    expect(m.expiresAt).toBe(Date.UTC(2026, 9, 28, 18, 0));
    expect(m.groupTitle).toContain("October 2026");
  });

  it("resolves instrument refs", () => {
    expect(resolveOutcomeRef("3600", "YES", meta)).toEqual({ id: 3600, side: 0 });
    expect(resolveOutcomeRef("3600", "no", meta)).toEqual({ id: 3600, side: 1 });
    expect(resolveOutcomeRef("#113821", "whatever", meta)).toEqual({ id: 11382, side: 1 });
    expect(resolveOutcomeRef("8565", "BUF", meta)).toEqual({ id: 8565, side: 1 });
    expect(resolveOutcomeRef("fomc-dec-2026-cut", "YES", meta)).toBeNull();
  });
});
