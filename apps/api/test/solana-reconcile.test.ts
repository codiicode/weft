import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine, MemoryStore, PaperExecutor } from "@weft/engine";
import { FakeMarket, FakeSignals, FakeTokenFacts, HEALTHY, SOL_PERP, T0, TEST_FEES, TOKEN, ZERO_SLIPPAGE, simpleStrategy } from "../../../packages/engine/test/fakes.ts";
import { Accounts } from "../src/lib/accounts.ts";
import { SolanaReconciler } from "../src/live/solana-reconcile.ts";

const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** An engine in live mode whose orders fill like paper (no venue needed). */
function liveSetup() {
  const clock = { t: T0 };
  const market = new FakeMarket();
  const signals = new FakeSignals();
  const tokenFacts = new FakeTokenFacts();
  const paper = new PaperExecutor({ marketData: market, fees: TEST_FEES, slippageBps: ZERO_SLIPPAGE });
  const engine = createEngine({
    store: new MemoryStore(),
    marketData: market,
    signalProviders: [signals],
    tokenFacts,
    clock: () => clock.t,
    fees: TEST_FEES,
    executor: { mode: "live", execute: (r, n) => paper.execute(r, n) },
  });
  return { engine, market, signals, tokenFacts, clock };
}

async function holding() {
  const t = liveSetup();
  t.market.set(TOKEN, 0.004).set(SOL_PERP, 180);
  t.tokenFacts.facts = HEALTHY;
  t.signals.set("go", { value: 1 });
  const strategy = simpleStrategy({ instrument: TOKEN, side: "long", size: { unit: "native", value: 0.5 }, exits: {} });
  const d = await t.engine.createDeployment({ strategy, allocationUsd: 1_000, mode: "live" });
  await t.engine.tick(d.id);
  const accounts = new Accounts(join(mkdtempSync(join(tmpdir(), "weft-srec-")), "a.db"));
  accounts.setDeploymentOwner(d.id, "alice");
  accounts.setSolanaAccount("alice", WALLET, "w1");
  const pos = (await t.engine.getSnapshot(d.id))!.positions[0]!;
  let held = BigInt(Math.round(pos.qty * 1e6));
  const rec = new SolanaReconciler(t.engine, accounts, { tokenBalance: async () => ({ amount: held, decimals: 6 }) }, () => t.clock.t);
  return { t, d, pos, rec, setHeld: (q: number) => (held = BigInt(Math.round(q * 1e6))) };
}

describe("Solana positions follow the wallet", () => {
  it("leaves new positions alone, waits for a second sighting, then closes a position that left the wallet", async () => {
    const { t, d, rec, setHeld } = await holding();
    setHeld(0);
    expect(await rec.run()).toEqual([]); // under three minutes old
    t.clock.t += 4 * 60_000;
    expect(await rec.run()).toEqual([]); // first sighting
    t.clock.t += 2 * 60_000;
    const done = await rec.run();
    expect(done).toHaveLength(1);
    const s = (await t.engine.getSnapshot(d.id))!;
    expect(s.positions).toHaveLength(0);
    expect((await t.engine.getFills(d.id)).at(-1)).toMatchObject({ reason: "outside", side: "sell" });
  });

  it("shrinks a position when part of it was moved, and ignores a blip that clears", async () => {
    const { t, d, pos, rec, setHeld } = await holding();
    t.clock.t += 4 * 60_000;
    setHeld(pos.qty * 0.5);
    await rec.run();
    setHeld(pos.qty); // RPC caught up: not a real shortfall
    t.clock.t += 2 * 60_000;
    expect(await rec.run()).toEqual([]);
    setHeld(pos.qty * 0.5);
    await rec.run();
    t.clock.t += 2 * 60_000;
    await rec.run();
    expect((await t.engine.getSnapshot(d.id))!.positions[0]!.qty).toBeCloseTo(pos.qty * 0.5, 4);
  });
});
