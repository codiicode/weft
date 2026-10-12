import {
  clauses,
  exprRefs,
  instrumentLabel,
  type Action,
  type Level,
  type Signal,
  type Size,
  type Strategy,
} from "@weft/strategy";
import type { GraphNode, GraphRuntime, GraphSpec, SignalType } from "@/components/graph/types";

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

function signalTitle(s: Signal): string {
  if (s.label) return s.label;
  const p = s.params as Record<string, unknown>;
  if (p.instrument) return instrumentLabel(p.instrument as never);
  if (s.kind === "token_onchain") return `${s.params.mint.slice(0, 4)}…${s.params.mint.slice(-4)}`;
  if (s.kind === "social") return [...s.params.cashtags.map((c) => `$${c}`), ...s.params.keywords, ...s.params.accounts].slice(0, 2).join(" ") || "Social";
  if (s.kind === "post_match") return s.params.accounts.join(", ");
  if (s.kind === "forecast") return s.params.series.replaceAll("_", " ");
  if (s.kind === "macro") return s.params.series;
  if (s.kind === "news") return s.params.query;
  if (s.kind === "model") return s.params.question;
  if (s.kind === "calendar") return `${s.params.symbol ?? ""} ${s.params.event}`.trim();
  return s.id;
}

function sizeLabel(size: Size): string {
  if (size.unit === "pct_equity") return `${size.value}%`;
  if (size.unit === "usd") return `$${fmtNum(size.value)}`;
  return `${size.value}`;
}

function levelLabel(l: Level | undefined, sign: "+" | "−"): string | undefined {
  if (!l) return undefined;
  if ("pct" in l) return `${sign}${l.pct}%`;
  if ("prob" in l) return `${Math.round(l.prob * 100)}¢`;
  return `$${fmtNum(l.price)}`;
}

function venueOf(a: Action): string {
  if (a.type === "open") {
    const i = a.instrument;
    if (i.kind === "token") return i.route === "auto" ? "Jupiter" : i.route[0]!.toUpperCase() + i.route.slice(1);
    if (i.kind === "outcome") return i.venue === "hyperliquid" ? "HIP-4" : "Jupiter";
    if (i.kind === "perp") return i.dex ? `HIP-3 · ${i.dex}` : "Hyperliquid";
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
      conditions: c.lines.map((l) => l.replace(/\b([a-z0-9_]+)\.([a-z0-9_]+)/g, (_, _sig, f: string) => f.replaceAll("_", " "))),
      met: live.triggers?.find((x) => x.id === t.id)?.met ?? false,
    });
    for (const sid of new Set(exprRefs(t.when).map((r) => r.ref.split(".")[0]!))) edges.push([sid, t.id]);
  }

  for (const a of s.actions) {
    const pos = live.positions?.find((p) => p.actionId === a.id);
    if (a.type === "open") {
      const longOnly = a.instrument.kind === "token" || a.instrument.kind === "outcome" || a.instrument.kind === "spot";
      const sign = a.side === "long" ? (["+", "−"] as const) : (["−", "+"] as const);
      nodes.push({
        id: a.id,
        kind: "action",
        side: longOnly ? "buy" : a.side,
        asset: a.label ?? instrumentLabel(a.instrument),
        venue: venueOf(a),
        alloc: sizeLabel(a.size) + (a.size.unit === "native" && a.instrument.kind === "token" ? ` ${a.instrument.quote}` : ""),
        lev: a.leverage > 1 ? `${a.leverage}×` : undefined,
        tp: levelLabel(a.exits.takeProfit, sign[0]),
        sl: levelLabel(a.exits.stopLoss, sign[1]),
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
        tp: levelLabel(a.exits.takeProfit, "+"),
        sl: levelLabel(a.exits.stopLoss, "−"),
        pnl: pos ? pos.unrealizedPnlPct : undefined,
      });
    } else if (a.type === "close") {
      nodes.push({
        id: a.id,
        kind: "exit",
        title: a.label ?? (a.target === "all" ? "Close all positions" : `Close ${instrumentLabel(a.target.instrument)}`),
        detail: a.fraction < 1 ? `${Math.round(a.fraction * 100)}% of position` : "entire position",
      });
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
