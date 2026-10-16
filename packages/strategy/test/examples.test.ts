import { describe, expect, it } from "vitest";
import { z } from "zod";
import { crowdedFade, ethBreakout, examples } from "../src/examples/index.ts";
import { Strategy, semanticIssues, toGraph, validateStrategy } from "../src/index.ts";

describe("examples", () => {
  it.each(examples.map((s) => [s.id, s] as const))("%s validates with no errors", (_, s) => {
    const r = validateStrategy(s);
    expect(r.ok, r.ok ? "" : JSON.stringify(r.errors, null, 2)).toBe(true);
  });

  it("cover every product: perps, stocks, options, predictions, Solana tokens", () => {
    const kinds = new Set<string>();
    for (const s of examples)
      for (const a of s.actions) {
        if (a.type === "open") kinds.add(a.instrument.kind === "token" && a.instrument.assetClass === "equity" ? "stock-token" : a.instrument.kind);
        if (a.type === "open" && a.instrument.kind === "perp" && a.instrument.assetClass !== "crypto") kinds.add("stock-or-commodity-perp");
        if (a.type === "options") kinds.add("option");
      }
    expect([...kinds].sort()).toEqual(["option", "outcome", "perp", "stock-or-commodity-perp", "stock-token", "token"].sort());
  });

  it("round-trips through JSON", () => {
    for (const s of examples) expect(Strategy.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("projects to a graph with edges derived from refs and `on`", () => {
    const g = toGraph(ethBreakout);
    expect(g.nodes.filter((n) => n.kind === "signal")).toHaveLength(2);
    expect(g.edges).toContainEqual(["eth_px", "breakout"]);
    expect(g.edges).toContainEqual(["eth_funding", "breakout"]);
    expect(g.edges).toContainEqual(["breakout", "long_eth"]);
    expect(g.nodes.find((n) => n.id === "breakout")).toMatchObject({ kind: "trigger", logic: "AND", lines: ["eth_px.price > 2600", "eth_funding.rate_1h_pct < 0.01"] });
    expect(toGraph(crowdedFade).nodes.find((n) => n.id === "exit_sol")?.kind).toBe("exit");
  });

  it("exports a JSON Schema for structured LLM output", () => {
    const schema = z.toJSONSchema(Strategy, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(JSON.stringify(schema)).toContain("token_onchain");
  });

  it("warnings are informative, not noise", () => {
    const all = examples.flatMap((s) => semanticIssues(s).map((i) => `${s.id}: ${i.message}`));
    expect(all.every((m) => m.length > 10)).toBe(true);
  });
});
