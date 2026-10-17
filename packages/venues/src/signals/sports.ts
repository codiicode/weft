import type { Http } from "../http.ts";
import type { SignalProvider } from "../types.ts";
import { defineProvider, type Fields } from "./common.ts";

/**
 * sports: a team's regular-season record from ESPN's public standings (no key). US leagues are
 * asked for the regular season only, so pre-season games never count; soccer leagues have one table.
 */
export const ESPN_URL = "https://site.api.espn.com/apis/v2/sports";

export const LEAGUES: Record<string, { path: string; regular: boolean }> = {
  nba: { path: "basketball/nba", regular: true },
  wnba: { path: "basketball/wnba", regular: true },
  nfl: { path: "football/nfl", regular: true },
  mlb: { path: "baseball/mlb", regular: true },
  nhl: { path: "hockey/nhl", regular: true },
  mls: { path: "soccer/usa.1", regular: false },
  epl: { path: "soccer/eng.1", regular: false },
  laliga: { path: "soccer/esp.1", regular: false },
  bundesliga: { path: "soccer/ger.1", regular: false },
  seriea: { path: "soccer/ita.1", regular: false },
  ligue1: { path: "soccer/fra.1", regular: false },
};

interface Stat { name: string; value?: number; displayValue?: string }
interface Entry { team: { displayName?: string; shortDisplayName?: string; name?: string; location?: string; abbreviation?: string; nickname?: string }; stats: Stat[] }
interface Node { standings?: { entries?: Entry[] }; children?: Node[] }

const entriesOf = (n: Node): Entry[] => [...(n.standings?.entries ?? []), ...(n.children ?? []).flatMap(entriesOf)];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The entry whose name, nickname, city or abbreviation matches `team` (exact beats partial). */
export function findTeam(entries: Entry[], team: string): Entry | null {
  const q = norm(team);
  const names = (e: Entry) => [e.team.displayName, e.team.shortDisplayName, e.team.name, e.team.nickname, e.team.location, e.team.abbreviation].filter(Boolean).map((x) => norm(x!));
  return entries.find((e) => names(e).includes(q)) ?? entries.find((e) => names(e).some((n) => n.includes(q) || (q.length > 3 && q.includes(n)))) ?? null;
}

/** "W3" → 3, "L2" → −2, "-" → 0. */
export function streakOf(s: string | undefined): number | null {
  const m = /^([WL])(\d+)$/i.exec((s ?? "").trim());
  if (!m) return s && s.trim() !== "-" ? null : 0;
  return (m[1]!.toUpperCase() === "W" ? 1 : -1) * Number(m[2]);
}

export function teamFields(e: Entry): Fields {
  const stat = (...names: string[]) => {
    for (const n of names) {
      const s = e.stats.find((x) => x.name === n);
      if (s && typeof s.value === "number" && Number.isFinite(s.value)) return s.value;
      if (s?.displayValue != null && s.displayValue !== "" && Number.isFinite(Number(s.displayValue))) return Number(s.displayValue);
    }
    return null;
  };
  const wins = stat("wins") ?? 0, losses = stat("losses") ?? 0, ties = stat("ties", "otLosses", "overtimeLosses") ?? 0;
  const played = stat("gamesPlayed") ?? wins + losses + ties;
  const streakStat = e.stats.find((x) => x.name === "streak");
  return {
    wins,
    losses,
    ties,
    games_played: played,
    win_pct: played > 0 ? wins / played : null,
    streak: streakStat ? (streakOf(streakStat.displayValue) ?? (typeof streakStat.value === "number" ? streakStat.value : null)) : null,
    points: stat("points"),
    rank: stat("rank", "playoffSeed"),
  };
}

export function sportsProvider(http: Http, base = ESPN_URL, onError?: (k: string, e: unknown) => void): SignalProvider {
  return defineProvider(
    ["sports"],
    "live",
    async (s) => {
      const league = LEAGUES[s.params.league];
      if (!league) return null;
      const url = `${base}/${league.path}/standings${league.regular ? "?seasontype=2" : ""}`;
      const data = await http.json<Node>(url, { ttlMs: 10 * 60_000, timeoutMs: 15_000 });
      const e = findTeam(entriesOf(data), s.params.team);
      return e ? teamFields(e) : null;
    },
    onError
  );
}
