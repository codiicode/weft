/** Parse a venue number (often a string) into a finite number, else null. */
export function num(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Percent change from `from` to `to`, null if not computable. */
export function pctChange(to: number | null | undefined, from: number | null | undefined): number | null {
  if (to == null || from == null || from === 0) return null;
  return ((to - from) / from) * 100;
}

export function round(x: number, dp = 6): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

/** Case-insensitive "contains" over several optional strings. */
export function matchesSearch(search: string | undefined, ...fields: (string | null | undefined)[]): boolean {
  if (!search) return true;
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => f != null && f.toLowerCase().includes(q));
}

/** "20261012-1335" → ms since epoch (UTC), as used in HIP-4 outcome descriptions. */
export function parseCompactUtc(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:-(\d{2})(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
}

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isoMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Run async mappers with bounded concurrency, keeping order; failures become null. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx]!);
      } catch {
        out[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}
