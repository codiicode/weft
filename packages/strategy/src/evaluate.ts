import type { Strategy, Trigger } from "./strategy.ts";
import type { Action, OpenAction, OptionsAction, OrderSpec, Exits, Size } from "./actions.ts";
import { DEFAULT_MAX_AGE, type SignalKind } from "./signals.ts";
import { evalExpr, type ExprContext, type Tri } from "./expr.ts";
import { instrumentKey, type TradableInstrument, type OptionInstrument } from "./instruments.ts";

/**
 * The evaluator is a pure function: (strategy, market snapshot, previous state)
 * → (trigger results, order intents, next state). It does no I/O and never
 * reads the clock; the runtime feeds it `now`. That makes it replayable for
 * backtests, paper trading and audits, and identical across all of them.
 */

/* ------------------------------------------------------------------ */
/* Inputs & state                                                       */
/* ------------------------------------------------------------------ */

export interface SignalSnapshot {
  /** When the provider observed these values (ms since epoch). */
  asOf: number;
  fields: Record<string, number | boolean | null | undefined>;
}

export interface OpenPosition {
  actionId: string;
  instrumentKey: string;
  sizeUsd: number;
}

export interface EvalInput {
  /** ms since epoch */
  now: number;
  signals: Record<string, SignalSnapshot | undefined>;
  equityUsd: number;
  positions?: OpenPosition[];
}

export interface TriggerState {
  met: boolean;
  /** When the condition last became continuously true (ms), for `forMinutes`. */
  trueSince: number | null;
  /** Re-arms when the condition stops being true; a fire disarms it. */
  armed: boolean;
  fires: number;
  lastFiredAt: number | null;
}

export interface EvalState {
  version: 1;
  triggers: Record<string, TriggerState>;
  actions: Record<string, { fires: number }>;
  /** Previous left−right differences for crosses_above/below, keyed by trigger and expression path. */
  prev: Record<string, number>;
}

export function initialState(s: Strategy): EvalState {
  return {
    version: 1,
    triggers: Object.fromEntries(
      s.triggers.map((t) => [t.id, { met: false, trueSince: null, armed: true, fires: 0, lastFiredAt: null }])
    ),
    actions: Object.fromEntries(s.actions.map((a) => [a.id, { fires: 0 }])),
    prev: {},
  };
}

/* ------------------------------------------------------------------ */
/* Outputs                                                              */
/* ------------------------------------------------------------------ */

export interface TriggerResult {
  id: string;
  /** Raw condition value this tick: true, false, or null (unknown: missing/stale data). */
  value: Tri;
  met: boolean;
  fired: boolean;
  /** Refs that were missing or stale. */
  unknown: string[];
  /** Why it did not fire despite being met. */
  held?: "cooldown" | "max_fires" | "already_fired";
}

/** `fixed`: the user gave the amount ("$50", "0.05 SOL"), so percentage caps don't apply to it. */
export type ResolvedSize = ({ usd: number; native?: undefined } | { native: number; usd?: undefined }) & { fixed?: boolean };

interface IntentBase {
  /** Deterministic idempotency key: the runtime must never execute the same key twice. */
  key: string;
  strategyId: string;
  actionId: string;
  triggerId: string;
}

export interface OpenIntent extends IntentBase {
  type: "open";
  instrument: TradableInstrument;
  instrumentKey: string;
  side: "long" | "short";
  size: ResolvedSize;
  leverage: number;
  order: OrderSpec;
  exits: Exits;
}

export interface OptionsIntent extends IntentBase {
  type: "options";
  legs: { instrument: OptionInstrument; instrumentKey: string; side: "buy" | "sell"; ratio: number }[];
  size: ResolvedSize;
  order: OrderSpec;
  exits: Exits;
}

export interface CloseIntent extends IntentBase {
  type: "close";
  /** "all" or an instrumentKey */
  target: string;
  fraction: number;
}

export interface NotifyIntent extends IntentBase {
  type: "notify";
  channel: "push" | "telegram" | "email";
  message: string;
}

export type Intent = OpenIntent | OptionsIntent | CloseIntent | NotifyIntent;

export interface EvalResult {
  state: EvalState;
  triggers: TriggerResult[];
  intents: Intent[];
}

/* ------------------------------------------------------------------ */
/* Evaluate                                                             */
/* ------------------------------------------------------------------ */

export function evaluate(s: Strategy, input: EvalInput, prevState: EvalState = initialState(s)): EvalResult {
  const state: EvalState = structuredClone(prevState);
  // Strategies can be edited between ticks: make sure every node has state.
  const fresh = initialState(s);
  for (const id of Object.keys(fresh.triggers)) state.triggers[id] ??= fresh.triggers[id]!;
  for (const id of Object.keys(fresh.actions)) state.actions[id] ??= fresh.actions[id]!;

  const lookup = makeLookup(s, input);
  const nextPrev: Record<string, number> = {};
  const results: TriggerResult[] = [];
  const firedTriggers: string[] = [];

  for (const t of s.triggers) {
    const ctx: ExprContext = {
      lookup,
      prev: scoped(state.prev, t.id),
      next: {},
      unknown: new Set(),
    };
    const value = evalExpr(t.when, ctx);
    for (const [k, v] of Object.entries(ctx.next)) nextPrev[`${t.id}:${k}`] = v;

    const ts = state.triggers[t.id]!;
    const r = stepTrigger(t, ts, value, input.now);
    results.push({ id: t.id, value, met: ts.met, fired: r.fired, unknown: [...ctx.unknown], held: r.held });
    if (r.fired) firedTriggers.push(t.id);
  }
  state.prev = nextPrev;

  const intents = buildIntents(s, input, state, firedTriggers);
  return { state, triggers: results, intents };
}

function stepTrigger(t: Trigger, ts: TriggerState, value: Tri, now: number): { fired: boolean; held?: TriggerResult["held"] } {
  if (value !== true) {
    ts.met = false;
    ts.trueSince = null;
    ts.armed = true;
    return { fired: false };
  }
  ts.trueSince ??= now;
  const heldMin = (now - ts.trueSince) / 60_000;
  ts.met = heldMin >= (t.forMinutes ?? 0);
  if (!ts.met) return { fired: false };
  if (!ts.armed) return { fired: false, held: "already_fired" };
  if (t.maxFires != null && ts.fires >= t.maxFires) return { fired: false, held: "max_fires" };
  if (ts.lastFiredAt != null && now - ts.lastFiredAt < t.cooldownMinutes * 60_000) return { fired: false, held: "cooldown" };
  ts.armed = false;
  ts.fires += 1;
  ts.lastFiredAt = now;
  return { fired: true };
}

function makeLookup(s: Strategy, input: EvalInput) {
  const signals = new Map(s.signals.map((x) => [x.id, x]));
  return (ref: string): number | boolean | null => {
    const [sid, field] = ref.split(".") as [string, string];
    const sig = signals.get(sid);
    const snap = input.signals[sid];
    if (!sig || !snap) return null;
    const maxAge = (sig.maxAgeSeconds ?? DEFAULT_MAX_AGE[sig.kind as SignalKind]) * 1000;
    if (input.now - snap.asOf > maxAge) return null; // stale counts as unknown
    const v = snap.fields[field];
    return v === undefined ? null : v;
  };
}

function scoped(prev: Record<string, number>, triggerId: string): Record<string, number> {
  const p = `${triggerId}:`;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(prev)) if (k.startsWith(p)) out[k.slice(p.length)] = v;
  return out;
}

export function resolveSize(size: Size, equityUsd: number): ResolvedSize {
  switch (size.unit) {
    case "pct_equity":
      return { usd: (equityUsd * size.value) / 100 };
    case "usd":
      return { usd: size.value, fixed: true };
    case "native":
      return { native: size.value, fixed: true };
  }
}

function buildIntents(s: Strategy, input: EvalInput, state: EvalState, fired: string[]): Intent[] {
  if (!fired.length) return [];
  const firedSet = new Set(fired);
  const positions = input.positions ?? [];
  const intents: Intent[] = [];

  for (const a of s.actions) {
    const triggerId = a.on.find((id) => firedSet.has(id));
    if (!triggerId) continue;
    const as = state.actions[a.id]!;
    if (!eligible(a, as.fires, positions)) continue;
    as.fires += 1;
    const base: IntentBase = {
      key: `${s.id}:${a.id}:${triggerId}:${state.triggers[triggerId]!.fires}`,
      strategyId: s.id,
      actionId: a.id,
      triggerId,
    };
    intents.push(toIntent(a, base, input.equityUsd, s.risk.defaultMaxSlippageBps));
  }
  // Exits before entries, so a same-tick flip never stacks exposure.
  const rank = (i: Intent) => (i.type === "close" ? 0 : i.type === "notify" ? 2 : 1);
  return intents.sort((x, y) => rank(x) - rank(y));
}

function eligible(a: Action, fires: number, positions: OpenPosition[]): boolean {
  if (a.type !== "open" && a.type !== "options") return true;
  if (a.reentry === "never") return fires === 0;
  return !positions.some((p) => p.actionId === a.id);
}

function toIntent(a: Action, base: IntentBase, equityUsd: number, defaultSlippage: number): Intent {
  switch (a.type) {
    case "open":
      return openIntent(a, base, equityUsd, defaultSlippage);
    case "options":
      return optionsIntent(a, base, equityUsd, defaultSlippage);
    case "close":
      return { ...base, type: "close", target: a.target === "all" ? "all" : instrumentKey(a.target.instrument), fraction: a.fraction };
    case "notify":
      return { ...base, type: "notify", channel: a.channel, message: a.message };
  }
}

function openIntent(a: OpenAction, base: IntentBase, equityUsd: number, defaultSlippage: number): OpenIntent {
  return {
    ...base,
    type: "open",
    instrument: a.instrument,
    instrumentKey: instrumentKey(a.instrument),
    side: a.side,
    size: resolveSize(a.size, equityUsd),
    leverage: a.leverage,
    order: { ...a.order, maxSlippageBps: a.order.maxSlippageBps ?? defaultSlippage },
    exits: a.exits,
  };
}

function optionsIntent(a: OptionsAction, base: IntentBase, equityUsd: number, defaultSlippage: number): OptionsIntent {
  return {
    ...base,
    type: "options",
    legs: a.legs.map((l) => ({ instrument: l.instrument, instrumentKey: instrumentKey(l.instrument), side: l.side, ratio: l.ratio })),
    size: resolveSize(a.size, equityUsd),
    order: { ...a.order, maxSlippageBps: a.order.maxSlippageBps ?? defaultSlippage },
    exits: a.exits,
  };
}
