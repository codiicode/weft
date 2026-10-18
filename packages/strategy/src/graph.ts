import type { Strategy } from "./strategy.ts";
import type { Signal } from "./signals.ts";
import { clauses, exprRefs } from "./expr.ts";
import { instrumentLabel } from "./instruments.ts";
import { describePctRange } from "./actions.ts";

/**
 * Projects a strategy into the node/edge shape the UI renders.
 * Edges are derived, never stored: signal → trigger from the refs in a
 * trigger's condition, trigger → action from the action's `on`.
 */

export type GraphNodeView =
  | { id: string; kind: "signal"; signalKind: Signal["kind"]; title: string; subtitle: string }
  | { id: string; kind: "trigger"; title?: string; logic: "AND" | "OR" | "IF"; lines: string[] }
  | { id: string; kind: "action"; side: "long" | "short" | "notify"; title: string; subtitle: string }
  | { id: string; kind: "exit"; title: string; subtitle: string };

export interface GraphView {
  nodes: GraphNodeView[];
  edges: [from: string, to: string][];
}

function signalTitle(s: Signal): string {
  if (s.label) return s.label;
  const p = s.params as Record<string, unknown>;
  if ("instrument" in p && p.instrument) return instrumentLabel(p.instrument as never);
  if ("mint" in p) return `${String(p.mint).slice(0, 4)}…${String(p.mint).slice(-4)}`;
  if (s.kind === "social") return [...s.params.cashtags.map((c) => `$${c}`), ...s.params.keywords].join(" ") || s.params.accounts.join(" ");
  if (s.kind === "post_match") return s.params.accounts.join(", ");
  if (s.kind === "forecast") return `${s.params.source} · ${s.params.series}`;
  if (s.kind === "macro") return s.params.series;
  if (s.kind === "news") return s.params.query;
  if (s.kind === "model") return s.params.question;
  if (s.kind === "calendar") return `${s.params.symbol ?? ""} ${s.params.event}`.trim();
  return s.id;
}

export function toGraph(s: Strategy): GraphView {
  const nodes: GraphNodeView[] = [];
  const edges: [string, string][] = [];

  for (const sig of s.signals) {
    nodes.push({ id: sig.id, kind: "signal", signalKind: sig.kind, title: signalTitle(sig), subtitle: sig.kind.replace("_", " ") });
  }
  for (const t of s.triggers) {
    const c = clauses(t.when);
    nodes.push({ id: t.id, kind: "trigger", title: t.label, logic: c.logic, lines: c.lines });
    const from = new Set(exprRefs(t.when).map((r) => r.ref.split(".")[0]!));
    from.forEach((sid) => edges.push([sid, t.id]));
  }
  for (const a of s.actions) {
    switch (a.type) {
      case "open":
        nodes.push({
          id: a.id,
          kind: "action",
          side: a.side,
          title: a.label ?? instrumentLabel(a.instrument),
          subtitle: a.instrument.kind === "token" || a.instrument.kind === "outcome" ? "buy" : `${a.side}${a.leverage > 1 ? ` ${a.leverage}×` : ""}`,
        });
        break;
      case "options":
        nodes.push({ id: a.id, kind: "action", side: "long", title: a.label ?? `${a.legs.length}-leg options`, subtitle: a.legs.map((l) => `${l.side} ${instrumentLabel(l.instrument)}`).join(" / ") });
        break;
      case "close":
        nodes.push({ id: a.id, kind: "exit", title: a.label ?? (a.target === "all" ? "Close all positions" : `Close ${instrumentLabel(a.target.instrument)}`), subtitle: a.fraction < 1 ? `${Math.round(a.fraction * 100)}%` : "100%" });
        break;
      case "notify":
        nodes.push({ id: a.id, kind: "action", side: "notify", title: a.label ?? "Notify", subtitle: a.channel });
        break;
      case "liquidity": {
        const r = "lowerPct" in a.range ? describePctRange(a.range).replace(/^from /, "").replace(/ the price$/, "") : `${a.range.lower} to ${a.range.upper}`;
        nodes.push({ id: a.id, kind: "action", side: "long", title: a.label ?? `${a.pool.symbol} liquidity`, subtitle: `range ${r}` });
        break;
      }
      case "copy": {
        const who = a.leader.venue === "solana" ? a.leader.wallet : a.leader.trader;
        nodes.push({ id: a.id, kind: "action", side: "long", title: a.label ?? `Copy ${who.slice(0, 4)}…${who.slice(-4)}`, subtitle: a.leader.venue === "solana" ? "every token it buys" : "every position it opens" });
        break;
      }
    }
    a.on.forEach((tid) => edges.push([tid, a.id]));
  }
  return { nodes, edges };
}
