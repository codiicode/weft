import type { Http } from "./http.ts";
import type { MarketListing } from "./types.ts";
import type { OutcomeInstrument } from "@weft/strategy";
import { instrumentKey } from "@weft/strategy";
import { num } from "./util.ts";

/**
 * Polymarket, read-only (Gamma API, public, no key). Weft watches these odds as signals and trades
 * other markets on them; it doesn't trade on Polymarket itself yet.
 */
export const POLYMARKET_GAMMA_URL = "https://gamma-api.polymarket.com";

export interface RawPolymarket {
  id: string;
  question: string;
  slug?: string;
  /** JSON-encoded string arrays, e.g. '["Yes","No"]' and '["0.81","0.19"]'. */
  outcomes?: string;
  outcomePrices?: string;
  /** 24h price change of the first outcome. */
  oneDayPriceChange?: number | null;
  volume24hr?: number | null;
  liquidityNum?: number | null;
  endDate?: string | null;
  closed?: boolean;
  active?: boolean;
}

export interface PolymarketView {
  id: string;
  question: string;
  slug: string | null;
  outcomes: { name: string; price: number | null; change24h: number | null }[];
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  endsAt: number | null;
  open: boolean;
}

const parseList = (s: string | undefined): string[] => {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

export function parsePolymarket(m: RawPolymarket): PolymarketView {
  const names = parseList(m.outcomes);
  const prices = parseList(m.outcomePrices).map((p) => num(p));
  const d = m.oneDayPriceChange ?? null;
  return {
    id: String(m.id),
    question: m.question,
    slug: m.slug ?? null,
    // The 24h change is reported for the first outcome; a two-way market's other side moves the opposite way.
    outcomes: names.map((name, i) => ({ name, price: prices[i] ?? null, change24h: d == null ? null : i === 0 ? d : names.length === 2 ? -d : null })),
    volume24hUsd: m.volume24hr ?? null,
    liquidityUsd: m.liquidityNum ?? null,
    endsAt: m.endDate ? Date.parse(m.endDate) : null,
    open: m.active !== false && m.closed !== true,
  };
}

/** The outcome named `outcome` (case-insensitive; "YES"/"NO" match "Yes"/"No"). */
export function polymarketOutcome(m: PolymarketView, outcome: string) {
  const want = outcome.trim().toLowerCase();
  return m.outcomes.find((o) => o.name.toLowerCase() === want) ?? null;
}

export function polymarketListings(m: PolymarketView): MarketListing[] {
  if (!m.open) return [];
  return m.outcomes
    // Outcomes at 1¢ or 99¢ are as good as settled: nothing left to watch.
    .filter((o) => o.price != null && o.price >= 0.01 && o.price <= 0.99)
    .map((o) => {
      const instrument: OutcomeInstrument = { kind: "outcome", venue: "polymarket", market: m.id, outcome: o.name, question: m.question };
      return {
        product: "predictions",
        instrument,
        instrumentKey: instrumentKey(instrument),
        label: `${m.question} · ${o.name}`,
        name: m.question,
        price: o.price,
        change24hPct: null,
        volume24hUsd: m.volume24hUsd,
        liquidityUsd: m.liquidityUsd,
        meta: {
          venue: "polymarket",
          watchOnly: true,
          change24hPp: o.change24h,
          expiresAt: m.endsAt != null ? new Date(m.endsAt).toISOString() : null,
          url: m.slug ? `https://polymarket.com/market/${m.slug}` : null,
        },
        venue: "polymarket",
      } as MarketListing;
    });
}

export class PolymarketClient {
  private readonly http: Http;
  private readonly base: string;

  constructor(http: Http, base = POLYMARKET_GAMMA_URL) {
    this.http = http;
    this.base = base;
  }

  async market(id: string): Promise<PolymarketView> {
    return parsePolymarket(await this.http.json<RawPolymarket>(`${this.base}/markets/${encodeURIComponent(id)}`, { ttlMs: 20_000, timeoutMs: 15_000 }));
  }

  /** Open markets matching a search, in Polymarket's own relevance order. */
  async search(query: string, limit = 20): Promise<PolymarketView[]> {
    const r = await this.http.json<{ events?: { markets?: RawPolymarket[] }[] }>(
      `${this.base}/public-search?q=${encodeURIComponent(query)}&limit_per_type=${limit}&events_status=active`,
      { ttlMs: 60_000, timeoutMs: 15_000 }
    );
    return (r.events ?? [])
      .flatMap((e) => e.markets ?? [])
      .map(parsePolymarket)
      .filter((m) => m.open)
      .slice(0, limit);
  }

  /** The busiest open markets right now. */
  async top(limit = 30): Promise<PolymarketView[]> {
    const r = await this.http.json<RawPolymarket[]>(`${this.base}/markets?limit=${limit}&active=true&closed=false&order=volume24hr&ascending=false`, {
      ttlMs: 5 * 60_000,
      timeoutMs: 15_000,
    });
    return r.map(parsePolymarket).filter((m) => m.open);
  }
}
