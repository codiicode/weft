import { describe, expect, it } from "vitest";
import { modelFields, newsFields, postMatchFields, seedOf, smooth, socialFields, valueNoise } from "../src/signals/simulated.ts";

const T = Date.parse("2026-10-12T13:00:00Z");

describe("simulated signals", () => {
  it("are deterministic for the same params and time", () => {
    const s = seedOf("social", { cashtags: ["PUMP"], keywords: [], accounts: [], platform: "x" });
    expect(socialFields(s, T)).toEqual(socialFields(s, T));
    expect(seedOf("x", { b: 1, a: [2] })).toBe(seedOf("x", { a: [2], b: 1 })); // key order independent
  });

  it("differ across params", () => {
    expect(socialFields(seedOf("social", { cashtags: ["PUMP"] }), T)).not.toEqual(socialFields(seedOf("social", { cashtags: ["WIF"] }), T));
  });

  it("change slowly (continuous noise)", () => {
    const s = seedOf("social", { cashtags: ["PUMP"] });
    expect(Math.abs(smooth(s, T + 60_000) - smooth(s, T))).toBeLessThan(0.05);
    for (let x = 0; x < 10; x += 0.37) expect(Math.abs(valueNoise("n", x))).toBeLessThanOrEqual(1);
  });

  it("stay in range", () => {
    for (let i = 0; i < 200; i++) {
      const t = T + i * 37 * 60_000;
      const so = socialFields(seedOf("social", { keywords: ["El Niño"] }), t);
      expect(so.sentiment).toBeGreaterThanOrEqual(-1);
      expect(so.sentiment).toBeLessThanOrEqual(1);
      expect(so.mentions_1h).toBeGreaterThanOrEqual(0);
      expect(so.unique_authors_1h as number).toBeLessThanOrEqual(so.mentions_1h as number);
      const n = newsFields(seedOf("news", { query: "wheat" }), t);
      expect(n.max_relevance).toBeGreaterThanOrEqual(0);
      expect(n.max_relevance).toBeLessThanOrEqual(1);
      const m = modelFields(seedOf("model", { question: "q?" }), t, 0.6);
      expect(m.prob).toBeGreaterThan(0);
      expect(m.prob).toBeLessThan(1);
      expect(Math.abs((m.prob as number) - 0.6)).toBeLessThanOrEqual(0.13);
    }
  });

  it("post_match matches occasionally and reports minutes since", () => {
    const seed = seedOf("post_match", { accounts: ["@fed"], claim: "cut in december" });
    let matched = 0;
    for (let i = 0; i < 400; i++) {
      const f = postMatchFields(seed, T + i * 3_600_000, true);
      if (f.matched) {
        matched++;
        expect(f.minutes_since_match).toBeGreaterThanOrEqual(0);
        expect(f.match_score).toBeGreaterThanOrEqual(0.8);
      } else expect(f.minutes_since_match).toBeNull();
    }
    expect(matched).toBeGreaterThan(0);
    expect(matched).toBeLessThan(400);
  });
});
