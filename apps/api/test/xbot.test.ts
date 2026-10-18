import { describe, expect, it } from "vitest";
import { DEFAULT_X_PREFS, XBot, asksAboutParent, planLine, ideaOf, looksLikeIdea, oauthHeader, replyText, thesisFromParent, type XPrefs } from "../src/social/xbot.ts";
import { resultCard, resultPage, type ResultCard } from "../src/lib/share.ts";

const tweet = (id: string, text: string, o: { author?: string; followers?: number; at?: number } = {}) => ({
  id, text, createdAt: new Date(o.at ?? Date.UTC(2026, 9, 18, 3)).toUTCString(), author: { userName: o.author ?? "trader", followers: o.followers ?? 500 },
});

function bot(tweets: unknown[], mode: "dry" | "live" = "dry") {
  const kv = new Map<string, string>();
  const posted: { url: string; body: string; auth: string }[] = [];
  const logs: string[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.includes("twitterapi.io")) return new Response(JSON.stringify({ tweets }), { status: 200 });
    posted.push({ url, body: String(init?.body), auth: String((init?.headers as Record<string, string>).authorization) });
    return new Response(JSON.stringify({ data: { id: `reply-${posted.length}` } }), { status: 201 });
  }) as typeof globalThis.fetch;
  const b = new XBot({
    mode, handle: "weftfinance", twitterApiKey: "k", site: "https://weft.fi", fetch,
    x: { apiKey: "ck", apiSecret: "cs", accessToken: "at", accessSecret: "as" },
    draft: async (t) => ({ strategy: { name: `Plan for ${t.slice(0, 10)}` } as never, rationale: "Goes long SOL at 10× once it breaks $110. Out at −15%." }),
    saveDraft: () => `d${kv.size}`,
    kvGet: (k) => kv.get(k) ?? null, kvSet: (k, v) => void kv.set(k, v),
    maxPerDay: 3, perAuthorPerDay: 1, minFollowers: 10, log: (m) => logs.push(m),
  });
  return { b, kv, posted, logs };
}

describe("x bot", () => {
  it("reads the idea out of a tweet", () => {
    expect(ideaOf("@weftfinance hey, long SOL 10x if it breaks $110 https://t.co/x")).toBe("long SOL 10x if it breaks $110");
    expect(looksLikeIdea("long SOL 10x if it breaks $110")).toBe(true);
    expect(looksLikeIdea("gm frens")).toBe(false);
    expect(looksLikeIdea("this project is so good, love the team")).toBe(false);
  });

  it("keeps a reply within 280 characters, counting the link as 23", () => {
    const link = "https://weft.fi/d/abcdef123456";
    const t = replyText("A very long strategy name ".repeat(4), "x".repeat(400) + ".", link);
    expect(t.length - link.length + 23).toBeLessThanOrEqual(280);
    expect(t.endsWith(link)).toBe(true);
  });

  it("answers trade ideas once, and skips retweets, tiny accounts, chatter and repeat authors", async () => {
    const { b, posted, logs } = bot([
      tweet("1", "@weftfinance long SOL 10x if it breaks $110"),
      tweet("2", "@weftfinance short BTC if funding goes above 0.1%"), // same author: over the per-author cap
      tweet("3", "@weftfinance buy ETH if fear and greed drops under 20", { author: "small", followers: 2 }),
      tweet("4", "@weftfinance gm", { author: "fan" }),
      tweet("5", "RT @x: @weftfinance long ETH", { author: "rt" }),
      tweet("6", "@weftfinance LP SOL-USDC tight range", { author: "lp" }),
    ], "live");
    expect(await b.run()).toEqual({ seen: 6, replied: 2 });
    expect(posted).toHaveLength(2);
    expect(JSON.parse(posted[0]!.body)).toMatchObject({ reply: { in_reply_to_tweet_id: "1" } });
    expect(JSON.parse(posted[0]!.body).text).toContain("https://weft.fi/d/");
    expect(posted[0]!.auth).toMatch(/^OAuth oauth_consumer_key="ck", oauth_nonce="[0-9a-f]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="\d+", oauth_token="at", oauth_version="1.0", oauth_signature="[^"]+"$/);
    expect(logs.join("\n")).toMatch(/author cap[\s\S]*2 followers[\s\S]*not a trade idea[\s\S]*retweet/);
    // the same mentions again: nothing new
    expect(await b.run()).toEqual({ seen: 6, replied: 0 });
    expect(posted).toHaveLength(2);
  });

  it("only logs in dry mode", async () => {
    const { b, posted, logs } = bot([tweet("9", "@weftfinance long SOL 10x if it breaks $110")]);
    expect(await b.run()).toEqual({ seen: 1, replied: 1 });
    expect(posted).toHaveLength(0);
    expect(logs.some((l) => l.startsWith("xbot (dry): would reply"))).toBe(true);
  });

  it("signs the same request the same way", () => {
    const k = { apiKey: "a", apiSecret: "b", accessToken: "c", accessSecret: "d" };
    expect(oauthHeader("POST", "https://api.x.com/2/tweets", k, "n", 1)).toBe(oauthHeader("POST", "https://api.x.com/2/tweets", k, "n", 1));
    expect(oauthHeader("POST", "https://api.x.com/2/tweets", k, "n", 1)).not.toBe(oauthHeader("POST", "https://api.x.com/2/tweets", k, "n", 2));
  });
});

describe("tweet a trade", () => {
  const T = (id: string, text: string, o: { author?: string; authorId?: string; followers?: number; inReplyToId?: string } = {}) => ({
    id, text, createdAt: new Date(Date.UTC(2026, 9, 18, 3)).toUTCString(), inReplyToId: o.inReplyToId ?? null,
    author: { id: o.authorId ?? "x-1", userName: o.author ?? "trader", followers: o.followers ?? 500 },
  });
  function linkedBot(tweets: unknown[], o: { prefs?: Partial<XPrefs>; parent?: { text: string; author: string }; fail?: string; mode?: "dry" | "live" } = {}) {
    const kv = new Map<string, string>();
    const posted: string[] = [], told: string[] = [], started: { mode: string; usd: number }[] = [], drafts: { thesis: string; owner?: string }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      if (url.includes("/twitter/tweets?tweet_ids=")) return new Response(JSON.stringify({ tweets: o.parent ? [{ id: "p", text: o.parent.text, author: { userName: o.parent.author } }] : [] }), { status: 200 });
      if (url.includes("twitterapi.io")) return new Response(JSON.stringify({ tweets }), { status: 200 });
      posted.push(JSON.parse(String(init?.body)).text);
      return new Response(JSON.stringify({ data: { id: `r${posted.length}` } }), { status: 201 });
    }) as typeof globalThis.fetch;
    const b = new XBot({
      mode: o.mode ?? "live", handle: "weftfinance", twitterApiKey: "k", site: "https://weft.fi", fetch,
      x: { apiKey: "ck", apiSecret: "cs", accessToken: "at", accessSecret: "as" },
      draft: async (t) => ({ strategy: { name: "SOL breakout" } as never, rationale: `Plan for: ${t}.` }),
      saveDraft: (d) => (drafts.push({ thesis: d.thesis, owner: d.owner }), `d${drafts.length}`),
      linked: (xId) => (xId === "x-me" ? { userId: "did:me", prefs: { ...DEFAULT_X_PREFS, ...o.prefs } } : null),
      start: async (_u, _s, mode, usd) => {
        if (o.fail) throw new Error(o.fail);
        started.push({ mode, usd });
        return { id: `run${started.length}` };
      },
      tell: async (_u, text) => void told.push(text),
      kvGet: (k) => kv.get(k) ?? null, kvSet: (k, v) => void kv.set(k, v),
      maxPerDay: 20, perAuthorPerDay: 5, perLinkedPerDay: 10, minFollowers: 10,
    });
    return { b, kv, posted, told, started, drafts };
  }

  it("says the plan itself in the reply", () => {
    const s = {
      name: "SOL Breakout 15×",
      triggers: [{ id: "breakout", label: "SOL breaks $107" }],
      actions: [{ id: "long_sol", on: ["breakout"], type: "open", instrument: { kind: "perp", venue: "hyperliquid", symbol: "SOL" }, side: "long", leverage: 15, exits: { stopLoss: { positionPct: 20 } } }],
    } as never;
    expect(planLine(s)).toBe("Long SOL 15× when SOL breaks $107. Stop at −20%.");
    const t = replyText("SOL Breakout 15×", "The strategy watches SOL.", "https://weft.fi/d/x", "practice", planLine(s));
    expect(t).toBe("SOL Breakout 15×\nLong SOL 15× when SOL breaks $107. Stop at −20%.\n\nStarted in practice on Weft. Try it yourself:\nhttps://weft.fi/d/x");
    expect(planLine({ name: "x", triggers: [], actions: [] } as never)).toBeNull();
  });

  it("says nothing to compliments under its own posts, even with a trade word in them", async () => {
    const { b, posted, drafts } = linkedBot([T("1", "@weftfinance keep building. haven't seen real project for long time", { inReplyToId: "p" })], { parent: { text: "You can now tweet a trade.", author: "weftfinance" } });
    (b as unknown as { d: { isTradeIdea: (p: string) => Promise<boolean> } }).d.isTradeIdea = async (p) => /\bif\b|\bbreaks?\b|\d+x\b/i.test(p);
    expect(await b.run()).toEqual({ seen: 1, replied: 0 });
    expect(posted).toEqual([]);
    expect(drafts).toEqual([]);
  });

  it("turns the tweet above into a strategy when asked to", async () => {
    expect(asksAboutParent("make this a strategy")).toBe(true);
    expect(asksAboutParent("turn that into a trade but 5x")).toBe(true);
    expect(asksAboutParent("long SOL 10x if it breaks $110")).toBe(false);
    expect(thesisFromParent("Long $SOL here, invalidation $95 https://t.co/a", "make this a strategy")).toBe("Long $SOL here, invalidation $95");
    expect(thesisFromParent("Long $SOL here", "turn this into a trade but 5x")).toBe("Long $SOL here (but 5x)");
    expect(thesisFromParent("ETH will outperform BTC this quarter", "make this a thesis")).toBe("ETH will outperform BTC this quarter");
    const { b, drafts, posted } = linkedBot([T("1", "@trader @weftfinance make this a strategy", { inReplyToId: "p" })], { parent: { text: "Long $SOL if it holds $100, target $130", author: "caller" } });
    expect(await b.run()).toEqual({ seen: 1, replied: 1 });
    expect(drafts[0]!.thesis).toBe("Long $SOL if it holds $100, target $130");
    expect(posted[0]).toContain("Read it, practice it or run it:");
  });

  it("drafts a view that doesn't read like a trade when someone asks for it under the tweet", async () => {
    const { b, drafts } = linkedBot([T("1", "@weftfinance make this a strategy", { inReplyToId: "p" })], { parent: { text: "Rates are coming down faster than people think. Duration wins this year.", author: "macro" } });
    expect(await b.run()).toEqual({ seen: 1, replied: 1 });
    expect(drafts[0]!.thesis).toBe("Rates are coming down faster than people think. Duration wins this year.");
  });

  it("puts it in a connected account, or starts it in practice", async () => {
    const yours = linkedBot([T("1", "@weftfinance long SOL 10x if it breaks $110", { authorId: "x-me", followers: 3 })]);
    expect(await yours.b.run()).toEqual({ seen: 1, replied: 1 }); // few followers is fine once connected
    expect(yours.drafts[0]!.owner).toBe("did:me");
    expect(yours.posted[0]).toContain("It's in your Weft account");
    expect(yours.started).toEqual([]);

    const practice = linkedBot([T("1", "@weftfinance long SOL 10x if it breaks $110", { authorId: "x-me" })], { prefs: { mode: "practice", sizeUsd: 500 } });
    await practice.b.run();
    expect(practice.started).toEqual([{ mode: "paper", usd: 500 }]);
    expect(practice.posted[0]).toContain("Started in practice on Weft");
    expect(practice.told[0]).toContain("Started in practice with $500");
  });

  it("starts live within the per-tweet and per-day limits, never naming amounts in public", async () => {
    const { b, started, posted, told } = linkedBot(
      ["1", "2", "3"].map((id) => T(id, `@weftfinance long SOL 10x if it breaks $11${id}`, { authorId: "x-me" })),
      { prefs: { mode: "live", sizeUsd: 80, maxPerTweetUsd: 60, maxPerDayUsd: 130 } },
    );
    expect(await b.run()).toEqual({ seen: 3, replied: 3 });
    expect(started).toEqual([{ mode: "live", usd: 60 }, { mode: "live", usd: 60 }]); // the third would pass $130
    expect(posted.slice(0, 2).every((t) => t.includes("Started on Weft") && !t.includes("$60"))).toBe(true);
    expect(posted[2]).toContain("It's in your Weft account");
    expect(told[2]).toContain("today's $130 live limit");
  });

  it("keeps it as a draft and says why, privately, when it can't start", async () => {
    const { b, posted, told } = linkedBot([T("1", "@weftfinance long SOL 10x if it breaks $110", { authorId: "x-me" })], { prefs: { mode: "live" }, fail: "Connect Papertrade under Wallets first (one signature)." });
    await b.run();
    expect(posted[0]).toContain("It's in your Weft account");
    expect(posted[0]).not.toContain("Papertrade");
    expect(told[0]).toContain("Not started: Connect Papertrade");
  });
});

describe("result cards", () => {
  const card: ResultCard = { id: "abc123def456", deploymentId: "d", createdAt: 0, practice: true, name: "SOL breakout", thesis: "Long SOL 10× above $110.", markets: ["SOL 10×"], returnPct: 12.44, curve: [0, 3, 12.44], since: Date.UTC(2026, 9, 17), trades: 2, strategy: {} as never };
  it("previews as the card and sends people to run the same strategy", () => {
    const html = resultPage(card, "https://weft.fi");
    expect(html).toContain('content="SOL breakout: +12.4% in practice · Weft"');
    expect(html).toContain("https://weft.fi/og/result/abc123def456.png");
    expect(html).toContain('location.replace("https://weft.fi/new?from=result%3Aabc123def456")');
  });
  it("draws a 1200×630 PNG", async () => {
    const png = await resultCard(card);
    expect(new DataView(png.buffer, png.byteOffset).getUint32(16)).toBe(1200);
    expect(new DataView(png.buffer, png.byteOffset).getUint32(20)).toBe(630);
  }, 20_000);
});
