import { createHmac, randomBytes } from "node:crypto";
import type { Strategy } from "@weft/strategy";

/**
 * The X reply bot: tag @weftfinance with a trade idea and Weft answers in the thread with the plan
 * and a link where it's ready to read, practise or run.
 *
 *   mentions  twitterapi.io search ("@weftfinance -from:weftfinance", newest first), every minute
 *   draft     the same AI that drafts strategies on weft.fi; template fallbacks are never posted
 *   reply     X API v2 (POST /2/tweets, OAuth 1.0a as @weftfinance), only to tweets that tag us
 *
 * Off unless WEFT_XBOT is "dry" (log what it would post) or "live". Capped per day overall and per
 * author, ignores retweets, its own posts, tiny accounts and anything that isn't a trade idea.
 */

export interface XBotDeps {
  mode: "dry" | "live";
  handle: string;
  twitterApiKey: string;
  site: string;
  /** Draft a strategy from the tweet's words. Returns null when it isn't a real (AI) draft. */
  draft: (thesis: string) => Promise<{ strategy: Strategy; rationale: string } | null>;
  /** Store a draft under a new id (the reply links to site/d/<id>). */
  saveDraft: (d: { strategy: Strategy; thesis: string; tweetId: string; author: string; at: number }) => string;
  kvGet: (k: string) => string | null;
  kvSet: (k: string, v: string) => void;
  /** OAuth 1.0a credentials for @weftfinance (live mode). */
  x?: { apiKey: string; apiSecret: string; accessToken: string; accessSecret: string };
  maxPerDay?: number;
  perAuthorPerDay?: number;
  minFollowers?: number;
  log?: (m: string) => void;
  fetch?: typeof fetch;
}

interface Mention {
  id: string;
  text: string;
  at: number;
  author: string;
  followers: number;
  isRetweet: boolean;
}

/** The trade idea in a tweet: without handles, links and the leading "hey". */
export function ideaOf(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(^|\s)@\w{1,15}/g, " ")
    .replace(/^\s*(hey|hi|yo|gm|pls|please)[,!.:\s]+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Worth answering: long enough, and it reads like something to trade or watch. */
export function looksLikeIdea(idea: string): boolean {
  if (idea.length < 12 || idea.length > 600) return false;
  return /\b(long|short|buy|sell|lp|liquidity|copy|mirror|hedge|if|when|above|below|breaks?|drops?|dips?|pumps?|funding|odds|leverage|\d+x|\$[a-z]{2,10}|btc|eth|sol|stake|position|trade)\b/i.test(idea);
}

/** "Here's the plan …" in at most 280 characters, the link counted as X counts it (23). */
export function replyText(name: string, rationale: string, link: string): string {
  const firstSentence = (rationale.match(/^[^.!?]+[.!?]/)?.[0] ?? rationale).trim();
  const tail = `\n\nRead it, practice it or run it:\n${link}`;
  const room = 280 - 23 - (tail.length - link.length) - 4;
  let body = `${name}. ${firstSentence}`;
  if (body.length > room) body = `${body.slice(0, room - 1).replace(/\s+\S*$/, "")}…`;
  return `${body}${tail}`;
}

/* ---------------- X API v2 posting (OAuth 1.0a user context) ---------------- */

const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The Authorization header for a JSON-body request (the body isn't part of the signature). */
export function oauthHeader(method: string, url: string, k: NonNullable<XBotDeps["x"]>, nonce = randomBytes(16).toString("hex"), ts = Math.floor(Date.now() / 1000)): string {
  const params: Record<string, string> = {
    oauth_consumer_key: k.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(ts),
    oauth_token: k.accessToken,
    oauth_version: "1.0",
  };
  const base = [method.toUpperCase(), pct(url), pct(Object.keys(params).sort().map((p) => `${pct(p)}=${pct(params[p]!)}`).join("&"))].join("&");
  const sig = createHmac("sha1", `${pct(k.apiSecret)}&${pct(k.accessSecret)}`).update(base).digest("base64");
  return `OAuth ${Object.entries({ ...params, oauth_signature: sig }).map(([a, b]) => `${pct(a)}="${pct(b)}"`).join(", ")}`;
}

export class XBot {
  private readonly d: XBotDeps;
  private readonly f: typeof fetch;
  private running = false;
  constructor(d: XBotDeps) {
    this.d = d;
    this.f = d.fetch ?? fetch;
  }

  private day(now: number) {
    return new Date(now).toISOString().slice(0, 10);
  }
  private count(k: string): number {
    return Number(this.d.kvGet(k) ?? 0);
  }
  private bump(k: string) {
    this.d.kvSet(k, String(this.count(k) + 1));
  }

  /** Mentions since the last run (the first run only looks back 15 minutes), oldest first. */
  private async mentions(now: number): Promise<Mention[]> {
    const since = Number(this.d.kvGet("xbot:since") ?? 0) || Math.floor(now / 1000) - 900;
    const h = this.d.handle.replace(/^@/, "");
    const q = `@${h} -from:${h} since_time:${since}`;
    const r = await this.f(`https://api.twitterapi.io/twitter/tweet/advanced_search?queryType=Latest&query=${encodeURIComponent(q)}`, { headers: { "X-API-Key": this.d.twitterApiKey }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`mentions: HTTP ${r.status}`);
    const body = (await r.json()) as { tweets?: { id: string; text?: string; createdAt?: string; author?: { userName?: string; followers?: number }; retweeted_tweet?: unknown }[] };
    return (body.tweets ?? [])
      .map((t) => ({ id: String(t.id), text: t.text ?? "", at: Date.parse(t.createdAt ?? ""), author: (t.author?.userName ?? "").toLowerCase(), followers: t.author?.followers ?? 0, isRetweet: !!t.retweeted_tweet || /^RT @/.test(t.text ?? "") }))
      .filter((m) => Number.isFinite(m.at))
      .sort((a, b) => a.at - b.at);
  }

  private async post(text: string, replyTo: string): Promise<string> {
    const k = this.d.x;
    if (!k) throw new Error("no X credentials");
    const url = "https://api.x.com/2/tweets";
    const r = await this.f(url, {
      method: "POST",
      headers: { authorization: oauthHeader("POST", url, k), "content-type": "application/json" },
      body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: replyTo } }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await r.json().catch(() => ({}))) as { data?: { id?: string }; detail?: string; title?: string };
    if (!r.ok || !body.data?.id) throw new Error(`post: HTTP ${r.status} ${body.detail ?? body.title ?? ""}`.trim());
    return body.data.id;
  }

  /** One pass: read new mentions, answer the ones worth answering. */
  async run(now = Date.now()): Promise<{ seen: number; replied: number }> {
    if (this.running) return { seen: 0, replied: 0 };
    this.running = true;
    let replied = 0;
    try {
      const list = await this.mentions(now);
      const day = this.day(now);
      for (const m of list) {
        this.d.kvSet("xbot:since", String(Math.floor(m.at / 1000)));
        if (this.d.kvGet(`xbot:done:${m.id}`)) continue;
        this.d.kvSet(`xbot:done:${m.id}`, "1");
        const idea = ideaOf(m.text);
        const why =
          m.isRetweet ? "retweet"
          : m.author === this.d.handle.replace(/^@/, "").toLowerCase() ? "own post"
          : m.followers < (this.d.minFollowers ?? 10) ? `${m.followers} followers`
          : !looksLikeIdea(idea) ? "not a trade idea"
          : this.count(`xbot:day:${day}`) >= (this.d.maxPerDay ?? 15) ? "daily cap"
          : this.count(`xbot:author:${day}:${m.author}`) >= (this.d.perAuthorPerDay ?? 2) ? "author cap"
          : null;
        if (why) {
          this.d.log?.(`xbot: skipped ${m.id} from @${m.author} (${why})`);
          continue;
        }
        const drafted = await this.d.draft(idea).catch((e) => (this.d.log?.(`xbot: draft failed for ${m.id}: ${(e as Error).message.slice(0, 120)}`), null));
        if (!drafted) continue;
        const id = this.d.saveDraft({ strategy: drafted.strategy, thesis: idea, tweetId: m.id, author: m.author, at: now });
        const text = replyText(drafted.strategy.name, drafted.rationale, `${this.d.site}/d/${id}`);
        if (this.d.mode === "dry") {
          this.d.log?.(`xbot (dry): would reply to @${m.author} ${m.id}: ${JSON.stringify(text)}`);
        } else {
          const sent = await this.post(text, m.id).catch((e) => (this.d.log?.(`xbot: reply to ${m.id} failed: ${(e as Error).message.slice(0, 160)}`), null));
          if (!sent) continue;
          this.d.log?.(`xbot: replied to @${m.author} ${m.id} → ${sent}`);
        }
        this.bump(`xbot:day:${day}`);
        this.bump(`xbot:author:${day}:${m.author}`);
        replied++;
      }
      return { seen: list.length, replied };
    } finally {
      this.running = false;
    }
  }
}
