import { describe, expect, it } from "vitest";
import { fomoLookup } from "../src/lib/fomo.ts";

describe("Fomo trader lookup", () => {
  it("resolves a handle to its addresses, keeps the answer, and remembers unknown handles", async () => {
    const kv = new Map<string, string>();
    let calls = 0;
    const fetch = (async (url: string, init: RequestInit) => {
      calls++;
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
      if (url.endsWith("/nobody")) return new Response(JSON.stringify({ error: "trader not found" }), { status: 404 });
      return new Response(JSON.stringify({ handle: "Frank", displayName: "Frank", followers: 9000, verified: true, wallets: { solana: "7xKpQ2mVb9fQe4tLr8NcZs1Wd3Hy6Ju5AgxEk9fQe", evm: "0xABCDEF0123456789abcdef0123456789ABCDEF01" } }), { status: 200 });
    }) as typeof globalThis.fetch;
    const look = fomoLookup({ key: "k", kvGet: (k) => kv.get(k) ?? null, kvSet: (k, v) => void kv.set(k, v), fetch });
    expect(await look("@Frank")).toMatchObject({ handle: "frank", verified: true, evm: "0xabcdef0123456789abcdef0123456789abcdef01", solana: "7xKpQ2mVb9fQe4tLr8NcZs1Wd3Hy6Ju5AgxEk9fQe" });
    expect(await look("frank")).toMatchObject({ handle: "frank" });
    expect(await look("nobody")).toBeNull();
    expect(await look("nobody")).toBeNull();
    expect(calls).toBe(2); // one per handle; the rest came from what was kept
    expect(await look("not a handle!")).toBeNull();
  });
});
