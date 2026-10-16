import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { Catalog } from "@weft/venues";
import { examples } from "@weft/strategy/examples";
import { generateStrategy, GenerationError } from "../src/ai/generate.ts";

const catalog: Catalog = {
  async list(product, q) {
    return [
      {
        product,
        instrument: { kind: "perp", venue: "hyperliquid", symbol: "BTC", assetClass: "crypto" },
        instrumentKey: "hl:perp:BTC",
        label: `BTC (${q?.search})`,
        price: 100,
        venue: "hyperliquid",
      },
    ];
  },
};

type Turn = { content: Anthropic.Beta.BetaContentBlock[]; stop_reason: string };
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as unknown as Anthropic.Beta.BetaContentBlock;

/** Scripted fake of client.beta.messages.create, recording every request. */
function fakeClient(turns: Turn[]) {
  const requests: { messages: Anthropic.Beta.BetaMessageParam[]; [k: string]: unknown }[] = [];
  const client = {
    beta: {
      messages: {
        create: async (req: (typeof requests)[number]) => {
          requests.push(structuredClone(req));
          const t = turns.shift();
          if (!t) throw new Error("no more scripted turns");
          return { content: t.content, stop_reason: t.stop_reason, stop_details: null };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

describe("generateStrategy with Claude", () => {
  it("searches, gets validation errors back, fixes them, and returns the accepted strategy", async () => {
    const good = examples.find((s) => s.id === "crowded-fade")!;
    const bad = { ...good, triggers: [{ ...good.triggers[0]!, when: { op: "gt", left: { ref: "sol_funding.nope" }, right: { value: 1 } } }, good.triggers[1]] };
    const { client, requests } = fakeClient([
      { stop_reason: "tool_use", content: [toolUse("t1", "search_markets", { product: "perps", query: "SOL" })] },
      { stop_reason: "tool_use", content: [toolUse("t2", "submit_strategy", { strategy: bad, rationale: "v1" })] },
      { stop_reason: "tool_use", content: [toolUse("t3", "submit_strategy", { strategy: good, rationale: "Fade crowded longs." })] },
    ]);
    const progress: string[] = [];
    const r = await generateStrategy("SOL longs are crowded", { catalog, client, onProgress: (p) => progress.push(p.type) });

    expect(r.source).toBe("claude");
    expect(r.strategy.id).toBe("crowded-fade");
    expect(r.rationale).toBe("Fade crowded longs.");
    expect(progress).toEqual(expect.arrayContaining(["search", "submit", "invalid"]));

    // Request shape: model, fallback, cached system prompt, tools
    const first = requests[0]!;
    expect(first.model).toBe("claude-opus-5-5");
    expect(first.fallbacks).toBe("default");
    expect(first.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect((first.system as { cache_control?: unknown }[])[0]!.cache_control).toEqual({ type: "ephemeral" });

    // Append-only history: search result fed back, then the validation error
    const second = requests[1]!.messages;
    const searchResult = (second.at(-1)!.content as { type: string; tool_use_id: string; content: string }[])[0]!;
    expect(searchResult.tool_use_id).toBe("t1");
    expect(JSON.parse(searchResult.content)[0].label).toBe("BTC (SOL)");
    const third = requests[2]!.messages;
    const err = (third.at(-1)!.content as { is_error?: boolean; content: string }[])[0]!;
    expect(err.is_error).toBe(true);
    expect(err.content).toMatch(/no field "nope"/);
    // earlier turns are untouched
    expect(third.slice(0, second.length)).toEqual(second);
  });

  it("nudges the model when it answers without calling a tool", async () => {
    const { client, requests } = fakeClient([
      { stop_reason: "end_turn", content: [{ type: "text", text: "Here is my plan…", citations: null } as unknown as Anthropic.Beta.BetaContentBlock] },
      { stop_reason: "tool_use", content: [toolUse("t1", "submit_strategy", { strategy: examples[0], rationale: "ok" })] },
    ]);
    const r = await generateStrategy("ETH breakout", { catalog, client });
    expect(r.source).toBe("claude");
    expect(requests[1]!.messages.at(-1)).toEqual({ role: "user", content: "Please call submit_strategy with the complete strategy." });
  });

  it("surfaces refusals as GenerationError", async () => {
    const { client } = fakeClient([{ stop_reason: "refusal", content: [] }]);
    await expect(generateStrategy("x", { catalog, client })).rejects.toBeInstanceOf(GenerationError);
  });
});

describe("refine by rules (offline)", async () => {
  const { refineByRules } = await import("../src/ai/refine.ts");
  const { pumpMomentum, crowdedFade } = await import("@weft/strategy/examples");
  it("changes stop, target, size and leverage from plain words", () => {
    const r = refineByRules(pumpMomentum, "stop at 8% and take profit at 25%, use 2 SOL");
    const buy = r.strategy.actions.find((a) => a.type === "open")!;
    expect(buy.type === "open" && buy.exits.stopLoss).toEqual({ positionPct: 8 });
    expect(buy.type === "open" && buy.exits.takeProfit).toEqual({ positionPct: 25 });
    expect(buy.type === "open" && buy.size).toEqual({ unit: "native", value: 2 });
    expect(r.rationale).toMatch(/stop-loss set to 8%/);
    const lev = refineByRules(crowdedFade, "go 3x on the perps");
    expect(lev.strategy.actions.filter((a) => a.type === "open" && a.instrument.kind === "perp").every((a) => a.type === "open" && a.leverage === 3)).toBe(true);
  });
  it("tightens stops without a number, and refuses what it can't do", () => {
    const before = pumpMomentum.actions.find((a) => a.type === "open")!;
    const r = refineByRules(pumpMomentum, "make the stop tighter");
    const after = r.strategy.actions.find((a) => a.type === "open")!;
    const pct = (a: typeof before) => (a.type === "open" && a.exits.stopLoss && "pct" in a.exits.stopLoss ? a.exits.stopLoss.pct : 0);
    expect(pct(after)).toBeCloseTo(pct(before) / 2);
    expect(() => refineByRules(pumpMomentum, "also watch what Elon posts")).toThrow(/needs Claude/);
  });
});
