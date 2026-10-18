import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { earnings, received } from "../src/lib/earnings.ts";

const engine = { listDeployments: async () => [], getSnapshot: async () => null } as never;

describe("protocol revenue and buybacks", () => {
  it("counts burns from the chain, buys from the log, and what's still set aside", async () => {
    const hlFetch = (async (_url: string, init: { body: string }) => {
      const t = (JSON.parse(init.body) as { type: string }).type;
      const body = t === "referral" ? { builderRewards: "40", unclaimedRewards: "10", claimedRewards: "30" } : { marginSummary: { accountValue: "130" } };
      return { text: async () => JSON.stringify(body) };
    }) as never;
    const conn = { getTokenSupply: async () => ({ value: { uiAmountString: "999250000" } }) } as never;
    const e = await earnings({
      engine,
      hlBaseUrl: "https://hl",
      builder: "0xb",
      solana: null,
      token: { mint: Keypair.generate().publicKey, initialSupply: 1_000_000_000, conn },
      buybackLog: () => [
        { at: 1, tx: "a", spentUsd: 5, boughtTokens: 500_000, burnTx: "b", burnedTokens: 500_000 },
        { at: 2, tx: "c", spentUsd: 3, boughtTokens: 250_000, burnTx: "d", burnedTokens: 250_000 },
      ],
      fetch: hlFetch,
    });
    expect(e.totalUsd).toBe(40);
    expect(e.buybackUsd).toBe(20);
    expect(e.buybacks).toMatchObject({ boughtTokens: 750_000, spentUsd: 8, burnedTokens: 750_000, setAsideUsd: 12 });
    expect(e.buybacks.events.map((x) => x.tx)).toEqual(["c", "a"]); // newest first
  });

  it("adds the fees on $WEFT trades, split 2.0/0.4, at today's SOL price", async () => {
    const f = (async (url: string, init: { body?: string }) => {
      if (url.includes("price")) return { text: async () => JSON.stringify({ So11111111111111111111111111111111111111112: { usdPrice: 100 } }) };
      const t = (JSON.parse(init.body!) as { type: string }).type;
      return { text: async () => JSON.stringify(t === "referral" ? { builderRewards: "10" } : {}) };
    }) as never;
    const e = await earnings({
      engine,
      hlBaseUrl: "https://hl",
      builder: "0xb",
      solana: null,
      token: null,
      buybackLog: () => [],
      tokenFees: () => ({ claims: 3, claimedSol: 24, protocolSol: 20, buybackSol: 4, lastClaimAt: 1 }),
      fetch: f,
    });
    expect(e.productUsd).toBe(10);
    expect(e.token).toMatchObject({ claimedUsd: 2400, protocolUsd: 2000, buybackUsd: 400 });
    expect(e.totalUsd).toBe(2410);
    expect(e.weftUsd).toBe(2005);
    expect(e.buybackUsd).toBe(405);
  });

  it("counts only what users paid into the fee wallet, not Weft moving its own money", () => {
    const tx = (payer: string, pre: string, post: string) =>
      ({
        transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => payer } }] } },
        meta: {
          preTokenBalances: [{ owner: "fee", mint: "usdc", uiTokenAmount: { uiAmountString: pre } }],
          postTokenBalances: [{ owner: "fee", mint: "usdc", uiTokenAmount: { uiAmountString: post } }],
        },
      }) as never;
    expect(received(tx("user", "10", "12.5"), "fee", "usdc", ["fee", "treasury"])).toBe(2.5);
    // the fee wallet swapping its own SOL to USDC isn't revenue
    expect(received(tx("fee", "0", "8551"), "fee", "usdc", ["fee", "treasury"])).toBe(0);
    expect(received(tx("user", "12.5", "2"), "fee", "usdc", ["fee"])).toBe(0);
    expect(received(null, "fee", "usdc", [])).toBe(0);
  });

  it("sets aside what's owed and not bought yet, and shows the launch burn", async () => {
    const f = (async (url: string) => ({ text: async () => JSON.stringify(url.includes("price") ? { So11111111111111111111111111111111111111112: { usdPrice: 100 } } : {}) })) as never;
    const e = await earnings({
      engine,
      hlBaseUrl: null,
      builder: null,
      solana: null,
      token: null,
      buybackLog: () => [{ at: 1, source: "token", tx: "a", spentUsd: 400, boughtTokens: 1_000, burnedTokens: 300 }],
      tokenFees: () => ({ claims: 1, claimedSol: 24, protocolSol: 20, buybackSol: 4, lastClaimAt: 1 }),
      owedBuybackSol: () => 0.5,
      launchBurn: { at: 0, tx: "L", tokens: 35_000_000 },
      fetch: f,
    });
    // token buys don't eat into the product-fee half; 0.5 SOL still waits in the treasury
    expect(e.buybacks.setAsideUsd).toBe(50);
    expect(e.buybacks.launchBurn).toEqual({ at: 0, tx: "L", tokens: 35_000_000 });
  });

  it("before launch: nothing bought, half of revenue set aside", async () => {
    const e = await earnings({ engine, hlBaseUrl: null, builder: null, solana: null, token: null, buybackLog: () => [] });
    expect(e.buybacks).toMatchObject({ mint: null, boughtTokens: 0, burnedTokens: 0, setAsideUsd: 0, events: [] });
  });
});
