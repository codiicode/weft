import type { Context, MiddlewareHandler } from "hono";

/**
 * Small in-memory rate limits (one process, one box). Keys by client IP:
 * the first X-Forwarded-For hop when behind a proxy, else the socket address.
 */

export function clientIp(c: Context): string {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

type Bucket = { tokens: number; at: number };

/** Token bucket: `perMinute` requests per minute with bursts up to `burst`. */
export function rateLimit(name: string, perMinute: number, burst = Math.max(5, Math.ceil(perMinute / 4))): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  const rate = perMinute / 60_000;
  let sweep = Date.now();
  return async (c, next) => {
    const now = Date.now();
    if (now - sweep > 120_000) {
      for (const [k, b] of buckets) if (now - b.at > 600_000) buckets.delete(k);
      sweep = now;
    }
    const key = clientIp(c);
    // In-process requests (tests, internal calls) have no client address: nothing to limit.
    if (key === "unknown") return next();
    const b = buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + (now - b.at) * rate);
    b.at = now;
    if (b.tokens < 1) {
      buckets.set(key, b);
      c.header("Retry-After", String(Math.ceil((1 - b.tokens) / rate / 1000)));
      return c.json({ error: `too many requests (${name}), slow down` }, 429);
    }
    b.tokens -= 1;
    buckets.set(key, b);
    await next();
  };
}

/** Caps concurrent long-lived connections (SSE) per client IP. */
export function connectionCap(max: number) {
  const open = new Map<string, number>();
  return {
    acquire(c: Context): (() => void) | null {
      const key = clientIp(c);
      const n = open.get(key) ?? 0;
      if (n >= max) return null;
      open.set(key, n + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const m = (open.get(key) ?? 1) - 1;
        if (m <= 0) open.delete(key);
        else open.set(key, m);
      };
    },
  };
}

/** Clamp a numeric query parameter. */
export function clampQuery(v: string | undefined, def: number, max: number): number {
  const n = Number(v ?? def);
  return Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : def;
}
