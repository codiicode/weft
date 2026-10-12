import { describe, expect, it } from "vitest";
import { SIGNAL_KINDS } from "@weft/strategy";
import { isXStock, predictionBook, predictionPrice, swapFill, tokenAgeMinutes, authorityRevoked, migrated } from "../src/jupiter/parse.ts";
import { summarizeDexPairs, parseMintAccount } from "../src/solana.ts";
import { toTokenFacts, tokenOnchainFields } from "../src/tokens.ts";
import { fixture, JUP_MINT, NOW } from "./helpers.ts";

describe("swap quotes", () => {
  it("buy: USDC → JUP fill price and impact (fraction → bps, max with observed slippage)", () => {
    const q = fixture("jup_quote_buy.json");
    const fill = swapFill(q, "buy", 6, 0.35272529155082416)!;
    const expected = Number(q.inAmount) / 1e6 / (Number(q.outAmount) / 1e6);
    expect(fill.fillPrice).toBeCloseTo(expected, 12);
    const observed = ((expected - 0.35272529155082416) / 0.35272529155082416) * 1e4;
    expect(fill.priceImpactBps).toBeCloseTo(Math.max(Number(q.priceImpactPct) * 1e4, observed), 9);
    expect(fill.route).toBe("HumidiFi");
  });

  it("sell: JUP → USDC", () => {
    const q = fixture("jup_quote_sell.json");
    const fill = swapFill(q, "sell", 6)!;
    expect(fill.fillPrice).toBeCloseTo(Number(q.outAmount) / Number(q.inAmount), 12);
    expect(fill.priceImpactBps).toBeCloseTo(Number(q.priceImpactPct) * 1e4, 9);
  });
});

describe("prediction markets", () => {
  const market = fixture("jup_pred_market.json");
  it("converts micro-USD pricing; NO uses the complement when unquoted", () => {
    expect(predictionPrice(market.pricing, "YES")).toEqual({ price: 0.825, bid: 0.82, ask: 0.83 });
    const no = predictionPrice(market.pricing, "NO")!;
    expect(no.bid).toBeCloseTo(0.17, 12);
    expect(no.ask).toBeCloseTo(0.18, 12);
  });

  it("builds a YES book: bids from YES bids, asks from 1 − NO bids", () => {
    const b = predictionBook(fixture("jup_pred_orderbook.json"), "YES");
    expect(b.bids[0]).toEqual({ px: 0.81, sz: 3161.57 });
    expect(b.asks[0]).toEqual({ px: 0.82, sz: 28.02 });
    expect(b.asks[1]!.px).toBeCloseTo(0.83, 12);
    const nob = predictionBook(fixture("jup_pred_orderbook.json"), "NO");
    expect(nob.bids[0]).toEqual({ px: 0.18, sz: 28.02 });
    expect(nob.asks[0]!.px).toBeCloseTo(0.19, 12);
  });
});

describe("token on-chain facts", () => {
  const jup = fixture("jup_token_jup.json")[0];
  const fresh = fixture("jup_token_fresh.json")[0];
  const nvdax = fixture("jup_trending.json").find((t: any) => t.symbol === "NVDAx");

  it("maps every token_onchain field (unknowns null)", () => {
    const f = tokenOnchainFields(jup, null, null, NOW);
    expect(Object.keys(f).sort()).toEqual(Object.keys(SIGNAL_KINDS.token_onchain.fields).sort());
    expect(f.market_cap_usd).toBe(jup.mcap);
    expect(f.liquidity_usd).toBe(jup.liquidity);
    expect(f.holders).toBe(838225);
    expect(f.holders_change_1h_pct).toBe(jup.stats1h.holderChange);
    expect(f.buy_sell_ratio_1h).toBeCloseTo(jup.stats1h.buyVolume / jup.stats1h.sellVolume, 12);
    expect(f.top10_holders_pct).toBe(jup.audit.topHoldersPercentage);
    expect(f.age_minutes).toBeCloseTo((NOW - Date.parse("2024-01-29T17:33:29Z")) / 60_000, 6);
    expect(f.mint_authority_revoked).toBe(true);
    expect(f.freeze_authority_revoked).toBe(true);
    expect(f.migrated).toBeNull(); // never on a launchpad
    expect(f.bonding_curve_pct).toBeNull();
    expect(f.lp_locked).toBeNull();
    expect(f.dev_sold_pct).toBeNull();
    expect(f.smart_wallet_buys_1h).toBeNull();
  });

  it("handles fresh pump.fun tokens (on the curve, no sells yet)", () => {
    const f = tokenOnchainFields(fresh, null, null, NOW);
    expect(f.migrated).toBe(false);
    expect(f.buy_sell_ratio_1h).toBeNull();
    expect(f.top10_holders_pct).toBeNull();
    expect(f.liquidity_usd).toBeNull();
    expect(tokenAgeMinutes(fresh, NOW)).toBeCloseTo((NOW - Date.parse("2026-10-12T13:06:12Z")) / 60_000, 6);
  });

  it("reads authorities from Jupiter, or from the mint account when silent", () => {
    expect(isXStock(nvdax)).toBe(true);
    expect(authorityRevoked(nvdax, "mint")).toBe(false);
    expect(authorityRevoked({ ...jup, audit: {} }, "mint")).toBeNull();
    const chain = parseMintAccount(fixture("solana_mint_xstock.json"))!;
    expect(chain.mintAuthority).toBeTruthy();
    expect(chain.decimals).toBe(8);
    const f = tokenOnchainFields({ ...jup, audit: {} }, null, parseMintAccount(fixture("solana_mint_jup.json")), NOW);
    expect(f.mint_authority_revoked).toBe(true);
    expect(f.freeze_authority_revoked).toBe(true);
    expect(migrated({ ...fresh, graduatedPool: "x" })).toBe(true);
  });

  it("falls back to DexScreener for liquidity / mcap / age", () => {
    const d = summarizeDexPairs(fixture("dexscreener_jup.json"), JUP_MINT)!;
    expect(d.liquidityUsd).toBe(786547.42);
    expect(d.firstPairAt).toBe(1706675725000);
    const f = tokenOnchainFields(null, d, null, NOW);
    expect(f.liquidity_usd).toBe(786547.42);
    expect(f.market_cap_usd).toBe(1170032523);
    expect(f.buy_sell_ratio_1h).toBeCloseTo(341 / 382, 12);
    expect(summarizeDexPairs(fixture("dexscreener_jup.json"), "other")).toBeNull();
  });

  it("converts to TokenFacts, failing closed on unknowns", () => {
    const facts = toTokenFacts(tokenOnchainFields(jup, null, null, NOW), 12.3456);
    expect(facts).toMatchObject({ liquidity_usd: jup.liquidity, mint_authority_revoked: true, price_impact_bps: 12.35, dev_sold_pct: 0 });
    expect(facts.unknown).toEqual(["dev_sold_pct"]);
    const freshFacts = toTokenFacts(tokenOnchainFields(fresh, null, null, NOW), undefined, 100);
    expect(freshFacts.liquidity_usd).toBe(0);
    expect(freshFacts.top10_holders_pct).toBe(100);
    expect(freshFacts.dev_sold_pct).toBe(100);
    expect(freshFacts.price_impact_bps).toBeUndefined();
    expect(freshFacts.unknown).toEqual(expect.arrayContaining(["liquidity_usd", "top10_holders_pct", "dev_sold_pct"]));
  });
});
