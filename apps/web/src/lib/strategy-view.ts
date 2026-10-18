import {
  clauses,
  describePctRange,
  exprRefs,
  instrumentLabel,
  type Action,
  type Level,
  type Signal,
  type Size,
  type Strategy,
} from "@weft/strategy";
import type { GraphNode, GraphRuntime, GraphSpec, SignalType } from "@/components/graph/types";
import { instrumentIcon, type IconRef } from "./assets";

/**
 * Bridges the real strategy schema (@weft/strategy) to the visual graph
 * component. Live values (signal readings, trigger states, open positions)
 * from an engine snapshot are optional; without them the graph shows the
 * strategy "armed".
 */

export interface LiveOverlay {
  signalValues?: Record<string, number | boolean | null>;
  triggers?: { id: string; met: boolean }[];
  positions?: { actionId: string; unrealizedPnlPct: number }[];
  /** Action ids that have fired (fills, notifications, closes). */
  firedActions?: string[];
}

const SIGNAL_TYPE: Record<Signal["kind"], SignalType> = {
  price: "price",
  funding: "funding",
  liquidity: "liquidity",
  odds: "odds",
  token_onchain: "onchain",
  social: "social",
  post_match: "social",
  news: "news",
  forecast: "forecast",
  model: "model",
  calendar: "calendar",
  macro: "rates",
  yield: "rates",
  wallet: "onchain",
  trader: "position",
  sports: "sports",
  position: "position",
};

const SOURCE: Record<Signal["kind"], string> = {
  price: "Price",
  funding: "Funding",
  liquidity: "Liquidity",
  odds: "Odds",
  token_onchain: "On-chain",
  social: "X / social",
  post_match: "X watch",
  news: "Newswire",
  forecast: "Forecast",
  model: "Weft model",
  calendar: "Calendar",
  macro: "Macro",
  yield: "Yield",
  wallet: "Wallet",
  trader: "Trader",
  sports: "Sports",
  position: "Position",
};

function fmtNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a === 0) return "0";
  return v.toPrecision(3);
}

/** Readable names for macro series ("FEES:hyperliquid" → "Hyperliquid daily fees"). */
const SERIES_LABEL: Record<string, string> = {
  FEAR_GREED: "Crypto Fear & Greed",
  FEAR_AND_GREED: "Crypto Fear & Greed",
  FNG: "Crypto Fear & Greed",
  BTC_DOMINANCE: "Bitcoin dominance (%)",
  ETH_DOMINANCE: "Ether dominance (%)",
  CRYPTO_MCAP: "Total crypto market cap ($B)",
  STABLECOIN_MCAP: "Stablecoin supply ($B)",
  TVL: "DeFi TVL ($B)",
  US3M: "US 3-month yield",
  US1Y: "US 1-year yield",
  US2Y: "US 2-year yield",
  US5Y: "US 5-year yield",
  US10Y: "US 10-year yield",
  US30Y: "US 30-year yield",
  REAL10Y: "US 10-year real yield",
  US10Y_REAL: "US 10-year real yield",
  FEDFUNDS: "Fed funds rate",
  EFFR: "Fed funds rate",
  T10Y2Y: "2s10s yield curve",
  BREAKEVEN10Y: "10-year inflation expectations",
  MORTGAGE30: "30-year mortgage rate",
  HY_SPREAD: "High-yield credit spread",
  SP500: "S&P 500",
  NASDAQ: "Nasdaq",
  VIX: "VIX",
  WTI: "WTI oil",
  BRENT: "Brent oil",
  DXY: "Dollar index",
  USD_BROAD: "Dollar index",
  CPI: "CPI",
  CORE_CPI: "Core CPI",
  UNEMPLOYMENT: "Unemployment rate",
  PAYROLLS: "Nonfarm payrolls",
  JOBLESS_CLAIMS: "Jobless claims",
  M2: "M2 money supply",
  FED_BALANCE_SHEET: "Fed balance sheet",
};

export function macroLabel(series: string): string {
  const up = series.trim().toUpperCase();
  if (SERIES_LABEL[up]) return SERIES_LABEL[up]!;
  const [kind, rest] = [up.split(":")[0]!, series.slice(series.indexOf(":") + 1).trim()];
  const name = rest.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  if (kind === "TVL" && up.includes(":")) return `${name} TVL ($B)`;
  if (kind === "FEES") return `${name} daily fees ($M)`;
  if (kind === "REVENUE") return `${name} daily revenue ($M)`;
  if (kind === "FRED") return `FRED ${rest}`;
  if (/^[A-Z]{6}$/.test(up.replace("/", ""))) return `${up.replace("/", "").slice(0, 3)}/${up.replace("/", "").slice(3)}`;
  return series;
}

function signalTitle(s: Signal): string {
  if (s.label) return s.label;
  const p = s.params as Record<string, unknown>;
  if (p.instrument) return instrumentLabel(p.instrument as never);
  if (s.kind === "token_onchain") return `${s.params.mint.slice(0, 4)}…${s.params.mint.slice(-4)}`;
  if (s.kind === "social") return [...s.params.cashtags.map((c) => `$${c}`), ...s.params.keywords, ...s.params.accounts].slice(0, 2).join(" ") || "Social";
  if (s.kind === "post_match") return s.params.accounts.map((a) => `@${a.replace(/^@/, "")}`).join(", ");
  if (s.kind === "wallet") return `Wallet ${s.params.address.slice(0, 4)}…${s.params.address.slice(-4)}`;
  if (s.kind === "trader") return `Trader ${s.params.address.slice(0, 6)}…${s.params.address.slice(-4)} · ${s.params.coin}`;
  if (s.kind === "forecast") {
    const w = /^(temp|temperature|precip|precipitation|rain)\s*:\s*(.+)$/i.exec(s.params.series);
    if (w) return /^temp/i.test(w[1]!) ? `${w[2]} temperature, next 7 days (°C)` : `${w[2]} rain and snow, next 7 days (mm)`;
    return s.params.series.replaceAll("_", " ");
  }
  if (s.kind === "macro") return macroLabel(s.params.series);
  if (s.kind === "sports") return `${s.params.team} (${s.params.league.toUpperCase()})`;
  if (s.kind === "news") return s.params.query;
  if (s.kind === "model") return s.params.question;
  if (s.kind === "calendar") return `${s.params.symbol ?? ""} ${s.params.event === "custom" ? "event" : s.params.event === "fomc" ? "Fed meeting" : s.params.event === "cpi" ? "inflation report" : s.params.event}`.trim();
  return s.id;
}

function sizeLabel(size: Size): string {
  if (size.unit === "pct_equity") return `${size.value}%`;
  if (size.unit === "usd") return `$${fmtNum(size.value)}`;
  return `${size.value}`;
}

/**
 * `sign` is the price direction for this exit. A `positionPct` level is about the position, so a stop
 * reads "−20%" and a take-profit "+50%" whichever way the trade goes.
 */
function levelLabel(l: Level | undefined, sign: "+" | "−", kind: "tp" | "sl" = sign === "+" ? "tp" : "sl"): string | undefined {
  if (!l) return undefined;
  if ("pct" in l) return `${sign}${l.pct}%`;
  if ("positionPct" in l) return `${kind === "sl" ? "−" : "+"}${l.positionPct}%`;
  if ("prob" in l) return `${Math.round(l.prob * 100)}¢`;
  return `$${fmtNum(l.price)}`;
}

function venueOf(a: Action): string {
  if (a.type === "open") {
    const i = a.instrument;
    if (i.kind === "token") return i.route === "auto" ? "Jupiter" : i.route[0]!.toUpperCase() + i.route.slice(1);
    if (i.kind === "outcome") return i.venue === "hyperliquid" ? "HIP-4" : i.venue === "polymarket" ? "Polymarket" : "Jupiter";
    if (i.kind === "perp") return i.dex ? `HIP-3 · ${i.dex}` : "Hyperliquid";
    if (i.kind === "lend") return i.venue === "jupiter" ? "Jupiter Lend" : "Kamino";
    if (i.kind === "synth") return "Papertrade";
    return "Hyperliquid";
  }
  if (a.type === "options") return a.legs[0]!.instrument.venue[0]!.toUpperCase() + a.legs[0]!.instrument.venue.slice(1);
  return "";
}

export function strategyToSpec(s: Strategy, live: LiveOverlay = {}): { spec: GraphSpec; runtime: GraphRuntime } {
  const nodes: GraphNode[] = [];
  const edges: [string, string][] = [];

  // Which fields of each signal the triggers actually use: shown on the node.
  const usedFields = new Map<string, string[]>();
  for (const t of s.triggers)
    for (const { ref } of exprRefs(t.when)) {
      const [sid, field] = ref.split(".") as [string, string];
      const list = usedFields.get(sid) ?? [];
      if (!list.includes(field)) list.push(field);
      usedFields.set(sid, list);
    }

  for (const sig of s.signals) {
    const fields = usedFields.get(sig.id) ?? [];
    const vals = fields.map((f) => [f, live.signalValues?.[`${sig.id}.${f}`]] as const);
    const primary = vals.find(([, v]) => v != null) ?? vals[0];
    const fmt = (f: string, v: number | boolean | null | undefined) =>
      v == null ? `${f.replaceAll("_", " ")} · —` : typeof v === "boolean" ? `${f.replaceAll("_", " ")} · ${v ? "yes" : "no"}` : `${f.replaceAll("_", " ")} ${fmtNum(v)}`;
    const second = vals.find(([f]) => f !== primary?.[0]);
    nodes.push({
      id: sig.id,
      kind: "signal",
      type: SIGNAL_TYPE[sig.kind],
      title: signalTitle(sig),
      source: SOURCE[sig.kind],
      value: primary ? fmt(primary[0], primary[1]) : sig.kind,
      delta: second ? fmt(second[0], second[1]) : undefined,
    });
  }

  for (const t of s.triggers) {
    const c = clauses(t.when);
    nodes.push({
      id: t.id,
      kind: "trigger",
      logic: c.logic,
      conditions: c.lines.map((l) => l.replace(/\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)/g, (_, _sig, f: string) => f.replaceAll("_", " "))),
      met: live.triggers?.find((x) => x.id === t.id)?.met ?? false,
    });
    for (const sid of new Set(exprRefs(t.when).map((r) => r.ref.split(".")[0]!))) edges.push([sid, t.id]);
  }

  for (const a of s.actions) {
    const pos = live.positions?.find((p) => p.actionId === a.id);
    if (a.type === "open") {
      const longOnly = a.instrument.kind === "token" || a.instrument.kind === "outcome" || a.instrument.kind === "spot" || a.instrument.kind === "lend";
      const sign = a.side === "long" ? (["+", "−"] as const) : (["−", "+"] as const);
      nodes.push({
        id: a.id,
        kind: "action",
        side: longOnly ? "buy" : a.side,
        asset: a.label ?? instrumentLabel(a.instrument),
        venue: venueOf(a),
        alloc: sizeLabel(a.size) + (a.size.unit === "native" && a.instrument.kind === "token" ? ` ${a.instrument.quote}` : ""),
        lev: a.leverage > 1 ? `${a.leverage}×` : undefined,
        tp: levelLabel(a.exits.takeProfit, sign[0], "tp"),
        sl: levelLabel(a.exits.stopLoss, sign[1], "sl"),
        pnl: pos ? pos.unrealizedPnlPct : undefined,
      });
    } else if (a.type === "options") {
      nodes.push({
        id: a.id,
        kind: "action",
        side: "buy",
        asset: a.label ?? `${a.legs[0]!.instrument.underlying} ${a.legs.length}-leg`,
        venue: venueOf(a),
        alloc: sizeLabel(a.size),
        tp: levelLabel(a.exits.takeProfit, "+", "tp"),
        sl: levelLabel(a.exits.stopLoss, "−", "sl"),
        pnl: pos ? pos.unrealizedPnlPct : undefined,
      });
    } else if (a.type === "close") {
      nodes.push({
        id: a.id,
        kind: "exit",
        title: a.label ?? (a.target === "all" ? "Close all positions" : `Close ${instrumentLabel(a.target.instrument)}`),
        detail: a.fraction < 1 ? `${Math.round(a.fraction * 100)}% of position` : "entire position",
      });
    } else if (a.type === "copy") {
      nodes.push({ id: a.id, kind: "action", side: "buy", asset: a.label ?? copyWho(a), venue: a.leader.venue === "hyperliquid" ? "Hyperliquid" : "Solana", alloc: sizeLabel(a.size) });
    } else if (a.type === "liquidity") {
      nodes.push({ id: a.id, kind: "action", side: "buy", asset: a.label ?? `${a.pool.symbol} liquidity`, venue: "Meteora", alloc: sizeLabel(a.size), tp: levelLabel(a.exits.takeProfit, "+", "tp"), sl: levelLabel(a.exits.stopLoss, "−", "sl"), pnl: pos ? pos.unrealizedPnlPct : undefined });
    } else {
      nodes.push({ id: a.id, kind: "exit", title: a.label ?? `Alert · ${a.channel}`, detail: a.message });
    }
    a.on.forEach((tid) => edges.push([tid, a.id]));
  }

  const visible = Object.fromEntries(nodes.map((n) => [n.id, true]));
  const met = Object.fromEntries((live.triggers ?? []).map((t) => [t.id, t.met]));
  const active: Record<string, boolean> = {};
  for (const a of s.actions) {
    if (live.positions?.some((p) => p.actionId === a.id) || live.firedActions?.includes(a.id)) active[a.id] = true;
  }
  return { spec: { nodes, edges }, runtime: { visible, met, active } };
}

/* ------------------------------------------------------------------ */
/* Plain-English reading of a strategy                                  */
/* ------------------------------------------------------------------ */

export interface PlainRule {
  id: string;
  /** "all" = every condition must hold, "any" = one is enough */
  match: "all" | "any";
  when: string[];
  hold?: string;
  then: { text: string; tone: "long" | "short" | "exit" | "alert"; icon?: IconRef }[];
}

function minutesLabel(m: number): string {
  if (m >= 1440 && m % 1440 === 0) return `${m / 1440} day${m === 1440 ? "" : "s"}`;
  if (m >= 60 && m % 60 === 0) return `${m / 60} hour${m === 60 ? "" : "s"}`;
  return `${m} min`;
}

/** Readable names for signal fields, with the unit their numbers are in. */
const FIELD: Record<string, [name: string, unit?: "%" | "$" | "pp" | "bps" | "h" | "min" | "prob"]> = {
  price: ["price"],
  change_5m_pct: ["5-min change", "%"],
  change_1h_pct: ["1h change", "%"],
  change_24h_pct: ["24h change", "%"],
  change_24h_pp: ["24h change", "pp"],
  change_1d: ["1-day change"],
  change_5d: ["5-day change"],
  change_7d: ["7-day change"],
  rate_1h_pct: ["hourly funding", "%"],
  rate_8h_pct: ["8h funding", "%"],
  apr_pct: ["funding APR", "%"],
  oi_zscore_30d: ["open interest vs 30-day normal"],
  binance_rate_1h_pct: ["Binance hourly funding", "%"],
  bybit_rate_1h_pct: ["Bybit hourly funding", "%"],
  funding_gap_1h_pct: ["funding gap to Binance/Bybit", "%"],
  buys_1h: ["buys in the last hour"],
  sells_1h: ["sells in the last hour"],
  sol_spent_1h: ["SOL spent in the last hour"],
  sol_received_1h: ["SOL received in the last hour"],
  minutes_since_buy: ["minutes since its last buy"],
  minutes_since_sell: ["minutes since its last sell"],
  token_balance: ["tokens held"],
  entry_price: ["entry price"],
  unrealized_pnl_pct: ["profit on the position", "%"],
  minutes_since_change: ["minutes since it last opened, closed or flipped"],
  account_value_usd: ["account value", "$"],
  open_interest_usd: ["open interest", "$"],
  volume_24h_usd: ["24h volume", "$"],
  liquidity_usd: ["liquidity", "$"],
  market_cap_usd: ["market cap", "$"],
  depth_2pct_usd: ["order book depth", "$"],
  spread_bps: ["spread", "bps"],
  price_impact_bps_1k: ["price impact on $1k", "bps"],
  prob: ["probability", "prob"],
  sentiment: ["sentiment"],
  mentions_1h: ["mentions per hour"],
  mentions_change_1h_pct: ["change in mentions", "%"],
  unique_authors_1h: ["people posting per hour"],
  articles_1h: ["articles per hour"],
  max_relevance: ["news relevance"],
  holders: ["holders"],
  holders_change_1h_pct: ["1h holder growth", "%"],
  top10_holders_pct: ["top-10 holders’ share", "%"],
  dev_sold_pct: ["dev wallet sold", "%"],
  buy_sell_ratio_1h: ["buys per sell (1h)"],
  smart_wallet_buys_1h: ["smart-wallet buys per hour"],
  bonding_curve_pct: ["bonding curve progress", "%"],
  age_minutes: ["age", "min"],
  mint_authority_revoked: ["mint authority revoked"],
  freeze_authority_revoked: ["freeze authority revoked"],
  lp_locked: ["liquidity locked"],
  migrated: ["graduated from launchpad"],
  wins: ["wins"],
  losses: ["losses"],
  ties: ["ties or draws"],
  games_played: ["games played"],
  win_pct: ["win rate", "prob"],
  streak: ["streak (+ wins, − losses in a row)"],
  points: ["league points"],
  rank: ["standing"],
  matched: ["post matched"],
  match_score: ["post match score"],
  minutes_since_match: ["minutes since the post", "min"],
  contradicted: ["contradicted"],
  confidence: ["confidence"],
  hours_until: ["hours until", "h"],
  hours_since: ["hours since", "h"],
  hours_open: ["hours open", "h"],
  open: ["open"],
  pnl_pct: ["profit", "%"],
  pnl_usd: ["profit", "$"],
  size_usd: ["size", "$"],
  value: ["value"],
};

function withUnit(n: string, unit?: string): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return n;
  if (unit === "%") return `${n}%`;
  if (unit === "prob") return `${Math.round(v * 100)}%`;
  if (unit === "$") return `$${fmtNum(v)}`;
  if (unit === "pp") return `${n} pts`;
  if (unit === "bps") return `${(v / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  if (unit === "h") return `${n}h`;
  if (unit === "min") return `${n} min`;
  return n;
}

/** Rewrites "px.change_24h_pct ≤ -5" into "BTC 24h change ≤ −5%" using signal titles and field names. */
function humanize(line: string, titles: Map<string, string>, sigs: Map<string, Signal> = new Map()): string {
  const name = (sid: string, f: string) => {
    const t = titles.get(sid);
    // A series' own value reads as its name: "Crypto Fear & Greed ≤ 20", not "… value ≤ 20".
    if (t && f === "value") return t;
    const field = FIELD[f]?.[0] ?? f.replaceAll("_", " ");
    // "RAY price" + "price" reads as "RAY price", not "RAY price price".
    return t ? (t.toLowerCase().endsWith(field.toLowerCase()) ? t : `${t} ${field}`) : field;
  };
  const title = (sid: string) => titles.get(sid) ?? sid;
  const claim = (sid: string) => {
    const sg = sigs.get(sid);
    return sg?.kind === "post_match" ? sg.params.claim.replace(/^(announces|says|posts|tweets)( that)? /i, "").replace(/\.$/, "") : "the claim";
  };
  const contra = (sid: string) => {
    const sg = sigs.get(sid);
    return sg?.kind === "post_match" && sg.params.contradiction ? sg.params.contradiction.replace(/\.$/, "") : "the opposite";
  };
  return line
    // Posts on X read as sentences: "@saylor posts that Strategy bought more bitcoin".
    .replace(/\bNOT ([a-z][a-z0-9_]*)\.contradicted\b/g, (_m, sid: string) => `no post from ${title(sid)} ${contra(sid).toLowerCase().startsWith("denies") ? contra(sid) : `says ${contra(sid)}`}`)
    .replace(/\bNOT ([a-z][a-z0-9_]*)\.matched\b/g, (_m, sid: string) => `${title(sid)} hasn’t posted that ${claim(sid)} yet`)
    .replace(/\b([a-z][a-z0-9_]*)\.matched\b(?!\s*[<>=≤≥≠])/g, (_m, sid: string) => `${title(sid)} posts that ${claim(sid)}`)
    .replace(/\b([a-z][a-z0-9_]*)\.minutes_since_match (<|≤) ([\d.]+)/g, (_m, _sid: string, _op: string, n: string) => `the post is under ${n} min old`)
    // Followed wallets and traders: "Wallet 7xKp…9fQe bought in the last hour".
    .replace(/\b([a-z][a-z0-9_]*)\.buys_1h (>|≥) 0\b/g, (_m, sid: string) => `${title(sid)} bought in the last hour`)
    .replace(/\b([a-z][a-z0-9_]*)\.sells_1h (>|≥) 0\b/g, (_m, sid: string) => `${title(sid)} sold in the last hour`)
    .replace(/\b([a-z][a-z0-9_]*)\.minutes_since_buy (<|≤) ([\d.]+)/g, (_m, _sid: string, _op: string, n: string) => `its last buy was under ${n} min ago`)
    .replace(/\b([a-z][a-z0-9_]*)\.minutes_since_sell (<|≤) ([\d.]+)/g, (_m, _sid: string, _op: string, n: string) => `its last sell was under ${n} min ago`)
    .replace(/\b([a-z][a-z0-9_]*)\.minutes_since_change (<|≤) ([\d.]+)/g, (_m, _sid: string, _op: string, n: string) => `they changed it under ${n} min ago`)
    // A followed trader's side reads as a word: "Trader 0x12…ab · BTC is long".
    .replace(/\b([a-z][a-z0-9_]*)\.side (=|≠) (-?1|0)\b/g, (_m, sid: string, op: string, n: string) => `${title(sid)} ${op === "≠" ? "isn’t" : "is"} ${n === "1" ? "long" : n === "0" ? "flat" : "short"}`)
    // Time to/since calendar events read as "in 2–48 hours", "less than 1 hour away".
    .replace(/(-?[\d.]+) ≤ ([a-z][a-z0-9_]*)\.hours_until ≤ (-?[\d.]+)/g, (_m, a: string, sid: string, b: string) => `${title(sid)} is ${a}–${b} hours away`)
    .replace(/([a-z][a-z0-9_]*)\.hours_until ([<≤]) (-?[\d.]+)/g, (_m, sid: string, _op: string, n: string) => `${title(sid)} is less than ${n} hour${n === "1" ? "" : "s"} away`)
    .replace(/([a-z][a-z0-9_]*)\.hours_since ([<≤]) (-?[\d.]+)/g, (_m, sid: string, _op: string, n: string) => `${title(sid)} happened less than ${n} hour${n === "1" ? "" : "s"} ago`)
    .replace(/(-?[\d.]+) ≤ ([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*) ≤ (-?[\d.]+)/g, (_m, a: string, sid: string, f: string, b: string) => `${name(sid, f)} between ${withUnit(a, FIELD[f]?.[1])} and ${withUnit(b, FIELD[f]?.[1])}`)
    .replace(/\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\s*([<>=≤≥≠])\s*(-?[\d.]+)/g, (_m, sid: string, f: string, op: string, n: string) => {
      const unit = FIELD[f]?.[1];
      return `${name(sid, f)} ${op} ${withUnit(n, unit).replace(/^-/, "−")}`;
    })
    .replace(/\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*) (crosses above|crosses below) (-?[\d.]+)/g, (_m, sid: string, f: string, op: string, n: string) => {
      return `${name(sid, f)} ${op.replace("crosses", "rises").replace("rises below", "falls below")} ${withUnit(n, FIELD[f]?.[1]).replace(/^-/, "−")}`;
    })
    .replace(/\bNOT ([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\b(?!\s*[<>=≤≥≠])/g, (_m, sid: string, f: string) => `${name(sid, f)} is false`)
    .replace(/\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\b/g, (m, sid: string, f: string) => (titles.has(sid) || FIELD[f] ? name(sid, f) : m))
    .replace(/\bAND\b/g, "and")
    .replace(/\bOR\b/g, "or")
    .replace(/\bNOT\b/g, "not");
}

function sizePhrase(a: { size: Size }, quote?: string): string {
  const s = a.size;
  if (s.unit === "pct_equity") return `${s.value}% of the account`;
  if (s.unit === "usd") return `$${s.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `${s.value}${quote ? ` ${quote}` : ""}`;
}

function exitPhrase(e: { takeProfit?: Level; stopLoss?: Level; trailingStopPct?: number; timeExitHours?: number }, sign: ["+" | "−", "+" | "−"], leverage = 1): string {
  const parts: string[] = [];
  // On a leveraged position, say both: what happens to the position, and the price move that means.
  const withPrice = (l: Level | undefined, label: string | undefined, priceSign: "+" | "−") =>
    label && l && "positionPct" in l && leverage > 1 ? `${label} on the position (price ${priceSign}${+(l.positionPct / leverage).toFixed(2)}%)` : label;
  const sl = withPrice(e.stopLoss, levelLabel(e.stopLoss, sign[1], "sl"), sign[1]);
  const tp = withPrice(e.takeProfit, levelLabel(e.takeProfit, sign[0], "tp"), sign[0]);
  if (sl) parts.push(`stop at ${sl}`);
  if (tp) parts.push(`take profit at ${tp}`);
  if (e.trailingStopPct) parts.push(`trailing stop ${e.trailingStopPct}%`);
  if (e.timeExitHours) parts.push(`exit after ${minutesLabel(e.timeExitHours * 60)}`);
  return parts.join(", ");
}

/** The rules of a strategy as short sentences: "When … → Buy …". */
export function describeStrategy(s: Strategy): { watches: string[]; watchKinds: { label: string; kind: Signal["kind"] }[]; rules: PlainRule[] } {
  // On-chain signals are titled by mint; use the token's name when the strategy trades it.
  const tokenName = (mint: string) => {
    for (const a of s.actions) if (a.type === "open" && a.instrument.kind === "token" && a.instrument.mint === mint) return a.label ?? instrumentLabel(a.instrument);
    return null;
  };
  const titleOf = (sig: Signal) => {
    if (sig.kind === "token_onchain" && !sig.label) {
      const n = tokenName(sig.params.mint);
      if (n) return `${n} on-chain`;
    }
    return signalTitle(sig);
  };
  // Long market questions make sentences unreadable: keep names short.
  const short = (t: string) => {
    let q = t.replace(/^YES · |^NO · /, "");
    if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(q)) q = q.replaceAll("-", " ");
    return q.length > 34 ? `${q.slice(0, 32).replace(/[\s,:;·-]+\S*$/, "")}…` : q;
  };
  const titles = new Map(s.signals.map((sig) => [sig.id, short(titleOf(sig)).replace(/ on-chain( health)?$/i, "")]));
  const sigById = new Map(s.signals.map((sig) => [sig.id, sig]));
  const watchLabel = (sig: Signal) => {
    const t = short(titleOf(sig));
    if (sig.kind === "price" && !/price/i.test(t)) return `${t} price`;
    if (sig.kind === "funding" && !/funding/i.test(t)) return `${t} funding`;
    if (sig.kind === "odds" && !/odds/i.test(t)) return `${t} odds`;
    return t;
  };
  const watchKinds = s.signals.map((sig) => ({ label: watchLabel(sig), kind: sig.kind })).filter((w, i, all) => all.findIndex((x) => x.label === w.label) === i);
  const watches = [
    ...new Set(
      s.signals.map((sig) => {
        const t = short(titleOf(sig));
        if (sig.kind === "price" && !/price/i.test(t)) return `${t} price`;
        if (sig.kind === "funding" && !/funding/i.test(t)) return `${t} funding`;
        if (sig.kind === "odds" && !/odds/i.test(t)) return `${t} odds`;
        return t;
      }),
    ),
  ];
  const rules: PlainRule[] = s.triggers.map((t) => {
    const c = clauses(t.when);
    const then = s.actions
      .filter((a) => a.type !== "copy" && a.on.includes(t.id))
      .map((a): PlainRule["then"][number] => {
        if (a.type === "open") {
          const inst =
            a.label ??
            (a.instrument.kind === "outcome"
              ? `${a.instrument.outcome} on “${short(a.instrument.question ?? a.instrument.market)}”`
              : instrumentLabel(a.instrument));
          const longOnly = a.instrument.kind === "token" || a.instrument.kind === "outcome" || a.instrument.kind === "spot" || a.instrument.kind === "lend";
          const verb = a.instrument.kind === "lend" ? "Lend" : longOnly ? "Buy" : a.side === "long" ? "Go long" : "Go short";
          const quote = a.instrument.kind === "token" ? a.instrument.quote : undefined;
          const lev = a.leverage > 1 ? ` at ${a.leverage}×` : "";
          const sign: ["+" | "−", "+" | "−"] = a.side === "long" ? ["+", "−"] : ["−", "+"];
          const ex = exitPhrase(a.exits, sign, a.leverage);
          // A label that already says what to do ("Buy 0.05 SOL of RAY") is used as the whole phrase.
          const said = a.label && /^(buy|sell|go long|go short|long|short)\b/i.test(a.label);
          return {
            text: said ? `${a.label}${lev}${ex ? `; ${ex}` : ""}` : `${verb} ${inst} with ${sizePhrase(a, quote)}${lev}${ex ? `; ${ex}` : ""}`,
            tone: a.side === "short" && !longOnly ? "short" : "long",
            icon: instrumentIcon(a.instrument),
          };
        }
        if (a.type === "options") {
          const ex = exitPhrase(a.exits, ["+", "−"]);
          return {
            text: `Open ${a.label ?? `${a.legs[0]!.instrument.underlying} options (${a.legs.length} legs)`} with ${sizePhrase(a)}${ex ? `; ${ex}` : ""}`,
            tone: "long",
            icon: instrumentIcon(a.legs[0]!.instrument),
          };
        }
        if (a.type === "close") {
          const what = a.target === "all" ? "every position" : instrumentLabel(a.target.instrument);
          return { text: `${a.fraction < 1 ? `Close ${Math.round(a.fraction * 100)}% of` : "Close"} ${what}`, tone: "exit", icon: a.target === "all" ? undefined : instrumentIcon(a.target.instrument) };
        }
        if (a.type === "copy") return { text: copyText(a), tone: "long" };
        if (a.type === "liquidity") {
          const r = a.range;
          const where = ("lowerPct" in r ? describePctRange(r) : `between ${r.lower.toLocaleString("en-US")} and ${r.upper.toLocaleString("en-US")} ${a.pool.quoteSymbol}`) + (a.shape === "bid_ask" ? ", weighted toward the edges (bid-ask)" : "");
          const ex = [exitPhrase(a.exits, ["+", "−"]), a.outOfRangeMinutes != null ? `withdraw if the price stays outside the range for ${a.outOfRangeMinutes >= 60 && a.outOfRangeMinutes % 60 === 0 ? `${a.outOfRangeMinutes / 60} h` : `${a.outOfRangeMinutes} min`}` : ""].filter(Boolean).join("; ");
          return { text: `Provide ${sizePhrase(a)} of liquidity to the ${a.pool.symbol} pool on Meteora, ${where}${ex ? `; ${ex}` : ""}`, tone: "long", icon: instrumentIcon(a.pool) };
        }
        return { text: `Send an alert: “${a.message}”`, tone: "alert" };
      });
    // "price > 0" is how a "do it now" order is written: say so instead of showing the comparison.
    const lines = c.lines.filter((l) => !/^[a-z][a-z0-9_]*\.price > 0$/.test(l.trim()));
    return {
      id: t.id,
      match: c.logic === "OR" ? "any" : "all",
      when: lines.length ? lines.map((l) => humanize(l, titles, sigById)) : ["Right away"],
      hold: t.forMinutes ? `for ${minutesLabel(t.forMinutes)}` : undefined,
      then,
    };
  });
  // Copy trading runs on the leader's trades, not on a rule: one plain rule per copy action.
  for (const a of s.actions) {
    if (a.type !== "copy") continue;
    const gate = a.on.map((id) => s.triggers.findIndex((t) => t.id === id)).filter((i) => i >= 0).map((i) => `rule ${i + 1} holds`);
    rules.push({
      id: a.id,
      match: "all",
      when: [a.leader.venue === "x" ? `${copyWho(a)} calls a Solana token in a post` : a.leader.venue === "solana" ? `${copyWho(a)} buys or sells a token` : `${copyWho(a)} opens, closes or flips a position`, ...gate],
      then: [{ text: copyText(a), tone: "long" }],
    });
    const w = copyWho(a);
    if (!watches.includes(w)) watches.push(w);
    watchKinds.push({ label: w, kind: a.leader.venue === "x" ? "post_match" : a.leader.venue === "solana" ? "wallet" : "trader" });
  }
  return { watches, watchKinds, rules };
}

/** "Wallet 7xKp…9fQe" / "Trader 0x1234…abcd". */
function copyWho(a: Extract<Action, { type: "copy" }>): string {
  if (a.leader.venue === "x") return `@${a.leader.account}`;
  return a.leader.venue === "solana" ? `Wallet ${a.leader.wallet.slice(0, 4)}…${a.leader.wallet.slice(-4)}` : `Trader ${a.leader.trader.slice(0, 6)}…${a.leader.trader.slice(-4)}`;
}

/** What a copy action does, in one sentence. */
function copyText(a: Extract<Action, { type: "copy" }>): string {
  const size = sizeLabel(a.size);
  const only = a.only?.length ? ` (only ${a.only.slice(0, 3).map((x) => (x.length > 12 ? `${x.slice(0, 4)}…` : x)).join(", ")}${a.only.length > 3 ? "…" : ""})` : "";
  if (a.leader.venue === "x") {
    const ex = a.exits;
    const exits = [ex.takeProfit && "pct" in ex.takeProfit ? `take profit at +${ex.takeProfit.pct}%` : null, ex.stopLoss && "pct" in ex.stopLoss ? `stop at −${ex.stopLoss.pct}%` : null, ex.timeExitHours ? `sell after ${ex.timeExitHours}h` : null].filter(Boolean);
    return `Buy each Solana token they call with ${size}${only}, if its liquidity is above $${Math.round(a.minLiquidityUsd / 1000)}k; ${exits.length ? exits.join(", ") : "stop at −30%, sell after 24h"}. Up to ${a.maxOpen} at once.`;
  }
  if (a.leader.venue === "solana")
    return `Buy the same token with ${size}${only}, if its liquidity is above $${Math.round(a.minLiquidityUsd / 1000)}k${a.mirrorExits ? ", and sell when it sells" : ""}. Up to ${a.maxOpen} at once.`;
  const lev = a.leverage ? `${a.leverage}×` : "their leverage";
  if (a.inverse)
    return `Take the opposite side with ${size} at ${lev}${only}: ${a.leaderSide === "long" ? "short when they long" : a.leaderSide === "short" ? "long when they short" : "short what they long, long what they short"}${a.mirrorExits ? ", and close when they close" : ""}. Up to ${a.maxOpen} at once.`;
  if (a.leaderSide) return `Copy only their ${a.leaderSide}s with ${size} at ${lev}${only}${a.mirrorExits ? ", and close when they close" : ""}. Up to ${a.maxOpen} at once.`;
  return `Open the same position with ${size} at ${lev}${only}${a.mirrorExits ? ", and close when they close" : ""}. Up to ${a.maxOpen} at once.`;
}

/** Words of a sentence, for comparing a title with its thesis ("Buy 0.05 SOL of RAY" ≈ "Buy 0.05 sol of RAY now"). */
const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/[$’'`".,!?:;()]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["now", "right", "away", "a", "the", "of", "with", "and"].includes(w));

/**
 * The line under a strategy's name on cards. The thesis, unless it just repeats the name (plain
 * orders: "Buy 0.05 SOL of RAY" / "Buy 0.05 sol of RAY now"); then what the strategy does.
 */
export function thesisRepeatsName(s: Strategy): boolean {
  const name = new Set(words(s.name));
  const thesis = words(s.thesis);
  return thesis.length === 0 || thesis.filter((w) => name.has(w)).length / thesis.length >= 0.75;
}

export function cardLine(s: Strategy): string {
  if (!thesisRepeatsName(s)) return s.thesis;
  const { rules } = describeStrategy(s);
  const r = rules[0];
  if (!r) return s.thesis;
  const once = s.triggers.every((t) => t.maxFires === 1);
  const when = r.when.length === 1 && r.when[0] === "Right away" ? "Right away" : `When ${r.when.join(r.match === "any" ? " or " : " and ")}`;
  const exits = r.then.map((x) => x.text.split("; ")[1]).filter(Boolean)[0];
  return `${when}${once ? ", once" : ""}${exits ? `, with a ${exits.replace(/^stop at /, "stop at ")}` : ", then holds until you change it"}.`;
}
