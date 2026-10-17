import { describe, expect, it } from "vitest";
import { timeContext } from "../src/ai/generate.ts";

describe("time context for the drafter", () => {
  it("gives the hours to the usual horizons", () => {
    const s = timeContext(new Date(Date.UTC(2026, 9, 17, 9, 0))); // Saturday 17 Oct 2026, 09:00 UTC
    expect(s).toContain("Now: 2026-10-17T09:00 UTC.");
    expect(s).toContain("the end of this week (Friday) 159"); // Fri 23 Oct 23:59
    expect(s).toContain("the end of this month 351"); // 31 Oct 23:59
    expect(s).toContain("the end of this quarter (2026-12-31) 1815");
    expect(s).toContain("the end of next quarter (2027-03-31) 3975");
    expect(s).toContain("the end of the year 1815");
  });
});
