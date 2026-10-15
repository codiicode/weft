"use client";
import { useEffect, useState } from "react";
import type { Strategy } from "@weft/strategy";
import { api } from "./api";

export type Venues = { hyperliquid: boolean; solana: boolean; network: "testnet" | "mainnet" | null };
let cached: Promise<Venues> | null = null;

/** Which venues take real orders right now (from the server), fetched once per page load. */
export function useTradingVenues(): Venues | null {
  const [v, setV] = useState<Venues | null>(null);
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
  return v;
}

/** True when a strategy opens positions in Solana tokens. */
export function tradesSolana(s: Strategy | undefined): boolean {
  return Boolean(s?.actions.some((a) => a.type === "open" && a.instrument.kind === "token"));
}
