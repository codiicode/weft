import Anthropic from "@anthropic-ai/sdk";
import { validateStrategy, type Issue, type Strategy } from "@weft/strategy";
import type { Catalog, Product } from "@weft/venues";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { templateStrategy } from "./template.ts";
import { refineByRules } from "./refine.ts";

export const MODEL = "claude-opus-5-5";
const MAX_TURNS = 10;
const PRODUCTS: Product[] = ["perps", "stocks", "predictions", "tokens", "options", "pools"];

export interface GenerateResult {
  strategy: Strategy;
  warnings: Issue[];
  rationale: string;
  source: "claude" | "template";
  notes: string[];
}

export type Progress = (step: { type: "search" | "submit" | "invalid" | "thinking" | "fallback"; message: string }) => void;

export class GenerationError extends Error {}

const tools: Anthropic.Beta.BetaTool[] = [
  {
    name: "search_markets",
    description:
      "Search tradable markets across Weft's venues. Returns real instruments (with exact Solana mints, HIP-3 dex/symbol, prediction market ids, option contracts) plus price, volume and liquidity. Use it before referencing any instrument.",
    input_schema: {
      type: "object",
      properties: {
        product: { type: "string", enum: PRODUCTS, description: "perps | stocks (HIP-3 perps + tokenized stocks) | predictions (Hyperliquid, tradable; Polymarket, watch-only odds) | tokens (Solana) | options | pools (Meteora liquidity pools: search a pair like SOL-USDC)" },
        query: { type: "string", description: "Symbol, name or keywords, e.g. PUMP, NVDA, wheat, fed cut, ETH" },
        limit: { type: "integer", description: "Max results (default 8)" },
      },
      required: ["product", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_strategy",
    description:
      "Submit the final strategy document. It is validated against the schema; on errors you get the exact problems back and should resubmit a corrected version.",
    input_schema: {
      type: "object",
      properties: {
        strategy: { type: "object", description: "The complete strategy document (schemaVersion 1)." },
        rationale: { type: "string", description: "2–4 sentences: how the graph expresses the thesis, and what would invalidate it." },
      },
      required: ["strategy", "rationale"],
    },
  },
];

function hasCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}

async function runSearch(catalog: Catalog, input: { product?: string; query?: string; limit?: number }) {
  const product = PRODUCTS.includes(input.product as Product) ? (input.product as Product) : "tokens";
  const rows = await catalog.list(product, { search: input.query ?? "", limit: Math.min(input.limit ?? 8, 15) });
  return rows.map((r) => ({
    label: r.label,
    name: r.name,
    instrument: r.instrument,
    price: r.price,
    change24hPct: r.change24hPct,
    volume24hUsd: r.volume24hUsd,
    liquidityUsd: r.liquidityUsd,
    meta: r.meta,
  }));
}

/**
 * Thesis → validated strategy. Uses Claude with two tools (market search and
 * a validating submit) so instruments are real and the output always passes
 * the schema. Falls back to a deterministic template when no credentials are
 * configured or the API is unavailable.
 */
export async function generateStrategy(
  thesis: string,
  deps: { catalog: Catalog; client?: Anthropic; onProgress?: Progress },
  edit?: { base: Strategy; instruction: string }
): Promise<GenerateResult> {
  const progress = deps.onProgress ?? (() => {});
  if (!deps.client && !hasCredentials()) {
    if (edit) {
      progress({ type: "fallback", message: "Applying the change without Claude" });
      return refineByRules(edit.base, edit.instruction);
    }
    progress({ type: "fallback", message: "No Anthropic credentials configured: using the built-in template generator." });
    return templateStrategy(thesis, deps.catalog);
  }

  const client = deps.client ?? new Anthropic();
  // The date goes in the message, not the cached system prompt, so "for Q4" or "until Friday" can be turned into a time.
  const today = timeContext(new Date());
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: edit
        ? `${today}\n\nHere is the user's current strategy:\n${JSON.stringify(edit.base)}\n\nThey want this change: ${edit.instruction}\n\nChange only what the request needs and keep everything else (ids, thesis, sizes, risk) as it is. Look up markets only if the change needs a new instrument, then submit the full updated strategy. In the rationale, say in one or two plain sentences what you changed.`
        : `${today}\n\nThesis: ${thesis}\n\nResearch the markets you need, then submit the strategy.`,
    },
  ];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      progress({ type: "thinking", message: turn === 0 ? (edit ? "Reading your change" : "Reading the thesis") : "Refining the graph" });
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16_000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "high" },
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools,
        messages,
      });

      if (response.stop_reason === "refusal") {
        throw new GenerationError(`The model declined this thesis${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : "."}`);
      }
      // Append-only: keep the assistant content exactly as returned (thinking blocks included).
      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (!toolUses.length) {
        if (response.stop_reason === "max_tokens") throw new GenerationError("The model ran out of output tokens.");
        messages.push({ role: "user", content: "Please call submit_strategy with the complete strategy." });
        continue;
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      let accepted: GenerateResult | null = null;
      for (const use of toolUses) {
        const input = (use.input ?? {}) as Record<string, unknown>;
        if (use.name === "search_markets") {
          progress({ type: "search", message: `Searching ${String(input.product)} for “${String(input.query)}”` });
          try {
            const rows = await runSearch(deps.catalog, input as { product?: string; query?: string; limit?: number });
            results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(rows) });
          } catch (e) {
            results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Search failed: ${(e as Error).message}` });
          }
        } else if (use.name === "submit_strategy") {
          progress({ type: "submit", message: "Validating the strategy graph" });
          const v = validateStrategy({ ...(input.strategy as object), thesis: (input.strategy as { thesis?: string })?.thesis || edit?.base.thesis || thesis });
          if (v.ok) {
            accepted = {
              strategy: v.strategy,
              warnings: v.warnings,
              rationale: typeof input.rationale === "string" ? input.rationale : "",
              source: "claude",
              notes: [],
            };
            results.push({ type: "tool_result", tool_use_id: use.id, content: "Accepted." });
          } else {
            progress({ type: "invalid", message: `${v.errors.length} validation issue(s), asking for a fix` });
            results.push({
              type: "tool_result",
              tool_use_id: use.id,
              is_error: true,
              content: `Validation failed. Fix these and resubmit:\n${v.errors.map((e) => `- ${e.path}: ${e.message}`).join("\n")}`,
            });
          }
        } else {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Unknown tool ${use.name}` });
        }
      }
      if (accepted) return accepted;
      messages.push({ role: "user", content: results });
    }
    throw new GenerationError("Could not produce a valid strategy within the turn limit.");
  } catch (e) {
    if (e instanceof GenerationError) throw e;
    // Any Claude-side problem (credentials, billing, rate limits, outages): log it for us, and still
    // give the user a strategy from the template generator instead of a raw API error.
    if (e instanceof Anthropic.APIError || e instanceof Anthropic.APIConnectionError) {
      const status = (e as { status?: number }).status;
      const reason = /credit balance/i.test(e.message) ? "out of Anthropic credits" : status === 401 || status === 403 ? "credentials rejected" : status === 429 ? "rate limited" : `API error ${status ?? "connection"}`;
      console.warn(`[ai] Claude unavailable (${reason}): ${e.message.slice(0, 300)}`);
      progress({ type: "fallback", message: "Claude is busy right now: drafting from Weft’s built-in templates." });
      if (edit) return refineByRules(edit.base, edit.instruction);
      return { ...(await templateStrategy(thesis, deps.catalog)), notes: ["Drafted from a template because Claude was unavailable. Check the rules before you run it."] };
    }
    throw e;
  }
}

/** Now, and the hours to the usual horizons, so the model never has to do date arithmetic. */
export function timeContext(now: Date): string {
  const hoursTo = (d: Date) => Math.max(1, Math.round((d.getTime() - now.getTime()) / 3_600_000));
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const end = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0, 23, 59)); // last day of `month`
  const qEnd = end(y, Math.floor(m / 3) * 3 + 2);
  const nextQEnd = end(y, Math.floor(m / 3) * 3 + 5);
  const friday = new Date(Date.UTC(y, m, now.getUTCDate() + ((5 - now.getUTCDay() + 7) % 7 || 7), 23, 59));
  return [
    `Now: ${now.toISOString().slice(0, 16)} UTC.`,
    `Hours from now until: the end of this week (Friday) ${hoursTo(friday)}, the end of this month ${hoursTo(end(y, m))}, the end of this quarter (${qEnd.toISOString().slice(0, 10)}) ${hoursTo(qEnd)}, the end of next quarter (${nextQEnd.toISOString().slice(0, 10)}) ${hoursTo(nextQEnd)}, the end of the year ${hoursTo(end(y, 11))}.`,
  ].join(" ");
}

