import { isoMinute, num, parseCompactUtc } from "../util.ts";
import type { RawOutcome, RawOutcomeMeta, RawQuestion, RawSpotCtx } from "./client.ts";

/**
 * HIP-4 outcome markets (live on mainnet since May 2026).
 *
 * Info API:
 *  - {type:"outcomeMeta"}            → outcomes[] + questions[] (multi-outcome groups)
 *  - {type:"allMids"}                → includes "#<encoding>" mids
 *  - {type:"spotMetaAndAssetCtxs"}   → ctxs include "#<encoding>" (prevDayPx, dayNtlVlm, markPx, midPx)
 *  - {type:"l2Book", coin:"#<enc>"}  → book for one side
 * Encoding: enc = 10 * outcomeId + side (side 0 = YES / first side, 1 = NO / second side).
 * Prices are probabilities (USDC per share, 0–1).
 *
 * Outcome descriptions are templated "key:value|key:value" strings; we turn
 * them into readable questions here.
 */

export function outcomeCoin(outcomeId: number, side: 0 | 1): string {
  return `#${10 * outcomeId + side}`;
}

export function parseKv(desc: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of desc.split("|")) {
    const i = part.indexOf(":");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export interface OutcomeSide {
  side: 0 | 1;
  name: string;
  coin: string;
  mid: number | null;
  prevDayPx: number | null;
  dayNtlVlm: number | null;
  change24hPp: number | null;
}

export interface OutcomeMarket {
  id: number;
  template: string;
  /** Readable question for this outcome, e.g. "BTC above 83,988 at 2026-10-13 06:00 UTC?" */
  question: string;
  /** Parent question (multi-outcome group), if any. */
  groupId: number | null;
  groupTitle: string | null;
  expiresAt: number | null;
  deployerVenue: string | null;
  sides: [OutcomeSide, OutcomeSide];
  /** Both sides' 24h notional volume. */
  volume24hUsd: number | null;
}

const strip = (s: string) => s.replace(/^template:/, "").trim();
const fmtNum = (s: string | undefined) => {
  const n = num(s);
  return n == null ? (s ?? "?") : n.toLocaleString("en-US", { maximumFractionDigits: 6 });
};
const fmtTime = (s: string | undefined) => {
  const t = parseCompactUtc(s);
  return t == null ? (s ?? "?") : isoMinute(t);
};
const asset = (perp: string | undefined) => {
  if (!perp) return "?";
  const i = perp.indexOf(":");
  return i > 0 ? perp.slice(i + 1) : perp;
};
const fill = (tpl: string, kv: Record<string, string>) => strip(tpl).replace(/\{(\w+)\}/g, (_, k: string) => kv[k] ?? k);

function questionTitle(q: RawQuestion): string {
  const kv = parseKv(q.description);
  switch (strip(q.name)) {
    case "sportsContestResult":
      return `${kv.participantA ?? "?"} vs ${kv.participantB ?? "?"}${kv.competition ? ` (${kv.competition})` : ""}`;
    case "sportsTournamentWinner":
      return `${(kv.competition ?? "Tournament").trim()} ${kv.season ?? ""} winner`.replace(/\s+/g, " ").trim();
    case "awardWinner":
      return `${kv.award ?? "Award"} ${kv.period ?? ""}`.trim();
    case "policyRateDecision":
      return `${kv.institution ?? "Central bank"} ${kv.decisionLabel ?? ""} decision`.replace(/\s+/g, " ").trim();
    default:
      if (kv.class === "priceBucket") return `${kv.underlying ?? "?"} price at ${fmtTime(kv.expiry)}`;
      return humanize(q.description) || strip(q.name);
  }
}

function humanize(desc: string): string {
  const kv = parseKv(desc);
  const keys = Object.keys(kv);
  if (!keys.length) return desc;
  return keys.map((k) => `${k}: ${kv[k]}`).join(", ");
}

function outcomeQuestion(o: RawOutcome, q: RawQuestion | undefined): string {
  const kv = parseKv(o.description);
  const qkv = q ? parseKv(q.description) : {};
  const group = q ? questionTitle(q) : null;
  const tpl = strip(o.name);
  switch (tpl) {
    case "binaryPrice":
      return `${asset(kv.perp)} above ${fmtNum(kv.threshold)} at ${fmtTime(kv.time)}?`;
    case "binaryPriceExternal":
      return `${kv.shortName ?? kv.instrument ?? "?"} above ${fmtNum(kv.threshold)} at ${fmtTime(kv.time)}?`;
    case "priceTouch":
      return `${asset(kv.perp)} touches ${fmtNum(kv.target)} by ${fmtTime(kv.time)}?`;
    case "Recurring":
      if (kv.class === "priceBinary") return `${kv.underlying ?? "?"} above ${fmtNum(kv.targetPrice)} at ${fmtTime(kv.expiry)}?`;
      return humanize(o.description);
    case "Recurring Named Outcome": {
      const idx = num(kv.index);
      const th = (qkv.priceThresholds ?? "").split(",").map((x) => fmtNum(x));
      let bucket = `bucket ${kv.index ?? "?"}`;
      if (idx != null && th.length) {
        if (idx === 0) bucket = `below ${th[0]}`;
        else if (idx >= th.length) bucket = `above ${th[th.length - 1]}`;
        else bucket = `${th[idx - 1]}–${th[idx]}`;
      }
      return `${group ?? qkv.underlying ?? "?"}: ${bucket}?`;
    }
    case "companyIpoConfirmed":
      return `${kv.company ?? "?"} IPO confirmed by ${fmtTime(kv.dateTime)}?`;
    case "companyIpoFirstDayMarketCap":
      return `${kv.company ?? "?"} first-day market cap ≥ $${fmtNum(kv.marketCapThresholdB)}B (listing by ${fmtTime(kv.listingDeadline)})?`;
    case "sportsContestParticipant2":
    case "sportsTournamentParticipant":
      return `${group ? `${group}: ` : ""}${kv.participant ?? "?"}${tpl === "sportsContestParticipant2" ? " wins" : ""}?`;
    case "sportsContestDraw2":
      return `${group ? `${group}: ` : ""}draw?`;
    case "awardCandidate":
      return `${group ? `${group}: ` : ""}${kv.candidate ?? "?"}?`;
    case "policyRateNoChange":
      return `${group ? `${group}: ` : ""}no change?`;
    case "policyRateDecrease":
      return `${group ? `${group}: ` : ""}cut?`;
    case "policyRateIncrease":
      return `${group ? `${group}: ` : ""}hike?`;
    case "sportsContestWinner":
      return `${kv.participantA ?? "?"} vs ${kv.participantB ?? "?"}${kv.competition ? ` (${kv.competition})` : ""}`;
    case "sportsSpread":
      return `${kv.shortNameA ?? kv.participantA ?? "?"} ${kv.spread ?? ""} vs ${kv.participantB ?? "?"}?`.replace(/\s+/g, " ");
    case "sportsTotal":
      return `${kv.participantA ?? "?"} vs ${kv.participantB ?? "?"}: total ${kv.measure ?? ""} over ${kv.line ?? "?"}?`.replace(/\s+/g, " ");
    case "template fallback":
    case "Recurring Fallback":
    case "awardOther":
      return `${group ? `${group}: ` : ""}other?`;
    default:
      return group ? `${group}: ${humanize(o.description) || tpl}` : humanize(o.description) || tpl;
  }
}

function outcomeExpiry(o: RawOutcome, q: RawQuestion | undefined): number | null {
  const kv = parseKv(o.description);
  const qkv = q ? parseKv(q.description) : {};
  for (const k of ["time", "expiry", "dateTime", "listingDeadline", "resolutionDeadline", "scheduledDecision", "decisionDeadline"]) {
    const t = parseCompactUtc(kv[k] ?? qkv[k]);
    if (t != null) return t;
  }
  return null;
}

export function parseOutcomes(
  meta: RawOutcomeMeta,
  ctxs: Map<string, RawSpotCtx>,
  mids: Record<string, string>
): OutcomeMarket[] {
  const groupOf = new Map<number, RawQuestion>();
  for (const q of meta.questions ?? []) {
    for (const id of [...(q.namedOutcomes ?? []), ...(q.fallbackOutcome != null ? [q.fallbackOutcome] : [])]) groupOf.set(id, q);
  }
  return meta.outcomes.map((o) => {
    const q = groupOf.get(o.outcome);
    const kv = { ...(q ? parseKv(q.description) : {}), ...parseKv(o.description) };
    const side = (s: 0 | 1): OutcomeSide => {
      const coin = outcomeCoin(o.outcome, s);
      const c = ctxs.get(coin);
      const mid = num(mids[coin]) ?? num(c?.midPx) ?? num(c?.markPx);
      const prev = num(c?.prevDayPx);
      const specName = o.sideSpecs[s]?.name;
      return {
        side: s,
        name: specName ? fill(specName, kv) : s === 0 ? "Yes" : "No",
        coin,
        mid,
        prevDayPx: prev && prev > 0 ? prev : null,
        dayNtlVlm: num(c?.dayNtlVlm),
        change24hPp: mid != null && prev && prev > 0 ? (mid - prev) * 100 : null,
      };
    };
    const sides: [OutcomeSide, OutcomeSide] = [side(0), side(1)];
    const vols = sides.map((s) => s.dayNtlVlm).filter((v): v is number => v != null);
    return {
      id: o.outcome,
      template: strip(o.name),
      question: outcomeQuestion(o, q),
      groupId: q?.question ?? null,
      groupTitle: q ? questionTitle(q) : null,
      expiresAt: outcomeExpiry(o, q),
      deployerVenue: o.venue ?? null,
      sides,
      volume24hUsd: vols.length ? vols.reduce((a, b) => a + b, 0) : null,
    };
  });
}

/**
 * Resolve an OutcomeInstrument's (market, outcome) to (id, side).
 * market: "11382", "#113820" or "+113820"; outcome: side name (YES/NO/Over/LAR…), or "0"/"1".
 */
export function resolveOutcomeRef(
  market: string,
  outcome: string,
  meta?: RawOutcomeMeta
): { id: number; side: 0 | 1 } | null {
  const m = market.trim();
  let id: number | null = null;
  let encSide: 0 | 1 | null = null;
  const enc = /^[#+](\d+)$/.exec(m);
  if (enc) {
    const n = Number(enc[1]);
    id = Math.floor(n / 10);
    encSide = n % 10 === 1 ? 1 : 0;
  } else if (/^\d+$/.test(m)) {
    id = Number(m);
  }
  if (id == null) return null;
  const o = outcome.trim().toLowerCase();
  if (["yes", "y", "0", "true"].includes(o)) return { id, side: 0 };
  if (["no", "n", "1", "false"].includes(o)) return { id, side: 1 };
  const raw = meta?.outcomes.find((x) => x.outcome === id);
  if (raw) {
    const kv = parseKv(raw.description);
    const idx = raw.sideSpecs.findIndex((s) => fill(s.name, kv).toLowerCase() === o);
    if (idx === 0 || idx === 1) return { id, side: idx };
  }
  return encSide != null ? { id, side: encSide } : null;
}

