import { describe, expect, it } from "vitest";
import type { EngineEvent } from "@weft/engine";
import { createNotifier, sinksFromEnv, toAlert, type Alert, type AlertSink } from "../src/lib/alerts.ts";

function bus() {
  const ls = new Set<(e: EngineEvent) => void>();
  return {
    subscribe: (l: (e: EngineEvent) => void) => (ls.add(l), () => void ls.delete(l)),
    emit: (e: EngineEvent) => ls.forEach((l) => l(e)),
  };
}
const ev = (over: Partial<EngineEvent>): EngineEvent => ({ id: Math.random().toString(36), deploymentId: "d1", ts: 1, type: "tick", message: "", ...over });
const flush = () => new Promise((r) => setTimeout(r, 5));

describe("alerts", () => {
  it("only notify actions alert by default; fills when enabled; funding notices never", () => {
    expect(toAlert(ev({ type: "notify", message: "Buy signal", data: { actionId: "a", channel: "telegram" } }), false)?.text).toBe("Buy signal");
    expect(toAlert(ev({ type: "notify", message: "Funding paid", data: { funding: { amountUsd: 1 } } }), true)).toBeNull();
    expect(toAlert(ev({ type: "fill", message: "Bought" }), false)).toBeNull();
    expect(toAlert(ev({ type: "fill", message: "Bought" }), true)?.kind).toBe("fill");
    expect(toAlert(ev({ type: "tick", message: "tick" }), true)).toBeNull();
  });

  it("delivers to every sink with the strategy name, dedupes and rate-limits", async () => {
    const b = bus();
    const got: Alert[] = [];
    const sink: AlertSink = { name: "mem", send: async (a) => void got.push(a) };
    const n = createNotifier(b, [sink], { strategyName: async () => "PUMP dip", perMinute: 2, now: () => 1000 });
    const e = ev({ type: "notify", message: "PUMP entry", data: { actionId: "alert" } });
    b.emit(e);
    b.emit(e); // duplicate id
    b.emit(ev({ type: "notify", message: "2", data: { actionId: "alert" } }));
    b.emit(ev({ type: "notify", message: "3 (rate limited)", data: { actionId: "alert" } }));
    await flush();
    expect(got.map((a) => a.text)).toEqual(["PUMP entry", "2"]);
    expect(got[0]!.strategyName).toBe("PUMP dip");
    n.unsubscribe();
  });

  it("a failing sink never throws into the engine", async () => {
    const b = bus();
    let calls = 0;
    const logs: string[] = [];
    createNotifier(b, [{ name: "bad", send: async () => { calls++; throw new Error("down"); } }], { strategyName: async () => "x", log: (m) => logs.push(m) });
    expect(() => b.emit(ev({ type: "notify", message: "hi", data: { actionId: "a" } }))).not.toThrow();
    await flush();
    expect(calls).toBe(2); // one retry
    expect(logs[0]).toMatch(/failed: down/);
  });

  it("builds Telegram and webhook requests from env", async () => {
    const reqs: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      reqs.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const sinks = sinksFromEnv({ TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "42", WEFT_ALERT_WEBHOOK_URL: "https://hooks.example/x" }, fakeFetch);
    expect(sinks.map((s) => s.name)).toEqual(["telegram", "webhook"]);
    for (const s of sinks) await s.send({ deploymentId: "d", strategyName: "S", kind: "notify", text: "go", ts: 0 });
    expect(reqs[0]!.url).toBe("https://api.telegram.org/botT/sendMessage");
    expect(reqs[0]!.body).toMatchObject({ chat_id: "42", text: "◆ S\ngo" });
    expect(reqs[1]!.body).toMatchObject({ content: "**S**: go", strategyName: "S" });
    expect(sinksFromEnv({})).toEqual([]);
  });
});
