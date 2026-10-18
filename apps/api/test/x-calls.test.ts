import { describe, expect, it } from "vitest";
import { candidates, xCallFeed } from "../src/social/x-calls.ts";

const MINT = "So1aNaToken1111111111111111111111111111111";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

describe("calls from X", () => {
  it("finds contract addresses and cashtags, leaving out majors", () => {
    expect(candidates(`aping $wif and $bonk now. $SOL to 500, $usdc parked`)).toEqual({ cas: [], tags: ["WIF", "BONK"] });
    // with a contract address, the cashtag is just its name
    expect(candidates(`Aped $Pierre, CA: ${MINT}`)).toEqual({ cas: [MINT], tags: [] });
    expect(candidates("gm")).toEqual({ cas: [], tags: [] });
  });

  it("reads each post once, keeps only buy calls, and resolves cashtags to the right token", async () => {
    let classified = 0, now = 1_000_000_000_000;
    const tweets = [
      { id: "1", text: "bought more $WIF here", createdAt: new Date(now - 60_000).toUTCString() },
      { id: "2", text: "careful, $WIF clones everywhere", createdAt: new Date(now - 30_000).toUTCString() },
      { id: "3", text: "just a thought", createdAt: new Date(now - 10_000).toUTCString() },
    ];
    const fetch = (async () => new Response(JSON.stringify({ tweets }), { status: 200 })) as typeof globalThis.fetch;
    const catalog = { list: async () => [
      { instrument: { kind: "token", mint: "FakeWif111111111111111111111111111111111111", symbol: "WIFF" }, liquidityUsd: 9e6 },
      { instrument: { kind: "token", mint: "WifC1one11111111111111111111111111111111111", symbol: "WIF" }, liquidityUsd: 2e4 },
      { instrument: { kind: "token", mint: WIF, symbol: "WIF" }, liquidityUsd: 4e7 },
    ] } as never;
    const feed = xCallFeed({
      twitterApiKey: "k", catalog, fetch, now: () => now,
      classify: async (post, tokens) => (classified++, /bought/.test(post) ? tokens : []),
    });
    expect(await feed("@Caller")).toEqual([{ id: `1:${WIF}`, at: Date.parse(tweets[0]!.createdAt), mint: WIF, symbol: "WIF" }]);
    expect(classified).toBe(2); // post 3 names no token
    now += 13_000;
    await feed("caller");
    expect(classified).toBe(2); // the same posts aren't read again
  });

  it("skips a cashtag two tokens share, and posts too old to copy", async () => {
    let classified = 0;
    const now = 1_000_000_000_000;
    const tweets = [
      { id: "a", text: "aping $GOLD", createdAt: new Date(now - 60_000).toUTCString() },
      { id: "b", text: "aping $WIF", createdAt: new Date(now - 2 * 3_600_000).toUTCString() },
    ];
    const fetch = (async () => new Response(JSON.stringify({ tweets }), { status: 200 })) as typeof globalThis.fetch;
    const catalog = { list: async () => [
      { instrument: { kind: "token", mint: "GoLd1111111111111111111111111111111111111111", symbol: "GOLD" }, liquidityUsd: 3e6 },
      { instrument: { kind: "token", mint: "GoLd2222222222222222222222222222222222222222", symbol: "GOLD" }, liquidityUsd: 2e6 },
    ] } as never;
    const feed = xCallFeed({ twitterApiKey: "k", catalog, fetch, now: () => now, classify: async (_p, tokens) => (classified++, tokens) });
    expect(await feed("x")).toEqual([]);
    expect(classified).toBe(1); // the two-hour-old post isn't read
  });
});
