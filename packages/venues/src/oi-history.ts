import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Open-interest history sampler. Hyperliquid's public info API has no OI
 * history endpoint, so we record our own: every time a perp's OI is observed
 * (from `metaAndAssetCtxs`), the value is stored in a per-coin ring of
 * time buckets (default hourly, last value in a bucket wins, 30 days kept).
 * With a `path` the rings are persisted to a small JSON file (atomic
 * write-then-rename, at most every `flushIntervalMs`); without one they live
 * in memory only.
 *
 * `zscore(coin)` = (latest OI − mean) / stdev over the buckets in the window,
 * or null until at least `minSamples` buckets exist.
 */
export interface OiHistoryOptions {
  /** JSON file to persist to. Omit for in-memory only. */
  path?: string;
  /** Bucket width. Default 1 h. */
  bucketMs?: number;
  /** History kept / used for the z-score. Default 30 days. */
  windowMs?: number;
  /** Buckets needed before a z-score is reported. Default 24. */
  minSamples?: number;
  /** Persist at most this often (when something changed). Default 5 min. */
  flushIntervalMs?: number;
  /** Clock used for pruning when no timestamp is given. Default Date.now. */
  now?: () => number;
  /** Called when loading or writing the file fails (the sampler keeps working in memory). */
  onError?: (err: unknown) => void;
}

export interface OiSample {
  /** Bucket start, ms since epoch. */
  ts: number;
  oiUsd: number;
}

interface FileShape {
  version: 1;
  bucketMs: number;
  /** coin → [bucket index (ts / bucketMs), OI USD][] ascending */
  series: Record<string, [number, number][]>;
}

const HOUR = 3_600_000;

export class OiHistory {
  readonly path: string | undefined;
  readonly bucketMs: number;
  readonly windowMs: number;
  readonly minSamples: number;
  private readonly flushIntervalMs: number;
  private readonly clock: () => number;
  private readonly onError: ((err: unknown) => void) | undefined;
  /** coin → ascending [bucketIndex, oiUsd] */
  private readonly series = new Map<string, [number, number][]>();
  private dirty = false;
  private lastFlush = -Infinity;

  constructor(opts: OiHistoryOptions = {}) {
    this.path = opts.path;
    this.bucketMs = opts.bucketMs ?? HOUR;
    this.windowMs = opts.windowMs ?? 30 * 24 * HOUR;
    this.minSamples = opts.minSamples ?? 24;
    this.flushIntervalMs = opts.flushIntervalMs ?? 5 * 60_000;
    this.clock = opts.now ?? Date.now;
    this.onError = opts.onError;
    if (this.path) this.load(this.path);
  }

  /** Number of coins with history. */
  get size(): number {
    return this.series.size;
  }

  /** Record one observation. Non-finite or negative values are ignored. */
  record(coin: string, oiUsd: number, ts: number = this.clock()): void {
    if (!(oiUsd >= 0) || !Number.isFinite(oiUsd) || !Number.isFinite(ts)) return;
    const idx = Math.floor(ts / this.bucketMs);
    const value = Math.round(oiUsd);
    let ring = this.series.get(coin);
    if (!ring) {
      ring = [];
      this.series.set(coin, ring);
    }
    const last = ring[ring.length - 1];
    if (last && last[0] === idx) {
      if (last[1] !== value) {
        last[1] = value;
        this.dirty = true;
      }
    } else if (!last || last[0] < idx) {
      ring.push([idx, value]);
      this.dirty = true;
    } else {
      // Out-of-order observation (clock went backwards): insert or overwrite in place.
      const at = ring.findIndex((e) => e[0] >= idx);
      if (at >= 0 && ring[at]![0] === idx) ring[at]![1] = value;
      else ring.splice(at < 0 ? ring.length : at, 0, [idx, value]);
      this.dirty = true;
    }
    this.prune(ring, idx);
  }

  /** Record a batch (one metaAndAssetCtxs response), then persist if due. */
  observe(markets: Iterable<{ coin: string; openInterestUsd: number | null; isDelisted?: boolean }>, ts: number = this.clock()): void {
    for (const m of markets) if (m.openInterestUsd != null && !m.isDelisted) this.record(m.coin, m.openInterestUsd, ts);
    this.maybeFlush(ts);
  }

  /** Buckets currently held for a coin, ascending. */
  samples(coin: string, now: number = this.clock()): OiSample[] {
    const minIdx = this.minIndex(now);
    return (this.series.get(coin) ?? []).filter((e) => e[0] >= minIdx).map(([i, v]) => ({ ts: i * this.bucketMs, oiUsd: v }));
  }

  /**
   * z-score of the latest OI (or `current`, if given) against the buckets in the
   * window. Null until `minSamples` buckets exist. 0 when the history is flat.
   */
  zscore(coin: string, current?: number | null, now: number = this.clock()): number | null {
    const minIdx = this.minIndex(now);
    const vals = (this.series.get(coin) ?? []).filter((e) => e[0] >= minIdx).map((e) => e[1]);
    if (vals.length < this.minSamples) return null;
    const x = current ?? vals[vals.length - 1]!;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    const sd = Math.sqrt(variance);
    if (!(sd > 1e-9 * Math.max(1, Math.abs(mean)))) return 0;
    return (x - mean) / sd;
  }

  /** Write to disk now (no-op without a path or when nothing changed). */
  flush(now: number = this.clock()): void {
    if (!this.path || !this.dirty) return;
    const minIdx = this.minIndex(now);
    const series: FileShape["series"] = {};
    for (const [coin, ring] of this.series) {
      const kept = ring.filter((e) => e[0] >= minIdx);
      if (kept.length) series[coin] = kept;
    }
    const data: FileShape = { version: 1, bucketMs: this.bucketMs, series };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, this.path);
      this.dirty = false;
      this.lastFlush = now;
    } catch (e) {
      // Keep sampling in memory; retry at the next interval.
      this.lastFlush = now;
      this.onError?.(e);
    }
  }

  private maybeFlush(now: number): void {
    if (this.path && this.dirty && (now - this.lastFlush >= this.flushIntervalMs || now < this.lastFlush)) this.flush(now);
  }

  private minIndex(now: number): number {
    return Math.floor((now - this.windowMs) / this.bucketMs) + 1;
  }

  private prune(ring: [number, number][], latestIdx: number): void {
    const minIdx = latestIdx - Math.ceil(this.windowMs / this.bucketMs) + 1;
    let drop = 0;
    while (drop < ring.length && ring[drop]![0] < minIdx) drop++;
    if (drop) ring.splice(0, drop);
  }

  private load(path: string): void {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.onError?.(e);
      return;
    }
    try {
      const data = JSON.parse(text) as Partial<FileShape>;
      if (data.version !== 1 || data.bucketMs !== this.bucketMs || typeof data.series !== "object" || !data.series) return;
      for (const [coin, ring] of Object.entries(data.series)) {
        if (!Array.isArray(ring)) continue;
        const clean = ring
          .filter((e): e is [number, number] => Array.isArray(e) && Number.isInteger(e[0]) && typeof e[1] === "number" && Number.isFinite(e[1]))
          .sort((a, b) => a[0] - b[0]);
        if (clean.length) this.series.set(coin, clean);
      }
    } catch (e) {
      this.onError?.(e);
    }
  }
}
