import { validateStrategy, type Instrument, type StrategyInput } from "@weft/strategy";
import { crowdedFade, elNino, fedPivot } from "@weft/strategy/examples";
import type { Catalog, MarketListing } from "@weft/venues";
import type { GenerateResult } from "./generate.ts";

/**
 * Deterministic thesis → strategy generator, used when Claude isn't configured
 * or is unavailable. It routes by keywords, resolves real instruments through
 * the catalog (mints, HIP-3 symbols, prediction markets, options) and always
 * returns a strategy that passes validation (worst case: alerts-only).
 */

const MAJORS = ["BTC", "ETH", "SOL", "HYPE", "DOGE", "XRP", "SUI", "AVAX", "LINK", "BNB"];
const STOCKS = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "AMD", "COIN", "HOOD", "MSTR", "PLTR", "NFLX"];

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "strategy";
const sid = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "s_$1").slice(0, 30) || "x";

/** First standalone number that isn't a percentage, a leverage ("3x") or a SOL size. */
function firstNumber(text: string): number | undefined {
  const m = text.match(/(?<![\w$.,])(\d+(?:[.,]\d+)?)(?![\d.,])(?!\s*(?:%|x\b|sol\b))/i);
  return m ? Number(m[1]!.replace(",", ".")) : undefined;
}
/** "dips 10%", "drops 5 %", "down 8%" → 10, 5, 8 */
function dipPct(text: string): number | undefined {
  const m = text.match(/\b(?:dips?|drops?|falls?|down|dumps?)\s+(?:by\s+)?(\d+(?:[.,]\d+)?)\s*%/i);
  return m ? Number(m[1]!.replace(",", ".")) : undefined;
}
function solSize(text: string): number | undefined {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*sol\b/i);
  return m ? Number(m[1]!.replace(",", ".")) : undefined;
}
function cashtags(text: string): string[] {
  return [...text.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,14})/g)].map((m) => m[1]!.toUpperCase());
}
function mentioned(text: string, list: string[]): string | undefined {
  const up = ` ${text.toUpperCase().replace(/[^A-Z0-9$]+/g, " ")} `;
  return list.find((s) => up.includes(` ${s} `) || up.includes(` $${s} `));
}

async function find(catalog: Catalog, product: Parameters<Catalog["list"]>[0], q: string, pick?: (r: MarketListing) => boolean) {
  try {
    const rows = await catalog.list(product, { search: q, limit: 10 });
    return (pick ? rows.find(pick) : undefined) ?? rows[0];
  } catch {
    return undefined;
  }
}

function keywordsOf(thesis: string): string[] {
  const words = thesis.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}$#@]/gu, "")).filter((w) => w.length > 3);
  return words.length ? words.slice(0, 4) : [thesis.trim().slice(0, 40) || "market"];
}

function alertsOnly(thesis: string): StrategyInput {
  const tag = cashtags(thesis)[0];
  return {
    schemaVersion: 1,
    id: slug(`watch-${tag ?? thesis.split(/\s+/).slice(0, 4).join(" ")}`),
    name: tag ? `Watch $${tag}` : "Thesis watch",
    thesis,
    tags: ["alerts"],
    signals: [{ id: "chatter", kind: "social", params: tag ? { cashtags: [tag] } : { keywords: keywordsOf(thesis) } }],
    triggers: [
      {
        id: "chatter_spike",
        label: "Bullish chatter spike",
        when: { op: "and", args: [
          { op: "gt", left: { ref: "chatter.mentions_change_1h_pct" }, right: { value: 150 } },
          { op: "gt", left: { ref: "chatter.sentiment" }, right: { value: 0.3 } },
        ] },
        forMinutes: 10,
        cooldownMinutes: 240,
      },
    ],
    actions: [{ id: "alert", type: "notify", on: ["chatter_spike"], channel: "telegram", message: `Signal for your thesis: ${thesis.slice(0, 200)}` }],
  };
}

async function tokenStrategy(thesis: string, symbol: string, catalog: Catalog): Promise<{ s: StrategyInput; notes: string[] } | null> {
  // Strict: a token must match the symbol exactly (tickers collide on Solana); never fall back to another token.
  const norm = (x: string | undefined) => (x ?? "").replace(/^\$+/, "").toUpperCase();
  const rows = await catalog.list("tokens", { search: symbol, limit: 20 }).catch(() => [] as MarketListing[]);
  const row = rows
    .filter((r) => r.instrument.kind === "token" && (norm(r.instrument.symbol) === symbol || norm(r.label) === symbol))
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
  if (!row || row.instrument.kind !== "token") return null;
  const inst = { ...row.instrument, symbol };
  const mint = inst.mint;
  const dip = dipPct(thesis);
  const rawLevel = dip == null ? firstNumber(thesis.replace(/\$[A-Za-z0-9]+/g, "")) : undefined;
  // Ignore numbers that can't be a price level for this token (e.g. "2 days", or 1000× the price).
  const level = rawLevel != null && rawLevel > 0 && row.price != null && rawLevel < row.price * 50 ? rawLevel : undefined;
  const size = solSize(thesis) ?? 0.5;
  const priceCond =
    dip != null
      ? { op: "lte" as const, left: { ref: "px.change_24h_pct" }, right: { value: -dip } }
      : level != null
        ? { op: "lte" as const, left: { ref: "px.price" }, right: { value: level } }
        : { op: "gt" as const, left: { ref: "px.change_1h_pct" }, right: { value: 5 } };
  const s: StrategyInput = {
    schemaVersion: 1,
    id: slug(`${symbol}-momentum`),
    name: `$${symbol} ${dip != null ? `dip ${dip}%` : level != null ? "level" : "momentum"} + sentiment`,
    thesis,
    tags: ["solana", "token"],
    signals: [
      { id: "px", kind: "price", label: `$${symbol}`, params: { instrument: inst } },
      { id: "chain", kind: "token_onchain", label: `$${symbol} on-chain`, params: { mint } },
      { id: "social", kind: "social", label: `$${symbol} on X`, params: { cashtags: [symbol] } },
    ],
    triggers: [
      {
        id: "entry",
        label: dip != null ? `Down ${dip}% & bullish` : level != null ? `Price ≤ ${level} & bullish` : "Breakout & bullish",
        when: { op: "and", args: [
          priceCond,
          { op: "gt", left: { ref: "social.sentiment" }, right: { value: 0.3 } },
          { op: "gt", left: { ref: "social.mentions_change_1h_pct" }, right: { value: 150 } },
          { op: "gt", left: { ref: "chain.buy_sell_ratio_1h" }, right: { value: 1.3 } },
        ] },
        forMinutes: 5,
      },
      { id: "dev_dump", label: "Dev selling", when: { op: "gt", left: { ref: "chain.dev_sold_pct" }, right: { value: 20 } } },
      { id: "hype_gone", label: "Sentiment flips", when: { op: "lt", left: { ref: "social.sentiment" }, right: { value: -0.2 } }, forMinutes: 30 },
    ],
    actions: [
      { id: "buy", type: "open", on: ["entry"], instrument: inst, side: "long", size: { unit: "native", value: size }, order: { maxPriceImpactBps: 200 }, exits: { takeProfit: { pct: 40 }, stopLoss: { pct: 20 }, timeExitHours: 48 } },
      { id: "alert", type: "notify", on: ["entry"], channel: "telegram", message: `$${symbol} entry conditions met: buying ${size} SOL.` },
      { id: "exit", type: "close", on: ["dev_dump", "hype_gone"], target: { instrument: inst } },
    ],
  };
  return { s, notes: [`Resolved $${symbol} to mint ${mint}.`] };
}

async function perpMomentum(thesis: string, symbol: string, catalog: Catalog, product: "perps" | "stocks"): Promise<StrategyInput | null> {
  const row = await find(catalog, product, symbol, (r) => r.label.toUpperCase() === symbol || r.label.toUpperCase().endsWith(`:${symbol}`));
  if (!row || (row.instrument.kind !== "perp" && row.instrument.kind !== "token")) return null;
  const inst = row.instrument;
  const bearish = /\b(short|dump|crash|bear|fade|top|overvalued|down)\b/i.test(thesis);
  const earnings = /earnings|report|print|q[1-4]/i.test(thesis);
  const perp = inst.kind === "perp";
  const signals: StrategyInput["signals"] = [{ id: "px", kind: "price", label: row.label, params: { instrument: inst } }];
  if (earnings) signals.push({ id: "er", kind: "calendar", params: { event: "earnings", symbol } });
  const when = earnings
    ? { op: "between" as const, value: { ref: "er.hours_until" }, min: { value: 2 }, max: { value: 48 } }
    : bearish
      ? { op: "lt" as const, left: { ref: "px.change_24h_pct" }, right: { value: -3 } }
      : { op: "gt" as const, left: { ref: "px.change_24h_pct" }, right: { value: 3 } };
  const side = bearish && perp ? "short" : "long";
  return {
    schemaVersion: 1,
    id: slug(`${symbol}-${earnings ? "earnings" : side}`),
    name: `${symbol} ${earnings ? "earnings drift" : side === "long" ? "momentum" : "breakdown"}`,
    thesis,
    tags: [product, earnings ? "earnings" : "momentum"],
    signals,
    triggers: [
      { id: "entry", when, forMinutes: earnings ? 0 : 15 },
      ...(earnings ? [{ id: "pre_print_exit", when: { op: "lt" as const, left: { ref: "er.hours_until" }, right: { value: 1 } } }] : []),
    ],
    actions: [
      {
        id: "open",
        type: "open",
        on: ["entry"],
        instrument: inst as Extract<Instrument, { kind: "perp" | "token" }>,
        side,
        size: { unit: "pct_equity", value: 8 },
        ...(perp ? { leverage: 2 } : {}),
        exits: { takeProfit: { pct: earnings ? 8 : 12 }, stopLoss: { pct: earnings ? 4 : 5 }, ...(earnings ? {} : { trailingStopPct: 6 }) },
      },
      ...(earnings ? [{ id: "flat", type: "close" as const, on: ["pre_print_exit"], target: "all" as const }] : []),
    ],
  };
}

async function optionsStrategy(thesis: string, underlying: string, catalog: Catalog): Promise<StrategyInput | null> {
  const rows = await catalog.list("options", { search: underlying, limit: 400 }).catch(() => []);
  const calls = rows.filter((r) => r.instrument.kind === "option" && r.instrument.right === (/\bput|bear|down|crash/i.test(thesis) ? "put" : "call"));
  if (!calls.length) return null;
  const spot = (await find(catalog, "perps", underlying))?.price ?? null;
  // Prefer ~1–5 weeks out: long enough for the thesis to play out, short enough to be liquid.
  const soon = Date.now() + 6 * 86_400_000;
  const byExpiry = new Map<string, MarketListing[]>();
  for (const r of calls) {
    if (r.instrument.kind !== "option" || Date.parse(r.instrument.expiry) < soon) continue;
    byExpiry.set(r.instrument.expiry, [...(byExpiry.get(r.instrument.expiry) ?? []), r]);
  }
  const expiry = [...byExpiry.keys()].sort()[0];
  if (!expiry || spot == null) return null;
  const chain = byExpiry.get(expiry)!.filter((r) => r.instrument.kind === "option").sort((a, b) => (a.instrument as { strike: number }).strike - (b.instrument as { strike: number }).strike);
  const isPut = chain[0]!.instrument.kind === "option" && chain[0]!.instrument.right === "put";
  const target = (m: number) => chain.reduce((best, r) => (Math.abs((r.instrument as { strike: number }).strike - spot * m) < Math.abs((best.instrument as { strike: number }).strike - spot * m) ? r : best));
  const near = target(isPut ? 0.95 : 1.05);
  const far = target(isPut ? 0.85 : 1.15);
  if (near === far || near.instrument.kind !== "option" || far.instrument.kind !== "option") return null;
  return {
    schemaVersion: 1,
    id: slug(`${underlying}-${isPut ? "put" : "call"}-spread`),
    name: `${underlying} ${isPut ? "put" : "call"} spread`,
    thesis,
    tags: ["options"],
    signals: [{ id: "px", kind: "price", label: underlying, params: { instrument: { kind: "perp", venue: "hyperliquid", symbol: underlying } } }],
    triggers: [{ id: "entry", when: { op: isPut ? "lt" : "gt", left: { ref: "px.change_24h_pct" }, right: { value: isPut ? -2 : 2 } }, forMinutes: 30 }],
    actions: [
      {
        id: "spread",
        type: "options",
        on: ["entry"],
        legs: [
          { instrument: near.instrument, side: "buy" },
          { instrument: far.instrument, side: "sell" },
        ],
        size: { unit: "usd", value: 500 },
        // Option books are wide: allow up to 10% from mid per leg, the risk engine still caps size.
        order: { maxSlippageBps: 1_000 },
        exits: { takeProfit: { pct: 100 }, stopLoss: { pct: 50 } },
      },
    ],
  };
}

async function predictionSwap<T extends StrategyInput>(base: T, catalog: Catalog, query: string): Promise<{ s: T; notes: string[] }> {
  const row = await find(catalog, "predictions", query);
  const s = structuredClone(base) as T;
  if (row && row.instrument.kind === "outcome") {
    const inst = row.instrument;
    const re = (o: unknown): unknown =>
      Array.isArray(o) ? o.map(re) : o && typeof o === "object"
        ? (o as { kind?: string }).kind === "outcome" ? inst : Object.fromEntries(Object.entries(o).map(([k, v]) => [k, re(v)]))
        : o;
    return { s: re(s) as T, notes: [`Using prediction market “${row.name ?? row.label}”.`] };
  }
  return { s, notes: ["No live prediction market matched; the outcome legs use a placeholder market id."] };
}

export async function templateStrategy(thesis: string, catalog: Catalog): Promise<GenerateResult> {
  const t = thesis.toLowerCase();
  const notes: string[] = ["Generated by the template engine (configure ANTHROPIC_API_KEY for full AI generation)."];
  let s: StrategyInput | null = null;

  try {
    const tags = cashtags(thesis);
    const tokenTag = tags.find((x) => !MAJORS.includes(x) && !STOCKS.includes(x));
    const stock = mentioned(thesis, STOCKS);
    const major = mentioned(thesis, MAJORS);

    if (/\boption|call spread|put spread|\bcalls?\b|\bputs?\b/i.test(t) && major) {
      s = await optionsStrategy(thesis, major, catalog);
    } else if (/el ni[nñ]o|la ni[nñ]a|weather|drought|harvest|wheat|crop/i.test(t)) {
      const r = await predictionSwap(elNino as StrategyInput, catalog, "el nino");
      notes.push(...r.notes);
      s = { ...r.s, thesis };
    } else if (/\bfed\b|fomc|rate cut|rates|powell|cpi|inflation/i.test(t)) {
      const r = await predictionSwap(fedPivot as StrategyInput, catalog, "fed");
      notes.push(...r.notes);
      s = { ...r.s, thesis };
    } else if (/funding|crowded|overleveraged|fade the crowd|squeeze/i.test(t)) {
      const sym = major ?? "SOL";
      s = JSON.parse(JSON.stringify(crowdedFade).replaceAll('"SOL"', `"${sym}"`).replaceAll("sol_funding", `${sid(sym)}_funding`).replaceAll("short_sol", `short_${sid(sym)}`).replaceAll("exit_sol", `exit_${sid(sym)}`)) as StrategyInput;
      s = { ...s, id: slug(`${sym}-crowded-fade`), name: `${sym} Crowded Fade`, thesis };
    } else if (tokenTag || /memecoin|pump\.fun|meteora|bonk|\bmeme\b/i.test(t)) {
      const r = tokenTag ? await tokenStrategy(thesis, tokenTag, catalog) : null;
      if (r) {
        s = r.s;
        notes.push(...r.notes);
      } else notes.push(`Couldn't resolve ${tokenTag ? `$${tokenTag}` : "the token"} to a mint; created an alerts-only watcher instead.`);
    } else if (stock) {
      s = await perpMomentum(thesis, stock, catalog, "stocks");
    } else if (major) {
      s = await perpMomentum(thesis, major, catalog, "perps");
    }
  } catch (e) {
    notes.push(`Template routing failed (${(e as Error).message}).`);
  }

  if (!s) s = alertsOnly(thesis);
  const v = validateStrategy(s);
  if (v.ok) return { strategy: v.strategy, warnings: v.warnings, rationale: "", source: "template", notes };
  const fallback = validateStrategy(alertsOnly(thesis));
  if (!fallback.ok) throw new Error(`template fallback invalid: ${fallback.errors.map((e) => e.message).join("; ")}`);
  return {
    strategy: fallback.strategy,
    warnings: fallback.warnings,
    rationale: "",
    source: "template",
    notes: [...notes, `Template output failed validation (${v.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}); created an alerts-only watcher.`],
  };
}
