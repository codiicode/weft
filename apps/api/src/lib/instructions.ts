import type { ExitsPatch, Position } from "@weft/engine";
import type { Strategy } from "@weft/strategy";

/**
 * Plain instructions for a running strategy ("sell half", "stop at 15%", "take profit at 30%",
 * "remove the stop"), turned into concrete steps the owner reviews before anything happens.
 * Anything this parser doesn't understand goes to Claude as a rule change instead.
 */

export type Step =
  | { kind: "sell"; positionId: string; fraction: number; label: string }
  | { kind: "exits"; patch: ExitsPatch; positionIds: string[]; label: string }
  | { kind: "rules"; strategy: Strategy; label: string };

const sym = (p: Position) => p.instrumentKey.split(":").pop()!.replace(/^\$/, "");

function targets(text: string, positions: Position[]): Position[] {
  const named = positions.filter((p) => new RegExp(`(^|[^a-z0-9])\\$?${sym(p).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(text));
  return named.length ? named : positions;
}

function fractionOf(text: string): number | null {
  const t = text.toLowerCase();
  const pct = /(\d+(?:\.\d+)?)\s*%/.exec(t);
  if (pct && !/stop|profit|target|trail|\btp\b|\bsl\b/.test(t)) return Math.min(1, Number(pct[1]) / 100);
  if (/\bhalf\b/.test(t)) return 0.5;
  if (/\b(a\s+)?third\b/.test(t)) return 1 / 3;
  if (/\b(a\s+)?quarter\b/.test(t)) return 0.25;
  return null;
}

/** Steps for the instruction, or null when it needs Claude. Throws with a plain reason when it can't apply. */
export function parseInstruction(text: string, positions: Position[]): Step[] | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const pos = targets(t, positions);
  const names = (ps: Position[]) => [...new Set(ps.map(sym))].join(", ");

  // Conditions ("sell if…", "when…") are rules, not commands: Claude handles those.
  if (/\b(if|when|whenever|once|unless|until|after)\b/.test(t)) return null;
  const steps: Step[] = [];

  // Selling now: the clause from "sell" to the next "and"/comma decides how much.
  const sell = /\b(sell|close|exit|dump|cash out|get out)\b/.exec(t);
  if (sell) {
    if (!positions.length) throw new Error("There’s nothing open to sell yet.");
    const clause = t.slice(sell.index).split(/\s+and\s+|,|;/)[0]!;
    const f = /\b(all|everything|whole|entire|rest)\b/.test(clause) ? 1 : (fractionOf(clause) ?? 1);
    const which = targets(clause, positions);
    for (const p of which) steps.push({ kind: "sell", positionId: p.id, fraction: f, label: `Sell ${f >= 1 ? "all" : `${Math.round(f * 100)}%`} of ${sym(p)} at market, now` });
    // Selling everything makes stops moot; otherwise keep reading for exit changes.
    if (f >= 1 && which.length === positions.length) return steps;
  }

  const patch: ExitsPatch = {};
  const said: string[] = [];
  // A number with % is a move from entry; a bare number or $ is a price; "2x" is a multiple of entry.
  if (/\b(remove|delete|cancel|drop|no)\b[^.]*\bstop/.test(t) && !/trail/.test(t)) {
    patch.stopLoss = null;
    said.push("remove the stop");
  } else {
    const m = /(?<!trailing[- ])\bstop(?:[- ]?loss)?\b(?!\s*trail)\D*?(\$)?(\d+(?:\.\d+)?)\s*(%)?/.exec(t);
    if (m && !/trail(ing)?[- ]?stop/.test(t)) {
      const n = Number(m[2]);
      patch.stopLoss = m[3] ? { pct: n } : { price: n };
      said.push(m[3] ? `set a stop ${n}% below entry` : `set a stop at ${n}`);
    }
  }
  if (/\b(remove|delete|cancel|drop|no)\b[^.]*\b(take[- ]?profit|target|tp)\b/.test(t)) {
    patch.takeProfit = null;
    said.push("remove the take-profit");
  } else {
    const m = /\b(?:take[- ]?profit|target|tp)\b\D*?(\$)?(\d+(?:\.\d+)?)\s*(%|x)?/.exec(t);
    if (m) {
      const n = Number(m[2]);
      patch.takeProfit = m[3] === "x" ? { pct: (n - 1) * 100 } : m[3] === "%" ? { pct: n } : { price: n };
      said.push(m[3] === "x" ? `take profit at ${n}× entry` : m[3] === "%" ? `take profit ${n}% above entry` : `take profit at ${n}`);
    }
  }
  if (/\b(remove|delete|cancel|drop|no)\b[^.]*\btrail/.test(t)) {
    patch.trailingStopPct = null;
    said.push("remove the trailing stop");
  } else {
    const m = /\btrail(?:ing)?(?:[- ]?stop)?\b[^0-9]*(\d+(?:\.\d+)?)\s*%/.exec(t);
    if (m) {
      patch.trailingStopPct = Number(m[1]);
      said.push(`trail the stop ${m[1]}% behind the best price`);
    }
  }
  if (!said.length) return steps.length ? steps : null;
  const label = `${said.join(", ").replace(/^./, (c) => c.toUpperCase())}${pos.length ? ` on ${names(pos)}` : ""}, and on future buys`;
  return [...steps, { kind: "exits", patch, positionIds: pos.map((p) => p.id), label }];
}

/** The strategy with an exits patch applied to its open actions (so future entries get it too). */
export function withExits(s: Strategy, patch: ExitsPatch): Strategy {
  return {
    ...s,
    actions: s.actions.map((a) => {
      if (a.type !== "open") return a;
      const exits: Record<string, unknown> = { ...a.exits };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (v === null) delete exits[k];
        else exits[k] = v;
      }
      return { ...a, exits: exits as typeof a.exits };
    }),
  };
}
