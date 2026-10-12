import type { SignalProvider } from "../types.ts";
import { defineProvider, type Fields } from "./common.ts";

/**
 * calendar signal: hours until the next / since the last scheduled event.
 *
 * - custom: computed exactly from `at`.
 * - fomc / cpi / earnings: from the STATIC tables below (no free, keyless,
 *   reliable API). FOMC 2026 dates are the Fed's published schedule; 2027 FOMC,
 *   CPI release dates and all earnings dates are best-effort estimates from the
 *   usual cadence and MUST be refreshed (or replaced by a feed: e.g. a paid
 *   earnings calendar) before relying on them. Times are UTC.
 */

/** FOMC statement times (14:00 ET on the last meeting day). */
export const FOMC_DATES: readonly string[] = [
  "2026-01-28T19:00:00Z", "2026-03-18T18:00:00Z", "2026-04-29T18:00:00Z", "2026-06-17T18:00:00Z",
  "2026-07-29T18:00:00Z", "2026-09-16T18:00:00Z", "2026-10-28T18:00:00Z", "2026-12-09T19:00:00Z",
  // 2027: tentative
  "2027-01-27T19:00:00Z", "2027-03-17T18:00:00Z", "2027-04-28T18:00:00Z", "2027-06-09T18:00:00Z",
  "2027-07-28T18:00:00Z", "2027-09-22T18:00:00Z", "2027-10-27T18:00:00Z", "2027-12-08T19:00:00Z",
];

/** US CPI releases (08:30 ET). Estimated; verify against the BLS schedule. */
export const CPI_DATES: readonly string[] = [
  "2026-01-13T13:30:00Z", "2026-02-11T13:30:00Z", "2026-03-11T12:30:00Z", "2026-04-10T12:30:00Z",
  "2026-05-12T12:30:00Z", "2026-06-10T12:30:00Z", "2026-07-14T12:30:00Z", "2026-08-12T12:30:00Z",
  "2026-09-11T12:30:00Z", "2026-10-14T12:30:00Z", "2026-11-10T13:30:00Z", "2026-12-10T13:30:00Z",
  "2027-01-13T13:30:00Z", "2027-02-10T13:30:00Z", "2027-03-10T13:30:00Z", "2027-04-13T12:30:00Z",
];

/** Earnings (after the US close unless noted). Estimated from each company's usual cadence. */
export const EARNINGS_DATES: Readonly<Record<string, readonly string[]>> = {
  NVDA: ["2026-02-25T21:20:00Z", "2026-05-27T20:20:00Z", "2026-08-26T20:20:00Z", "2026-11-18T21:20:00Z", "2027-02-24T21:20:00Z"],
  AAPL: ["2026-01-29T21:30:00Z", "2026-04-30T20:30:00Z", "2026-07-30T20:30:00Z", "2026-10-29T20:30:00Z", "2027-01-28T21:30:00Z"],
  MSFT: ["2026-01-28T21:30:00Z", "2026-04-29T20:30:00Z", "2026-07-29T20:30:00Z", "2026-10-28T20:30:00Z", "2027-01-27T21:30:00Z"],
  GOOGL: ["2026-02-04T21:30:00Z", "2026-04-28T20:30:00Z", "2026-07-28T20:30:00Z", "2026-10-27T20:30:00Z", "2027-02-02T21:30:00Z"],
  AMZN: ["2026-02-05T21:30:00Z", "2026-04-30T20:30:00Z", "2026-07-30T20:30:00Z", "2026-10-29T20:30:00Z", "2027-02-04T21:30:00Z"],
  META: ["2026-01-28T21:30:00Z", "2026-04-29T20:30:00Z", "2026-07-29T20:30:00Z", "2026-10-28T20:30:00Z", "2027-01-27T21:30:00Z"],
  TSLA: ["2026-01-28T21:30:00Z", "2026-04-22T20:30:00Z", "2026-07-22T20:30:00Z", "2026-10-21T20:30:00Z", "2027-01-27T21:30:00Z"],
  NFLX: ["2026-01-20T21:00:00Z", "2026-04-16T20:00:00Z", "2026-07-16T20:00:00Z", "2026-10-15T20:00:00Z", "2027-01-19T21:00:00Z"],
  AMD: ["2026-02-03T21:15:00Z", "2026-05-05T20:15:00Z", "2026-08-04T20:15:00Z", "2026-11-03T21:15:00Z", "2027-02-02T21:15:00Z"],
  COIN: ["2026-02-12T21:05:00Z", "2026-05-07T20:05:00Z", "2026-07-30T20:05:00Z", "2026-10-29T20:05:00Z", "2027-02-11T21:05:00Z"],
  PLTR: ["2026-02-02T21:05:00Z", "2026-05-04T20:05:00Z", "2026-08-03T20:05:00Z", "2026-11-02T21:05:00Z", "2027-02-01T21:05:00Z"],
  MSTR: ["2026-02-05T21:30:00Z", "2026-04-30T20:30:00Z", "2026-07-30T20:30:00Z", "2026-10-29T20:30:00Z", "2027-02-04T21:30:00Z"],
  HOOD: ["2026-02-10T21:05:00Z", "2026-04-29T20:05:00Z", "2026-07-29T20:05:00Z", "2026-10-28T20:05:00Z", "2027-02-09T21:05:00Z"],
  AVGO: ["2026-03-05T21:15:00Z", "2026-06-11T20:15:00Z", "2026-09-10T20:15:00Z", "2026-12-10T21:15:00Z", "2027-03-04T21:15:00Z"],
  TSM: ["2026-01-15T05:30:00Z", "2026-04-16T05:30:00Z", "2026-07-16T05:30:00Z", "2026-10-15T05:30:00Z", "2027-01-14T05:30:00Z"],
};

/** "xyz:NVDA" → "NVDA", "NVDAx" → "NVDA", "$nvda" → "NVDA". */
export function normalizeTicker(symbol: string): string {
  let s = symbol.trim().replace(/^\$/, "");
  const i = s.indexOf(":");
  if (i >= 0) s = s.slice(i + 1);
  const up = s.toUpperCase();
  if (!EARNINGS_DATES[up] && /x$/.test(s) && EARNINGS_DATES[up.slice(0, -1)]) return up.slice(0, -1);
  return up;
}

export function hoursAround(times: readonly number[], now: number): Fields {
  let next: number | null = null;
  let last: number | null = null;
  for (const t of times) {
    if (t > now && (next == null || t < next)) next = t;
    if (t <= now && (last == null || t > last)) last = t;
  }
  return {
    hours_until: next != null ? (next - now) / 3_600_000 : null,
    hours_since: last != null ? (now - last) / 3_600_000 : null,
  };
}

export function calendarFields(p: { event: "earnings" | "fomc" | "cpi" | "custom"; symbol?: string; at?: string }, now: number): Fields | null {
  const ms = (xs: readonly string[]) => xs.map((x) => Date.parse(x)).filter(Number.isFinite);
  switch (p.event) {
    case "custom": {
      const at = p.at ? Date.parse(p.at) : NaN;
      return Number.isFinite(at) ? hoursAround([at], now) : null;
    }
    case "fomc":
      return hoursAround(ms(FOMC_DATES), now);
    case "cpi":
      return hoursAround(ms(CPI_DATES), now);
    case "earnings": {
      if (!p.symbol) return null;
      const dates = EARNINGS_DATES[normalizeTicker(p.symbol)];
      return dates ? hoursAround(ms(dates), now) : null;
    }
  }
}

export function calendarProvider(): SignalProvider {
  return defineProvider(["calendar"], "live", async (s, now) => calendarFields(s.params, now));
}
