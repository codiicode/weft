import type { Instrument } from "@weft/strategy";

/**
 * Fee schedule for paper fills. Defaults mirror what a live Weft order pays:
 *
 * - Hyperliquid perps & spot: taker 4.5 bps + Weft builder fee 10 bps (Hyperliquid's perp maximum), on notional, both sides.
 * - HIP-4 / Jupiter outcomes: 0 bps venue fee to open (close configurable, default 0) + builder fee 10 bps.
 * - Solana tokens (Jupiter / launchpads): Weft platform fee 100 bps + ~$0.002 network fee per swap.
 * - Options: 3 bps of underlying notional (contracts × strike as proxy), or a flat
 *   per-contract fee if set, capped at a % of premium (Deribit-style cap).
 *
 * "builder" fees are Weft's take (Hyperliquid builder code + Solana platform fee)
 * and are tracked separately per deployment: they later fund token buybacks.
 */
export interface FeeSchedule {
  /** builderBps: perps (max 0.1%). spotBuilderBps: spot sells only (max 1%); Hyperliquid takes no builder fee on spot buys. */
  hyperliquid: { takerBps: number; builderBps: number; spotBuilderBps?: number };
  outcome: { openBps: number; closeBps: number; builderBps: number };
  solana: { platformBps: number; networkFeeUsd: number };
  options: { notionalBps: number; perContractUsd?: number; capPctOfPremium: number };
}

export type FeeOverrides = { [K in keyof FeeSchedule]?: Partial<FeeSchedule[K]> };

export const DEFAULT_FEES: FeeSchedule = {
  hyperliquid: { takerBps: 4.5, builderBps: 10, spotBuilderBps: 100 },
  outcome: { openBps: 0, closeBps: 0, builderBps: 10 },
  solana: { platformBps: 100, networkFeeUsd: 0.002 },
  options: { notionalBps: 3, capPctOfPremium: 12.5 },
};

export function resolveFees(o: FeeOverrides = {}): FeeSchedule {
  return {
    hyperliquid: { ...DEFAULT_FEES.hyperliquid, ...o.hyperliquid },
    outcome: { ...DEFAULT_FEES.outcome, ...o.outcome },
    solana: { ...DEFAULT_FEES.solana, ...o.solana },
    options: { ...DEFAULT_FEES.options, ...o.options },
  };
}

export interface FeeQuote {
  /** Everything paid on this fill, USD (includes builderFeeUsd). */
  feeUsd: number;
  /** Weft's share, USD. */
  builderFeeUsd: number;
}

/**
 * @param notionalUsd qty × fill price (perps: leveraged notional)
 * @param qty units filled (contracts for options)
 */
export function computeFee(
  fees: FeeSchedule,
  instrument: Instrument,
  phase: "open" | "close",
  notionalUsd: number,
  qty: number
): FeeQuote {
  const bps = (n: number) => (notionalUsd * n) / 10_000;
  switch (instrument.kind) {
    case "perp": {
      const builder = bps(fees.hyperliquid.builderBps);
      return { feeUsd: bps(fees.hyperliquid.takerBps) + builder, builderFeeUsd: builder };
    }
    case "spot": {
      const builder = phase === "close" ? bps(fees.hyperliquid.spotBuilderBps ?? fees.hyperliquid.builderBps) : 0;
      return { feeUsd: bps(fees.hyperliquid.takerBps) + builder, builderFeeUsd: builder };
    }
    case "outcome": {
      const builder = bps(fees.outcome.builderBps);
      const venue = bps(phase === "open" ? fees.outcome.openBps : fees.outcome.closeBps);
      return { feeUsd: venue + builder, builderFeeUsd: builder };
    }
    case "token": {
      const platform = bps(fees.solana.platformBps);
      return { feeUsd: platform + fees.solana.networkFeeUsd, builderFeeUsd: platform };
    }
    case "lp":
      // Practice only for now: depositing and withdrawing carry no Weft fee.
      return { feeUsd: 0, builderFeeUsd: 0 };
    case "synth":
      // Papertrade charges nothing on the position; what it keeps of a win is settled on close.
      return { feeUsd: 0, builderFeeUsd: 0 };
    case "lend":
      // A Kamino deposit and withdrawal carry no fee; the interest is in the kToken's price.
      return { feeUsd: 0, builderFeeUsd: 0 };
    case "option": {
      const o = fees.options;
      const raw = o.perContractUsd != null ? qty * o.perContractUsd : (qty * instrument.strike * o.notionalBps) / 10_000;
      const cap = (notionalUsd * o.capPctOfPremium) / 100;
      return { feeUsd: Math.min(raw, cap), builderFeeUsd: 0 };
    }
  }
}
