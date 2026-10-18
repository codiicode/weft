import Anthropic from "@anthropic-ai/sdk";
import type { Catalog } from "@weft/venues";
import { officialMint } from "@weft/strategy";

/**
 * Calls from X: the Solana tokens an account tells people to buy, read from its own posts. Each new
 * post that names a token (a contract address or a cashtag) is read once by a small model: is it a
 * buy call, or a warning, a sell, a joke, a question? The tokens it calls are looked up: a contract
 * address stands for itself (and then the post's cashtags are just its name); a cashtag alone is
 * bought only when one token clearly owns that symbol (5× the liquidity of the next one), so a
 * clone is never bought by mistake ($WEFT is always Weft's own). Majors aren't calls to copy.
 *
 * An account is read at most every 12 seconds however many strategies follow it, and a post is
 * classified once.
 */
const MODEL = "claude-haiku-4-5-20251001";
const TTL_MS = 12_000, LOOKBACK_S = 2 * 3600;
/** Only posts this recent are read: an older call is never copied (copying starts with the strategy). */
const FRESH_MS = 30 * 60_000;
const MAJORS = new Set(["SOL", "WSOL", "BTC", "WBTC", "ETH", "WETH", "USDC", "USDT", "USD", "USDS", "PYUSD"]);
const CA = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const TAG = /(?:^|[^\w$])\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;

export interface XCall {
  id: string;
  at: number;
  mint: string;
  symbol?: string;
}

/** Contract addresses and cashtags in a post, majors left out. */
export function candidates(text: string): { cas: string[]; tags: string[] } {
  const cas = [...new Set(text.match(CA) ?? [])].filter((m) => !/^[1-9]+$/.test(m));
  // With a contract address in the post, its cashtags are only the token's name, not more calls.
  const tags = cas.length ? [] : [...new Set([...text.matchAll(TAG)].map((m) => m[1]!.toUpperCase()))].filter((t) => !MAJORS.has(t));
  return { cas, tags };
}

export type CallClassifier = (post: string, tokens: string[]) => Promise<string[]>;

/** Which of `tokens` the post calls as a buy (a small model). */
export function claudeCallClassifier(client: Anthropic = new Anthropic()): CallClassifier {
  return async (post, tokens) => {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system:
        "You read one post by a crypto trader. Decide which of the listed tokens the post calls as a buy: the author bought or is buying it, tells people to buy it, or gives a clear bullish entry. NOT a buy call: selling or taking profit, warnings, rug or scam alerts, jokes, questions, regret about missing it, neutral mentions, paid-ad disclaimers. Reply with JSON only: {\"buy\": [tokens exactly as listed]} (empty when none).",
      messages: [{ role: "user", content: `Tokens: ${tokens.join(", ")}\n\nPost: ${post.replace(/\s+/g, " ").slice(0, 1_000)}` }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { buy?: unknown };
    return Array.isArray(j.buy) ? j.buy.map(String).filter((t) => tokens.includes(t)) : [];
  };
}

export function xCallFeed(o: { twitterApiKey: string; catalog: Catalog; classify: CallClassifier; fetch?: typeof fetch; now?: () => number; log?: (m: string) => void }) {
  const f = o.fetch ?? fetch, now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; calls: Promise<XCall[]> }>();
  const posts = new Map<string, XCall[]>(); // post id → its calls (classified once)

  /** A cashtag or contract address → the token's mint and symbol, or null. */
  const resolve = async (token: string): Promise<{ mint: string; symbol?: string } | null> => {
    const isCa = !token.startsWith("$");
    const q = isCa ? token : token.slice(1);
    const pinned = !isCa ? officialMint(q) : null;
    if (pinned) return { mint: pinned, symbol: q.toUpperCase() };
    const rows = await o.catalog.list("tokens", { search: q, limit: 20 }).catch(() => []);
    if (isCa) {
      const hit = rows.find((r) => r.instrument.kind === "token" && r.instrument.mint === q);
      return hit && hit.instrument.kind === "token" ? { mint: hit.instrument.mint, symbol: hit.instrument.symbol } : null;
    }
    const same = rows
      .filter((r) => r.instrument.kind === "token" && (r.instrument.symbol ?? "").toUpperCase() === q.toUpperCase())
      .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
    const [top, next] = same;
    // Ambiguous ticker: skip rather than risk a clone.
    if (!top || top.instrument.kind !== "token" || (next && (top.liquidityUsd ?? 0) < 5 * (next.liquidityUsd ?? 0))) return null;
    return { mint: top.instrument.mint, symbol: top.instrument.symbol };
  };

  const read = async (account: string): Promise<XCall[]> => {
    const since = Math.floor(now() / 1000) - LOOKBACK_S;
    const q = `from:${account} -filter:retweets since_time:${since}`;
    const r = await f(`https://api.twitterapi.io/twitter/tweet/advanced_search?queryType=Latest&query=${encodeURIComponent(q)}`, { headers: { "X-API-Key": o.twitterApiKey }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`X posts: HTTP ${r.status}`);
    const tweets = ((await r.json()) as { tweets?: { id: string; text?: string; createdAt?: string }[] }).tweets ?? [];
    const out: XCall[] = [];
    const list = [...tweets]
      .map((t) => ({ id: String(t.id), text: t.text ?? "", at: Date.parse(t.createdAt ?? "") }))
      .filter((t) => Number.isFinite(t.at))
      .sort((a, b) => a.at - b.at);
    // New posts are read in parallel; old ones are never copied, so they're not read at all.
    await Promise.all(
      list
        .filter((t) => !posts.has(t.id))
        .map(async (t) => {
          if (now() - t.at > FRESH_MS) return void posts.set(t.id, []);
          const { cas, tags } = candidates(t.text);
          const listed = [...cas, ...tags.map((x) => `$${x}`)];
          if (!listed.length) return void posts.set(t.id, []);
          const buys = await o.classify(t.text, listed).catch((e) => (o.log?.(`x calls: couldn't read ${t.id}: ${(e as Error).message.slice(0, 80)}`), null));
          if (buys === null) return; // read again next time
          const calls: XCall[] = [];
          for (const b of buys) {
            const tok = await resolve(b);
            if (tok && !calls.some((c) => c.mint === tok.mint)) calls.push({ id: `${t.id}:${tok.mint}`, at: t.at, ...tok });
          }
          posts.set(t.id, calls);
        }),
    );
    for (const t of list) out.push(...(posts.get(t.id) ?? []));
    while (posts.size > 5_000) posts.delete(posts.keys().next().value!);
    return out;
  };

  return (raw: string): Promise<XCall[]> => {
    const account = raw.replace(/^@/, "").toLowerCase();
    const hit = cache.get(account);
    if (hit && now() - hit.at < TTL_MS) return hit.calls;
    const calls = read(account);
    cache.set(account, { at: now(), calls });
    calls.catch(() => cache.delete(account));
    return calls;
  };
}
