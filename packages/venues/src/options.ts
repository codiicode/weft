import type { OptionInstrument } from "@weft/strategy";
import type { Http } from "./http.ts";
import type { Book } from "./book.ts";
import { normalizeBook } from "./book.ts";
import { num } from "./util.ts";

/**
 * Options market data:
 *  - Deribit public API (no auth): BTC/ETH inverse options (premium quoted in the coin → × index for USD)
 *    and USDC-margined linear options for SOL, XRP, … (premium already in USDC).
 *  - Derive (formerly Lyra) public API (no auth): USDC-quoted options, one ticker per call.
 */

export const DERIBIT_URL = "https://www.deribit.com/api/v2/public";
export const DERIVE_URL = "https://api.lyra.finance/public";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export interface ParsedOptionName {
  underlying: string;
  expiry: string; // YYYY-MM-DD
  strike: number;
  right: "call" | "put";
  /** USDC-margined (linear) vs coin-margined (inverse). */
  linear: boolean;
}

/** "ETH-16OCT26-2800-P", "SOL_USDC-27NOV26-154-P", "XRP_USDC-13OCT26-2d5-C" */
export function parseDeribitName(name: string): ParsedOptionName | null {
  const m = /^([A-Z0-9]+?)(_USDC)?-(\d{1,2})([A-Z]{3})(\d{2})-([\dd.]+)-([CP])$/.exec(name);
  if (!m) return null;
  const month = MONTHS.indexOf(m[4]!);
  if (month < 0) return null;
  const day = Number(m[3]);
  const year = 2000 + Number(m[5]);
  const strike = Number(m[6]!.replace("d", "."));
  if (!Number.isFinite(strike)) return null;
  return {
    underlying: m[1]!,
    expiry: `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    strike,
    right: m[7] === "C" ? "call" : "put",
    linear: !!m[2],
  };
}

/** Which Deribit `currency` lists options on this underlying. */
export function deribitCurrency(underlying: string): "BTC" | "ETH" | "USDC" {
  const u = underlying.toUpperCase();
  return u === "BTC" || u === "ETH" ? u : "USDC";
}

export interface RawDeribitSummary {
  instrument_name: string;
  bid_price: number | null;
  ask_price: number | null;
  mid_price: number | null;
  mark_price: number | null;
  mark_iv?: number | null;
  open_interest?: number | null;
  volume?: number | null;
  volume_usd?: number | null;
  underlying_price?: number | null;
  estimated_delivery_price?: number | null;
  base_currency?: string;
  quote_currency?: string;
  creation_timestamp?: number;
}

export interface RawDeribitTicker {
  instrument_name: string;
  timestamp: number;
  best_bid_price: number | null;
  best_ask_price: number | null;
  best_bid_amount?: number;
  best_ask_amount?: number;
  mark_price: number;
  mark_iv?: number;
  index_price: number;
  underlying_price?: number;
  open_interest?: number;
  stats?: { volume?: number | null; volume_usd?: number | null };
  greeks?: Record<string, number>;
}

export interface RawDeribitBook extends RawDeribitTicker {
  bids: [number, number][];
  asks: [number, number][];
}

export interface OptionRow {
  name: string;
  parsed: ParsedOptionName;
  /** USD premium per 1 unit of underlying. */
  markUsd: number | null;
  bidUsd: number | null;
  askUsd: number | null;
  ivPct: number | null;
  openInterest: number | null;
  openInterestUsd: number | null;
  volume24hUsd: number | null;
  underlyingPrice: number | null;
}

/** USD conversion: inverse options are quoted in the coin, linear ones in USDC. */
export function summaryToRow(s: RawDeribitSummary): OptionRow | null {
  const parsed = parseDeribitName(s.instrument_name);
  if (!parsed) return null;
  const under = s.underlying_price ?? s.estimated_delivery_price ?? null;
  const mult = parsed.linear ? 1 : under;
  const usd = (x: number | null | undefined) => (x != null && x > 0 && mult != null ? x * mult : null);
  return {
    name: s.instrument_name,
    parsed,
    markUsd: usd(s.mark_price),
    bidUsd: usd(s.bid_price),
    askUsd: usd(s.ask_price),
    ivPct: s.mark_iv ?? null,
    openInterest: s.open_interest ?? null,
    openInterestUsd: s.open_interest != null && under != null ? s.open_interest * under : null,
    volume24hUsd: s.volume_usd ?? (s.volume != null && under != null ? s.volume * under : null),
    underlyingPrice: under,
  };
}

interface DeribitEnvelope<T> {
  result: T;
}

export class DeribitClient {
  private readonly http: Http;
  private readonly url: string;

  constructor(http: Http, url: string = DERIBIT_URL) {
    this.http = http;
    this.url = url;
  }

  private async get<T>(path: string, ttlMs: number): Promise<T> {
    const r = await this.http.json<DeribitEnvelope<T>>(`${this.url}${path}`, { ttlMs });
    return r.result;
  }

  summaries(currency: "BTC" | "ETH" | "USDC"): Promise<RawDeribitSummary[]> {
    return this.get(`/get_book_summary_by_currency?currency=${currency}&kind=option`, 15_000);
  }

  instrumentNames(currency: "BTC" | "ETH" | "USDC"): Promise<{ instrument_name: string }[]> {
    return this.get(`/get_instruments?currency=${currency}&kind=option&expired=false`, 10 * 60_000);
  }

  ticker(name: string): Promise<RawDeribitTicker> {
    return this.get(`/ticker?instrument_name=${encodeURIComponent(name)}`, 3_000);
  }

  orderBook(name: string, depth = 20): Promise<RawDeribitBook> {
    return this.get(`/get_order_book?instrument_name=${encodeURIComponent(name)}&depth=${depth}`, 2_000);
  }

  /** Find the listed instrument for an OptionInstrument (exact underlying/expiry/strike/right). */
  async resolve(i: Pick<OptionInstrument, "underlying" | "expiry" | "strike" | "right">): Promise<string | null> {
    const list = await this.instrumentNames(deribitCurrency(i.underlying));
    const u = i.underlying.toUpperCase();
    for (const { instrument_name } of list) {
      const p = parseDeribitName(instrument_name);
      if (p && p.underlying === u && p.expiry === i.expiry && Math.abs(p.strike - i.strike) < 1e-9 && p.right === i.right) return instrument_name;
    }
    return null;
  }
}

/** Order book converted to USD premium levels, size in underlying units. */
export function deribitBookUsd(b: RawDeribitBook, linear: boolean): Book {
  const mult = linear ? 1 : b.index_price;
  return normalizeBook({
    bids: (b.bids ?? []).map(([px, sz]) => ({ px: px * mult, sz })),
    asks: (b.asks ?? []).map(([px, sz]) => ({ px: px * mult, sz })),
    ts: b.timestamp,
  });
}

/* ---------------- Derive ---------------- */

export function deriveName(i: Pick<OptionInstrument, "underlying" | "expiry" | "strike" | "right">): string {
  return `${i.underlying.toUpperCase()}-${i.expiry.replaceAll("-", "")}-${i.strike}-${i.right === "call" ? "C" : "P"}`;
}

export interface RawDeriveTicker {
  instrument_name: string;
  best_bid_price?: string;
  best_ask_price?: string;
  best_bid_amount?: string;
  best_ask_amount?: string;
  mark_price?: string;
  index_price?: string;
  timestamp?: number;
  option_pricing?: { iv?: string; mark_price?: string };
}

export interface DeriveQuote {
  mark: number | null;
  bid: number | null;
  ask: number | null;
  bidAmount: number | null;
  askAmount: number | null;
  ts: number | null;
}

export function parseDeriveTicker(t: RawDeriveTicker): DeriveQuote {
  const pos = (x: string | undefined) => {
    const n = num(x);
    return n != null && n > 0 ? n : null;
  };
  return {
    mark: pos(t.mark_price) ?? pos(t.option_pricing?.mark_price),
    bid: pos(t.best_bid_price),
    ask: pos(t.best_ask_price),
    bidAmount: num(t.best_bid_amount),
    askAmount: num(t.best_ask_amount),
    ts: t.timestamp ?? null,
  };
}

export class DeriveClient {
  private readonly http: Http;
  private readonly url: string;

  constructor(http: Http, url: string = DERIVE_URL) {
    this.http = http;
    this.url = url;
  }

  /** Active option instrument names for a currency (e.g. "ETH-20261030-2600-C"). */
  async instruments(currency: string): Promise<string[]> {
    const r = await this.http.json<{ result?: { instrument_name: string; is_active?: boolean }[] }>(`${this.url}/get_instruments`, {
      method: "POST",
      body: { currency: currency.toUpperCase(), instrument_type: "option", expired: false },
      ttlMs: 10 * 60_000,
    });
    return (r.result ?? []).filter((x) => x.is_active !== false).map((x) => x.instrument_name);
  }

  async ticker(name: string): Promise<RawDeriveTicker> {
    const r = await this.http.json<{ result?: RawDeriveTicker; error?: { message?: string; data?: string } }>(`${this.url}/get_ticker`, {
      method: "POST",
      body: { instrument_name: name },
      ttlMs: 3_000,
    });
    if (!r.result) throw new Error(`derive: ${r.error?.message ?? "no result"} ${r.error?.data ?? ""}`.trim());
    return r.result;
  }
}
