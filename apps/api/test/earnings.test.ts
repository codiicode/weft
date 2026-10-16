import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { earnings } from "../src/lib/earnings.ts";

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

  it("before launch: nothing bought, half of revenue set aside", async () => {
    const e = await earnings({ engine, hlBaseUrl: null, builder: null, solana: null, token: null, buybackLog: () => [] });
    expect(e.buybacks).toMatchObject({ mint: null, boughtTokens: 0, burnedTokens: 0, setAsideUsd: 0, events: [] });
  });
});
