import { describe, expect, it } from "vitest";
import { fxPair, noaaFields, parseFredCsv, parseNoaaWeekly, seriesChanges } from "../src/signals/external.ts";
import { calendarFields, hoursAround, normalizeTicker } from "../src/signals/calendar.ts";
import { fixtureText } from "./helpers.ts";

describe("NOAA CPC weekly Niño", () => {
  const weeks = parseNoaaWeekly(fixtureText("noaa_wksst9120.for"));

  it("parses fixed-width rows (incl. abutting negative anomalies)", () => {
    expect(weeks).toHaveLength(5);
    expect(weeks[4]!.week).toBe(Date.UTC(2026, 9, 7));
    expect(weeks[4]!.nino34).toEqual({ sst: 30.0, anom: 3.3 });
    const neg = parseNoaaWeekly(" 02SEP1981     20.6-0.1     24.8-0.1     26.5-0.2     28.3-0.3");
    expect(neg[0]!.nino34.anom).toBe(-0.2);
    expect(neg[0]!.nino12).toEqual({ sst: 20.6, anom: -0.1 });
  });

  it("produces value and change_7d", () => {
    expect(noaaFields(weeks, "nino34_anomaly")).toEqual({ value: 3.3, change_7d: 0.1 });
    expect(noaaFields(weeks, "nino4_anomaly")).toEqual({ value: 1.3, change_7d: 0.1 });
    expect(noaaFields(weeks, "unknown_series")).toBeNull();
  });
});

describe("macro", () => {
  it("parses FRED CSV and computes 1d / 5d changes over observations", () => {
    const rows = parseFredCsv(fixtureText("fred_dgs2.csv"));
    expect(rows.at(-1)).toEqual({ date: "2026-10-08", value: 4.75 });
    expect(seriesChanges(rows.map((r) => r.value))).toEqual({ value: 4.75, change_1d: -0.02, change_5d: -0.03 });
    expect(parseFredCsv("observation_date,X\n2026-01-01,.\n2026-01-02,1.5")).toEqual([{ date: "2026-01-02", value: 1.5 }]);
  });

  it("recognises FX pairs", () => {
    expect(fxPair("USDBRL")).toEqual(["USD", "BRL"]);
    expect(fxPair("eur/usd")).toEqual(["EUR", "USD"]);
    expect(fxPair("US2Y")).toBeNull();
  });
});

describe("calendar", () => {
  const now = Date.parse("2026-10-12T13:00:00Z");

  it("custom events are exact", () => {
    expect(calendarFields({ event: "custom", at: "2026-10-13T13:00:00Z" }, now)).toEqual({ hours_until: 24, hours_since: null });
    expect(calendarFields({ event: "custom", at: "2026-10-12T10:00:00Z" }, now)).toEqual({ hours_until: null, hours_since: 3 });
    expect(calendarFields({ event: "custom" }, now)).toBeNull();
  });

  it("FOMC / earnings use the static tables", () => {
    const fomc = calendarFields({ event: "fomc" }, now)!;
    expect(fomc.hours_until).toBe((Date.parse("2026-10-28T18:00:00Z") - now) / 3_600_000);
    expect(fomc.hours_since).toBe((now - Date.parse("2026-09-16T18:00:00Z")) / 3_600_000);
    expect(calendarFields({ event: "earnings", symbol: "xyz:NVDA" }, now)!.hours_until).toBeGreaterThan(0);
    expect(calendarFields({ event: "earnings", symbol: "UNKNOWNCO" }, now)).toBeNull();
    expect(normalizeTicker("NVDAx")).toBe("NVDA");
    expect(normalizeTicker("$tsla")).toBe("TSLA");
    expect(hoursAround([], now)).toEqual({ hours_until: null, hours_since: null });
  });
});
