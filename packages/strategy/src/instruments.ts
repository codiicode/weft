import { z } from "zod";

/**
 * Instruments: everything a strategy can trade, identified unambiguously.
 *
 * Stocks are not their own kind: an NVDA HIP-3 perp is a `perp` with
 * `assetClass: "equity"`, and a tokenized stock on Solana (e.g. NVDAx) is a
 * `token` with `assetClass: "equity"`. Execution venue follows from the kind.
 */

export const AssetClass = z.enum(["crypto", "equity", "commodity", "fx", "index", "other"]);
export type AssetClass = z.infer<typeof AssetClass>;

/** Base58 SPL mint address. Tickers are ambiguous on Solana; mints are not. */
export const SolanaMint = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a base58 Solana mint address");

/** Hyperliquid perpetual. `dex` selects a HIP-3 builder-deployed market (stocks, commodities, FX…). */
export const PerpInstrument = z.object({
  kind: z.literal("perp"),
  venue: z.literal("hyperliquid"),
  dex: z.string().min(1).optional().describe("HIP-3 deployer dex name; omit for core Hyperliquid perps"),
  symbol: z.string().min(1).describe("Market symbol, e.g. BTC, NVDA, WHEAT"),
  assetClass: AssetClass.default("crypto"),
});

/** Hyperliquid spot pair. */
export const SpotInstrument = z.object({
  kind: z.literal("spot"),
  venue: z.literal("hyperliquid"),
  symbol: z.string().min(1).describe("Spot pair, e.g. HYPE/USDC"),
  assetClass: AssetClass.default("crypto"),
});

/** Any SPL token on Solana: majors, new tokens on pump.fun/Meteora/Raydium, tokenized stocks. */
export const TokenInstrument = z.object({
  kind: z.literal("token"),
  chain: z.literal("solana"),
  mint: SolanaMint,
  symbol: z.string().min(1).optional().describe("Display only; the mint is the identity"),
  quote: z.enum(["SOL", "USDC"]).default("SOL"),
  route: z
    .enum(["auto", "jupiter", "pumpfun", "meteora", "raydium"])
    .default("auto")
    .describe("Execution route; auto lets the router pick (Jupiter, or the launchpad curve before migration)"),
  assetClass: AssetClass.default("crypto"),
});

/** A single outcome of a prediction market (HIP-4 on Hyperliquid, or Jupiter Prediction). Prices are probabilities 0–1. */
export const OutcomeInstrument = z.object({
  kind: z.literal("outcome"),
  venue: z.enum(["hyperliquid", "jupiter", "polymarket"]).describe("polymarket: watch-only odds (signals), not tradable yet"),
  market: z.string().min(1).describe("Venue market id"),
  outcome: z.string().min(1).describe("Outcome to hold, e.g. YES or NO"),
  question: z.string().optional().describe("Display only"),
});

/** A listed option contract. */
export const OptionInstrument = z.object({
  kind: z.literal("option"),
  venue: z.enum(["hyperliquid", "derive", "deribit"]),
  underlying: z.string().min(1),
  expiry: z.iso.date().describe("YYYY-MM-DD"),
  strike: z.number().positive(),
  right: z.enum(["call", "put"]),
});

/**
 * A liquidity pool to provide liquidity to (a `liquidity` action, never an `open`). Meteora DLMM on
 * Solana: prices are the base token in the quote token (SOL-USDC: USDC per SOL).
 */
export const LpInstrument = z.object({
  kind: z.literal("lp"),
  venue: z.literal("meteora"),
  pool: SolanaMint.describe("The DLMM pool (pair) address, copied exactly from the search"),
  symbol: z.string().min(1).describe("Pair name for display, e.g. SOL-USDC"),
  baseMint: SolanaMint,
  quoteMint: SolanaMint,
  quoteSymbol: z.string().min(1).describe("e.g. USDC or SOL"),
});

/**
 * A synthetic perp on Papertrade (HyperEVM): BTC or ETH, up to 1000×, priced at Hyperliquid's mid.
 * No funding or fee on the position; a winning close keeps part of the gain (an impact haircut, then
 * a 2% win fee); crossing the bust price forfeits the whole margin.
 */
export const SynthInstrument = z.object({
  kind: z.literal("synth"),
  venue: z.literal("papertrade"),
  symbol: z.enum(["BTC", "ETH"]),
  assetClass: AssetClass.default("crypto"),
});

export const Instrument = z.discriminatedUnion("kind", [
  PerpInstrument,
  SpotInstrument,
  TokenInstrument,
  OutcomeInstrument,
  OptionInstrument,
  LpInstrument,
  SynthInstrument,
]);

/** Instruments a plain `open` action may trade (options go through multi-leg `options` actions). */
export const TradableInstrument = z.discriminatedUnion("kind", [
  PerpInstrument,
  SpotInstrument,
  TokenInstrument,
  OutcomeInstrument,
  SynthInstrument,
]);

export type PerpInstrument = z.infer<typeof PerpInstrument>;
export type SpotInstrument = z.infer<typeof SpotInstrument>;
export type TokenInstrument = z.infer<typeof TokenInstrument>;
export type OutcomeInstrument = z.infer<typeof OutcomeInstrument>;
export type OptionInstrument = z.infer<typeof OptionInstrument>;
export type LpInstrument = z.infer<typeof LpInstrument>;
export type SynthInstrument = z.infer<typeof SynthInstrument>;
export type Instrument = z.infer<typeof Instrument>;
export type TradableInstrument = z.infer<typeof TradableInstrument>;

/** Canonical, stable key for an instrument, used for positions and idempotency. */
export function instrumentKey(i: Instrument): string {
  switch (i.kind) {
    case "perp":
      return `hl:perp:${i.dex ? `${i.dex}:` : ""}${i.symbol}`;
    case "spot":
      return `hl:spot:${i.symbol}`;
    case "token":
      return `sol:token:${i.mint}`;
    case "outcome":
      return `${i.venue === "hyperliquid" ? "hl" : i.venue === "polymarket" ? "pm" : "jup"}:outcome:${i.market}:${i.outcome}`;
    case "option":
      return `${i.venue}:option:${i.underlying}-${i.expiry}-${i.strike}-${i.right === "call" ? "C" : "P"}`;
    case "lp":
      return `meteora:lp:${i.pool}`;
    case "synth":
      return `papertrade:synth:${i.symbol}`;
  }
}

/** Short human label for UIs and logs. */
export function instrumentLabel(i: Instrument): string {
  switch (i.kind) {
    case "perp":
      return `${i.symbol}-PERP`;
    case "spot":
      return i.symbol;
    case "token":
      return i.symbol ? `$${i.symbol}` : `${i.mint.slice(0, 4)}…${i.mint.slice(-4)}`;
    case "outcome":
      return `${i.outcome} · ${i.question ?? i.market}`;
    case "option":
      return `${i.underlying} ${i.expiry} ${i.strike}${i.right === "call" ? "C" : "P"}`;
    case "lp":
      return `${i.symbol} liquidity`;
    case "synth":
      return `${i.symbol} on Papertrade`;
  }
}

/** Instruments that can only be bought (no shorting): spot, tokens, outcome shares. */
export function isLongOnly(i: Instrument): boolean {
  return i.kind === "spot" || i.kind === "token" || i.kind === "outcome";
}
