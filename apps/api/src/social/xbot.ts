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
  /** Does this post actually ask for a strategy? (Not a compliment, a question, chatter.) Default: yes. */
  isTradeIdea?: (post: string, context: string | null) => Promise<boolean>;
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

function toMention(t: ApiTweet): Mention {
  return {
    id: String(t.id),
    text: t.text ?? "",
    at: Date.parse(t.createdAt ?? ""),
    author: (t.author?.userName ?? "").toLowerCase(),
    authorId: String(t.author?.id ?? ""),
    followers: t.author?.followers ?? 0,
    isRetweet: !!t.retweeted_tweet || /^RT @/.test(t.text ?? ""),
    inReplyToId: t.inReplyToId ? String(t.inReplyToId) : null,
  };
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
  const extra = asksAboutParent(idea) ? idea.replace(/^(pls |please )?(make|turn|do|run|trade|draft|build|create)\b[\s\S]{0,40}\b(this|that|it)\b( into)?( a)?( strategy| trade| plan| thesis| setup)?[,.!:\s]*/i, "").trim() : idea;
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

/**
 * The plan in one line, from the strategy itself: "Long SOL 15× when SOL breaks $107. Stop at −20%."
 * Only for the common shape (one position to open); otherwise null and the AI's rationale is used.
 */
export function planLine(s: Strategy): string | null {
  const opens = s.actions.filter((a) => a.type === "open");
  if (opens.length !== 1) return null;
  const a = opens[0]!;
  if (a.type !== "open") return null;
  const i = a.instrument as { kind: string; symbol?: string };
  if (!i.symbol || i.kind === "outcome") return null;
  const spotLike = i.kind === "spot" || i.kind === "token";
  const what = `${spotLike ? "Buy" : a.side === "short" ? "Short" : "Long"} ${i.symbol.replace(/^\$/, "")}${!spotLike && a.leverage > 1 ? ` ${a.leverage}×` : ""}`;
  const label = s.triggers.find((t) => a.on?.includes(t.id))?.label?.trim();
  // "Funding turns negative" → "when funding turns negative"; tickers ("SOL breaks…") keep their case
  const first = label && /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
  const when = first ? ` when ${first.replace(/[.!]+$/, "")}` : "";
  const lv = (l: Record<string, number> | undefined, sign: string) =>
    !l ? null : "positionPct" in l ? `${sign}${l.positionPct}%` : "pct" in l ? `${sign}${l.pct}% on the price` : "price" in l ? `$${l.price!.toLocaleString("en-US")}` : null;
  const ex = a.exits as { takeProfit?: Record<string, number>; stopLoss?: Record<string, number>; trailingStopPct?: number };
  const parts = [
    lv(ex.takeProfit, "+") && `take profit at ${lv(ex.takeProfit, "+")}`,
    lv(ex.stopLoss, "−") && `stop at ${lv(ex.stopLoss, "−")}`,
    ex.trailingStopPct && `trailing stop ${ex.trailingStopPct}%`,
  ].filter(Boolean) as string[];
  const exits = parts.length ? ` ${parts.join(", ").charAt(0).toUpperCase()}${parts.join(", ").slice(1)}.` : "";
  return `${what}${when}.${exits}`;
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
export function replyText(name: string, rationale: string, link: string, outcome: Outcome = "draft", plan: string | null = null): string {
  const firstSentence = (rationale.match(/^[^.!?]+[.!?]/)?.[0] ?? rationale).trim();
  const tail = `\n\n${TAILS[outcome]}\n${link}`;
  const room = 280 - 23 - (tail.length - link.length) - 4;
  let body = plan ? `${name}\n${plan}` : `${name}. ${firstSentence}`;
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
  /** Tweets being answered right now (a pass can start while the last one is still drafting). */
  private inflight = new Set<string>();
  /** The first pass after a start looks further back and retries answers a restart cut short. */
  private firstPass = true;
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
  private unbump(k: string) {
    this.d.kvSet(k, String(Math.max(0, this.count(k) - 1)));
  }

  /** Mentions since the last run (the first run only looks back 15 minutes), oldest first. */
  private async mentions(now: number): Promise<Mention[]> {
    const stored = Number(this.d.kvGet("xbot:since") ?? 0) || Math.floor(now / 1000) - 900;
    // After a restart, look back 30 minutes: a tweet whose answer was cut short is picked up again.
    const since = this.firstPass ? Math.min(stored, Math.floor(now / 1000) - 1800) : stored;
    const h = this.d.handle.replace(/^@/, "");
    // Two minutes of overlap: a tweet the search indexes late isn't skipped (answered ones are marked done).
    const q = `@${h} -from:${h} since_time:${since - 120}`;
    const r = await this.f(`https://api.twitterapi.io/twitter/tweet/advanced_search?queryType=Latest&query=${encodeURIComponent(q)}`, { headers: { "X-API-Key": this.d.twitterApiKey }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`mentions: HTTP ${r.status}`);
    const body = (await r.json()) as { tweets?: ApiTweet[] };
    return (body.tweets ?? [])
      .map(toMention)
      .filter((m) => Number.isFinite(m.at))
      .sort((a, b) => a.at - b.at);
  }

  /** One tweet by id, as a mention. */
  private async tweet(id: string): Promise<Mention | null> {
    const r = await this.f(`https://api.twitterapi.io/twitter/tweets?tweet_ids=${encodeURIComponent(id)}`, { headers: { "X-API-Key": this.d.twitterApiKey }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`tweet: HTTP ${r.status}`);
    const t = ((await r.json()) as { tweets?: ApiTweet[] }).tweets?.[0];
    return t ? toMention(t) : null;
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

  /** Draft it, act on it, reply. False when nothing went out. */
  private async answer(m: Mention, idea: string, link: { userId: string; prefs: XPrefs } | null, day: string, now: number): Promise<boolean> {
    const drafted = await this.d.draft(idea).catch((e) => (this.d.log?.(`xbot: draft failed for ${m.id}: ${(e as Error).message.slice(0, 120)}`), null));
    if (!drafted) return false;
    const id = this.d.saveDraft({ strategy: drafted.strategy, thesis: idea, tweetId: m.id, author: m.author, at: now, owner: link?.userId });
    const draftUrl = `${this.d.site}/d/${id}`;
    const outcome = link ? await this.act(link, drafted.strategy, draftUrl, day) : "draft";
    let plan: string | null = null;
    try {
      plan = planLine(drafted.strategy);
    } catch {
      /* the rationale's first sentence instead */
    }
    const text = replyText(drafted.strategy.name, drafted.rationale, draftUrl, outcome, plan);
    const took = `${Math.round((Date.now() - m.at) / 1000)}s after the tweet`;
    if (this.d.mode === "dry") {
      this.d.log?.(`xbot (dry): would reply to @${m.author} ${m.id} (${took}): ${JSON.stringify(text)}`);
      return true;
    }
    const sent = await this.post(text, m.id).catch((e) => (this.d.log?.(`xbot: reply to ${m.id} failed: ${(e as Error).message.slice(0, 160)}`), null));
    if (!sent) return false;
    this.d.log?.(`xbot: replied to @${m.author} ${m.id} (${outcome}, ${took}) → ${sent}`);
    return true;
  }

  /** Whether a mention is worth answering; reserves the caps when it is. Null when it's skipped. */
  private async consider(m: Mention, day: string): Promise<{ m: Mention; idea: string; link: { userId: string; prefs: XPrefs } | null } | null> {
    this.d.kvSet(`xbot:done:${m.id}`, "started");
      const link = m.authorId ? (this.d.linked?.(m.authorId) ?? null) : null;
      let idea = ideaOf(m.text);
      // "@weftfinance make this a strategy" under someone's call: the call is the idea. Asked for
      // outright, the AI judges the tweet (it may read like a view, not a trade, and still be one).
      let asked = false;
      let context: string | null = null;
      if (m.inReplyToId) {
        const p = await this.parent(m.inReplyToId).catch(() => null);
        context = p?.text ?? null;
        if (p && p.author !== this.d.handle.replace(/^@/, "").toLowerCase() && (!looksLikeIdea(idea) || asksAboutParent(idea))) {
          asked = asksAboutParent(idea);
          idea = thesisFromParent(p.text, idea);
        }
      }
      const why =
        m.isRetweet ? "retweet"
        : m.author === this.d.handle.replace(/^@/, "").toLowerCase() ? "own post"
        : !link && m.followers < (this.d.minFollowers ?? 10) ? `${m.followers} followers`
        : !asked && !looksLikeIdea(idea) ? "not a trade idea"
        : idea.length < 12 ? "nothing to trade"
        : this.count(`xbot:day:${day}`) >= (this.d.maxPerDay ?? 15) ? "daily cap"
        : this.count(`xbot:author:${day}:${m.author}`) >= (link ? (this.d.perLinkedPerDay ?? 10) : (this.d.perAuthorPerDay ?? 2)) ? "author cap"
        : null;
      if (why) {
        this.d.log?.(`xbot: skipped ${m.id} from @${m.author} (${why})`);
        this.d.kvSet(`xbot:done:${m.id}`, "skipped");
        return null;
      }
      // The keyword check is only a coarse first pass ("for long time" has "long" in it): a small
      // model decides whether the post really asks for a trade. Unsure or failing: no reply.
      if (!asked && this.d.isTradeIdea) {
        const yes = await this.d.isTradeIdea(ideaOf(m.text), context).catch(() => false);
        if (!yes) {
          this.d.log?.(`xbot: skipped ${m.id} from @${m.author} (not asking for a trade)`);
          this.d.kvSet(`xbot:done:${m.id}`, "skipped");
          return null;
        }
      }
    this.bump(`xbot:day:${day}`);
    this.bump(`xbot:author:${day}:${m.author}`);
    return { m, idea, link };
  }

  /** Answer a considered mention; the outcome is recorded so it's never answered twice. */
  private async finish(t: { m: Mention; idea: string; link: { userId: string; prefs: XPrefs } | null }, day: string, now: number): Promise<boolean> {
    const { m, idea, link } = t;
    this.inflight.add(m.id);
    try {
      const ok = await this.answer(m, idea, link, day, now);
      if (!ok) {
        this.unbump(`xbot:day:${day}`);
        this.unbump(`xbot:author:${day}:${m.author}`);
      }
      this.d.kvSet(`xbot:done:${m.id}`, ok ? "replied" : "failed");
      return ok;
    } finally {
      this.inflight.delete(m.id);
    }
  }

  /** Answer one tweet again by id (an answer that got lost). Says what happened. */
  async retry(id: string, now = Date.now()): Promise<string> {
    if (this.inflight.has(id)) return "already being answered";
    if (this.d.kvGet(`xbot:done:${id}`) === "replied") return "already answered";
    const m = await this.tweet(id);
    if (!m) return "tweet not found";
    const day = this.day(now);
    const t = await this.consider(m, day);
    if (!t) return `skipped: ${this.d.kvGet(`xbot:done:${id}`) ?? "?"} (see the log for why)`;
    return (await this.finish(t, day, now)) ? "replied" : "couldn't answer (see the log)";
  }

  /** One pass: read new mentions, answer the ones worth answering. */
  async run(now = Date.now()): Promise<{ seen: number; replied: number }> {
    if (this.running) return { seen: 0, replied: 0 };
    this.running = true;
    let replied = 0;
    try {
      const list = await this.mentions(now);
      const day = this.day(now);
      // 1. Decide, in order: what's worth answering (the caps are reserved here, so answering in
      //    parallel below can't go over them).
      const todo: { m: Mention; idea: string; link: { userId: string; prefs: XPrefs } | null }[] = [];
      for (const m of list) {
        this.d.kvSet("xbot:since", String(Math.floor(m.at / 1000)));
        // Done once answered or skipped. "started" with no answer means a restart cut it short:
        // the first pass after a start tries those again. (Older entries just say "1": done.)
        const st = this.d.kvGet(`xbot:done:${m.id}`);
        if ((st && !(st === "started" && this.firstPass)) || this.inflight.has(m.id)) continue;
        const t = await this.consider(m, day);
        if (t) todo.push(t);
      }
      // 2. Answer: different people in parallel, one person's tweets in order (their live limits).
      const byAuthor = new Map<string, typeof todo>();
      for (const t of todo) byAuthor.set(t.m.author, [...(byAuthor.get(t.m.author) ?? []), t]);
      await Promise.all(
        [...byAuthor.values()].map(async (mine) => {
          for (const t of mine) if (await this.finish(t, day, now)) replied++;
        }),
      );
      return { seen: list.length, replied };
    } finally {
      this.firstPass = false;
      this.running = false;
    }
  }
}
