import { describe, expect, it } from "vitest";
import { Http } from "../src/http.ts";
import { findTeam, sportsProvider, streakOf, teamFields } from "../src/signals/sports.ts";
import { mockFetch } from "./helpers.ts";

const stat = (name: string, displayValue: string, value?: number) => ({ name, displayValue, ...(value != null ? { value } : {}) });
const NBA = {
  children: [
    {
      standings: {
        entries: [
          { team: { displayName: "San Antonio Spurs", shortDisplayName: "Spurs", name: "Spurs", location: "San Antonio", abbreviation: "SA" }, stats: [stat("wins", "11", 11), stat("losses", "4", 4), stat("streak", "W3"), stat("playoffSeed", "2", 2)] },
          { team: { displayName: "Oklahoma City Thunder", shortDisplayName: "Thunder", name: "Thunder", location: "Oklahoma City", abbreviation: "OKC" }, stats: [stat("wins", "9", 9), stat("losses", "6", 6), stat("streak", "L2"), stat("playoffSeed", "4", 4)] },
        ],
      },
    },
  ],
};
const EPL = { children: [{ standings: { entries: [{ team: { displayName: "Arsenal", abbreviation: "ARS" }, stats: [stat("gamesPlayed", "8", 8), stat("wins", "6", 6), stat("losses", "1", 1), stat("ties", "1", 1), stat("points", "19", 19), stat("rank", "1", 1)] }] } }] };

describe("sports standings", () => {
  it("reads streaks", () => {
    expect(streakOf("W3")).toBe(3);
    expect(streakOf("L2")).toBe(-2);
    expect(streakOf("-")).toBe(0);
  });

  it("finds a team by name, city, nickname or abbreviation", () => {
    const entries = NBA.children[0]!.standings.entries;
    for (const q of ["Spurs", "san antonio", "SA", "San Antonio Spurs"]) expect(findTeam(entries as never, q)?.team.abbreviation).toBe("SA");
    expect(findTeam(entries as never, "Thunder")?.team.abbreviation).toBe("OKC");
    expect(findTeam(entries as never, "Lakers")).toBeNull();
  });

  it("turns a record into fields", () => {
    const f = teamFields(NBA.children[0]!.standings.entries[0] as never);
    expect(f).toMatchObject({ wins: 11, losses: 4, games_played: 15, streak: 3, rank: 2 });
    expect(f.win_pct).toBeCloseTo(11 / 15);
    const a = teamFields(EPL.children[0]!.standings.entries[0] as never);
    expect(a).toMatchObject({ wins: 6, losses: 1, ties: 1, games_played: 8, points: 19, rank: 1 });
  });

  it("asks US leagues for the regular season only, soccer for its table", async () => {
    const f = mockFetch((url) => (url.includes("basketball/nba/standings?seasontype=2") ? NBA : url.includes("soccer/eng.1/standings") ? EPL : undefined));
    const p = sportsProvider(new Http({ fetch: f, retries: 0, sleep: async () => {} }));
    const spurs = await p.fetch({ id: "spurs", kind: "sports", params: { league: "nba", team: "Spurs" } } as never, Date.now());
    expect(spurs?.fields).toMatchObject({ wins: 11, games_played: 15 });
    const ars = await p.fetch({ id: "ars", kind: "sports", params: { league: "epl", team: "Arsenal" } } as never, Date.now());
    expect(ars?.fields).toMatchObject({ points: 19 });
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?seasontype=2",
      "https://site.api.espn.com/apis/v2/sports/soccer/eng.1/standings",
    ]);
  });
});
