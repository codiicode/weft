import type { Http } from "../http.ts";
import type { SignalProvider } from "../types.ts";
import { num } from "../util.ts";
import { defineProvider, type Fields } from "./common.ts";

/**
 * Live external series (all free, no key):
 *  - forecast: NOAA CPC weekly OISST Niño indices (wksst9120.for, 1991–2020 base, updated Mondays)
 *  - macro: FX from Frankfurter (ECB reference rates, business days), rates/commodities/economy
 *           from FRED's public CSV endpoint (fredgraph.csv, no key needed), and crypto market-wide
 *           series: the Crypto Fear & Greed Index (alternative.me), dominance and total market cap
 *           (CoinGecko), stablecoin supply, chain TVL and protocol fees/revenue (DefiLlama)
 */

export const NOAA_WEEKLY_URL = "https://www.cpc.ncep.noaa.gov/data/indices/wksst9120.for";
export const FRANKFURTER_URL = "https://api.frankfurter.dev/v1";
export const FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv";
export const FEAR_GREED_URL = "https://api.alternative.me/fng/";
export const COINGECKO_GLOBAL_URL = "https://api.coingecko.com/api/v3/global";
export const LLAMA_URL = "https://api.llama.fi";
export const LLAMA_STABLES_URL = "https://stablecoins.llama.fi";
export const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
export const OPEN_METEO_GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";

/**
 * Weather from Open-Meteo for a place: "temp:<place>" is the average temperature (°C) over the next
 * 7 days, "precip:<place>" the rain and snow (mm) expected over them. change_7d compares with the
 * past 7 days. <place> is a city name or "lat,lon".
 */
export function weatherFields(daily: { temperature_2m_mean?: (number | null)[]; precipitation_sum?: (number | null)[] }, metric: "temp" | "precip", pastDays: number): Fields | null {
  const series = (metric === "temp" ? daily.temperature_2m_mean : daily.precipitation_sum) ?? [];
  const past = series.slice(0, pastDays).filter((v): v is number => v != null);
  const next = series.slice(pastDays).filter((v): v is number => v != null);
  if (!next.length) return null;
  const agg = (xs: number[]) => (metric === "temp" ? xs.reduce((a, b) => a + b, 0) / xs.length : xs.reduce((a, b) => a + b, 0));
  const r = (x: number) => Math.round(x * 10) / 10;
  const value = r(agg(next));
  return { value, change_7d: past.length ? r(value - agg(past)) : null };
}

/* ------------------------------------------------------------------ */
/* NOAA CPC weekly Niño                                                  */
/* ------------------------------------------------------------------ */

export interface NinoWeek {
  /** ms, week centre (Wednesday) */
  week: number;
  nino12: { sst: number; anom: number };
  nino3: { sst: number; anom: number };
  nino34: { sst: number; anom: number };
  nino4: { sst: number; anom: number };
}

const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/** Fixed-width rows like " 07OCT2026     26.1 5.2     29.0 4.1     30.0 3.3     29.9 1.3" (anomalies may abut: "20.6-0.1"). */
export function parseNoaaWeekly(text: string): NinoWeek[] {
  const out: NinoWeek[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d{2})([A-Z]{3})(\d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const month = MONTHS[m[2]!];
    if (month == null) continue;
    const nums = (m[4]!.match(/-?\d+\.\d+/g) ?? []).map(Number);
    if (nums.length < 8) continue;
    const [a, b, c, d, e, f, g, h] = nums as [number, number, number, number, number, number, number, number];
    out.push({
      week: Date.UTC(Number(m[3]), month, Number(m[1])),
      nino12: { sst: a, anom: b },
      nino3: { sst: c, anom: d },
      nino34: { sst: e, anom: f },
      nino4: { sst: g, anom: h },
    });
  }
  return out.sort((x, y) => x.week - y.week);
}

const NOAA_SERIES: Record<string, (w: NinoWeek) => number> = {
  nino34_anomaly: (w) => w.nino34.anom,
  nino34_sst: (w) => w.nino34.sst,
  nino3_anomaly: (w) => w.nino3.anom,
  nino3_sst: (w) => w.nino3.sst,
  nino4_anomaly: (w) => w.nino4.anom,
  nino4_sst: (w) => w.nino4.sst,
  nino12_anomaly: (w) => w.nino12.anom,
  nino12_sst: (w) => w.nino12.sst,
};

export function noaaFields(weeks: NinoWeek[], series: string): Fields | null {
  const pick = NOAA_SERIES[series];
  const last = weeks[weeks.length - 1];
  if (!pick || !last) return null;
  const prev = weeks[weeks.length - 2];
  return { value: pick(last), change_7d: prev ? Math.round((pick(last) - pick(prev)) * 100) / 100 : null };
}

/* ------------------------------------------------------------------ */
/* Macro: FX (Frankfurter) + FRED                                        */
/* ------------------------------------------------------------------ */

/** Common names → FRED series ids. Any "FRED:<ID>" also works. */
export const FRED_ALIASES: Record<string, string> = {
  US3M: "DTB3",
  US1Y: "DGS1",
  US2Y: "DGS2",
  US5Y: "DGS5",
  US10Y: "DGS10",
  US30Y: "DGS30",
  FEDFUNDS: "DFF",
  EFFR: "DFF",
  SOFR: "SOFR",
  T10Y2Y: "T10Y2Y",
  VIX: "VIXCLS",
  WTI: "DCOILWTICO",
  BRENT: "DCOILBRENTEU",
  USD_BROAD: "DTWEXBGS",
  DXY: "DTWEXBGS", // FRED's broad trade-weighted dollar index, not ICE DXY
  BREAKEVEN10Y: "T10YIE",
  HY_SPREAD: "BAMLH0A0HYM2",
  REAL10Y: "DFII10",
  US10Y_REAL: "DFII10",
  SP500: "SP500",
  NASDAQ: "NASDAQCOM",
  CPI: "CPIAUCSL",
  CORE_CPI: "CPILFESL",
  UNEMPLOYMENT: "UNRATE",
  PAYROLLS: "PAYEMS",
  JOBLESS_CLAIMS: "ICSA",
  M2: "M2SL",
  MORTGAGE30: "MORTGAGE30US",
  FED_BALANCE_SHEET: "WALCL",
};

/**
 * Crypto market-wide series. Units are chosen so the numbers read well in a rule:
 * Fear & Greed 0–100; dominance in %; market cap, stablecoin supply and TVL in billions of USD;
 * daily fees and revenue in millions of USD.
 */
export const CRYPTO_SERIES = ["FEAR_GREED", "BTC_DOMINANCE", "ETH_DOMINANCE", "CRYPTO_MCAP", "STABLECOIN_MCAP", "TVL", "TVL:<chain>", "FEES:<protocol>", "REVENUE:<protocol>"] as const;

/** alternative.me's /fng/ payload → values oldest first. */
export function parseFearGreed(r: { data?: { value: string; timestamp: string }[] }): number[] {
  return (r.data ?? [])
    .map((d) => ({ t: Number(d.timestamp), v: Number(d.value) }))
    .filter((d) => Number.isFinite(d.t) && Number.isFinite(d.v))
    .sort((a, b) => a.t - b.t)
    .map((d) => d.v);
}

/** CoinGecko /global → dominance (%) or total market cap ($B, with its 24h change). */
export function coingeckoGlobalFields(
  r: { data?: { market_cap_percentage?: Record<string, number>; total_market_cap?: Record<string, number>; market_cap_change_percentage_24h_usd?: number } },
  series: "BTC_DOMINANCE" | "ETH_DOMINANCE" | "CRYPTO_MCAP"
): Fields | null {
  const d = r.data;
  if (!d) return null;
  const round = (x: number) => Math.round(x * 100) / 100;
  if (series === "CRYPTO_MCAP") {
    const usd = d.total_market_cap?.usd;
    if (usd == null) return null;
    const pct = d.market_cap_change_percentage_24h_usd;
    const value = usd / 1e9;
    return { value: round(value), change_1d: pct != null ? round(value - value / (1 + pct / 100)) : null, change_5d: null };
  }
  const v = d.market_cap_percentage?.[series === "BTC_DOMINANCE" ? "btc" : "eth"];
  return v == null ? null : { value: round(v), change_1d: null, change_5d: null };
}

/** DefiLlama daily points (any shape) → the last 60 values, scaled. */
export function llamaDaily(points: unknown[], pick: (p: unknown) => number | null | undefined, scale: number): number[] {
  return points
    .map(pick)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .slice(-60)
    .map((v) => Math.round((v / scale) * 1e4) / 1e4);
}

export function parseFredCsv(csv: string): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    const [date, v] = line.split(",");
    const value = num(v);
    if (date && value != null) out.push({ date, value });
  }
  return out;
}

export function seriesChanges(values: number[]): Fields | null {
  const last = values[values.length - 1];
  if (last == null) return null;
  const at = (k: number) => values[values.length - 1 - k];
  const d1 = at(1);
  const d5 = at(5);
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  return { value: last, change_1d: d1 != null ? r(last - d1) : null, change_5d: d5 != null ? r(last - d5) : null };
}

/** "USDBRL" / "USD/BRL" / "EURUSD" → ["USD","BRL"] */
export function fxPair(series: string): [string, string] | null {
  const s = series.toUpperCase().replace(/[^A-Z]/g, "");
  return /^[A-Z]{6}$/.test(s) ? [s.slice(0, 3), s.slice(3)] : null;
}

export interface ExternalUrls {
  openMeteo?: string;
  openMeteoGeo?: string;
  noaa?: string;
  frankfurter?: string;
  fred?: string;
  fearGreed?: string;
  coingecko?: string;
  llama?: string;
  llamaStables?: string;
}

export function externalProviders(http: Http, urls: ExternalUrls = {}, onError?: (k: string, e: unknown) => void): SignalProvider[] {
  const noaa = urls.noaa ?? NOAA_WEEKLY_URL;
  const fx = urls.frankfurter ?? FRANKFURTER_URL;
  const fred = urls.fred ?? FRED_CSV_URL;
  const fng = urls.fearGreed ?? FEAR_GREED_URL;
  const cg = urls.coingecko ?? COINGECKO_GLOBAL_URL;
  const llama = urls.llama ?? LLAMA_URL;
  const stables = urls.llamaStables ?? LLAMA_STABLES_URL;
  const HOUR = 3_600_000;
  const meteo = urls.openMeteo ?? OPEN_METEO_URL;
  const geo = urls.openMeteoGeo ?? OPEN_METEO_GEO_URL;

  /** Crypto market-wide series (see CRYPTO_SERIES); null when the name isn't one of them. */
  const crypto = async (up: string, raw: string): Promise<Fields | null | undefined> => {
    if (up === "FEAR_GREED" || up === "FEAR_AND_GREED" || up === "FNG") {
      const r = await http.json<{ data?: { value: string; timestamp: string }[] }>(`${fng}?limit=10`, { ttlMs: HOUR, timeoutMs: 15_000 });
      return seriesChanges(parseFearGreed(r));
    }
    if (up === "BTC_DOMINANCE" || up === "ETH_DOMINANCE" || up === "CRYPTO_MCAP") {
      return coingeckoGlobalFields(await http.json(cg, { ttlMs: 10 * 60_000, timeoutMs: 15_000 }), up);
    }
    if (up === "STABLECOIN_MCAP") {
      const r = await http.json<unknown[]>(`${stables}/stablecoincharts/all`, { ttlMs: 6 * HOUR, timeoutMs: 30_000 });
      return seriesChanges(llamaDaily(r, (p) => (p as { totalCirculatingUSD?: { peggedUSD?: number } }).totalCirculatingUSD?.peggedUSD, 1e9));
    }
    if (up === "TVL" || up.startsWith("TVL:")) {
      const chain = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1).trim() : "";
      const r = await http.json<unknown[]>(`${llama}/v2/historicalChainTvl${chain ? `/${encodeURIComponent(chain)}` : ""}`, { ttlMs: HOUR, timeoutMs: 20_000 });
      return seriesChanges(llamaDaily(r, (p) => (p as { tvl?: number }).tvl, 1e9));
    }
    if (up.startsWith("FEES:") || up.startsWith("REVENUE:")) {
      const slug = raw.slice(raw.indexOf(":") + 1).trim().toLowerCase().replace(/\s+/g, "-");
      const type = up.startsWith("FEES:") ? "dailyFees" : "dailyRevenue";
      const r = await http.json<{ totalDataChart?: [number, number][] }>(
        `${llama}/summary/fees/${encodeURIComponent(slug)}?dataType=${type}&excludeTotalDataChartBreakdown=true`,
        { ttlMs: HOUR, timeoutMs: 20_000 }
      );
      return seriesChanges(llamaDaily(r.totalDataChart ?? [], (p) => (p as [number, number])[1], 1e6));
    }
    return undefined;
  };

  const forecast = defineProvider(
    ["forecast"],
    "live",
    async (s) => {
      const src = s.params.source.toLowerCase();
      if (src === "weather" || src === "open-meteo" || src === "openmeteo") {
        const m = /^(temp|temperature|precip|precipitation|rain)\s*:\s*(.+)$/i.exec(s.params.series.trim());
        if (!m) return null;
        const metric = /^temp/i.test(m[1]!) ? "temp" : "precip";
        const place = m[2]!.trim();
        let lat: number;
        let lon: number;
        const ll = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(place);
        if (ll) [lat, lon] = [Number(ll[1]), Number(ll[2])];
        else {
          const g = await http.json<{ results?: { latitude: number; longitude: number }[] }>(`${geo}?name=${encodeURIComponent(place)}&count=1`, { ttlMs: 7 * 24 * HOUR, timeoutMs: 15_000 });
          if (!g.results?.[0]) return null;
          [lat, lon] = [g.results[0].latitude, g.results[0].longitude];
        }
        const w = await http.json<{ daily?: { temperature_2m_mean?: (number | null)[]; precipitation_sum?: (number | null)[] } }>(
          `${meteo}?latitude=${lat}&longitude=${lon}&daily=temperature_2m_mean,precipitation_sum&past_days=7&forecast_days=7&timezone=UTC`,
          { ttlMs: 2 * HOUR, timeoutMs: 15_000 }
        );
        return w.daily ? weatherFields(w.daily, metric, 7) : null;
      }
      if (src !== "noaa_cpc" && src !== "noaa") return null; // other sources: not wired yet
      const text = await http.text(noaa, { ttlMs: 6 * 3_600_000, timeoutMs: 20_000 });
      return noaaFields(parseNoaaWeekly(text), s.params.series.toLowerCase());
    },
    onError
  );

  const macro = defineProvider(
    ["macro"],
    "live",
    async (s, now) => {
      const series = s.params.series.trim();
      const up = series.toUpperCase();
      const c = await crypto(up, series);
      if (c !== undefined) return c;
      const fredId = up.startsWith("FRED:") ? series.slice(5) : FRED_ALIASES[up];
      if (fredId) {
        // Long enough that monthly and weekly series (CPI, jobless claims) have earlier observations.
        const start = new Date(now - 400 * 86_400_000).toISOString().slice(0, 10);
        const csv = await http.text(`${fred}?id=${encodeURIComponent(fredId)}&cosd=${start}`, { ttlMs: 3_600_000, timeoutMs: 20_000 });
        return seriesChanges(parseFredCsv(csv).map((r) => r.value));
      }
      const pair = fxPair(series);
      if (pair) {
        const [base, quote] = pair;
        const start = new Date(now - 14 * 86_400_000).toISOString().slice(0, 10);
        const r = await http.json<{ rates?: Record<string, Record<string, number>> }>(`${fx}/${start}..?from=${base}&to=${quote}`, { ttlMs: 3_600_000 });
        const values = Object.keys(r.rates ?? {})
          .sort()
          .map((d) => r.rates![d]![quote])
          .filter((v): v is number => typeof v === "number");
        return seriesChanges(values);
      }
      return null;
    },
    onError
  );

  return [forecast, macro];
}
