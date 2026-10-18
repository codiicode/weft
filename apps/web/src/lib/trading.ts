"use client";
import { useEffect, useState } from "react";
import type { Strategy } from "@weft/strategy";
import { api } from "./api";
import { useAuth } from "./auth";

export type Venues = {
  hyperliquid: boolean;
  solana: boolean;
  /** Liquidity in Meteora pools with real money. */
  liquidity?: boolean;
  network: "testnet" | "mainnet" | null;
  /** Signal kinds Weft only simulates (no live feed): fine for alerts, never for real trades. */
  simulated?: string[];
};
let cached: Promise<Venues> | null = null;

/**
 * Which venues take real orders right now (from the server), fetched once per page load. A venue
 * that is still open to early testers only counts as live for a signed-in tester.
 */
export function useTradingVenues(): Venues | null {
  const auth = useAuth();
  const signedIn = auth.enabled && auth.authenticated;
  const [v, setV] = useState<Venues | null>(null);
  const [solanaForMe, setSolanaForMe] = useState(false);
  useEffect(() => {
    if (!signedIn) return setSolanaForMe(false);
    let alive = true;
    void api
      .solanaStatus()
      .then((s) => alive && setSolanaForMe(s.enabled))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [signedIn]);
  useEffect(() => {
    cached ??= api
      .health()
      .then((h) => ({
        ...(h.trading ?? { hyperliquid: false, solana: false, network: null }),
        simulated: Object.entries(h.signals ?? {}).filter(([, m]) => m === "simulated").map(([k]) => k),
      }))
      .catch(() => {
        cached = null;
        return { hyperliquid: false, solana: false, network: null };
      });
    let alive = true;
    void cached.then((x) => alive && setV(x));
    return () => {
      alive = false;
    };
  }, []);
  return v && solanaForMe && !v.solana ? { ...v, solana: true } : v;
}

type HlVenue = { accountValueUsd: number | null; positionsWorthUsd?: number | null; withdrawableUsd: number | null };

/**
 * Money free to trade on Hyperliquid: account value minus what the open positions are worth, so
 * free + in positions always adds up to the account value. (Not Hyperliquid's "withdrawable",
 * which drops to 0 while a leveraged position is open.)
 */
export function hlFreeUsd(venue: HlVenue | null | undefined): number | null {
  if (!venue || venue.accountValueUsd == null) return null;
  if (venue.positionsWorthUsd != null) return Math.max(0, venue.accountValueUsd - venue.positionsWorthUsd);
  return venue.withdrawableUsd ?? venue.accountValueUsd;
}

/** True when a strategy opens positions in Solana tokens. */
export function tradesSolana(s: Strategy | undefined): boolean {
  return Boolean(s?.actions.some((a) => (a.type === "open" && a.instrument.kind === "token") || a.type === "liquidity"));
}
