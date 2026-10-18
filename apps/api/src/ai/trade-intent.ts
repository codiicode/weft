import Anthropic from "@anthropic-ai/sdk";

/**
 * Is a post that mentions @weftfinance asking for a trading strategy? A small, fast model decides
 * before the X bot drafts anything: replies under Weft's own posts mention it too, and compliments,
 * questions and chatter must get no strategy back.
 */
const MODEL = "claude-haiku-4-5-20251001";

export function claudeTradeIntent(client: Anthropic = new Anthropic()) {
  return async (post: string, context: string | null): Promise<boolean> => {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 10,
      system:
        "You screen posts that mention @weftfinance, a bot that turns trade ideas into trading strategies. Answer YES only if the post asks for a strategy or states a concrete thing to trade or automate: a market or asset plus what to do or when (\"long SOL if it breaks $110\", \"buy ETH when fear is extreme\", \"fade this trader\", \"make this a strategy\"). Answer NO for compliments, encouragement, thanks, questions about Weft or its token, complaints, jokes, greetings and general opinions with nothing to act on. Answer with YES or NO only.",
      messages: [{ role: "user", content: `${context ? `It replies to: ${context.replace(/\s+/g, " ").slice(0, 400)}\n\n` : ""}Post: ${post.replace(/\s+/g, " ").slice(0, 600)}` }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim().toUpperCase();
    return text.startsWith("YES");
  };
}
