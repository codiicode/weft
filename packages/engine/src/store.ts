import type { EvalState, SignalSnapshot, TriggerResult } from "@weft/strategy";
import type { DeploymentRecord, EngineEvent, Fill, Position } from "./types.ts";

/**
 * Per-deployment runtime state: everything besides positions, fills and events
 * that a tick needs to resume exactly where it left off after a restart.
 */
export interface DeploymentRuntime {
  evalState: EvalState;
  cashUsd: number;
  /** Cumulative realized P&L net of all fees paid (entry fees included). */
  realizedPnlUsd: number;
  feesUsd: number;
  builderFeesUsd: number;
  /** Optional (additive): net perp funding paid, USD (positive = paid). Included in realizedPnlUsd. */
  fundingUsd?: number;
  /** UTC day (YYYY-MM-DD) the daily counters refer to. */
  day: string;
  dayStartEquityUsd: number;
  realizedTodayUsd: number;
  lastTickAt: number | null;
  triggers: TriggerResult[];
  signalValues: Record<string, number | boolean | null>;
  /** Last good snapshot per signal id: carried forward when a fetch fails (staleness still applies). */
  lastSnapshots: Record<string, SignalSnapshot>;
  lastEquitySampleAt?: number | null;
  /** Optional (additive): the most money that was in positions at once (margin), USD. Returns are on this. */
  peakInUseUsd?: number;
}

/**
 * Everything one tick (or a control action) changes, written atomically.
 * Paper execution has no external side effects, so a crash mid-tick simply
 * re-runs the tick from the last committed state; executed intent keys are
 * committed together with the fills they produced.
 */
export interface StoreBatch {
  deploymentId: string;
  deployment?: DeploymentRecord;
  runtime?: DeploymentRuntime;
  upsertPositions?: Position[];
  deletePositionIds?: string[];
  fills?: Fill[];
  events?: EngineEvent[];
  intentKeys?: { key: string; ts: number }[];
  equitySample?: [number, number];
}

export interface Store {
  /** Apply a batch atomically. */
  commit(batch: StoreBatch): Promise<void>;
  getDeployment(id: string): Promise<DeploymentRecord | null>;
  listDeployments(): Promise<DeploymentRecord[]>;
  getRuntime(id: string): Promise<DeploymentRuntime | null>;
  /** Open positions only (closed positions are deleted; their history lives in fills). */
  listPositions(id: string): Promise<Position[]>;
  listFills(id: string): Promise<Fill[]>;
  /** Ascending by time. `sinceTs` is exclusive; `limit` keeps the most recent N. */
  listEvents(id: string, opts?: { sinceTs?: number; limit?: number }): Promise<EngineEvent[]>;
  hasIntentKey(id: string, key: string): Promise<boolean>;
  listEquity(id: string): Promise<[number, number][]>;
  close?(): Promise<void>;
}

export interface StoreLimits {
  /** Max equity samples kept per deployment (oldest dropped). Default 2000. */
  maxEquitySamples?: number;
  /** Max events kept per deployment (oldest dropped). Default 10 000. */
  maxEvents?: number;
}

export const DEFAULT_LIMITS = { maxEquitySamples: 2_000, maxEvents: 10_000 } as const;

interface MemDeployment {
  record: DeploymentRecord;
  runtime: DeploymentRuntime | null;
  positions: Map<string, Position>;
  fills: Fill[];
  events: EngineEvent[];
  keys: Set<string>;
  equity: [number, number][];
}

/** In-memory store (tests, replays, ephemeral dev). Values are cloned in and out. */
export class MemoryStore implements Store {
  private readonly deps = new Map<string, MemDeployment>();
  private readonly limits: Required<StoreLimits>;

  constructor(limits: StoreLimits = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async commit(b: StoreBatch): Promise<void> {
    let d = this.deps.get(b.deploymentId);
    if (!d) {
      if (!b.deployment) throw new Error(`unknown deployment ${b.deploymentId}`);
      d = { record: clone(b.deployment), runtime: null, positions: new Map(), fills: [], events: [], keys: new Set(), equity: [] };
      this.deps.set(b.deploymentId, d);
    }
    if (b.deployment) d.record = clone(b.deployment);
    if (b.runtime) d.runtime = clone(b.runtime);
    for (const p of b.upsertPositions ?? []) d.positions.set(p.id, clone(p));
    for (const id of b.deletePositionIds ?? []) d.positions.delete(id);
    for (const f of b.fills ?? []) d.fills.push(clone(f));
    for (const e of b.events ?? []) d.events.push(clone(e));
    if (d.events.length > this.limits.maxEvents) d.events.splice(0, d.events.length - this.limits.maxEvents);
    for (const k of b.intentKeys ?? []) d.keys.add(k.key);
    if (b.equitySample) {
      d.equity.push([...b.equitySample]);
      if (d.equity.length > this.limits.maxEquitySamples) d.equity.splice(0, d.equity.length - this.limits.maxEquitySamples);
    }
  }

  async getDeployment(id: string) {
    const d = this.deps.get(id);
    return d ? clone(d.record) : null;
  }
  async listDeployments() {
    return [...this.deps.values()].map((d) => clone(d.record));
  }
  async getRuntime(id: string) {
    const r = this.deps.get(id)?.runtime;
    return r ? clone(r) : null;
  }
  async listPositions(id: string) {
    return [...(this.deps.get(id)?.positions.values() ?? [])].map(clone);
  }
  async listFills(id: string) {
    return (this.deps.get(id)?.fills ?? []).map(clone);
  }
  async listEvents(id: string, opts: { sinceTs?: number; limit?: number } = {}) {
    let ev = this.deps.get(id)?.events ?? [];
    if (opts.sinceTs != null) ev = ev.filter((e) => e.ts > opts.sinceTs!);
    if (opts.limit != null) ev = ev.slice(Math.max(0, ev.length - opts.limit));
    return ev.map(clone);
  }
  async hasIntentKey(id: string, key: string) {
    return this.deps.get(id)?.keys.has(key) ?? false;
  }
  async listEquity(id: string) {
    return (this.deps.get(id)?.equity ?? []).map((s) => [...s] as [number, number]);
  }
}

function clone<T>(v: T): T {
  return structuredClone(v);
}
