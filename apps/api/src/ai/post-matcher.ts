import Anthropic from "@anthropic-ai/sdk";
import type { PostMatcher, Tweet } from "@weft/venues";

/**
 * Semantic matching for post_match signals ("if @elonmusk posts about Dogecoin payments"): a small,
 * fast model reads the new posts once each and scores how well they say the claim. The venues
 * package caches every score per post, so a post is never sent twice.
 */
const MODEL = "claude-haiku-4-5-20251001";

export function claudePostMatcher(client: Anthropic = new Anthropic()): PostMatcher {
  return async (claim: string, contradiction: string | undefined, posts: Tweet[]) => {
    const list = posts.map((p, i) => `${i}. @${p.author}: ${p.text.replace(/\s+/g, " ").slice(0, 500)}`).join("\n");
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1_000,
      system:
        "You check social media posts against a claim for a trading bot. For each post, score 0 to 1 how clearly the post itself states or announces the claim (1 = clearly says it, 0.5 = related but vague, 0 = unrelated). Jokes, questions and quotes of others count low. If a contradiction is given, mark posts that clearly say it. Reply with JSON only: [{\"i\":0,\"score\":0.0,\"contradicts\":false}, ...] with one entry per post.",
      messages: [{ role: "user", content: `Claim: ${claim}\n${contradiction ? `Contradiction: ${contradiction}\n` : ""}\nPosts:\n${list}` }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const json = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as { i: number; score: number; contradicts?: boolean }[];
    const byIndex = new Map(json.map((x) => [x.i, x]));
    return posts.map((_, i) => {
      const x = byIndex.get(i);
      return { score: Math.max(0, Math.min(1, Number(x?.score ?? 0))), contradicts: Boolean(x?.contradicts) };
    });
  };
}
