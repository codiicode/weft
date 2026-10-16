import { validateStrategy, type Strategy } from "@weft/strategy";
import type { GenerateResult } from "./generate.ts";

/**
 * Offline fallback for "change my strategy" requests: handles the common
 * numeric edits (stop, target, trailing stop, size, leverage, time exit)
 * without a model. Anything else needs Claude.
 */

const num = (s: string) => Number(s.replace(/,/g, ""));

/** A relative stop scaled (tighter < 1 < wider); absolute price levels are left as they are. */
function scaleLevel<L extends { pct: number } | { positionPct: number } | { price: number } | { prob: number }>(l: L, f: number): L {
  if ("pct" in l) return { pct: Math.max(0.5, +(l.pct * f).toFixed(2)) } as L;
  if ("positionPct" in l) return { positionPct: Math.max(0.5, +(l.positionPct * f).toFixed(2)) } as L;
  return l;
}

export function refineByRules(base: Strategy, instruction: string): GenerateResult {
  const t = instruction.toLowerCase();
  const s = structuredClone(base) as Strategy;
  const changes: string[] = [];
  const opens = s.actions.filter((a) => a.type === "open");
  const withExits = s.actions.filter((a) => a.type === "open" || a.type === "options");

  const stop = t.match(/(?:stop(?:[- ]?loss)?|\bsl\b)[^\d%]{0,14}(\d+(?:\.\d+)?)\s*%/);
  if (stop) {
    for (const a of withExits) if (!(a.type === "open" && a.instrument.kind === "outcome")) a.exits.stopLoss = { positionPct: num(stop[1]!) };
    changes.push(`stop-loss set to ${stop[1]}%`);
  } else if (/\b(?:tight(?:er|en)?|closer)\b.*\bstops?\b|\bstops?\b.*\b(?:tight(?:er|en)?|closer)\b/.test(t)) {
    for (const a of withExits) if (a.exits.stopLoss) a.exits.stopLoss = scaleLevel(a.exits.stopLoss, 0.5);
    changes.push("stops tightened to half their distance");
  } else if (/\b(?:wid(?:e|er|en)|loos(?:e|er|en))\b.*\bstops?\b|\bstops?\b.*\b(?:wid(?:e|er|en)|loos(?:e|er|en))\b/.test(t)) {
    for (const a of withExits) if (a.exits.stopLoss) a.exits.stopLoss = scaleLevel(a.exits.stopLoss, 1.5);
    changes.push("stops widened by half");
  }

  const tp = t.match(/(?:take[- ]?profit|target|\btp\b)[^\d%]{0,14}(\d+(?:\.\d+)?)\s*%/);
  if (tp) {
    for (const a of withExits) if (!(a.type === "open" && a.instrument.kind === "outcome")) a.exits.takeProfit = { positionPct: num(tp[1]!) };
    changes.push(`take-profit set to ${tp[1]}%`);
  }

  const trail = t.match(/trail(?:ing)?(?: stop)?[^\d%]{0,10}(\d+(?:\.\d+)?)\s*%/);
  if (trail) {
    for (const a of withExits) a.exits.trailingStopPct = num(trail[1]!);
    changes.push(`trailing stop ${trail[1]}%`);
  }

  const time = t.match(/(?:exit|close|sell|out)[^\d]{0,16}(\d+(?:\.\d+)?)\s*(day|days|d|hour|hours|h)\b/);
  if (time) {
    const hours = num(time[1]!) * (time[2]!.startsWith("d") ? 24 : 1);
    for (const a of withExits) a.exits.timeExitHours = hours;
    changes.push(`exit after ${time[1]} ${time[2]!.startsWith("d") ? "days" : "hours"}`);
  }

  const native = t.match(/(\d+(?:\.\d+)?)\s*(sol|usdc)\b/);
  const usd = t.match(/\$\s?(\d[\d,]*(?:\.\d+)?)/);
  const pct = t.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of (?:the |my )?(?:account|equity|portfolio)|equity)/);
  if (native) {
    let n = 0;
    for (const a of opens) if (a.instrument.kind === "token") (a.size = { unit: "native", value: num(native[1]!) }), n++;
    if (n) changes.push(`size set to ${native[1]} ${native[2]!.toUpperCase()}`);
  } else if (usd) {
    for (const a of opens) a.size = { unit: "usd", value: num(usd[1]!) };
    if (opens.length) changes.push(`size set to $${usd[1]}`);
  } else if (pct) {
    for (const a of opens) a.size = { unit: "pct_equity", value: num(pct[1]!) };
    if (opens.length) changes.push(`size set to ${pct[1]}% of the account`);
  }

  const lev = t.match(/(\d+(?:\.\d+)?)\s*(?:x|×)\b(?:\s*leverage)?|leverage(?: of| to)?\s*(\d+(?:\.\d+)?)/);
  const noLev = /no leverage|without leverage|unleveraged/.test(t);
  if (lev || noLev) {
    const v = noLev ? 1 : num(lev![1] ?? lev![2]!);
    let n = 0;
    for (const a of opens) if (a.instrument.kind === "perp") (a.leverage = v), n++;
    if (n) {
      if (v > s.risk.maxLeverage) s.risk.maxLeverage = v;
      changes.push(noLev ? "leverage removed" : `leverage set to ${v}×`);
    }
  }

  if (!changes.length) {
    throw new Error("That change needs Claude. Without it I can only adjust numbers, like “stop at 5%”, “take profit at 20%”, “use 2 SOL” or “3x leverage”.");
  }
  const v = validateStrategy(s);
  if (!v.ok) throw new Error(`That change makes the strategy invalid: ${v.errors.map((e) => e.message).join("; ")}`);
  const text = changes.join(", ");
  return { strategy: v.strategy, warnings: v.warnings, rationale: `Changed: ${text}.`, source: "template", notes: [] };
}
