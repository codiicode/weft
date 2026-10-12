import { describe, expect, it } from "vitest";
import { Http, HttpError } from "../src/http.ts";
import { mockFetch } from "./helpers.ts";

const noSleep = async () => {};

describe("Http", () => {
  it("caches successful responses for ttl and expires them", async () => {
    let t = 0;
    let n = 0;
    const f = mockFetch(() => ({ n: ++n }));
    const http = new Http({ fetch: f, now: () => t, sleep: noSleep });
    expect(await http.json("https://x.test/a", { ttlMs: 1000 })).toEqual({ n: 1 });
    expect(await http.json("https://x.test/a", { ttlMs: 1000 })).toEqual({ n: 1 });
    expect(http.stats.cacheHits).toBe(1);
    t = 1001;
    expect(await http.json("https://x.test/a", { ttlMs: 1000 })).toEqual({ n: 2 });
  });

  it("keys the cache by POST body", async () => {
    const f = mockFetch((_u, body) => ({ echo: body.type }));
    const http = new Http({ fetch: f, sleep: noSleep });
    const a = await http.json("https://x.test/info", { method: "POST", body: { type: "a" }, ttlMs: 1000 });
    const b = await http.json("https://x.test/info", { method: "POST", body: { type: "b" }, ttlMs: 1000 });
    expect([a, b]).toEqual([{ echo: "a" }, { echo: "b" }]);
    expect(f.calls).toHaveLength(2);
  });

  it("coalesces concurrent identical requests", async () => {
    const f = mockFetch(() => ({ ok: true }));
    const http = new Http({ fetch: f, sleep: noSleep });
    await Promise.all([1, 2, 3, 4].map(() => http.json("https://x.test/same")));
    expect(f.calls).toHaveLength(1);
    expect(http.stats.coalesced).toBe(3);
  });

  it("retries 429 and 5xx with backoff, then succeeds", async () => {
    let i = 0;
    const sleeps: number[] = [];
    const f = mockFetch(() => {
      i++;
      if (i === 1) return { status: 429, body: "slow down", headers: { "retry-after": "1" } };
      if (i === 2) return { status: 503, body: "busy" };
      return { ok: i };
    });
    const http = new Http({ fetch: f, retries: 3, sleep: async (ms) => void sleeps.push(ms) });
    expect(await http.json("https://x.test/r")).toEqual({ ok: 3 });
    expect(sleeps[0]).toBe(1000); // Retry-After honoured
    expect(sleeps).toHaveLength(2);
  });

  it("does not retry 4xx (other than 429)", async () => {
    const f = mockFetch(() => ({ status: 400, body: "bad" }));
    const http = new Http({ fetch: f, retries: 3, sleep: noSleep });
    await expect(http.json("https://x.test/bad")).rejects.toBeInstanceOf(HttpError);
    expect(f.calls).toHaveLength(1);
  });

  it("retries network errors and gives up after `retries`", async () => {
    let calls = 0;
    const http = new Http({
      fetch: async () => {
        calls++;
        throw new TypeError("fetch failed");
      },
      retries: 2,
      sleep: noSleep,
    });
    await expect(http.text("https://x.test/down")).rejects.toThrow("fetch failed");
    expect(calls).toBe(3);
  });

  it("caps concurrency per host", async () => {
    let active = 0;
    let peak = 0;
    const http = new Http({
      maxPerHost: 2,
      fetch: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return new Response("{}");
      },
    });
    await Promise.all([1, 2, 3, 4, 5, 6].map((i) => http.json(`https://x.test/${i}`)));
    expect(peak).toBe(2);
  });
});
