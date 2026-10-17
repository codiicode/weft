import type { MarketListing } from "@weft/venues";

/** Three ready-to-run theses for a market, written the way a person would say them. */
export function ideasFor(r: MarketListing): string[] {
  const name = r.label.replace(/^\$/, "").split(":").pop()!;
  switch (r.product) {
    case "tokens":
      return [
        `Buy $${name} with 0.1 SOL if it drops 10% in an hour, 20% stop`,
        `Buy $${name} if its 24h volume passes $5M and liquidity stays above $500k`,
        `Sell my $${name} if liquidity drops 30% in a day`,
      ];
    case "predictions":
      if (r.instrument.kind === "outcome" && r.instrument.venue === "polymarket") {
        const q = `“${r.name ?? r.label}” (${r.instrument.outcome})`;
        return [
          `Long BTC 2× if Polymarket's odds for ${q} pass 60%`,
          `Alert me if the odds for ${q} move 10 points in a day`,
          `Long ETH 2× if the odds for ${q} jump 15 points in a day, 20% stop`,
        ];
      }
      return [
        `Buy ${r.label} under 40¢ if the odds move 10 points our way`,
        `Buy ${r.label} if the odds jump 10 points in a day`,
        `Sell ${r.label} if the price jumps 15¢ in an hour`,
      ];
    case "options":
      return [`${r.instrument.kind === "option" ? r.instrument.underlying : name} call spread if it breaks out this week`];
    case "stocks":
      return [
        `${name}: go long on a 3% breakout with a 5% stop`,
        `Buy ${name} if it falls 4% in a day, take profit at +6%`,
        `Short ${name} 2× if it falls 5% in a day, 10% stop`,
      ];
    default:
      return [
        `${name} breakout: long 2× on a 3% move up with a trailing stop`,
        `Short ${name} when funding stays above 0.02% an hour for 8 hours`,
        `Buy ${name} if it drops 6% in a day, take profit at +8%`,
      ];
  }
}

const SUB = "₀₁₂₃₄₅₆₇₈₉";

/**
 * Tiny prices the way DEX screens write them: 0.00000309 → 0.0₅309 (five zeros after the point).
 * Keeps four significant digits and drops trailing zeros.
 */
export function tinyPrice(p: number): string {
  const a = Math.abs(p);
  const sign = p < 0 ? "−" : "";
  if (a >= 0.0001 || a === 0) return sign + a.toPrecision(4).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  const zeros = Math.floor(-Math.log10(a));
  const digits = Math.round(a * 10 ** (zeros + 4)).toString().replace(/0+$/, "") || "0";
  return `${sign}0.0${[...String(zeros)].map((d) => SUB[Number(d)]).join("")}${digits}`;
}

/** Price formatting for a market: cents for outcomes, sensible precision for everything else. */
export function priceFormatter(r: Pick<MarketListing, "product"> | null | undefined): (p: number) => string {
  if (r?.product === "predictions") return (p) => `${(p * 100).toFixed(1)}¢`;
  return (p) => {
    const a = Math.abs(p);
    if (a >= 10_000) return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (a >= 1) return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: a >= 100 ? 2 : 3 });
    return tinyPrice(p);
  };
}

/** The smallest price step worth showing on a chart axis, so ticks never repeat a label. */
export function chartMinMove(product: string | undefined, maxPrice: number): number {
  if (product === "predictions") return 0.001;
  if (!(maxPrice > 0)) return 0.01;
  return 10 ** (Math.floor(Math.log10(maxPrice)) - 3);
}

const VENUES: Record<string, string> = { hyperliquid: "Hyperliquid", jupiter: "Jupiter", polymarket: "Polymarket", deribit: "Deribit", solana: "Solana", geckoterminal: "GeckoTerminal" };
/** "hyperliquid" → "Hyperliquid"; unknown venues get a capital first letter. */
export function venueName(v: string | null | undefined): string {
  if (!v) return "";
  return VENUES[v.toLowerCase()] ?? v.replace(/^./, (c) => c.toUpperCase());
}
