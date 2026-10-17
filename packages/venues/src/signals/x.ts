import type { Http } from "../http.ts";
import type { SignalProvider } from "../types.ts";
import { defineProvider, type Fields } from "./common.ts";

/**
 * Live X (Twitter) data through twitterapi.io (pay per tweet read, ~$0.15 per 1,000).
 *  - social: how much a cashtag/keyword/account is talked about and the tone of it
 *  - post_match: whether given accounts posted something matching a claim
 *
 * Every read is billed, so results are cached (social 5 min, posts 90 s) and searches are bounded
 * to recent tweets with since_time, so a quiet query costs almost nothing.
 */
export const TWITTERAPI_URL = "https://api.twitterapi.io";

export interface Tweet {
  id: string;
  text: string;
  at: number;
  author: string;
}

interface RawTweet {
  id: string;
  text?: string;
  createdAt?: string;
  author?: { userName?: string };
}

const toTweet = (t: RawTweet): Tweet | null => {
  const at = Date.parse(t.createdAt ?? "");
  return Number.isFinite(at) ? { id: String(t.id), text: t.text ?? "", at, author: (t.author?.userName ?? "").toLowerCase() } : null;
};

/** One page of the newest tweets for a search, oldest first. `full` is true when no older tweets matched. */
export async function searchTweets(http: Http, key: string, query: string, opts: { base?: string; ttlMs: number }): Promise<{ tweets: Tweet[]; full: boolean }> {
  const r = await http.json<{ tweets?: RawTweet[]; has_next_page?: boolean }>(
    `${opts.base ?? TWITTERAPI_URL}/twitter/tweet/advanced_search?queryType=Latest&query=${encodeURIComponent(query)}`,
    { headers: { "X-API-Key": key }, ttlMs: opts.ttlMs, timeoutMs: 20_000 }
  );
  const tweets = (r.tweets ?? []).map(toTweet).filter((t): t is Tweet => t != null).sort((a, b) => a.at - b.at);
  return { tweets, full: !r.has_next_page };
}

/** The search for a social signal's cashtags, keywords and accounts (any of them). */
export function socialQuery(p: { cashtags: string[]; keywords: string[]; accounts: string[] }): string {
  const parts = [
    ...p.cashtags.map((c) => `$${c.replace(/^\$+/, "")}`),
    ...p.keywords.map((k) => (/\s/.test(k) ? `"${k}"` : k)),
    ...p.accounts.map((a) => `from:${a.replace(/^@/, "")}`),
  ];
  return parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0] ?? "";
}

/**
 * Tweets per hour in a window. A full page (more tweets than one read returns) is extrapolated from
 * the time it spans, so busy cashtags don't need dozens of paid reads.
 */
export function perHour(page: { tweets: Tweet[]; full: boolean }, windowMs: number): number {
  const n = page.tweets.length;
  if (page.full || n < 2) return n * (3_600_000 / windowMs);
  const span = Math.max(60_000, page.tweets[n - 1]!.at - page.tweets[0]!.at);
  return Math.round((n / span) * 3_600_000);
}

const BULL = ["bullish", "moon", "mooning", "pump", "pumping", "send", "sending", "lfg", "wagmi", "buy", "buying", "long", "breakout", "ath", "rally", "up only", "gem", "undervalued", "accumulate", "accumulating", "🚀", "📈", "🔥"];
const BEAR = ["bearish", "dump", "dumping", "rug", "rugged", "scam", "rekt", "ngmi", "sell", "selling", "short", "crash", "dead", "exit", "hack", "hacked", "exploit", "overvalued", "top", "📉", "💀"];

/** −1 … 1 from a crypto-slang word list. Neutral tweets don't move it. */
export function tweetTone(texts: string[]): number | null {
  let p = 0;
  let n = 0;
  for (const raw of texts) {
    const t = ` ${raw.toLowerCase()} `;
    const hit = (w: string) => (/^[a-z ]+$/.test(w) ? new RegExp(`[^a-z]${w}[^a-z]`).test(t) : t.includes(w));
    const b = BULL.some(hit);
    const s = BEAR.some(hit);
    if (b && !s) p++;
    else if (s && !b) n++;
  }
  return p + n === 0 ? null : Math.round(((p - n) / (p + n)) * 100) / 100;
}

export function socialFields(now: Tweet[], nowFull: boolean, before: Tweet[], beforeFull: boolean): Fields {
  const H = 3_600_000;
  const rate = perHour({ tweets: now, full: nowFull }, H);
  const prev = perHour({ tweets: before, full: beforeFull }, H);
  const authors = new Set(now.map((t) => t.author)).size;
  const authorRate = now.length ? Math.round(authors * (rate / now.length)) : 0;
  return {
    mentions_1h: rate,
    mentions_change_1h_pct: prev > 0 ? Math.round(((rate - prev) / prev) * 100) : rate > 0 ? null : 0,
    unique_authors_1h: authorRate,
    sentiment: tweetTone(now.map((t) => t.text)),
  };
}

/** Scores how well each post matches a claim (0–1) and whether it contradicts it. */
export type PostMatcher = (claim: string, contradiction: string | undefined, posts: Tweet[]) => Promise<{ score: number; contradicts: boolean }[]>;

const words = (s: string) => s.toLowerCase().replace(/[$#@]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !["the", "and", "for", "with", "that", "this", "will", "about", "from", "has", "have", "are", "was", "post", "posts", "says", "tweet", "tweets"].includes(w));

/** Fallback matcher: share of the claim's words found in the post. */
export const keywordMatcher: PostMatcher = async (claim, contradiction, posts) => {
  const c = words(claim);
  const k = contradiction ? words(contradiction) : [];
  return posts.map((p) => {
    const text = ` ${p.text.toLowerCase()} `;
    const share = (ws: string[]) => (ws.length ? ws.filter((w) => text.includes(w)).length / ws.length : 0);
    return { score: Math.round(share(c) * 100) / 100, contradicts: k.length > 0 && share(k) >= 0.7 };
  });
};

export function xProviders(http: Http, key: string, opts: { base?: string; matcher?: PostMatcher; onError?: (k: string, e: unknown) => void } = {}): SignalProvider[] {
  const sec = (t: number) => Math.floor(t / 1000);
  const social = defineProvider(
    ["social"],
    "live",
    async (s, now) => {
      const q = socialQuery(s.params);
      if (!q) return null;
      // Rounded to the cache window so the same query reuses one paid read for five minutes.
      const t = Math.floor(now / 300_000) * 300_000;
      const [cur, prev] = await Promise.all([
        searchTweets(http, key, `${q} since_time:${sec(t - 3_600_000)}`, { base: opts.base, ttlMs: 300_000 }),
        searchTweets(http, key, `${q} since_time:${sec(t - 7_200_000)} until_time:${sec(t - 3_600_000)}`, { base: opts.base, ttlMs: 300_000 }),
      ]);
      return socialFields(cur.tweets, cur.full, prev.tweets, prev.full);
    },
    opts.onError
  );

  const matched = new Map<string, { score: number; contradicts: boolean }>();
  const postMatch = defineProvider(
    ["post_match"],
    "live",
    async (s, now) => {
      const accounts = s.params.accounts.map((a) => a.replace(/^@/, ""));
      const t = Math.floor(now / 90_000) * 90_000;
      const q = `(${accounts.map((a) => `from:${a}`).join(" OR ")}) since_time:${sec(t - 24 * 3_600_000)}`;
      const { tweets } = await searchTweets(http, key, q, { base: opts.base, ttlMs: 90_000 });
      // Each post is scored once per claim (the semantic matcher is a model call).
      const ck = `${s.params.claim}\u0000${s.params.contradiction ?? ""}`;
      const fresh = tweets.filter((p) => !matched.has(`${ck}\u0000${p.id}`));
      if (fresh.length) {
        const scores = await (opts.matcher ?? keywordMatcher)(s.params.claim, s.params.contradiction, fresh).catch(() => keywordMatcher(s.params.claim, s.params.contradiction, fresh));
        fresh.forEach((p, i) => matched.set(`${ck}\u0000${p.id}`, scores[i] ?? { score: 0, contradicts: false }));
        // Bounded memory: forget the oldest scores past 5,000 (insertion order).
        for (const k of matched.keys()) {
          if (matched.size <= 5_000) break;
          matched.delete(k);
        }
      }
      let best = 0;
      let bestAt: number | null = null;
      let contradicted = false;
      for (const p of tweets) {
        const m = matched.get(`${ck}\u0000${p.id}`)!;
        if (m.contradicts) contradicted = true;
        if (m.score > best || (m.score === best && m.score > 0 && (bestAt ?? 0) < p.at)) [best, bestAt] = [m.score, p.at];
      }
      const hit = best >= 0.7;
      return { matched: hit, match_score: best, contradicted, minutes_since_match: hit && bestAt != null ? Math.max(0, Math.round((now - bestAt) / 60_000)) : null };
    },
    opts.onError
  );
  return [social, postMatch];
}
