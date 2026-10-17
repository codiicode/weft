import { describe, expect, it } from "vitest";
import { pickTraders } from "../src/lib/traders.ts";

const row = (address: string, value: number, pnl: number, roi: number, vlm: number, name: string | null = null) => ({
  ethAddress: address,
  accountValue: String(value),
  displayName: name,
  windowPerformances: [
    ["week", { pnl: String(pnl / 4), roi: "0", vlm: "0" }],
    ["month", { pnl: String(pnl), roi: String(roi), vlm: String(vlm) }],
    ["allTime", { pnl: String(pnl * 3), roi: "0", vlm: "0" }],
  ] as [string, { pnl: string; roi: string; vlm: string }][],
});

describe("top traders", () => {
  it("keeps profitable, believable, active accounts and sorts them by profit", () => {
    const t = pickTraders([
      row("0xa", 1_000_000, 200_000, 0.2, 5_000_000, "x.com/a"),
      row("0xb", 2_000_000, 900_000, 0.45, 9_000_000),
      row("0xc", 50_000, 40_000, 0.8, 1_000_000), // too small
      row("0xd", 1_000_000, 500_000, 3_000, 9_000_000), // deposit artefact
      row("0xe", 1_000_000, -10_000, -0.01, 9_000_000), // lost money
      row("0xf", 1_000_000, 100_000, 0.1, 10_000), // not trading
    ]);
    expect(t.map((x) => x.address)).toEqual(["0xb", "0xa"]);
    expect(t[1]).toMatchObject({ name: "x.com/a", roi30dPct: 20, pnl7dUsd: 50_000, pnlAllTimeUsd: 600_000 });
  });
});
