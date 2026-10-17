import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REWARDS, Rewards } from "../src/lib/rewards.ts";

const at = (day: string, h = 12) => Date.parse(`${day}T${String(h).padStart(2, "0")}:00:00Z`);
const make = (startDay: string | null = "2026-11-01") => new Rewards(join(mkdtempSync(join(tmpdir(), "rewards-")), "rewards.db"), { startDay });
const fee = (r: Rewards, id: string, user: string, usd: number, day = "2026-11-01", creator: string | null = null) =>
  r.record({ id, ts: at(day), userId: user, deploymentId: `run-${user}`, creatorId: creator, instrumentKey: "hl:perp:ETH", feeUsd: usd });

describe("$WEFT daily rewards", () => {
  it("splits half of the fees: 50% to traders by fees paid, 20% to creators, 30% burned", async () => {
    const r = make();
    fee(r, "f1", "alice", 30);
    fee(r, "f2", "bob", 10, "2026-11-01", "carol");
    fee(r, "f2", "bob", 10, "2026-11-01", "carol"); // the same fill twice counts once
    const d = await r.closeDay("2026-11-01", async () => 1);
    expect(d.feesUsd).toBe(40);
    expect(d.buybackUsd).toBe(40 * REWARDS.buybackShare);
    expect(d.traderPoolUsd).toBeCloseTo(10);
    expect(d.creatorPoolUsd).toBeCloseTo(4);
    expect(d.burnUsd).toBeCloseTo(6);
    expect(r.summary("alice", at("2026-11-02")).history[0]).toMatchObject({ kind: "trade", share: 0.75, usd: 7.5, tokens: null });
    expect(r.summary("carol", at("2026-11-02")).history[0]).toMatchObject({ kind: "create", share: 1, usd: 4 });
  });

  it("gives holders a bigger share, and sends a pool nobody earns to the burn", async () => {
    const r = make();
    fee(r, "f1", "alice", 10);
    fee(r, "f2", "bob", 10);
    const d = await r.closeDay("2026-11-01", async (u) => (u === "alice" ? 2 : 1));
    expect(d.creatorPoolUsd).toBe(0);
    expect(d.burnUsd).toBeCloseTo(10 - 5);
    const share = (u: string) => r.summary(u, at("2026-11-02")).history[0]!.share;
    expect(share("alice")).toBeCloseTo(2 / 3);
    expect(share("bob")).toBeCloseTo(1 / 3);
  });

  it("never rewards a creator for their own runs", async () => {
    const r = make();
    fee(r, "f1", "carol", 10, "2026-11-01", "carol");
    const d = await r.closeDay("2026-11-01", async () => 1);
    expect(d.creators).toBe(0);
  });

  it("closes each ended day once, from the start day, and only when switched on", async () => {
    const r = make("2026-11-01");
    expect(r.pendingDays(at("2026-11-03"))).toEqual(["2026-11-01", "2026-11-02"]);
    await r.closeDay("2026-11-01", async () => 1);
    expect(r.pendingDays(at("2026-11-03"))).toEqual(["2026-11-02"]);
    expect(make(null).pendingDays(at("2026-11-03"))).toEqual([]);
  });

  it("turns shares into tokens when the day is funded, and pays a claim exactly once", async () => {
    const r = make();
    fee(r, "f1", "alice", 30);
    fee(r, "f2", "bob", 10);
    await r.closeDay("2026-11-01", async () => 1);
    expect(r.claimableTokens("alice")).toBe(0);
    r.fundDay("2026-11-01", { spentUsd: 20, priceUsd: 0.001, traderTokens: 10_000, creatorTokens: 0, burnedTokens: 10_000, buyTx: "buy", burnTx: "burn" });
    expect(r.claimableTokens("alice")).toBeCloseTo(7_500);
    const paid: number[] = [];
    const [a, b] = await Promise.all([
      r.claim("alice", async (n) => (paid.push(n), "tx1")),
      r.claim("alice", async (n) => (paid.push(n), "tx2")),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(paid).toHaveLength(1);
    expect(paid[0]).toBeCloseTo(7_500);
    expect(r.claimableTokens("alice")).toBe(0);
  });

  it("releases a claim that failed to send", async () => {
    const r = make();
    fee(r, "f1", "alice", 10);
    await r.closeDay("2026-11-01", async () => 1);
    r.fundDay("2026-11-01", { spentUsd: 5, priceUsd: 0.001, traderTokens: 1_000, creatorTokens: 0, burnedTokens: 0, buyTx: null, burnTx: null });
    await expect(r.claim("alice", async () => { throw new Error("rpc down"); })).rejects.toThrow("rpc down");
    expect(r.claimableTokens("alice")).toBeCloseTo(1_000);
  });

  it("estimates today's reward from the fees so far", () => {
    const r = make();
    fee(r, "f1", "alice", 30, "2026-11-05");
    fee(r, "f2", "bob", 10, "2026-11-05", "carol");
    const s = r.summary("alice", at("2026-11-05", 18));
    expect(s.today.feesPaidUsd).toBe(30);
    expect(s.today.estTradeUsd).toBeCloseTo(20 * 0.5 * 0.75);
    expect(r.summary("carol", at("2026-11-05", 18)).today.estCreateUsd).toBeCloseTo(4);
  });
});
