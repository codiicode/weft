import type { Http } from "../http.ts";
import type { SignalProvider } from "../types.ts";
import { num } from "../util.ts";
import { defineProvider, type Fields } from "./common.ts";

/**
 * Live external series (all free, no key):
 *  - forecast: NOAA CPC weekly OISST Niño indices (wksst9120.for, 1991–2020 base, updated Mondays)
 *  - macro: FX from Frankfurter (ECB reference rates, business days) and rates/commodities from
 *           FRED's public CSV endpoint (fredgraph.csv, no key needed)
 */

export const NOAA_WEEKLY_URL = "https://www.cpc.ncep.noaa.gov/data/indices/wksst9120.for";
export const FRANKFURTER_URL = "https://api.frankfurter.dev/v1";
export const FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv";

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
};

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
  noaa?: string;
  frankfurter?: string;
  fred?: string;
}

export function externalProviders(http: Http, urls: ExternalUrls = {}, onError?: (k: string, e: unknown) => void): SignalProvider[] {
  const noaa = urls.noaa ?? NOAA_WEEKLY_URL;
  const fx = urls.frankfurter ?? FRANKFURTER_URL;
  const fred = urls.fred ?? FRED_CSV_URL;

  const forecast = defineProvider(
    ["forecast"],
    "live",
    async (s) => {
      const src = s.params.source.toLowerCase();
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
      const fredId = up.startsWith("FRED:") ? series.slice(5) : FRED_ALIASES[up];
      if (fredId) {
        const start = new Date(now - 30 * 86_400_000).toISOString().slice(0, 10);
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
