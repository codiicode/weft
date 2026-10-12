/**
 * Small HTTP layer shared by every venue client:
 * - timeout per request (AbortSignal)
 * - retry with exponential backoff + jitter on network errors, 429 and 5xx (honours Retry-After)
 * - in-memory TTL cache keyed by method + url + body
 * - request coalescing: concurrent identical requests share one in-flight promise
 * - per-host concurrency cap, so a burst of signals can't hammer one API
 *
 * `fetch` is injectable so tests never touch the network.
 */

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch?: FetchFn;
  /** Default per-request timeout, ms. */
  timeoutMs?: number;
  /** Default retry count (attempts = retries + 1). */
  retries?: number;
  /** Base backoff, ms. */
  backoffMs?: number;
  /** Max concurrent requests per host. */
  maxPerHost?: number;
  /** Max cache entries before the oldest are evicted. */
  maxCacheEntries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  /** JSON body (POST). */
  body?: unknown;
  headers?: Record<string, string>;
  /** Cache successful responses for this long. 0 = no cache (still coalesced). */
  ttlMs?: number;
  timeoutMs?: number;
  retries?: number;
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body?: string;
  constructor(status: number, url: string, body?: string) {
    super(`HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

export class Http {
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly maxPerHost: number;
  private readonly maxCacheEntries: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly cache = new Map<string, { expires: number; value: unknown }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly hostActive = new Map<string, number>();
  private readonly hostQueue = new Map<string, (() => void)[]>();

  /** Counters, handy for smoke output and tests. */
  readonly stats = { requests: 0, cacheHits: 0, coalesced: 0, retries: 0 };

  constructor(opts: HttpOptions = {}) {
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = opts.retries ?? 2;
    this.backoffMs = opts.backoffMs ?? 300;
    this.maxPerHost = opts.maxPerHost ?? 6;
    this.maxCacheEntries = opts.maxCacheEntries ?? 1_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  json<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
    return this.request(url, opts, "json") as Promise<T>;
  }

  text(url: string, opts: RequestOptions = {}): Promise<string> {
    return this.request(url, opts, "text") as Promise<string>;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private request(url: string, opts: RequestOptions, as: "json" | "text"): Promise<unknown> {
    const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const key = `${as} ${method} ${url} ${bodyStr ?? ""}`;
    const ttl = opts.ttlMs ?? 0;

    if (ttl > 0) {
      const hit = this.cache.get(key);
      if (hit && hit.expires > this.now()) {
        this.stats.cacheHits++;
        return Promise.resolve(hit.value);
      }
      if (hit) this.cache.delete(key);
    }
    const pending = this.inflight.get(key);
    if (pending) {
      this.stats.coalesced++;
      return pending;
    }

    const p = this.withHostSlot(url, () => this.doFetch(url, method, bodyStr, opts, as))
      .then((value) => {
        if (ttl > 0) this.store(key, value, ttl);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private store(key: string, value: unknown, ttl: number) {
    this.cache.set(key, { expires: this.now() + ttl, value });
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async doFetch(
    url: string,
    method: string,
    body: string | undefined,
    opts: RequestOptions,
    as: "json" | "text"
  ): Promise<unknown> {
    const retries = opts.retries ?? this.retries;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) this.stats.retries++;
      try {
        this.stats.requests++;
        const res = await this.fetchFn(url, {
          method,
          body,
          headers: {
            accept: "application/json, text/plain, */*",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            ...opts.headers,
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const err = new HttpError(res.status, url, text);
          if (RETRYABLE(res.status) && attempt < retries) {
            lastErr = err;
            await this.sleep(this.backoff(attempt, res.headers.get("retry-after")));
            continue;
          }
          throw err;
        }
        if (as === "text") return await res.text();
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          throw new HttpError(res.status, url, `invalid JSON: ${text.slice(0, 120)}`);
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        // network error / timeout: retry
        lastErr = err;
        if (attempt < retries) {
          await this.sleep(this.backoff(attempt, null));
          continue;
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`request failed: ${url}`);
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    const ra = retryAfter ? Number(retryAfter) : NaN;
    if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 5_000);
    const base = this.backoffMs * 2 ** attempt;
    return base + Math.floor(Math.random() * base * 0.3);
  }

  private async withHostSlot<T>(url: string, fn: () => Promise<T>): Promise<T> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      host = "";
    }
    const active = this.hostActive.get(host) ?? 0;
    if (active >= this.maxPerHost) {
      await new Promise<void>((resolve) => {
        const q = this.hostQueue.get(host) ?? [];
        q.push(resolve);
        this.hostQueue.set(host, q);
      });
    } else {
      this.hostActive.set(host, active + 1);
    }
    try {
      return await fn();
    } finally {
      const next = this.hostQueue.get(host)?.shift();
      if (next) next(); // hand the slot over without decrementing
      else this.hostActive.set(host, (this.hostActive.get(host) ?? 1) - 1);
    }
  }
}
