import { describe, expect, it } from "vitest";
import { validateStrategy } from "@weft/strategy";
import { asPlainOrder, isPlainOrder } from "../src/ai/template.ts";

describe("plain orders", () => {
  it("tells orders from theses", () => {
    expect(isPlainOrder("Buy 0.05 sol of RAY now")).toBe(true);
    expect(isPlainOrder("long ETH 2x")).toBe(true);
    expect(isPlainOrder("Buy RAY with a 10% stop")).toBe(false);
    expect(isPlainOrder("Buy $BONK if it dips 10%")).toBe(false);
    expect(isPlainOrder("Short SOL when funding gets crowded")).toBe(false);
  });

  it("strips exits and extra rules: buy once, then hold", () => {
    const inst = { kind: "token", chain: "solana", mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", quote: "SOL", route: "auto", assetClass: "crypto" };
    const s = asPlainOrder({
      schemaVersion: 1,
      id: "ray",
      name: "RAY",
      thesis: "Buy 0.05 sol of RAY now",
      signals: [{ id: "px", kind: "price", params: { instrument: inst } }, { id: "social", kind: "social", params: { cashtags: ["RAY"] } }],
      triggers: [{ id: "entry", when: { op: "gt", left: { ref: "social.sentiment" }, right: { value: 0.3 } } }],
      actions: [
        { id: "buy", type: "open", on: ["entry"], instrument: inst, side: "long", size: { unit: "native", value: 0.05 }, exits: { stopLoss: { pct: 20 }, takeProfit: { pct: 40 } } },
        { id: "exit", type: "close", on: ["entry"], target: "all" },
      ],
    } as never);
    const v = validateStrategy(s);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.strategy.signals.map((x) => x.id)).toEqual(["px"]);
    expect(v.strategy.triggers).toHaveLength(1);
    expect(v.strategy.triggers[0]!.maxFires).toBe(1);
    expect(v.strategy.actions).toHaveLength(1);
    const a = v.strategy.actions[0]!;
    expect(a.type === "open" && a.exits.stopLoss).toBeFalsy();
  });
});
