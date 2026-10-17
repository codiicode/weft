import type { z } from "zod";
import { Strategy, type StrategyInput } from "./strategy.ts";
import { fieldType, SIGNAL_KINDS, type SignalKind } from "./signals.ts";
import { exprRefs } from "./expr.ts";
import { instrumentKey, isLongOnly, type Instrument } from "./instruments.ts";
import type { Level, OptionLeg } from "./actions.ts";

export interface Issue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; strategy: Strategy; warnings: Issue[] }
  | { ok: false; errors: Issue[]; warnings: Issue[] };

const pathOf = (p: PropertyKey[]) =>
  p.reduce<string>((s, k) => (typeof k === "number" ? `${s}[${k}]` : s ? `${s}.${String(k)}` : String(k)), "");

/**
 * Parse + semantic checks. Use this on anything an LLM or a user produced.
 * Errors block saving/deploying; warnings are shown to the author.
 */
export function validateStrategy(input: unknown): ValidationResult {
  const parsed = Strategy.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: zodIssues(parsed.error), warnings: [] };
  }
  const s = fitRiskToActions(parsed.data);
  const issues = semanticIssues(s);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return errors.length ? { ok: false, errors, warnings } : { ok: true, strategy: s, warnings };
}

/**
 * The exposure cap never blocks what the strategy itself asks for: "5% of the account at 20×" is
 * 100% exposure, so the cap (default 50%) rises to fit its largest single order (up to 5,000%: the whole budget at 50×). It still binds
 * when several orders add up. (Leverage and position size are checked below as errors instead.)
 */
export function fitRiskToActions(s: Strategy): Strategy {
  let exp = s.risk.maxTotalExposurePct;
  for (const a of s.actions) {
    if (a.type !== "open" || a.size.unit !== "pct_equity") continue;
    exp = Math.max(exp, a.size.value * (a.instrument.kind === "perp" ? a.leverage : 1));
  }
  exp = Math.min(5000, exp);
  return exp === s.risk.maxTotalExposurePct ? s : { ...s, risk: { ...s.risk, maxTotalExposurePct: exp } };
}

/** Throwing variant for trusted fixtures and tests. */
export function defineStrategy(input: StrategyInput): Strategy {
  const r = validateStrategy(input);
  if (!r.ok) throw new Error(`Invalid strategy:\n${r.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`);
  return r.strategy;
}

function zodIssues(err: z.ZodError): Issue[] {
  return err.issues.map((i) => ({ severity: "error", path: pathOf(i.path), message: i.message }));
}

export function semanticIssues(s: Strategy): Issue[] {
  const out: Issue[] = [];
  const err = (path: string, message: string) => out.push({ severity: "error", path, message });
  const warn = (path: string, message: string) => out.push({ severity: "warning", path, message });

  // ---- unique ids across the whole graph (they are graph node ids) ----
  const seen = new Map<string, string>();
  const claim = (id: string, path: string) => {
    const prev = seen.get(id);
    if (prev) err(path, `duplicate id "${id}" (already used at ${prev})`);
    else seen.set(id, path);
  };
  s.signals.forEach((x, i) => claim(x.id, `signals[${i}].id`));
  s.triggers.forEach((x, i) => claim(x.id, `triggers[${i}].id`));
  s.actions.forEach((x, i) => claim(x.id, `actions[${i}].id`));

  const signals = new Map(s.signals.map((x) => [x.id, x]));
  const triggerIds = new Set(s.triggers.map((t) => t.id));
  const usedSignals = new Set<string>();
  const usedTriggers = new Set<string>();

  // ---- trigger refs resolve to real signal fields of the right type ----
  s.triggers.forEach((t, ti) => {
    for (const { ref, as } of exprRefs(t.when)) {
      const [sid, field] = ref.split(".") as [string, string];
      const sig = signals.get(sid);
      const path = `triggers[${ti}].when`;
      if (!sig) {
        err(path, `"${ref}": no signal with id "${sid}"`);
        continue;
      }
      usedSignals.add(sid);
      const ft = fieldType(sig.kind as SignalKind, field);
      if (!ft) {
        const known = Object.keys(SIGNAL_KINDS[sig.kind as SignalKind].fields).join(", ");
        err(path, `"${ref}": ${sig.kind} signals have no field "${field}" (fields: ${known})`);
      } else if (ft !== as) {
        err(path, `"${ref}" is a ${ft} field but is used as a ${as}`);
      }
    }
  });

  // ---- actions ----
  const opened = new Set<string>();
  for (const a of s.actions) {
    if (a.type === "open") opened.add(instrumentKey(a.instrument));
    if (a.type === "options") a.legs.forEach((l) => opened.add(instrumentKey(l.instrument)));
  }
  s.actions.forEach((a, ai) => {
    const p = `actions[${ai}]`;
    a.on.forEach((tid, k) => {
      if (!triggerIds.has(tid)) err(`${p}.on[${k}]`, `no trigger with id "${tid}"`);
      usedTriggers.add(tid);
    });

    if (a.type === "open") {
      const inst = a.instrument;
      if (isLongOnly(inst) && a.side === "short") err(`${p}.side`, `${inst.kind} instruments can only be bought (long)`);
      if (inst.kind !== "perp" && a.leverage > 1) err(`${p}.leverage`, `leverage only applies to perps`);
      if (a.leverage > s.risk.maxLeverage) err(`${p}.leverage`, `leverage ${a.leverage}× exceeds the strategy max of ${s.risk.maxLeverage}×`);
      if (a.size.unit === "pct_equity" && a.size.value > s.risk.maxPositionPct)
        err(`${p}.size`, `${a.size.value}% exceeds maxPositionPct (${s.risk.maxPositionPct}%)`);
      if (a.order.type === "limit" && a.order.limitPrice == null) err(`${p}.order.limitPrice`, "limit orders need a limitPrice");

      // Bounded-loss positions (buying outcome shares) may skip the stop; everything else needs one.
      const boundedLoss = inst.kind === "outcome";
      if (s.risk.requireStopLoss && !a.exits.stopLoss && !boundedLoss)
        err(`${p}.exits.stopLoss`, "a stop-loss is required on every position (risk.requireStopLoss)");
      checkLevel(inst, a.exits.takeProfit, `${p}.exits.takeProfit`, err);
      checkLevel(inst, a.exits.stopLoss, `${p}.exits.stopLoss`, err);
      if (a.leverage > 1 && a.exits.stopLoss && "positionPct" in a.exits.stopLoss && a.exits.stopLoss.positionPct >= 90)
        warn(`${p}.exits.stopLoss`, `a ${a.exits.stopLoss.positionPct}% stop on a ${a.leverage}× position sits at or past liquidation, so it may never fire`);
      if (a.leverage > 1 && a.exits.stopLoss && "pct" in a.exits.stopLoss && a.exits.stopLoss.pct * a.leverage >= 90)
        warn(`${p}.exits.stopLoss`, `a ${a.exits.stopLoss.pct}% price stop at ${a.leverage}× sits at or past liquidation, so it may never fire`);
      if (inst.kind === "token" && a.exits.stopLoss)
        warn(`${p}.exits.stopLoss`, "AMM tokens have no native stop orders; the agent sells at market when hit and may fill worse in thin liquidity");
      if (inst.kind === "token" && !a.order.maxPriceImpactBps)
        warn(`${p}.order`, `no maxPriceImpactBps; the policy default (${s.risk.token.maxPriceImpactBps} bps) will be used`);
    }

    if (a.type === "options") {
      const naked = nakedLegs(a.legs);
      naked.forEach((msg) => err(`${p}.legs`, msg));
      const venues = new Set(a.legs.map((l) => l.instrument.venue));
      if (venues.size > 1) err(`${p}.legs`, "all legs must trade on the same venue");
    }

    if (a.type === "copy") {
      if (a.leverage != null && a.leverage > s.risk.maxLeverage) err(`${p}.leverage`, `leverage ${a.leverage}× exceeds the strategy max of ${s.risk.maxLeverage}×`);
      if (a.leader.venue === "solana" && a.leverage != null && a.leverage > 1) err(`${p}.leverage`, "leverage only applies to Hyperliquid copies");
    }

    if (a.type === "close" && a.target !== "all") {
      if (!opened.has(instrumentKey(a.target.instrument)))
        warn(`${p}.target`, "closes an instrument this strategy never opens");
    }
  });

  // Only a pure copy strategy may run without signals and triggers.
  const onlyCopies = s.actions.every((a) => a.type === "copy");
  if (!onlyCopies && !s.signals.length) err("signals", "add at least one signal");
  if (!onlyCopies && !s.triggers.length) err("triggers", "add at least one trigger");

  // ---- graph hygiene ----
  s.signals.forEach((x, i) => !usedSignals.has(x.id) && warn(`signals[${i}]`, `signal "${x.id}" is not used by any trigger`));
  s.triggers.forEach((x, i) => !usedTriggers.has(x.id) && warn(`triggers[${i}]`, `trigger "${x.id}" does not drive any action`));
  if (!s.actions.some((a) => a.type === "close") && s.actions.some((a) => a.type === "open" || a.type === "options"))
    warn("actions", "no close action: positions only exit via their own TP/SL/time exits");
  s.signals.forEach((x, i) => {
    if (x.kind === "calendar" && x.params.event === "custom" && !x.params.at) err(`signals[${i}].params.at`, "custom calendar events need `at`");
  });

  return out;
}

function checkLevel(inst: Instrument, level: Level | undefined, path: string, err: (p: string, m: string) => void) {
  if (!level) return;
  if ("prob" in level && inst.kind !== "outcome") err(path, "prob levels only apply to prediction outcomes");
}

/**
 * Defined-risk check for multi-leg options: per underlying/right, every sold
 * contract must be covered by a bought one expiring no earlier.
 */
export function nakedLegs(legs: OptionLeg[]): string[] {
  const problems: string[] = [];
  const groups = new Map<string, OptionLeg[]>();
  for (const l of legs) {
    const k = `${l.instrument.underlying}:${l.instrument.right}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  for (const [k, g] of groups) {
    const sold = g.filter((l) => l.side === "sell");
    if (!sold.length) continue;
    const latestShortExpiry = sold.map((l) => l.instrument.expiry).sort().at(-1)!;
    const cover = g
      .filter((l) => l.side === "buy" && l.instrument.expiry >= latestShortExpiry)
      .reduce((n, l) => n + l.ratio, 0);
    const short = sold.reduce((n, l) => n + l.ratio, 0);
    if (cover < short) problems.push(`naked short ${k.replace(":", " ")}: ${short} sold vs ${cover} covering bought (must be defined-risk)`);
  }
  return problems;
}
