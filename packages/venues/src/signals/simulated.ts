import type { OutcomeInstrument } from "@weft/strategy";
import type { SignalProvider } from "../types.ts";
import { clamp } from "../util.ts";
import { defineProvider, type Fields } from "./common.ts";

/**
 * SIMULATED providers (mode: "simulated"): stand-ins until paid feeds are wired.
 *  - social, post_match → X API (Pro/Enterprise) + an embedding model for claim matching
 *  - news               → a news API (e.g. NewsAPI / Benzinga / Tiingo)
 *  - model              → Weft's own forecasting model
 *
 * Values are deterministic: a smooth multi-octave value noise seeded by the
 * signal params and evaluated at `now`. The same (params, now) always yields
 * the same snapshot, nearby times give nearby values, and series drift slowly
 * (dominant period 6h), so backtests and paper runs are reproducible.
 */

const HOUR = 3_600_000;

/** FNV-1a 32-bit. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic uniform [0,1) for (seed, key). */
export function rand(seed: string, key: string | number): number {
  let t = (hash32(`${seed}|${key}`) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Smooth value noise in [-1, 1] over x (one lattice point per unit). */
export function valueNoise(seed: string, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = rand(seed, i) * 2 - 1;
  const b = rand(seed, i + 1) * 2 - 1;
  const s = f * f * (3 - 2 * f);
  return a + (b - a) * s;
}

/** Multi-octave noise in roughly [-1, 1]: 6h, 1h and 15m periods. */
export function smooth(seed: string, t: number): number {
  return 0.6 * valueNoise(`${seed}:6h`, t / (6 * HOUR)) + 0.3 * valueNoise(`${seed}:1h`, t / HOUR) + 0.1 * valueNoise(`${seed}:15m`, t / (HOUR / 4));
}

/** Stable seed from params (key order independent). */
export function seedOf(kind: string, params: unknown): string {
  const norm = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(norm)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]))
        : typeof v === "string"
          ? v.toLowerCase()
          : v;
  return `${kind}:${JSON.stringify(norm(params))}`;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function socialFields(seed: string, now: number): Fields {
  const base = 10 ** (1.5 + 2 * rand(seed, "base")); // ~30 … 3000 mentions/h
  const m = (t: number) => base * Math.exp(0.9 * smooth(`${seed}:m`, t));
  const cur = m(now);
  const prev = m(now - HOUR);
  const authorsShare = 0.35 + 0.25 * (0.5 + 0.5 * valueNoise(`${seed}:u`, now / (6 * HOUR)));
  const bias = rand(seed, "bias") * 2 - 1;
  return {
    mentions_1h: Math.round(cur),
    mentions_change_1h_pct: r2((cur / prev - 1) * 100),
    unique_authors_1h: Math.round(cur * authorsShare),
    sentiment: r3(clamp(0.15 * bias + 0.6 * smooth(`${seed}:s`, now), -1, 1)),
  };
}

export function newsFields(seed: string, now: number): Fields {
  const base = 1 + 30 * rand(seed, "base");
  return {
    articles_1h: Math.max(0, Math.round(base * Math.exp(0.8 * smooth(`${seed}:a`, now)) - 1)),
    sentiment: r3(clamp(0.1 * (rand(seed, "bias") * 2 - 1) + 0.6 * smooth(`${seed}:s`, now), -1, 1)),
    max_relevance: r3(clamp(0.55 + 0.4 * smooth(`${seed}:r`, now), 0, 1)),
  };
}

/** A match happens in ~12% of 6h windows; one may be contradicted a bit later. Lookback 48h. */
export function postMatchFields(seed: string, now: number, hasContradiction: boolean): Fields {
  const W = 6 * HOUR;
  const k0 = Math.floor(now / W);
  for (let k = k0; k >= k0 - 8; k--) {
    if (rand(seed, `pm${k}`) >= 0.12) continue;
    const at = k * W + rand(seed, `pt${k}`) * W;
    if (at > now) continue;
    const contradictedAt = hasContradiction && rand(seed, `c${k}`) < 0.2 ? at + rand(seed, `ct${k}`) * 3 * HOUR : null;
    return {
      matched: true,
      match_score: r3(0.8 + 0.18 * rand(seed, `ps${k}`)),
      contradicted: contradictedAt != null && contradictedAt <= now,
      minutes_since_match: Math.round((now - at) / 60_000),
    };
  }
  return {
    matched: false,
    match_score: r3(0.25 + 0.2 * (smooth(`${seed}:near`, now) + 1)),
    contradicted: false,
    minutes_since_match: null,
  };
}

export function modelFields(seed: string, now: number, anchor: number | null): Fields {
  const prob =
    anchor != null
      ? clamp(anchor + 0.12 * smooth(`${seed}:p`, now), 0.02, 0.98)
      : clamp(0.5 + 0.3 * (rand(seed, "bias") * 2 - 1) + 0.15 * smooth(`${seed}:p`, now), 0.02, 0.98);
  return {
    prob: r3(prob),
    confidence: r3(0.45 + 0.35 * (0.5 + 0.5 * valueNoise(`${seed}:c`, now / (12 * HOUR)))),
  };
}

export function simulatedProviders(opts: { marketProb?: (i: OutcomeInstrument) => Promise<number | null> } = {}): SignalProvider[] {
  return [
    defineProvider(["social"], "simulated", async (s, now) => socialFields(seedOf("social", s.params), now)),
    defineProvider(["news"], "simulated", async (s, now) => newsFields(seedOf("news", s.params), now)),
    defineProvider(["post_match"], "simulated", async (s, now) =>
      postMatchFields(seedOf("post_match", s.params), now, !!s.params.contradiction)
    ),
    defineProvider(["model"], "simulated", async (s, now) => {
      // Anchored to the live market price when an instrument is given, so the "edge" looks plausible.
      const anchor = s.params.instrument && opts.marketProb ? await opts.marketProb(s.params.instrument).catch(() => null) : null;
      return modelFields(seedOf("model", { question: s.params.question }), now, anchor);
    }),
  ];
}
