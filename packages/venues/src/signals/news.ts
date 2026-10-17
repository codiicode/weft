import type { Http } from "../http.ts";
import type { SignalProvider } from "../types.ts";
import { defineProvider, type Fields } from "./common.ts";

/**
 * Live news from public RSS feeds (crypto and markets), no key needed. For a query it reports how
 * many matching headlines came out in the last hour, how closely the best recent one matches, and a
 * simple tone score of the matching headlines (a word list, not a language model).
 */
export const NEWS_FEEDS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss",
  "https://cointelegraph.com/rss",
  "https://decrypt.co/feed",
  "https://www.theblock.co/rss.xml",
  "https://bitcoinmagazine.com/feed",
  "https://www.cnbc.com/id/100003114/device/rss/rss.html",
  "https://feeds.content.dowjones.io/public/rss/mw_topstories",
];

export interface NewsItem {
  title: string;
  summary: string;
  at: number;
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#8217;|&rsquo;/g, "’")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tag = (block: string, names: string[]) => {
  for (const n of names) {
    const m = new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, "i").exec(block);
    if (m) return m[1]!;
  }
  return "";
};

/** RSS <item> and Atom <entry> blocks → headline, summary and publish time. */
export function parseFeed(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const m of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
    const b = m[0];
    const title = decode(tag(b, ["title"]));
    const at = Date.parse(decode(tag(b, ["pubDate", "published", "updated", "dc:date"])));
    if (!title || !Number.isFinite(at)) continue;
    out.push({ title, summary: decode(tag(b, ["description", "summary", "content:encoded", "content"])).slice(0, 400), at });
  }
  return out;
}

const STOP = new Set(["the", "a", "an", "of", "on", "in", "to", "and", "or", "for", "is", "are", "news", "about", "with"]);
const ALIASES: Record<string, string[]> = {
  btc: ["bitcoin"], bitcoin: ["btc"], eth: ["ether", "ethereum"], ethereum: ["eth", "ether"], sol: ["solana"], solana: ["sol"],
  fed: ["federal reserve", "fomc", "powell"], sec: ["securities and exchange commission"], etf: ["etfs"], hype: ["hyperliquid"], hyperliquid: ["hype"],
};

const terms = (query: string) =>
  query
    .toLowerCase()
    .replace(/[$#@]/g, "")
    .split(/[^a-z0-9.]+/)
    .filter((t) => t && !STOP.has(t));

const has = (text: string, term: string) => {
  const words = [term, ...(ALIASES[term] ?? [])];
  return words.some((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(text));
};

/** Share of the query's words found in a headline (the summary counts half). */
export function relevance(item: NewsItem, query: string): number {
  const ts = terms(query);
  if (!ts.length) return 0;
  let score = 0;
  for (const t of ts) score += has(item.title, t) ? 1 : has(item.summary, t) ? 0.5 : 0;
  return Math.round((score / ts.length) * 100) / 100;
}

const POSITIVE = ["surge", "surges", "soar", "soars", "rally", "rallies", "jump", "jumps", "gain", "gains", "record", "high", "approve", "approved", "approval", "inflow", "inflows", "bullish", "upgrade", "beat", "beats", "partnership", "launch", "adopt", "adoption", "rebound", "recover", "climb", "climbs", "win", "wins"];
const NEGATIVE = ["crash", "crashes", "plunge", "plunges", "drop", "drops", "fall", "falls", "slump", "low", "hack", "hacked", "exploit", "lawsuit", "sue", "sues", "ban", "bans", "reject", "rejected", "outflow", "outflows", "bearish", "downgrade", "miss", "misses", "fraud", "liquidation", "liquidations", "selloff", "sell-off", "fear", "probe", "delist", "delisted", "halt"];

/** −1 (all negative words) … 1 (all positive), from a word list. */
export function tone(text: string): number {
  const words = text.toLowerCase().split(/[^a-z-]+/);
  let p = 0;
  let n = 0;
  for (const w of words) {
    if (POSITIVE.includes(w)) p++;
    if (NEGATIVE.includes(w)) n++;
  }
  return p + n === 0 ? 0 : (p - n) / (p + n);
}

export function newsFields(items: NewsItem[], query: string, now: number): Fields {
  const HOUR = 3_600_000;
  const recent = items.filter((i) => i.at <= now + 5 * 60_000 && i.at > now - 6 * HOUR).map((i) => ({ i, r: relevance(i, query) }));
  const single = terms(query).length <= 1;
  const matched = recent.filter((x) => x.r >= (single ? 1 : 0.6));
  const seen = new Set<string>();
  const unique = matched.filter((x) => {
    const k = x.i.title.toLowerCase().slice(0, 60);
    return seen.has(k) ? false : (seen.add(k), true);
  });
  const lastHour = unique.filter((x) => x.i.at > now - HOUR).length;
  const toneAvg = unique.length ? unique.reduce((s, x) => s + tone(`${x.i.title} ${x.i.summary}`), 0) / unique.length : null;
  return {
    articles_1h: lastHour,
    sentiment: toneAvg == null ? null : Math.round(toneAvg * 100) / 100,
    max_relevance: recent.length ? Math.max(...recent.map((x) => x.r)) : 0,
  };
}

export function newsProvider(http: Http, feeds: string[] = NEWS_FEEDS, onError?: (k: string, e: unknown) => void): SignalProvider {
  return defineProvider(
    ["news"],
    "live",
    async (s, now) => {
      const results = await Promise.all(
        feeds.map((u) =>
          http
            .text(u, { ttlMs: 3 * 60_000, timeoutMs: 12_000, headers: { "user-agent": "Mozilla/5.0 (compatible; WeftBot/1.0; +https://weft.fi)" } })
            .then(parseFeed)
            .catch(() => [] as NewsItem[])
        )
      );
      const items = results.flat();
      if (!items.length) return null;
      return newsFields(items, s.params.query, now);
    },
    onError
  );
}
