import { describe, expect, it } from "vitest";
import { crowdedFade, ethCallSpread } from "@weft/strategy/examples";
import { replay, type ReplayFrame } from "../src/index.ts";
import { HOUR, MIN, T0, ZERO_SLIPPAGE } from "./fakes.ts";

const snap = (now: number, fields: Record<string, number | boolean | null>) => ({ asOf: now, fields });

describe("replay", () => {
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
    const LONG = "derive:option:ETH-2026-12-25-2800-C";
    const SHORT = "derive:option:ETH-2026-12-25-3200-C";
    const f = (h: number, buy: number, sell: number): ReplayFrame => {
      const now = T0 + h * HOUR;
      return {
        now,
        signals: {
          event: snap(now, { hours_until: 48 - h, hours_since: null }),
          eth: snap(now, { price: 2500, change_24h_pct: 2, change_5m_pct: 0, change_1h_pct: 0, volume_24h_usd: 1e9 }),
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
    expect(entries[0]!.feeUsd).toBeCloseTo(units * 2800 * 3e-4, 8); // 3 bps of strike notional
    const exits = r.fills.filter((x) => x.reason === "take_profit");
    expect(exits).toHaveLength(2); // +125% on a 120 debit at frame 2 (frame 1 was +58%)
    const gross = exits.reduce((s, x) => s + x.realizedPnlUsd! + x.feeUsd, 0);
    expect(gross).toBeCloseTo(units * 150, 6);
    expect(r.snapshot.positions).toHaveLength(0);
  });
});
