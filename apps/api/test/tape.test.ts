import { describe, expect, it } from "vitest";
import { TradeTape } from "../src/lib/tape.ts";

describe("trade tape", () => {
  const T0 = 1_800_000_000_000; // a multiple of 5 s

  it("builds 5 s bars from trades and rolls them up to 15 s", () => {
    let now = T0;
    const tape = new TradeTape({ offline: true, now: () => now });
    tape.start(["BTC"]);
    tape.ingest("BTC", 100, 1, T0 + 100);
    tape.ingest("BTC", 103, 2, T0 + 900);
    tape.ingest("BTC", 99, 1, T0 + 4_000);
    tape.ingest("BTC", 101, 1, T0 + 6_000); // next 5 s bar
    tape.ingest("BTC", 98, 1, T0 + 16_000); // next 15 s bar
    tape.ingest("BTC", 500, 1, T0 + 1_000); // late: ignored
    now = T0 + 20_000;

    const five = tape.bars("BTC", 5_000, now, 100);
    expect(five).toHaveLength(3);
    expect(five[0]).toMatchObject({ t: T0, o: 100, h: 103, l: 99, c: 99 });
    expect(five[0]!.volUsd).toBe(100 + 206 + 99);

    const fifteen = tape.bars("BTC", 15_000, now, 100);
    expect(fifteen.map((b) => b.t)).toEqual([T0, T0 + 15_000]);
    expect(fifteen[0]).toMatchObject({ o: 100, h: 103, l: 99, c: 101 });
  });

  it("pages back with an end time and a count, and ignores markets it doesn't record", () => {
    const tape = new TradeTape({ offline: true, now: () => T0 + 60_000 });
    tape.start(["ETH"]);
    for (let i = 0; i < 10; i++) tape.ingest("ETH", 10 + i, 1, T0 + i * 5_000);
    const page = tape.bars("ETH", 5_000, T0 + 25_000, 3);
    expect(page.map((b) => b.c)).toEqual([12, 13, 14]);
    tape.ingest("SOL", 1, 1, T0);
    expect(tape.bars("SOL", 5_000, T0 + 60_000, 10)).toEqual([]);
    expect(tape.since("ETH")).toBe(T0 + 60_000);
  });

  it("forgets bars older than the window", () => {
    let now = T0;
    const tape = new TradeTape({ offline: true, keepMs: 60_000, now: () => now });
    tape.start(["BTC"]);
    tape.ingest("BTC", 1, 1, T0);
    now = T0 + 120_000;
    tape.ingest("BTC", 2, 1, now);
    expect(tape.bars("BTC", 5_000, now + 5_000, 100).map((b) => b.c)).toEqual([2]);
  });
});
