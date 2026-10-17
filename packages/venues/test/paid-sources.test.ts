import { describe, expect, it } from "vitest";
import { keywordMatcher, perHour, socialFields, socialQuery, tweetTone, type Tweet } from "../src/signals/x.ts";
import { walletFields, walletTrades, type HeliusTx } from "../src/signals/wallet.ts";

const T = Date.parse("2026-10-17T12:00:00Z");
const tw = (minAgo: number, text = "gm", author = "a"): Tweet => ({ id: String(minAgo), text, at: T - minAgo * 60_000, author });

describe("X social", () => {
  it("builds one OR query for cashtags, keywords and accounts", () => {
    expect(socialQuery({ cashtags: ["PUMP"], keywords: [], accounts: [] })).toBe("$PUMP");
    expect(socialQuery({ cashtags: ["$WIF"], keywords: ["dog hat"], accounts: ["@ansem"] })).toBe('($WIF OR "dog hat" OR from:ansem)');
  });

  it("counts a full window exactly and extrapolates a page that ran out", () => {
    expect(perHour({ tweets: [tw(50), tw(10)], full: true }, 3_600_000)).toBe(2);
    // 20 tweets over 10 minutes and more behind them: about 120 an hour.
    const busy = Array.from({ length: 20 }, (_, i) => tw(10 - i * (10 / 19)));
    expect(perHour({ tweets: busy.sort((a, b) => a.at - b.at), full: false }, 3_600_000)).toBe(120);
  });

  it("reads tone from crypto slang and compares with the hour before", () => {
    expect(tweetTone(["$PUMP to the moon 🚀", "this is a rug", "gm"])).toBe(0);
    expect(tweetTone(["LFG", "bullish af"])).toBe(1);
    const f = socialFields([tw(5, "bullish", "a"), tw(20, "lfg", "b"), tw(30, "gm", "a")], true, [tw(70)], true);
    expect(f).toEqual({ mentions_1h: 3, mentions_change_1h_pct: 200, unique_authors_1h: 2, sentiment: 1 });
  });

  it("keyword fallback scores posts against a claim", async () => {
    const r = await keywordMatcher("Dogecoin payments on X", "no Dogecoin", [tw(1, "X will accept Dogecoin payments soon"), tw(2, "gm")]);
    expect(r[0]!.score).toBe(1);
    expect(r[1]!.score).toBe(0);
  });
});

describe("wallet tracking", () => {
  const W = "Wa11et1111111111111111111111111111111111111";
  const MINT = "Mint111111111111111111111111111111111111111";
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const txs: HeliusTx[] = [
    { signature: "a", timestamp: T / 1000 - 120, tokenTransfers: [{ mint: MINT, tokenAmount: 100, fromUserAccount: "pool", toUserAccount: W }], accountData: [{ account: W, nativeBalanceChange: -500_000_000 }] },
    { signature: "b", timestamp: T / 1000 - 1_800, tokenTransfers: [{ mint: MINT, tokenAmount: 40, fromUserAccount: W, toUserAccount: "pool" }, { mint: USDC, tokenAmount: 12, fromUserAccount: "pool", toUserAccount: W }], accountData: [{ account: W, nativeBalanceChange: 0 }] },
    { signature: "c", timestamp: T / 1000 - 7_200, tokenTransfers: [{ mint: "Other1111111111111111111111111111111111111", tokenAmount: 5, fromUserAccount: "pool", toUserAccount: W }], accountData: [{ account: W, nativeBalanceChange: -100_000_000 }] },
    { signature: "d", timestamp: T / 1000 - 60, transactionError: { x: 1 }, tokenTransfers: [{ mint: MINT, tokenAmount: 1, fromUserAccount: "pool", toUserAccount: W }] },
  ];

  it("turns parsed history into buys and sells, skipping failed transactions", () => {
    const trades = walletTrades(txs, W);
    expect(trades.map((t) => [t.side, t.sol])).toEqual([["buy", 0.5], ["sell", 0], ["buy", 0.1]]);
  });

  it("counts the last hour, for one token or all of them", () => {
    const trades = walletTrades(txs, W);
    expect(walletFields(trades, T, MINT, 60)).toEqual({ buys_1h: 1, sells_1h: 1, sol_spent_1h: 0.5, sol_received_1h: 0, minutes_since_buy: 2, minutes_since_sell: 30, token_balance: 60 });
    expect(walletFields(trades, T, undefined, null).minutes_since_buy).toBe(2);
    expect(walletFields(trades, T, "Nope111111111111111111111111111111111111111", 0)).toMatchObject({ buys_1h: 0, minutes_since_buy: null });
  });
});
