import { createHmac, randomBytes } from "node:crypto";
import type { Strategy } from "@weft/strategy";

/**
 * The X reply bot: tag @weftfinance with a trade idea and Weft answers in the thread with the plan
 * and a link where it's ready to read, practise or run.
 *
 *   mentions  twitterapi.io search ("@weftfinance -from:weftfinance", newest first), every minute
 *   thesis    the tweet's own words; "make this a strategy" under someone else's tweet uses that tweet
 *   draft     the same AI that drafts strategies on weft.fi; template fallbacks are never posted
 *   act       by who tweeted. Anyone: a public draft link. Someone who connected X in Weft's
 *             Settings: what they chose there, either the draft in their account, a practice run, or
 *             (opt-in, capped per tweet and per day) a live run, always through the same checks as
 *             the Start button. The public reply never mentions amounts.
 *   reply     X API v2 (POST /2/tweets, OAuth 1.0a as @weftfinance), only to tweets that tag us
 *
 * Off unless WEFT_XBOT is "dry" (log what it would post) or "live". Capped per day overall and per
 * author, ignores retweets, its own posts, tiny accounts and anything that isn't a trade idea.
 */

/** What a tweet does for someone who connected X (Settings → Tweet a trade). */
export interface XPrefs {
  mode: "draft" | "practice" | "live";
  /** Money per run started from a tweet, USD. */
  sizeUsd: number;
  /** Live only: most per tweet, and across all of one day's tweets. */
  maxPerTweetUsd: number;
  maxPerDayUsd: number;
}
export const DEFAULT_X_PREFS: XPrefs = { mode: "draft", sizeUsd: 50, maxPerTweetUsd: 100, maxPerDayUsd: 100 };

export interface XBotDeps {
  mode: "dry" | "live";
  handle: string;
  twitterApiKey: string;
  site: string;
  /** Draft a strategy from the tweet's words. Returns null when it isn't a real (AI) draft. */
  draft: (thesis: string) => Promise<{ strategy: Strategy; rationale: string } | null>;
  /** Store a draft under a new id (the reply links to site/d/<id>). */
  saveDraft: (d: { strategy: Strategy; thesis: string; tweetId: string; author: string; at: number; owner?: string }) => string;
  /** The Weft account an X user id is connected to, with what their tweets should do. */
  linked?: (xUserId: string) => { userId: string; prefs: XPrefs } | null;
  /** Start a run as that user, through the same checks as the Start button. Throws with the reason. */
  start?: (userId: string, strategy: Strategy, mode: "paper" | "live", allocationUsd: number) => Promise<{ id: string }>;
  /** A private note to the user (their Telegram, when linked). */
  tell?: (userId: string, text: string) => Promise<void>;
  kvGet: (k: string) => string | null;
  kvSet: (k: string, v: string) => void;
  /** OAuth 1.0a credentials for @weftfinance (live mode). */
  x?: { apiKey: string; apiSecret: string; accessToken: string; accessSecret: string };
  maxPerDay?: number;
  perAuthorPerDay?: number;
  /** Per day for people who connected X (they're known, so they get more). */
  perLinkedPerDay?: number;
  minFollowers?: number;
  log?: (m: string) => void;
  fetch?: typeof fetch;
}

interface Mention {
  id: string;
  text: string;
  at: number;
  author: string;
  authorId: string;
  followers: number;
  isRetweet: boolean;
  /** The tweet this one answers, if any. */
  inReplyToId: string | null;
}

/** "make this a strategy", "turn this into a trade": a request about the tweet above, not an idea. */
export function asksAboutParent(idea: string): boolean {
  return /^(pls |please )?(make|turn|do|run|trade|draft|build|create)\b[\s\S]{0,40}\b(this|that|it)\b/i.test(idea) || /^(this|that)\b/i.test(idea) || idea.length < 12;
}

/** The thesis for a mention that answers another tweet: that tweet's idea, plus anything added ("but 5x"). */
export function thesisFromParent(parentText: string, idea: string): string {
  const base = ideaOf(parentText);
  const extra = asksAboutParent(idea) ? idea.replace(/^(pls |please )?(make|turn|do|run|trade|draft|build|create)\b[\s\S]{0,40}\b(this|that|it)\b( into)?( a)?( strategy| trade| plan)?[,.!:\s]*/i, "").trim() : idea;
  return extra ? `${base} (${extra})` : base;
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

/** What the public reply says happened. Never amounts: a connected account's money is its own business. */
export type Outcome = "draft" | "yours" | "practice" | "live";
const TAILS: Record<Outcome, string> = {
  draft: "Read it, practice it or run it:",
  yours: "It's in your Weft account, ready to start:",
  practice: "Started in practice on Weft. Try it yourself:",
  live: "Started on Weft. Try it yourself:",
};

/** "Here's the plan …" in at most 280 characters, the link counted as X counts it (23). */
export function replyText(name: string, rationale: string, link: string, outcome: Outcome = "draft"): string {
  const firstSentence = (rationale.match(/^[^.!?]+[.!?]/)?.[0] ?? rationale).trim();
  const tail = `\n\n${TAILS[outcome]}\n${link}`;
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

interface ApiTweet {
  id: string;
  text?: string;
  createdAt?: string;
  author?: { id?: string; userName?: string; followers?: number };
  retweeted_tweet?: unknown;
  inReplyToId?: string | null;
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
    const body = (await r.json()) as { tweets?: ApiTweet[] };
    return (body.tweets ?? [])
      .map((t) => ({
        id: String(t.id),
        text: t.text ?? "",
        at: Date.parse(t.createdAt ?? ""),
        author: (t.author?.userName ?? "").toLowerCase(),
        authorId: String(t.author?.id ?? ""),
        followers: t.author?.followers ?? 0,
        isRetweet: !!t.retweeted_tweet || /^RT @/.test(t.text ?? ""),
        inReplyToId: t.inReplyToId ? String(t.inReplyToId) : null,
      }))
      .filter((m) => Number.isFinite(m.at))
      .sort((a, b) => a.at - b.at);
  }

  /** The tweet a mention answers (for "make this a strategy"). */
  private async parent(id: string): Promise<{ text: string; author: string } | null> {
    const r = await this.f(`https://api.twitterapi.io/twitter/tweets?tweet_ids=${encodeURIComponent(id)}`, { headers: { "X-API-Key": this.d.twitterApiKey }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const t = ((await r.json()) as { tweets?: ApiTweet[] }).tweets?.[0];
    return t?.text ? { text: t.text, author: (t.author?.userName ?? "").toLowerCase() } : null;
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

  /**
   * A connected account's tweet: start it the way they chose. Live is capped per tweet and per day;
   * anything that can't start stays a draft in their account, and they hear why privately.
   */
  private async act(link: { userId: string; prefs: XPrefs }, strategy: Strategy, draftUrl: string, day: string): Promise<Outcome> {
    const { userId, prefs } = link;
    if (prefs.mode === "draft" || !this.d.start) return "yours";
    const live = prefs.mode === "live";
    const usd = live ? Math.min(prefs.sizeUsd, prefs.maxPerTweetUsd) : prefs.sizeUsd;
    const usedKey = `xbot:live:${userId}:${day}`;
    if (live && this.count(usedKey) + usd > prefs.maxPerDayUsd + 1e-9) {
      await this.d.tell?.(userId, `◆ From your tweet: ${strategy.name}\nNot started: your tweets have used $${this.count(usedKey)} of today's $${prefs.maxPerDayUsd} live limit. It's saved as a draft: ${draftUrl}`).catch(() => {});
      return "yours";
    }
    if (this.d.mode === "dry") {
      this.d.log?.(`xbot (dry): would start ${strategy.name} for ${userId.slice(-6)} (${prefs.mode}, $${usd})`);
      return live ? "live" : "practice";
    }
    try {
      const run = await this.d.start(userId, strategy, live ? "live" : "paper", usd);
      if (live) this.d.kvSet(usedKey, String(this.count(usedKey) + usd));
      await this.d
        .tell?.(userId, `◆ From your tweet: ${strategy.name}\nStarted ${live ? "live" : "in practice"} with $${usd}. Stop it any time: ${this.d.site}/run?id=${run.id}`)
        .catch(() => {});
      return live ? "live" : "practice";
    } catch (e) {
      const reason = (e as Error).message.slice(0, 200);
      this.d.log?.(`xbot: couldn't start for ${userId.slice(-6)}: ${reason}`);
      await this.d.tell?.(userId, `◆ From your tweet: ${strategy.name}\nNot started: ${reason}\nIt's saved as a draft: ${draftUrl}`).catch(() => {});
      return "yours";
    }
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
        const link = m.authorId ? (this.d.linked?.(m.authorId) ?? null) : null;
        let idea = ideaOf(m.text);
        // "@weftfinance make this a strategy" under someone's call: the call is the idea
        if (m.inReplyToId && (!looksLikeIdea(idea) || asksAboutParent(idea))) {
          const p = await this.parent(m.inReplyToId).catch(() => null);
          if (p && p.author !== this.d.handle.replace(/^@/, "").toLowerCase()) idea = thesisFromParent(p.text, idea);
        }
        const why =
          m.isRetweet ? "retweet"
          : m.author === this.d.handle.replace(/^@/, "").toLowerCase() ? "own post"
          : !link && m.followers < (this.d.minFollowers ?? 10) ? `${m.followers} followers`
          : !looksLikeIdea(idea) ? "not a trade idea"
          : this.count(`xbot:day:${day}`) >= (this.d.maxPerDay ?? 15) ? "daily cap"
          : this.count(`xbot:author:${day}:${m.author}`) >= (link ? (this.d.perLinkedPerDay ?? 10) : (this.d.perAuthorPerDay ?? 2)) ? "author cap"
          : null;
        if (why) {
          this.d.log?.(`xbot: skipped ${m.id} from @${m.author} (${why})`);
          continue;
        }
        const drafted = await this.d.draft(idea).catch((e) => (this.d.log?.(`xbot: draft failed for ${m.id}: ${(e as Error).message.slice(0, 120)}`), null));
        if (!drafted) continue;
        const id = this.d.saveDraft({ strategy: drafted.strategy, thesis: idea, tweetId: m.id, author: m.author, at: now, owner: link?.userId });
        const draftUrl = `${this.d.site}/d/${id}`;
        const outcome = link ? await this.act(link, drafted.strategy, draftUrl, day) : "draft";
        const text = replyText(drafted.strategy.name, drafted.rationale, draftUrl, outcome);
        if (this.d.mode === "dry") {
          this.d.log?.(`xbot (dry): would reply to @${m.author} ${m.id}: ${JSON.stringify(text)}`);
        } else {
          const sent = await this.post(text, m.id).catch((e) => (this.d.log?.(`xbot: reply to ${m.id} failed: ${(e as Error).message.slice(0, 160)}`), null));
          if (!sent) continue;
          this.d.log?.(`xbot: replied to @${m.author} ${m.id} (${outcome}) → ${sent}`);
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
