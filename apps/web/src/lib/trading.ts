"use client";
import { useEffect, useState } from "react";
import type { Strategy } from "@weft/strategy";
import { api } from "./api";
import { useAuth } from "./auth";

export type Venues = { hyperliquid: boolean; solana: boolean; network: "testnet" | "mainnet" | null };
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
      .then((h) => h.trading ?? { hyperliquid: false, solana: false, network: null })
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

/** True when a strategy opens positions in Solana tokens. */
export function tradesSolana(s: Strategy | undefined): boolean {
  return Boolean(s?.actions.some((a) => a.type === "open" && a.instrument.kind === "token"));
}
