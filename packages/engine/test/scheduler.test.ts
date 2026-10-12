import { afterEach, describe, expect, it, vi } from "vitest";
import { defineStrategy } from "@weft/strategy";
import { createEngine, MemoryStore } from "../src/index.ts";
import { deferred, FakeMarket, FakeSignals, T0 } from "./fakes.ts";

const watch = (id: string, kind: "macro" | "forecast") =>
  defineStrategy({
    schemaVersion: 1,
    id,
    name: id,
    thesis: "alerts only",
    signals: kind === "macro" ? [{ id: "x", kind, params: { series: "X" } }] : [{ id: "x", kind, params: { source: "s", series: "X" } }],
    triggers: [{ id: "t", when: { op: "gt", left: { ref: "x.value" }, right: { value: 100 } } }],
    actions: [{ id: "n", type: "notify", on: ["t"], message: "hi" }],
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduler", () => {
  it("runs deployments on their interval, never overlaps a deployment's ticks, isolates slow ones, and drains on shutdown", async () => {
    vi.useFakeTimers({ now: T0 });
    const gate = deferred();
    let active = 0;
    let maxActive = 0;
    let slowCalls = 0;
    let fastCalls = 0;

    const slow = new FakeSignals(["macro"]).set("x", async (_sig, now) => {
      slowCalls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await gate.promise;
      active--;
      return { asOf: now, fields: { value: 1 } };
    });
    const fast = new FakeSignals(["forecast"]).set("x", async (_sig, now) => {
      fastCalls++;
      return { asOf: now, fields: { value: 1 } };
    });

    const engine = createEngine({
      store: new MemoryStore(),
      marketData: new FakeMarket(),
      signalProviders: [slow, fast],
      schedulerResolutionMs: 100,
      signalTimeoutMs: 60_000,
    });
    const a = await engine.createDeployment({ strategy: watch("slow-one", "macro"), allocationUsd: 1_000, intervalSec: 1 });
    const b = await engine.createDeployment({ strategy: watch("fast-one", "forecast"), allocationUsd: 1_000, intervalSec: 1 });
    expect(a.intervalSec).toBe(1);

    engine.start();
    await vi.advanceTimersByTimeAsync(5_050);
    expect(slowCalls).toBe(1); // stuck tick is not re-entered
    expect(maxActive).toBe(1);
    expect(fastCalls).toBeGreaterThanOrEqual(5); // the other deployment keeps ticking
    expect(fastCalls).toBeLessThanOrEqual(6);

    // A manual tick waits for the in-flight one instead of overlapping it.
    let manualDone = false;
    const manual = engine.tick(a.id).then(() => (manualDone = true));
    await vi.advanceTimersByTimeAsync(500);
    expect(manualDone).toBe(false);
    expect(maxActive).toBe(1);

    // Shutdown waits for in-flight ticks.
    let down = false;
    const sd = engine.shutdown().then(() => (down = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(down).toBe(false);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await sd;
    await manual;
    expect(down).toBe(true);
    expect(manualDone).toBe(true);
    expect(maxActive).toBe(1);
    expect(slowCalls).toBe(2);

    // After shutdown nothing else runs.
    const calls = fastCalls;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fastCalls).toBe(calls);
    expect((await engine.getSnapshot(b.id))!.lastTickAt).not.toBeNull();
  });

  it("an error in one deployment does not stop the others", async () => {
    vi.useFakeTimers({ now: T0 });
    const store = new MemoryStore();
    const fast = new FakeSignals(["forecast", "macro"]).set("x", async (_s, now) => ({ asOf: now, fields: { value: 1 } }));
    const engine = createEngine({ store, marketData: new FakeMarket(), signalProviders: [fast], schedulerResolutionMs: 100 });
    const a = await engine.createDeployment({ strategy: watch("breaks", "macro"), allocationUsd: 1_000, intervalSec: 1 });
    const b = await engine.createDeployment({ strategy: watch("works", "forecast"), allocationUsd: 1_000, intervalSec: 1 });
    // Corrupt deployment A's runtime so its tick throws.
    const rt = (await store.getRuntime(a.id))!;
    await store.commit({ deploymentId: a.id, runtime: { ...rt, lastSnapshots: null as never } });
    engine.start();
    await vi.advanceTimersByTimeAsync(3_050);
    await engine.shutdown();
    const errs = (await engine.getEvents(a.id)).filter((e) => e.type === "error");
    expect(errs.length).toBeGreaterThanOrEqual(2);
    expect((await engine.getSnapshot(b.id))!.lastTickAt).toBe(T0 + 3_000);
  });
});
