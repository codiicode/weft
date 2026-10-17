import type { HyperliquidClient } from "../hyperliquid/client.ts";
import type { SignalProvider } from "../types.ts";
import { traderState } from "../traders.ts";
import { defineProvider } from "./common.ts";

/** Another Hyperliquid account's position in one coin, with when it last opened, closed or flipped. */
export function traderProvider(hl: HyperliquidClient, onError?: (k: string, e: unknown) => void): SignalProvider {
  // Last side seen per account and coin, and since when (first sighting has no change time).
  const seen = new Map<string, { side: number; since: number | null }>();
  return defineProvider(
    ["trader"],
    "live",
    async (s, now) => {
      const st = await traderState(hl, s.params.address);
      const coin = s.params.coin.toUpperCase();
      const p = st.positions.find((x) => x.coin.toUpperCase() === coin);
      const side = p ? (p.side === "long" ? 1 : -1) : 0;
      const k = `${s.params.address.toLowerCase()}:${coin}`;
      const prev = seen.get(k);
      const since = !prev ? null : prev.side !== side ? now : prev.since;
      seen.set(k, { side, since });
      if (seen.size > 5_000) seen.delete(seen.keys().next().value!);
      return {
        side,
        size_usd: p?.sizeUsd ?? 0,
        leverage: p?.leverage ?? null,
        entry_price: p?.entryPrice ?? null,
        unrealized_pnl_pct: p?.unrealizedPct ?? null,
        minutes_since_change: since == null ? null : Math.max(0, Math.round((now - since) / 60_000)),
        account_value_usd: st.accountValueUsd,
      };
    },
    onError
  );
}
