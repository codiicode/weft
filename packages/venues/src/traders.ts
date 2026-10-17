import type { HyperliquidClient, RawClearinghouseState } from "./hyperliquid/client.ts";
import { num } from "./util.ts";

/** Another Hyperliquid account's open perp positions (core dex), for following and copying it. */
export interface TraderPosition {
  coin: string;
  side: "long" | "short";
  sizeUsd: number;
  leverage: number;
  entryPrice: number | null;
  /** Profit on the margin, in percent. */
  unrealizedPct: number | null;
}

export interface TraderState {
  accountValueUsd: number | null;
  positions: TraderPosition[];
}

export function parseTraderState(r: RawClearinghouseState): TraderState {
  const positions: TraderPosition[] = [];
  for (const { position: p } of r.assetPositions ?? []) {
    const szi = num(p.szi) ?? 0;
    if (!szi) continue;
    const roe = num(p.returnOnEquity);
    positions.push({
      coin: p.coin,
      side: szi > 0 ? "long" : "short",
      sizeUsd: Math.abs(num(p.positionValue) ?? 0),
      leverage: p.leverage?.value ?? 1,
      entryPrice: num(p.entryPx),
      unrealizedPct: roe == null ? null : Math.round(roe * 10_000) / 100,
    });
  }
  return { accountValueUsd: num(r.marginSummary?.accountValue), positions };
}

export async function traderState(hl: HyperliquidClient, address: string): Promise<TraderState> {
  return parseTraderState(await hl.clearinghouseState(address.toLowerCase()));
}
