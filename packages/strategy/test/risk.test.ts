import { describe, expect, it } from "vitest";
import { checkIntents, effectiveRisk, RiskPolicy, type Intent, type RiskContext, type TokenFacts } from "../src/index.ts";
import { PUMP_MINT } from "../src/examples/index.ts";

const risk = RiskPolicy.parse({});
const ctx = (over: Partial<RiskContext> = {}): RiskContext => ({ risk, equityUsd: 10_000, exposureUsd: 0, dailyPnlPct: 0, ...over });
/** Token checks block only when the user asked for them. */
const strict = (over: Partial<RiskContext> = {}) => ctx({ risk: { ...risk, token: { ...risk.token, enforce: true } }, ...over });

const perp = (usd: number, leverage = 1, key = "a"): Intent => ({
  type: "open", key, strategyId: "s", actionId: key, triggerId: "t",
  instrument: { kind: "perp", venue: "hyperliquid", symbol: "BTC", assetClass: "crypto" }, instrumentKey: "hl:perp:BTC",
  side: "long", size: { usd }, leverage, order: { type: "market", maxSlippageBps: 100 }, exits: { stopLoss: { pct: 5 } },
});
const token = (sol: number): Intent => ({
  type: "open", key: "tok", strategyId: "s", actionId: "buy", triggerId: "t",
  instrument: { kind: "token", chain: "solana", mint: PUMP_MINT, quote: "SOL", route: "auto", assetClass: "crypto" }, instrumentKey: `sol:token:${PUMP_MINT}`,
  side: "long", size: { native: sol }, leverage: 1, order: { type: "market", maxSlippageBps: 100 }, exits: { stopLoss: { pct: 20 } },
});
const close: Intent = { type: "close", key: "c", strategyId: "s", actionId: "x", triggerId: "t", target: "all", fraction: 1 };
const healthy: TokenFacts = { liquidity_usd: 250_000, top10_holders_pct: 18, mint_authority_revoked: true, freeze_authority_revoked: true, age_minutes: 600, dev_sold_pct: 0, price_impact_bps: 40 };

describe("checkIntents", () => {
  it("approves a sized, in-limits order", () => {
    expect(checkIntents([perp(500, 2)], ctx()).approved).toHaveLength(1);
  });

  it("enforces max position and cumulative exposure across intents", () => {
    const r = checkIntents([perp(1_200)], ctx());
    expect(r.rejected[0]!.reasons[0]).toMatch(/exceeds max position/);
    const r2 = checkIntents([perp(1_000, 3, "a"), perp(1_000, 3, "b")], ctx()); // 3k + 3k notional vs 5k max
    expect(r2.approved.map((i) => i.key)).toEqual(["a"]);
    expect(r2.rejected[0]!.reasons[0]).toMatch(/exposure would be/);
  });

  it("daily loss and kill switch block opens but never exits", () => {
    for (const c of [ctx({ dailyPnlPct: -11 }), ctx({ halted: true })]) {
      const r = checkIntents([close, perp(100)], c);
      expect(r.approved.map((i) => i.type)).toEqual(["close"]);
      expect(r.rejected).toHaveLength(1);
    }
  });

  it("fails closed for native sizes without a price, and token buys without safety data", () => {
    const r = checkIntents([token(0.5)], strict());
    expect(r.rejected[0]!.reasons).toEqual(["cannot size-check: no USD price for a native-sized order", "no on-chain safety data for this token"]);
  });

  it("token gates: authorities, holders, liquidity, dev selling, price impact", () => {
    const ok = checkIntents([token(0.5)], ctx({ usdPrices: { SOL: 180 }, tokenFacts: { [PUMP_MINT]: healthy } }));
    expect(ok.approved).toHaveLength(1);
    const facts = { [PUMP_MINT]: { ...healthy, mint_authority_revoked: false, top10_holders_pct: 61, liquidity_usd: 9_000, dev_sold_pct: 80, price_impact_bps: 900 } };
    const bad = checkIntents([token(0.5)], strict({ usdPrices: { SOL: 180 }, tokenFacts: facts }));
    expect(bad.rejected[0]!.reasons).toHaveLength(5);
    // By default the user's own buy goes ahead and the failed checks are a heads-up.
    const asked = checkIntents([token(0.5)], ctx({ usdPrices: { SOL: 180 }, tokenFacts: facts }));
    expect(asked.approved).toHaveLength(1);
    expect(asked.warnings[0]!.reasons).toHaveLength(5);
    expect(asked.warnings[0]!.reasons).toContain("top-10 holders own 61.0% (max 35%)");
  });
});

describe("tokenized stocks", () => {
  it("skip issuer-controlled rug gates but keep liquidity and impact gates", () => {
    const x = token(0.5);
    if (x.type !== "open" || x.instrument.kind !== "token") throw new Error();
    x.instrument = { ...x.instrument, assetClass: "equity" };
    const facts = { ...healthy, mint_authority_revoked: false, freeze_authority_revoked: false, top10_holders_pct: 73 };
    expect(checkIntents([x], strict({ usdPrices: { SOL: 180 }, tokenFacts: { [PUMP_MINT]: facts } })).approved).toHaveLength(1);
    const thin = checkIntents([x], strict({ usdPrices: { SOL: 180 }, tokenFacts: { [PUMP_MINT]: { ...facts, liquidity_usd: 1_000 } } }));
    expect(thin.rejected[0]!.reasons[0]).toMatch(/liquidity/);
  });
});

describe("effectiveRisk", () => {
  it("the stricter of strategy and user caps wins, absent caps change nothing", () => {
    const strat = RiskPolicy.parse({ maxLeverage: 10, maxPositionPct: 20 });
    expect(effectiveRisk(strat, {})).toEqual(strat);
    const eff = effectiveRisk(strat, { maxLeverage: 3, maxPositionPct: 50, token: { minLiquidityUsd: 200_000 } });
    expect(eff.maxLeverage).toBe(3);
    expect(eff.maxPositionPct).toBe(20);
    expect(eff.token.minLiquidityUsd).toBe(200_000);
  });
});

describe("risk caps fit the strategy's own orders", () => {
  it("raises the exposure cap to fit the strategy's largest order", async () => {
    const { validateStrategy } = await import("../src/validate.ts");
    const r = validateStrategy({
      schemaVersion: 1, id: "eth-20x", name: "ETH 20× Long", thesis: "long eth 20x with 5% of the account",
      signals: [{ id: "px", kind: "price", params: { instrument: { kind: "perp", venue: "hyperliquid", symbol: "ETH" } } }],
      triggers: [{ id: "now", when: { op: "gt", left: { ref: "px.price" }, right: { value: 0 } }, maxFires: 1 }],
      risk: { maxLeverage: 20 },
      actions: [{ id: "go", type: "open", on: ["now"], instrument: { kind: "perp", venue: "hyperliquid", symbol: "ETH" }, side: "long", size: { unit: "pct_equity", value: 5 }, leverage: 20 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.strategy.risk.maxTotalExposurePct).toBe(100);
    expect(r.strategy.risk.maxPositionPct).toBe(10); // untouched: checked as an error instead
  });
});
