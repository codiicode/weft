import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REWARDS, Rewards } from "../src/lib/rewards.ts";

const at = (day: string, h = 12) => Date.parse(`${day}T${String(h).padStart(2, "0")}:00:00Z`);
const make = (startDay: string | null = "2026-11-01") => new Rewards(join(mkdtempSync(join(tmpdir(), "rewards-")), "rewards.db"), { startDay });
const fee = (r: Rewards, id: string, user: string, usd: number, day = "2026-11-01", creator: string | null = null) =>
  r.record({ id, ts: at(day), userId: user, deploymentId: `run-${user}`, creatorId: creator, instrumentKey: "hl:perp:ETH", feeUsd: usd });
const buy = (r: Rewards, tokens: number, day = "2026-11-01", h = 13) =>
  r.addBuy({ at: at(day, h), source: "token", spentUsd: tokens / 1000, boughtTokens: tokens, burnedTokens: tokens * REWARDS.burnShare, swapTx: "swap", burnTx: "burn" });

describe("$WEFT rewards", () => {
  it("splits every buy: 30% burned, 50% into the day's traders' pot, 20% into its creators' pot", () => {
    expect(Rewards.split(1000)).toEqual({ burn: 300, trader: 500, creator: 200 });
  });

  it("shares a day's pots out at close: traders by fees paid, creators by their strategies' fees", async () => {
    const r = make();
    fee(r, "f1", "alice", 30);
    fee(r, "f2", "bob", 10, "2026-11-01", "carol");
    fee(r, "f2", "bob", 10, "2026-11-01", "carol"); // the same fill twice counts once
    buy(r, 6_000);
    buy(r, 4_000, "2026-11-01", 20);
    const d = await r.closeDay("2026-11-01", async () => 1);
    expect(d).toMatchObject({ feesUsd: 40, traders: 2, creators: 1, traderTokens: 5_000, creatorTokens: 2_000 });
    expect(r.claimableTokens("alice")).toBeCloseTo(3_750);
    expect(r.claimableTokens("bob")).toBeCloseTo(1_250);
    expect(r.claimableTokens("carol")).toBeCloseTo(2_000);
  });

  it("gives holders a bigger share", async () => {
    const r = make();
    fee(r, "f1", "alice", 10);
    fee(r, "f2", "bob", 10);
    buy(r, 3_000);
    await r.closeDay("2026-11-01", async (u) => (u === "alice" ? 2 : 1));
    expect(r.claimableTokens("alice")).toBeCloseTo(1_000);
    expect(r.claimableTokens("bob")).toBeCloseTo(500);
  });

  it("rolls a pot nobody earned into the next day, and never pays a creator for their own runs", async () => {
    const r = make();
    fee(r, "f1", "carol", 10, "2026-11-01", "carol");
    buy(r, 1_000);
    const d1 = await r.closeDay("2026-11-01", async () => 1);
    expect(d1.creators).toBe(0);
    expect(d1.creatorTokens).toBe(0);
    fee(r, "f2", "dave", 5, "2026-11-02", "carol");
    const d2 = await r.closeDay("2026-11-02", async () => 1);
    expect(d2.creatorTokens).toBeCloseTo(200);
    expect(r.claimableTokens("carol")).toBeCloseTo(500 + 200);
  });

  it("turns each closed day's strategy-fee buyback into a budget bought in slices over the next day", async () => {
    const r = make();
    fee(r, "f1", "alice", 288);
    await r.closeDay("2026-11-01", async () => 1);
    expect(r.budgetSlice()).toBeCloseTo((288 * REWARDS.buybackShare) / REWARDS.slicesPerDay);
    r.spendBudget(144 - 0.5);
    expect(r.budgetSlice()).toBeCloseTo(0.5);
    r.spendBudget(0.5);
    expect(r.budgetSlice()).toBe(0);
  });

  it("closes each ended day once, from the start day, and only when switched on", async () => {
    const r = make("2026-11-01");
    expect(r.pendingDays(at("2026-11-03"))).toEqual(["2026-11-01", "2026-11-02"]);
    await r.closeDay("2026-11-01", async () => 1);
    expect(r.pendingDays(at("2026-11-03"))).toEqual(["2026-11-02"]);
    expect(make(null).pendingDays(at("2026-11-03"))).toEqual([]);
  });

  it("pays a claim exactly once, and releases one that failed to send", async () => {
    const r = make();
    fee(r, "f1", "alice", 30);
    fee(r, "f2", "bob", 10);
    buy(r, 20_000);
    await r.closeDay("2026-11-01", async () => 1);
    const paid: number[] = [];
    const [a, b] = await Promise.all([r.claim("alice", async (n) => (paid.push(n), "tx1")), r.claim("alice", async (n) => (paid.push(n), "tx2"))]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(paid).toEqual([7_500]);
    expect(r.claimableTokens("alice")).toBe(0);
    await expect(r.claim("bob", async () => { throw new Error("rpc down"); })).rejects.toThrow("rpc down");
    expect(r.claimableTokens("bob")).toBeCloseTo(2_500);
  });

  it("estimates today's reward from the fees and the pots so far", () => {
    const r = make();
    fee(r, "f1", "alice", 30, "2026-11-05");
    fee(r, "f2", "bob", 10, "2026-11-05", "carol");
    buy(r, 2_000, "2026-11-05");
    const s = r.summary("alice", at("2026-11-05", 18));
    expect(s.today.feesPaidUsd).toBe(30);
    expect(s.today.estTradeTokens).toBeCloseTo(1_000 * 0.75);
    expect(r.summary("carol", at("2026-11-05", 18)).today.estCreateTokens).toBeCloseTo(400);
    expect(s.priceUsd).toBeCloseTo(0.001);
  });

  it("remembers a token-fee buyback that has to be retried", () => {
    const r = make();
    expect(r.owedTokenBuyback()).toBe(0n);
    r.setOwedTokenBuyback(12_345n);
    expect(r.owedTokenBuyback()).toBe(12_345n);
  });
});
