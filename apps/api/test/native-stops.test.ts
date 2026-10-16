import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloidFromKey, type HyperliquidExecutor } from "@weft/execution";
import type { Engine } from "@weft/engine";
import { Accounts } from "../src/lib/accounts.ts";
import { NativeStops } from "../src/live/native-stops.ts";

const ETH = { kind: "perp" as const, venue: "hyperliquid" as const, symbol: "ETH", assetClass: "crypto" as const };

function world() {
  const accounts = new Accounts(join(mkdtempSync(join(tmpdir(), "weft-ns-")), "a.db"));
  accounts.setDeploymentOwner("d1", "u1");
  const position = { id: "p1", instrument: ETH, side: "long" as const, leverage: 20, qty: 0.041, entryPrice: 2000, openedAt: 0, exits: { stopLoss: { positionPct: 20 } } as Record<string, unknown> };
  const state = { positions: [position], venueHas: true };
  const reconciled: unknown[] = [];
  const engine = {
    listDeployments: async () => [{ id: "d1", mode: "live", status: "running" }],
    getSnapshot: async () => ({ positions: state.positions }),
    reconcilePosition: async (...a: unknown[]) => (reconciled.push(a), 0.041),
  } as unknown as Engine;
  const resting: { coin: string; cloid: string; triggerPx: string }[] = [];
  const placed: { px: number; kind: string }[] = [];
  const cancelled: string[] = [];
  const ex = {
    setPositionTpsl: async (p: { clientId: string; stopLoss?: number; takeProfit?: number }) => {
      const kind = p.stopLoss != null ? "sl" : "tp";
      const px = (p.stopLoss ?? p.takeProfit)!;
      placed.push({ px, kind });
      resting.push({ coin: "ETH", cloid: cloidFromKey(`${p.clientId}:${kind}`), triggerPx: String(px) });
      return { statuses: [{ resting: { oid: placed.length } }] };
    },
    cancel: async (p: { cloid: string }) => {
      cancelled.push(p.cloid);
      resting.splice(resting.findIndex((o) => o.cloid === p.cloid), 1);
    },
  } as unknown as HyperliquidExecutor;
  const fetch = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { type: string };
    const payload =
      body.type === "frontendOpenOrders"
        ? resting
        : { assetPositions: state.venueHas ? [{ position: { coin: "ETH", szi: "0.041" } }] : [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
  };
  const ns = new NativeStops({ engine, accounts, executorFor: async () => ex, addressOf: () => "0xabc", baseUrl: "https://hl", fetch: fetch as never });
  return { ns, state, position, placed, cancelled, resting, reconciled, accounts };
}

describe("venue-side stops on Hyperliquid", () => {
  it("places a stop at the price that loses 20% of the position at 20× (−1%), once", async () => {
    const w = world();
    await w.ns.run();
    expect(w.placed).toEqual([{ px: 1980, kind: "sl" }]);
    await w.ns.run();
    expect(w.placed).toHaveLength(1); // already resting: nothing new
  });

  it("moves the stop when the owner changes it, removes it when they remove it, adds a take-profit", async () => {
    const w = world();
    await w.ns.run();
    w.position.exits = { stopLoss: { positionPct: 10 }, takeProfit: { positionPct: 50 } };
    await w.ns.run();
    expect(w.placed.slice(1)).toEqual([{ px: 1990, kind: "sl" }, { px: 2050, kind: "tp" }]);
    expect(w.cancelled).toHaveLength(1);
    w.position.exits = {};
    await w.ns.run();
    expect(w.resting).toHaveLength(0);
  });

  it("re-places a stop that disappeared from the venue, and survives a restart without duplicating", async () => {
    const w = world();
    await w.ns.run();
    w.resting.length = 0; // e.g. cancelled by hand on Hyperliquid
    await w.ns.run();
    expect(w.placed).toHaveLength(2);
    const again = new NativeStops({ ...(w.ns as unknown as { d: ConstructorParameters<typeof NativeStops>[0] }).d });
    await again.run();
    expect(w.placed).toHaveLength(2);
  });

  it("books the position out when Hyperliquid closed it (seen gone twice), and cleans up when a run closes it", async () => {
    const w = world();
    await w.ns.run();
    w.state.venueHas = false;
    await w.ns.run();
    expect(w.reconciled).toHaveLength(0); // one sighting is not enough
    await w.ns.run();
    expect(w.reconciled).toEqual([["d1", "p1", 0]]);

    const v = world();
    await v.ns.run();
    v.state.positions = [];
    await v.ns.run();
    expect(v.cancelled).toHaveLength(1);
    expect(v.resting).toHaveLength(0);
  });
});
