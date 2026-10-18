import { describe, expect, it } from "vitest";
import { Http } from "../src/http.ts";
import { Yields, yieldProvider } from "../src/signals/yields.ts";

const POOLS = {
  data: [
    { pool: "kamino-main-usdc", project: "kamino-lend", chain: "Solana", symbol: "USDC", poolMeta: "Main Market", tvlUsd: 62e6, apy: 5.18, apyBase: 5.18, apyReward: null, apyPct1D: 0.1, apyPct7D: -0.4, apyMean30d: 6.1, stablecoin: true },
    { pool: "aave-base-usdc", project: "aave-v3", chain: "Base", symbol: "USDC", poolMeta: null, tvlUsd: 18e6, apy: 5.59, apyBase: 5.59, apyReward: null, apyPct1D: 0, apyPct7D: 0.2, apyMean30d: 5.2, stablecoin: true },
    { pool: "tiny", project: "kamino-lend", chain: "Solana", symbol: "USDC", poolMeta: null, tvlUsd: 5_000, apy: 40, apyBase: 40, apyReward: null, apyPct1D: 0, apyPct7D: 0, apyMean30d: 40, stablecoin: true },
  ],
};
const http = new Http({ fetch: (async () => new Response(JSON.stringify(POOLS), { status: 200 })) as never });

describe("DeFi yields", () => {
  it("finds pools by protocol, token and chain words, biggest first, without dust pools", async () => {
    const y = new Yields(http);
    expect((await y.search("kamino usdc")).map((p) => p.pool)).toEqual(["kamino-main-usdc"]);
    expect((await y.search("aave base usdc")).map((p) => p.pool)).toEqual(["aave-base-usdc"]);
    expect((await y.search("usdc")).map((p) => p.pool)).toEqual(["kamino-main-usdc", "aave-base-usdc"]);
  });
  it("reads a pool's APY and deposits as signal fields", async () => {
    const snap = await yieldProvider(new Yields(http)).fetch({ id: "k", kind: "yield", params: { pool: "kamino-main-usdc" } } as never, Date.now());
    expect(snap?.fields).toMatchObject({ apy: 5.18, tvl_usd: 62e6, apy_change_7d: -0.4, apy_mean_30d: 6.1 });
  });
});
