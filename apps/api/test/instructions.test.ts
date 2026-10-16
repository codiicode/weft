import { describe, expect, it } from "vitest";
import type { Position } from "@weft/engine";
import { parseInstruction } from "../src/lib/instructions.ts";

const pos = (id: string, key: string) => ({ id, instrumentKey: key }) as Position;
const RAY = pos("p1", "sol:token:4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R");
const BTC = pos("p2", "hl:perp:BTC");

describe("instructions for a running strategy", () => {
  it("sells now: all, half, a percentage, or one named market", () => {
    expect(parseInstruction("sell everything", [BTC])).toEqual([{ kind: "sell", positionId: "p2", fraction: 1, label: "Sell all of BTC at market, now" }]);
    expect(parseInstruction("sell half", [BTC])![0]).toMatchObject({ fraction: 0.5 });
    expect(parseInstruction("close 25%", [BTC])![0]).toMatchObject({ fraction: 0.25 });
    expect(parseInstruction("sell btc", [BTC, RAY])!.map((s) => (s as { positionId: string }).positionId)).toEqual(["p2"]);
    expect(() => parseInstruction("sell all", [])).toThrow(/nothing open/);
  });

  it("sets and removes stops, targets and trailing stops", () => {
    expect(parseInstruction("set a stop at 15%", [BTC])![0]).toMatchObject({ kind: "exits", patch: { stopLoss: { positionPct: 15 } } });
    expect(parseInstruction("stop loss at $80000", [BTC])![0]).toMatchObject({ patch: { stopLoss: { price: 80000 } } });
    expect(parseInstruction("take profit at 30%", [BTC])![0]).toMatchObject({ patch: { takeProfit: { positionPct: 30 } } });
    expect(parseInstruction("tp 2x", [BTC])![0]).toMatchObject({ patch: { takeProfit: { positionPct: 100 } } });
    expect(parseInstruction("trailing stop 10%", [BTC])![0]).toMatchObject({ patch: { trailingStopPct: 10 } });
    expect(parseInstruction("remove the stop", [BTC])![0]).toMatchObject({ patch: { stopLoss: null } });
    expect(parseInstruction("stop at 15% and take profit at 40%", [BTC])![0]).toMatchObject({ patch: { stopLoss: { positionPct: 15 }, takeProfit: { positionPct: 40 } } });
  });

  it("does both when asked for both, and never mistakes a stop's % for a sell size", () => {
    const steps = parseInstruction("set a stop at 10% and sell half", [BTC])!;
    expect(steps.map((x) => x.kind)).toEqual(["sell", "exits"]);
    expect(steps[0]).toMatchObject({ fraction: 0.5 });
    expect(steps[1]).toMatchObject({ patch: { stopLoss: { positionPct: 10 } } });
  });

  it("leaves everything else to Claude", () => {
    expect(parseInstruction("also buy more if it dips 10%", [BTC])).toBeNull();
    expect(parseInstruction("sell when funding flips negative", [BTC])).toBeNull();
  });
});
