import { describe, expect, it } from "vitest";
import { encodeAbiParameters, hashStruct, keccak256, toBytes, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { CloseIntent, Instrument, OpenIntent } from "@weft/strategy";
import { HyperliquidExecutor, levelToPrice } from "../src/hyperliquid/executor.ts";
import { buildApproveAgent, feeTenthsBpsToPercent } from "../src/hyperliquid/approvals.ts";
import { APPROVE_AGENT_TYPES, recoverL1Signer, recoverUserSigner, signerFromPrivateKey, signUserSignedAction } from "../src/hyperliquid/signing.ts";
import { AssetResolver, builderPerpAssetId, outcomeAssetId, type HlInfo, type PerpDexs, type PerpMeta } from "../src/hyperliquid/info.ts";
import { isValidPrice, roundPrice, roundSize, slippagePrice } from "../src/hyperliquid/ticks.ts";
import { cloidFromKey } from "../src/hyperliquid/wire.ts";
import type { ExchangeRequest } from "../src/hyperliquid/exchange.ts";

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const USER = "0x00000000000000000000000000000000000000aa" as Hex;
const BUILDER = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdef0001" as Hex;

function fixtureInfo(over: Partial<HlInfo> = {}): HlInfo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async meta(dex = ""): Promise<PerpMeta> {
      calls.push(`meta:${dex}`);
      if (dex === "xyz")
        return { universe: [{ name: "xyz:XYZ100", szDecimals: 4 }, { name: "xyz:NVDA", szDecimals: 3, maxLeverage: 20 }, { name: "xyz:HOOD", szDecimals: 3, maxLeverage: 10, onlyIsolated: true }] };
      if (dex === "abc") return { universe: [{ name: "abc:GOLD", szDecimals: 2 }] };
      return {
        universe: [
          { name: "BTC", szDecimals: 5, maxLeverage: 40 },
          { name: "ETH", szDecimals: 4, maxLeverage: 25 },
          { name: "MATIC", szDecimals: 1, isDelisted: true },
        ],
      };
    },
    async spotMeta() {
      return {
        universe: [
          { tokens: [1, 0], name: "PURR/USDC", index: 0 },
          { tokens: [150, 0], name: "@107", index: 107 },
        ],
        tokens: [
          { name: "USDC", szDecimals: 8, index: 0 },
          { name: "PURR", szDecimals: 0, index: 1 },
          { name: "HYPE", szDecimals: 2, index: 150 },
        ],
      };
    },
    async perpDexs(): Promise<PerpDexs> {
      return [null, { name: "xyz" }, { name: "abc" }];
    },
    async allMids(dex = ""): Promise<Record<string, string>> {
      if (dex === "xyz") return { "xyz:NVDA": "180.5", "xyz:HOOD": "120" };
      return { BTC: "100000", ETH: "2500.5", "@107": "40.123", "PURR/USDC": "0.12", "#100": "0.62" };
    },
    async outcomeMeta() {
      return {
        outcomes: [
          { outcome: 10, name: "x", sideSpecs: [{ name: "template:Yes" }, { name: "template:No" }] },
          { outcome: 11454, name: "game", description: "competition:NFL|participantA:New England Patriots|shortNameA:NE|shortNameB:NYJ", sideSpecs: [{ name: "template:{shortNameA}" }, { name: "template:{shortNameB}" }] },
        ],
      };
    },
    async clearinghouseState() {
      return { assetPositions: [{ position: { coin: "ETH", szi: "-0.5" } }] };
    },
    async spotClearinghouseState() {
      return { balances: [{ coin: "HYPE", token: 150, total: "3.456", hold: "0.4" }] };
    },
    async orderStatus() {
      return { status: "unknownOid" };
    },
    async maxBuilderFee() {
      return 50;
    },
    ...over,
  };
}

function fakeFetch(response: unknown) {
  const posted: { url: string; body: ExchangeRequest }[] = [];
  const fetch = async (url: string, init: { body: string }) => {
    posted.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify(response) };
  };
  return { fetch, posted };
}

const agentKey = generatePrivateKey();
const agent = privateKeyToAccount(agentKey);

function makeExec(opts: Partial<ConstructorParameters<typeof HyperliquidExecutor>[0]> = {}) {
  return new HyperliquidExecutor({
    agentPrivateKey: agentKey,
    userAddress: USER,
    isMainnet: false,
    info: fixtureInfo(),
    builder: { address: BUILDER },
    now: () => 1_700_000_000_000,
    ...opts,
  });
}

const BTC: Instrument = { kind: "perp", venue: "hyperliquid", symbol: "BTC", assetClass: "crypto" };
const ETH: Instrument = { kind: "perp", venue: "hyperliquid", symbol: "ETH", assetClass: "crypto" };
const NVDA: Instrument = { kind: "perp", venue: "hyperliquid", dex: "xyz", symbol: "NVDA", assetClass: "equity" };
const HYPE: Instrument = { kind: "spot", venue: "hyperliquid", symbol: "HYPE/USDC", assetClass: "crypto" };

/* ------------------------------------------------------------------ */
/* Tick / lot rules                                                     */
/* ------------------------------------------------------------------ */

describe("tick and lot rules (docs examples)", () => {
  it("perp prices: ≤5 significant figures and ≤ 6 − szDecimals decimals; integers always valid", () => {
    expect(isValidPrice(1234.5, "perp", 0)).toBe(true);
    expect(isValidPrice(1234.56, "perp", 0)).toBe(false);
    expect(isValidPrice(0.001234, "perp", 0)).toBe(true);
    expect(isValidPrice(0.0012345, "perp", 0)).toBe(false);
    expect(isValidPrice(0.01234, "perp", 1)).toBe(true);
    expect(isValidPrice(0.012345, "perp", 1)).toBe(false);
    expect(isValidPrice(123456, "perp", 0)).toBe(true);
    expect(isValidPrice(12345.6, "perp", 0)).toBe(false);
  });

  it("spot prices: ≤ 8 − szDecimals decimals", () => {
    expect(isValidPrice(0.0001234, "spot", 0)).toBe(true);
    expect(isValidPrice(0.0001234, "spot", 1)).toBe(true);
    expect(isValidPrice(0.0001234, "spot", 3)).toBe(false);
  });

  it("roundPrice produces valid prices; matches the SDK's slippage price", () => {
    expect(roundPrice(1234.56, "perp", 0)).toBe(1234.6);
    expect(roundPrice(12345.6, "perp", 0)).toBe(12346);
    expect(roundPrice(0.0123456, "perp", 1)).toBe(0.01235);
    expect(roundPrice(123456, "perp", 0)).toBe(123456);
    // Python: round(float(f"{1670.1 * 1.05:.5g}"), 6 - 4) == 1753.6
    expect(slippagePrice(1670.1, true, 0.05, "perp", 4)).toBe(1753.6);
    // Python: round(float(f"{100000 * 0.95:.5g}"), 1) == 95000.0
    expect(slippagePrice(100000, false, 0.05, "perp", 5)).toBe(95000);
    for (const px of [0.123456789, 98765.4321, 3.14159, 0.000987654]) {
      for (const sz of [0, 2, 4]) expect(isValidPrice(roundPrice(px, "spot", sz), "spot", sz)).toBe(true);
    }
  });

  it("roundSize rounds down to szDecimals by default", () => {
    expect(roundSize(0.123456, 4)).toBe(0.1234);
    expect(roundSize(1.005, 2, "nearest")).toBe(1.01);
    expect(roundSize(0.29999999999999993, 1)).toBe(0.3);
    expect(roundSize(5, 0)).toBe(5);
  });
});

/* ------------------------------------------------------------------ */
/* Asset ids                                                            */
/* ------------------------------------------------------------------ */

describe("asset ids", () => {
  const r = new AssetResolver(fixtureInfo());
  it("core perps = meta index", async () => {
    expect((await r.perp("BTC")).asset).toBe(0);
    expect((await r.perp("ETH")).asset).toBe(1);
    await expect(r.perp("MATIC")).rejects.toThrow(/delisted/);
  });
  it("HIP-3 builder perps = 100000 + dexIndex × 10000 + index (SDK: 110000 + i × 10000 over perpDexs[1:])", async () => {
    expect(builderPerpAssetId(1, 0)).toBe(110000); // docs example: test:ABC on testnet
    const nvda = await r.perp("NVDA", "xyz");
    expect(nvda).toMatchObject({ asset: 110001, coin: "xyz:NVDA", dex: "xyz", szDecimals: 3, tickKind: "perp" });
    expect((await r.perp("xyz:NVDA")).asset).toBe(110001);
    expect((await r.perp("GOLD", "abc")).asset).toBe(120000);
    expect((await r.perp("HOOD", "xyz")).onlyIsolated).toBe(true);
    await expect(r.perp("NVDA", "nope")).rejects.toThrow(/unknown HIP-3/);
  });
  it("spot = 10000 + spot index, by BASE/QUOTE or pair name", async () => {
    expect(await r.spot("HYPE/USDC")).toMatchObject({ asset: 10107, coin: "@107", szDecimals: 2, tickKind: "spot" });
    expect((await r.spot("@107")).asset).toBe(10107);
    expect((await r.spot("PURR/USDC")).asset).toBe(10000);
  });
  it("HIP-4 outcomes = 100_000_000 + 10 × outcome + side", async () => {
    expect(outcomeAssetId(1, 0)).toBe(100000010); // docs example
    expect(await r.outcome("10", "YES")).toMatchObject({ asset: 100000100, coin: "#100", market: "outcome" });
    expect((await r.outcome("10", "No")).asset).toBe(100000101);
    // Templated side names are filled from the description, as the catalog shows them.
    expect((await r.outcome("11454", "NYJ")).coin).toBe("#114541");
    expect((await r.outcome("11454", "ne")).coin).toBe("#114540");
  });
});

/* ------------------------------------------------------------------ */
/* Executor                                                             */
/* ------------------------------------------------------------------ */

describe("HyperliquidExecutor", () => {
  it("refuses the user's main key", () => {
    expect(() => makeExec({ userAddress: agent.address })).toThrow(/main key/);
  });

  it("dry run: market buy → exact signed IOC body with builder + cloid, nothing sent", async () => {
    const { fetch, posted } = fakeFetch({});
    const seen: ExchangeRequest[] = [];
    const ex = makeExec({ dryRun: true, fetch, onRequest: (r) => seen.push(r) });
    const placed = await ex.placeOrder({ instrument: BTC, side: "buy", size: { notionalUsd: 1000 }, type: "market", maxSlippageBps: 50, clientId: "s:a:t:1" });
    expect(posted).toHaveLength(0);
    expect(placed.dryRun).toBe(true);
    expect(seen[0]).toBe(placed.request);
    expect(placed.request).toEqual({
      action: {
        type: "order",
        orders: [{ a: 0, b: true, p: "100500", s: "0.01", r: false, t: { limit: { tif: "Ioc" } }, c: cloidFromKey("s:a:t:1") }],
        grouping: "na",
        builder: { b: BUILDER.toLowerCase(), f: 50 },
      },
      nonce: 1_700_000_000_000,
      signature: expect.any(Object),
      vaultAddress: null,
    });
    const r = placed.request;
    expect(await recoverL1Signer(r.action, r.signature, null, r.nonce, undefined, false)).toBe(agent.address);
    // signed for testnet, not mainnet
    expect(await recoverL1Signer(r.action, r.signature, null, r.nonce, undefined, true)).not.toBe(agent.address);
  });

  it("HIP-3 limit order uses the builder-dex asset id and tick rules", async () => {
    const ex = makeExec({ dryRun: true });
    const placed = await ex.placeOrder({ instrument: NVDA, side: "sell", size: { qty: 0.12345 }, type: "limit", limitPrice: 181.234567, tif: "Alo" });
    expect((placed.request.action as { orders: unknown[] }).orders[0]).toEqual({
      a: 110001,
      b: false,
      p: "181.23",
      s: "0.123",
      r: false,
      t: { limit: { tif: "Alo" } },
    });
  });

  it("entry + TP/SL children are sent atomically with grouping normalTpsl", async () => {
    const ex = makeExec({ dryRun: true });
    const placed = await ex.placeOrder({
      instrument: ETH,
      side: "buy",
      size: { qty: 1 },
      type: "market",
      clientId: "k",
      tpsl: { takeProfit: 2750, stopLoss: 2400 },
    });
    const a = placed.request.action as { grouping: string; orders: Record<string, unknown>[] };
    expect(a.grouping).toBe("normalTpsl");
    expect(a.orders).toHaveLength(3);
    expect(a.orders[1]).toEqual({ a: 1, b: false, p: "2475", s: "1", r: true, t: { trigger: { isMarket: true, triggerPx: "2750", tpsl: "tp" } }, c: cloidFromKey("k:tp") });
    expect(a.orders[2]).toEqual({ a: 1, b: false, p: "2160", s: "1", r: true, t: { trigger: { isMarket: true, triggerPx: "2400", tpsl: "sl" } }, c: cloidFromKey("k:sl") });
    await expect(ex.placeOrder({ instrument: ETH, side: "buy", size: { qty: 1 }, type: "market", tpsl: { takeProfit: 2000 } })).rejects.toThrow(/wrong side/);
  });

  it("positionTpsl attaches exits to an existing short", async () => {
    const ex = makeExec({ dryRun: true });
    const r = await ex.setPositionTpsl({ instrument: ETH, positionSide: "short", size: 0.5, takeProfit: 2300, stopLoss: 2700 });
    const a = r.request.action as { grouping: string; orders: { b: boolean; r: boolean }[] };
    expect(a.grouping).toBe("positionTpsl");
    expect(a.orders.every((o) => o.b === true && o.r === true)).toBe(true);
  });

  it("rejects orders below the $10 minimum and sizes that round to zero", async () => {
    const ex = makeExec({ dryRun: true });
    await expect(ex.placeOrder({ instrument: BTC, side: "buy", size: { notionalUsd: 5 }, type: "market" })).rejects.toThrow(/\$10 minimum/);
    await expect(ex.placeOrder({ instrument: BTC, side: "buy", size: { qty: 0.000001 }, type: "market" })).rejects.toThrow(/rounds to 0/);
  });

  it("fails closed when the user has not approved the builder fee", async () => {
    const ex = makeExec({ dryRun: true, info: fixtureInfo({ maxBuilderFee: async () => 10 }) });
    const res = await ex.execute({ clientId: "x", instrument: BTC, instrumentKey: "hl:perp:BTC", side: "buy", phase: "open", notionalUsd: 100 }, 0);
    expect(res).toMatchObject({ status: "rejected", reason: expect.stringMatching(/buildApproveBuilderFee/) });
  });

  it("spot sells carry the spot builder fee once approved, and the base fee until then; perps keep the base fee", async () => {
    const order = async (inst: Instrument, side: "buy" | "sell", maxFee: number) => {
      const ex = makeExec({ dryRun: true, info: fixtureInfo({ maxBuilderFee: async () => maxFee }), builder: { address: BUILDER, feeTenthsBps: 100, spotFeeTenthsBps: 1000 } });
      const placed = await ex.placeOrder({ instrument: inst, side, size: { notionalUsd: 100 }, type: "market" });
      return (placed.request.action as { builder?: { f: number } }).builder?.f;
    };
    expect(await order(HYPE, "sell", 1000)).toBe(1000);
    expect(await order(HYPE, "sell", 100)).toBe(100);
    expect(await order(BTC, "buy", 1000)).toBe(100);
  });

  it("execute(): filled IOC → engine ExecutionResult with fee estimates", async () => {
    const { fetch, posted } = fakeFetch({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.01", avgPx: "100100", oid: 7 } }] } } });
    const ex = makeExec({ fetch });
    const res = await ex.execute({ clientId: "s:a:t:1", instrument: BTC, instrumentKey: "hl:perp:BTC", side: "buy", phase: "open", notionalUsd: 1000 }, 0);
    expect(posted[0]!.url).toBe("https://api.hyperliquid-testnet.xyz/exchange");
    expect(res).toEqual({
      status: "filled",
      qty: 0.01,
      price: 100100,
      markPrice: 100000,
      feeUsd: expect.closeTo(1001 * 0.00045 + 1001 * 0.0005, 9),
      builderFeeUsd: expect.closeTo(0.5005, 9),
      slippageBps: expect.closeTo(10, 9),
    });
  });

  it("execute(): venue errors → rejected; resting → pending; spot buys pay no builder fee", async () => {
    let ex = makeExec({ fetch: fakeFetch({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Insufficient margin" }] } } }).fetch });
    expect(await ex.execute({ clientId: "1", instrument: BTC, instrumentKey: "k", side: "buy", phase: "open", notionalUsd: 100 }, 0)).toEqual({
      status: "rejected",
      reason: "Insufficient margin",
    });
    ex = makeExec({ fetch: fakeFetch({ status: "err", response: "User or API Wallet 0x… does not exist." }).fetch });
    expect(await ex.execute({ clientId: "2", instrument: BTC, instrumentKey: "k", side: "buy", phase: "open", notionalUsd: 100 }, 0)).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/does not exist/),
    });
    ex = makeExec({ fetch: fakeFetch({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 9 } }] } } }).fetch });
    expect(
      await ex.execute({ clientId: "3", instrument: BTC, instrumentKey: "k", side: "buy", phase: "open", notionalUsd: 100, order: { type: "limit", limitPrice: 90000 } }, 0)
    ).toEqual({ status: "pending", reason: "resting oid 9" });
    ex = makeExec({ fetch: fakeFetch({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "2", avgPx: "40.2", oid: 1 } }] } } }).fetch });
    expect(await ex.execute({ clientId: "4", instrument: HYPE, instrumentKey: "k", side: "buy", phase: "open", notionalUsd: 80 }, 0)).toMatchObject({
      status: "filled",
      builderFeeUsd: 0,
    });
  });

  it("limit orders: sized from the mid, and never far through the market", async () => {
    const ex = makeExec({ dryRun: true });
    // A passive buy limit below the market sizes from the mid, not the (lower) limit.
    const passive = await ex.placeOrder({ instrument: BTC, side: "buy", size: { notionalUsd: 100 }, type: "limit", limitPrice: 90000 });
    expect((passive.request.action as { orders: { s: string }[] }).orders[0]!.s).toBe("0.001");
    // A short with a limit 80% under the market would fill instantly at 5x size: refused.
    await expect(ex.placeOrder({ instrument: BTC, side: "sell", size: { notionalUsd: 100 }, type: "limit", limitPrice: 20000 })).rejects.toThrow(/through the market/);
    await expect(ex.placeOrder({ instrument: BTC, side: "buy", size: { notionalUsd: 100 }, type: "limit", limitPrice: 120000 })).rejects.toThrow(/through the market/);
  });

  it("execute(): an existing cloid is never resent (idempotency)", async () => {
    const { fetch, posted } = fakeFetch({});
    const ex = makeExec({ fetch, info: fixtureInfo({ orderStatus: async () => ({ status: "order", order: { status: "filled" } }) }) });
    const res = await ex.execute({ clientId: "dup", instrument: BTC, instrumentKey: "k", side: "buy", phase: "open", notionalUsd: 100 }, 0);
    expect(res).toMatchObject({ status: "rejected", reason: expect.stringMatching(/duplicate/) });
    expect(posted).toHaveLength(0);
  });

  it("execute(): close phase is reduce-only with the wide close slippage", async () => {
    const ex = makeExec({ dryRun: true });
    const seen: ExchangeRequest[] = [];
    const ex2 = makeExec({ dryRun: true, onRequest: (r) => seen.push(r) });
    expect(await ex.execute({ clientId: "c", instrument: ETH, instrumentKey: "k", side: "sell", phase: "close", qty: 0.5 }, 0)).toMatchObject({ status: "pending" });
    await ex2.execute({ clientId: "c", instrument: ETH, instrumentKey: "k", side: "sell", phase: "close", qty: 0.5, order: { maxSlippageBps: 1 } }, 0);
    const o = (seen[0]!.action as { orders: { r: boolean; p: string }[] }).orders[0]!;
    expect(o.r).toBe(true);
    expect(o.p).toBe(roundPrice(2500.5 * 0.95, "perp", 4).toString());
  });

  it("refuses to POST to mainnet unless allowMainnetSend", async () => {
    const { fetch, posted } = fakeFetch({});
    const ex = makeExec({ isMainnet: true, fetch });
    const res = await ex.execute({ clientId: "m", instrument: BTC, instrumentKey: "k", side: "buy", phase: "open", notionalUsd: 100 }, 0);
    expect(res).toMatchObject({ status: "rejected", reason: expect.stringMatching(/mainnet/) });
    expect(posted).toHaveLength(0);
  });

  it("closePosition reads the account position and sends a reduce-only IOC", async () => {
    const ex = makeExec({ dryRun: true });
    const placed = await ex.closePosition({ instrument: ETH });
    const o = (placed!.request.action as { orders: { b: boolean; s: string; r: boolean; t: unknown }[] }).orders[0]!;
    expect(o).toMatchObject({ b: true, s: "0.5", r: true, t: { limit: { tif: "Ioc" } } });
    expect(await ex.closePosition({ instrument: BTC })).toBeNull();
    const spot = await ex.closePosition({ instrument: HYPE, fraction: 0.5 });
    expect((spot!.request.action as { orders: { b: boolean; s: string; r: boolean }[] }).orders[0]).toMatchObject({ b: false, s: "1.52", r: false });
  });

  it("cancel by oid and by clientId", async () => {
    const ex = makeExec({ dryRun: true });
    expect((await ex.cancel({ instrument: NVDA, oid: 42 })).request.action).toEqual({ type: "cancel", cancels: [{ a: 110001, o: 42 }] });
    expect((await ex.cancel({ instrument: ETH, clientId: "k" })).request.action).toEqual({
      type: "cancelByCloid",
      cancels: [{ asset: 1, cloid: cloidFromKey("k") }],
    });
  });

  it("isolated-only HIP-3 markets get isCross=false leverage updates", async () => {
    const ex = makeExec({ dryRun: true });
    const hood: Instrument = { kind: "perp", venue: "hyperliquid", dex: "xyz", symbol: "HOOD", assetClass: "equity" };
    expect((await ex.setLeverage(hood, 5)).request.action).toEqual({ type: "updateLeverage", asset: 110002, isCross: false, leverage: 5 });
    await expect(ex.setLeverage(hood, 11)).rejects.toThrow(/max/);
  });

  it("maps an OpenIntent: leverage, notional = margin × leverage, pct exits → venue TP/SL", async () => {
    const seen: ExchangeRequest[] = [];
    const ex = makeExec({ dryRun: true, onRequest: (r) => seen.push(r) });
    const intent: OpenIntent = {
      key: "strat:act:trig:1",
      strategyId: "strat",
      actionId: "act",
      triggerId: "trig",
      type: "open",
      instrument: ETH,
      instrumentKey: "hl:perp:ETH",
      side: "short",
      size: { usd: 500 },
      leverage: 3,
      order: { type: "market", maxSlippageBps: 30 },
      exits: { takeProfit: { pct: 10 }, stopLoss: { pct: 5 }, trailingStopPct: 2 },
    };
    const res = await ex.executeOpenIntent(intent);
    expect(seen[0]!.action).toEqual({ type: "updateLeverage", asset: 1, isCross: true, leverage: 3 });
    const a = seen[1]!.action as { grouping: string; orders: { b: boolean; s: string; p: string; t: { trigger?: { triggerPx: string } } }[] };
    expect(a.grouping).toBe("normalTpsl");
    expect(a.orders[0]).toMatchObject({ b: false, s: "0.5998", p: "2493" }); // 1500 / 2500.5, 30 bps below mid
    expect(a.orders[1]!.t.trigger!.triggerPx).toBe("2250.5"); // TP 10% below for a short (2250.45 → 5 s.f.)
    expect(a.orders[2]!.t.trigger!.triggerPx).toBe("2625.5"); // SL 5% above
    expect(res.engineManagedExits.trailingStopPct).toBe(2);
  });

  it("maps a CloseIntent onto the strategy's own positions only", async () => {
    const ex = makeExec({ dryRun: true });
    const intent: CloseIntent = { key: "s:c:t:1", strategyId: "s", actionId: "c", triggerId: "t", type: "close", target: "all", fraction: 0.5 };
    const placed = await ex.executeCloseIntent(intent, [
      { instrument: ETH, instrumentKey: "hl:perp:ETH", side: "long", qty: 1.2345 },
      { instrument: NVDA, instrumentKey: "hl:perp:xyz:NVDA", side: "short", qty: 2 },
      { instrument: { kind: "token", chain: "solana", mint: "So11111111111111111111111111111111111111112", quote: "USDC", route: "auto", assetClass: "crypto" }, instrumentKey: "sol", side: "long", qty: 1 },
    ]);
    expect(placed).toHaveLength(2);
    expect((placed[0]!.request.action as { orders: unknown[] }).orders[0]).toMatchObject({ a: 1, b: false, s: "0.6173", r: true });
    expect((placed[1]!.request.action as { orders: unknown[] }).orders[0]).toMatchObject({ a: 110001, b: true, s: "1", r: true });
  });

  it("outcomes are disabled unless explicitly enabled (experimental)", async () => {
    const outcome: Instrument = { kind: "outcome", venue: "hyperliquid", market: "10", outcome: "YES" };
    expect(await makeExec({ dryRun: true }).execute({ clientId: "o", instrument: outcome, instrumentKey: "k", side: "buy", phase: "open", notionalUsd: 20 }, 0)).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/disabled/),
    });
    const ex = makeExec({ dryRun: true, outcomes: { enabled: true } });
    const placed = await ex.placeOrder({ instrument: outcome, side: "buy", size: { qty: 20 }, type: "limit", limitPrice: 0.61 });
    expect((placed.request.action as { orders: unknown[] }).orders[0]).toMatchObject({ a: 100000100, p: "0.61", s: "20" });
  });
});

/* ------------------------------------------------------------------ */
/* User-signed approvals                                                */
/* ------------------------------------------------------------------ */

describe("approveAgent payload (signed by the user's wallet, never by Weft)", () => {
  it("struct hash equals the Rust SDK's hand-written ApproveAgent encoding", () => {
    const req = buildApproveAgent({ isMainnet: true, agentAddress: agent.address, agentName: "weft", nonce: 1583838 });
    const viemHash = hashStruct({ data: req.typedData.message, primaryType: req.typedData.primaryType, types: req.typedData.types });
    const rustHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "uint64" }],
        [
          keccak256(toBytes("HyperliquidTransaction:ApproveAgent(string hyperliquidChain,address agentAddress,string agentName,uint64 nonce)")),
          keccak256(toBytes("Mainnet")),
          agent.address,
          keccak256(toBytes("weft")),
          1583838n,
        ]
      )
    );
    expect(viemHash).toBe(rustHash);
    expect(req.typedData.domain).toEqual({ name: "HyperliquidSignTransaction", version: "1", chainId: 0x66eee, verifyingContract: "0x0000000000000000000000000000000000000000" });
  });

  it("wallet signature round-trips; unnamed agents post without agentName (like the SDK)", async () => {
    const userKey = generatePrivateKey();
    const wallet = privateKeyToAccount(userKey);
    const req = buildApproveAgent({ isMainnet: false, agentAddress: agent.address, nonce: 1234 });
    const sig = await wallet.signTypedData(req.typedData as Parameters<typeof wallet.signTypedData>[0]);
    const body = await req.toRequest(sig, wallet.address);
    expect(body.action).toEqual({ type: "approveAgent", agentAddress: agent.address, nonce: 1234, signatureChainId: "0x66eee", hyperliquidChain: "Testnet" });
    // Same signature as the SDK's sign_agent path (sign_user_signed_action with agentName "").
    const sdk = await signUserSignedAction(
      signerFromPrivateKey(userKey),
      { type: "approveAgent", agentAddress: agent.address, agentName: "", nonce: 1234 },
      APPROVE_AGENT_TYPES,
      "HyperliquidTransaction:ApproveAgent",
      false
    );
    expect(body.signature).toEqual(sdk.signature);
    expect(await recoverUserSigner(sdk.action, sdk.signature, APPROVE_AGENT_TYPES, "HyperliquidTransaction:ApproveAgent")).toBe(wallet.address);
  });

  it("builder fee percent strings", () => {
    expect(feeTenthsBpsToPercent(50)).toBe("0.05%");
    expect(feeTenthsBpsToPercent(1)).toBe("0.001%");
    expect(feeTenthsBpsToPercent(100)).toBe("0.1%");
  });
});

describe("levelToPrice", () => {
  it("puts a position-based stop at the price move that loses that share of the margin", () => {
    expect(levelToPrice({ positionPct: 20 }, 2000, true, "sl", 20)).toBeCloseTo(1980, 9); // −1% at 20×
    expect(levelToPrice({ positionPct: 20 }, 2000, false, "sl", 20)).toBeCloseTo(2020, 9); // short: +1%
    expect(levelToPrice({ positionPct: 50 }, 2000, true, "tp", 10)).toBeCloseTo(2100, 9); // +5% at 10×
    expect(levelToPrice({ pct: 5 }, 2000, true, "sl", 20)).toBeCloseTo(1900, 9); // price levels ignore leverage
  });
});
