import { describe, expect, it } from "vitest";
import { crowdedFade, elNino, ethCallSpread } from "@weft/strategy/examples";
import { replay, type ReplayFrame } from "../src/index.ts";
import { HOUR, MIN, T0, ZERO_SLIPPAGE } from "./fakes.ts";

const snap = (now: number, fields: Record<string, number | boolean | null>) => ({ asOf: now, fields });

describe("replay", () => {
  it("El Niño: buys the mispriced outcome, adds grains after forMinutes, exits on TP prob and close-all", async () => {
    const YES = "hl:outcome:elnino-djf-2026:YES";
    const WHEAT = "hl:perp:xyz:WHEAT";
    const SUGAR = "hl:perp:xyz:SUGAR";
    const frame = (h: number, o: { nino?: number; odds?: number; wheat?: number }): ReplayFrame => {
      const now = T0 + h * HOUR;
      return {
        now,
        signals: {
          nino: snap(now, { value: o.nino ?? 1.8, change_7d: 0.2 }),
          nino_odds: snap(now, { prob: o.odds ?? 0.55, change_24h_pp: 0, volume_24h_usd: 1e6 }),
          nino_model: snap(now, { prob: 0.8, confidence: 0.7 }),
          wheat: snap(now, { price: o.wheat ?? 6, change_24h_pct: 1.5, change_5m_pct: 0, change_1h_pct: 0, volume_24h_usd: 1e6 }),
          desks: snap(now, { sentiment: 0.5, mentions_1h: 40, mentions_change_1h_pct: 10, unique_authors_1h: 20 }),
          usdbrl: snap(now, { value: 5.4, change_1d: 0, change_5d: 0 }),
        },
        quotes: { [YES]: o.odds ?? 0.55, [WHEAT]: o.wheat ?? 6, [SUGAR]: 0.2 },
      };
    };
    const timeline = [
      frame(0, {}),
      frame(1, {}), // grains_bid has held 60 min
      frame(2, { odds: 0.7, wheat: 6.3 }),
      frame(3, { odds: 0.93, wheat: 6.4 }), // YES take-profit at prob 0.92
      frame(4, { nino: 0.4, odds: 0.93, wheat: 6.5 }), // ENSO fades: close all
      frame(5, { nino: 0.4, odds: 0.93, wheat: 6.5 }),
    ];
    const r = await replay(elNino, timeline, { allocationUsd: 10_000 });

    const byReason = (reason: string) => r.fills.filter((f) => f.reason === reason).map((f) => f.instrumentKey);
    expect(byReason("entry")).toEqual(expect.arrayContaining([YES, WHEAT]));
    expect(byReason("take_profit")).toEqual([YES]);
    expect(byReason("close_action")).toEqual(expect.arrayContaining([WHEAT]));
    expect(r.snapshot.positions).toHaveLength(0);
    expect(r.snapshot.realizedPnlUsd).toBeGreaterThan(0);
    expect(r.snapshot.signalValues["nino.value"]).toBe(0.4);
    expect(r.snapshot.lastTickAt).toBe(T0 + 5 * HOUR);
    expect(r.snapshot.equityCurve.length).toBeGreaterThanOrEqual(timeline.length);
    expect(r.events.some((e) => e.type === "trigger_fired" && e.data?.triggerId === "enso_fades")).toBe(true);
  });

  it("crowded fade: shorts after the condition holds 60 min, takes profit, re-enters after close", async () => {
    const SOL = "hl:perp:SOL";
    const frames: ReplayFrame[] = [];
    const add = (min: number, rate: number, z: number, px: number) => {
      const now = T0 + min * MIN;
      frames.push({ now, signals: { sol_funding: snap(now, { rate_8h_pct: rate, rate_1h_pct: rate / 8, apr_pct: 0, open_interest_usd: 1e9, oi_zscore_30d: z }) }, quotes: { [SOL]: px } });
    };
    add(0, 0.15, 2.5, 150);
    add(30, 0.15, 2.5, 150);
    add(60, 0.15, 2.5, 150); // met + fired: short
    add(90, 0.12, 2.2, 140);
    add(120, 0.11, 2.1, 136); // −9.3%: take profit
    add(150, 0.01, 1.0, 137); // normalised: close (nothing open)
    // A day later it gets crowded again: cooldown elapsed, reentry after_close.
    add(1_500, 0.2, 3.0, 160);
    add(1_530, 0.2, 3.0, 160);
    add(1_560, 0.2, 3.0, 160);

    const r = await replay(crowdedFade, frames, { allocationUsd: 10_000, slippageBps: ZERO_SLIPPAGE });
    expect(r.fills.map((f) => [f.reason, f.side])).toEqual([
      ["entry", "sell"],
      ["take_profit", "buy"],
      ["entry", "sell"],
    ]);
    const [entry, tp] = r.fills;
    expect(entry!.price).toBe(150);
    expect(entry!.qty).toBeCloseTo(1_600 / 150, 6); // 8% of 10k × 2×
    expect(tp!.realizedPnlUsd).toBeCloseTo((1_600 / 150) * 14 - tp!.feeUsd, 6);
    expect(r.snapshot.positions).toHaveLength(1);
    expect(r.snapshot.positions[0]).toMatchObject({ side: "short", entryPrice: 160, leverage: 2 });
  });

  it("options: a call spread opens as grouped legs and exits on premium", async () => {
    const LONG = "derive:option:ETH-2026-12-25-4800-C";
    const SHORT = "derive:option:ETH-2026-12-25-5400-C";
    const f = (h: number, buy: number, sell: number): ReplayFrame => {
      const now = T0 + h * HOUR;
      return {
        now,
        signals: {
          upgrade: snap(now, { hours_until: 48 - h, hours_since: null }),
          eth: snap(now, { price: 4000, change_24h_pct: 2, change_5m_pct: 0, change_1h_pct: 0, volume_24h_usd: 1e9 }),
        },
        quotes: { [LONG]: buy, [SHORT]: sell },
      };
    };
    const r = await replay(ethCallSpread, [f(0, 200, 80), f(1, 300, 110), f(2, 400, 130)], { slippageBps: ZERO_SLIPPAGE });
    const units = 500 / 120;
    const entries = r.fills.filter((x) => x.reason === "entry");
    expect(entries.map((x) => [x.instrumentKey, x.side])).toEqual([
      [LONG, "buy"],
      [SHORT, "sell"],
    ]);
    expect(entries[0]!.qty).toBeCloseTo(units, 8);
    expect(entries[0]!.feeUsd).toBeCloseTo(units * 4800 * 3e-4, 8); // 3 bps of strike notional
    const exits = r.fills.filter((x) => x.reason === "take_profit");
    expect(exits).toHaveLength(2); // +125% on a 120 debit at frame 2 (frame 1 was +58%)
    const gross = exits.reduce((s, x) => s + x.realizedPnlUsd! + x.feeUsd, 0);
    expect(gross).toBeCloseTo(units * 150, 6);
    expect(r.snapshot.positions).toHaveLength(0);
  });
});
