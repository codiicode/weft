import { describe, expect, it } from "vitest";
import { XBot, ideaOf, looksLikeIdea, oauthHeader, replyText } from "../src/social/xbot.ts";
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
