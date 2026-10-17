import { describe, expect, it } from "vitest";
import { Http, HeliusWallets } from "@weft/venues";
import { HeliusWebhook } from "../src/live/helius-webhook.ts";

const W1 = "Wa11et1111111111111111111111111111111111111";
const W2 = "Wa11et2222222222222222222222222222222222222";

function setup() {
  const kv = new Map<string, string>();
  const calls: { method: string; url: string; body?: { accountAddresses: string[] } }[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ webhookID: "wh1" }), { status: 200 });
  }) as typeof fetch;
  const active: string[][] = [];
  const wallets = new HeliusWallets(new Http(), "key");
  const hook = new HeliusWebhook({ apiKey: "key", publicUrl: "https://api.example", wallets, kvGet: (k) => kv.get(k) ?? null, kvSet: (k, v) => kv.set(k, v), onActivity: (a) => active.push(a), fetch: fakeFetch });
  return { hook, calls, active, kv, wallets };
}

describe("Helius webhook", () => {
  it("creates once, updates on change, skips when unchanged, removes when empty", async () => {
    const { hook, calls } = setup();
    await hook.sync([W1]);
    await hook.sync([W1]);
    await hook.sync([W1, W2]);
    await hook.sync([]);
    expect(calls.map((c) => c.method)).toEqual(["POST", "PUT", "DELETE"]);
    expect(calls[0]!.url).toContain("/v0/webhooks?api-key=key");
    expect(calls[1]!.body!.accountAddresses).toEqual([W1, W2]);
    expect(hook.url).toBe("https://api.example/webhooks/helius");
  });

  it("only accepts its own secret, and reports which watched wallets traded", async () => {
    const { hook, active, kv, wallets } = setup();
    await hook.sync([W1]);
    const secret = JSON.parse(kv.get("helius-webhook")!).secret as string;
    expect(hook.authorized(undefined)).toBe(false);
    expect(hook.authorized("wrong")).toBe(false);
    expect(hook.authorized(secret)).toBe(true);
    const tx = { signature: "s1", timestamp: 1_792_000_000, feePayer: W1, tokenTransfers: [{ mint: "M", tokenAmount: 1, fromUserAccount: "pool", toUserAccount: W1 }], accountData: [] };
    expect(hook.handle([tx, { ...tx, signature: "s2", feePayer: "someone", tokenTransfers: [] }])).toEqual([W1]);
    expect(active).toEqual([[W1]]);
    // The pushed transaction is served from the cache without asking Helius.
    expect((await wallets.txs(W1)).map((t) => t.signature)).toEqual(["s1"]);
  });
});
