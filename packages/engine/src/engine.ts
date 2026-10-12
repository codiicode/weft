import { randomUUID } from "node:crypto";
import { initialState, RiskCaps, validateStrategy, type Instrument } from "@weft/strategy";
import type { MarketData, SignalProvider, TokenFactsProvider } from "@weft/venues";
import type {
  CreateDeploymentInput,
  DeploymentRecord,
  DeploymentSnapshot,
  DeploymentStatus,
  Engine,
  EngineEvent,
  EngineEventType,
  Fill,
} from "./types.ts";
import type { DeploymentRuntime, Store } from "./store.ts";
import { errMsg, PaperExecutor, type Executor } from "./executor.ts";
import { resolveFees, type FeeOverrides } from "./fees.ts";
import { marginOf, unrealizedOf } from "./positions.ts";
import { fmtUsd, runTick, Session, type TickDeps } from "./tick.ts";

export type Clock = (() => number) | { now(): number };

export interface Logger {
  debug?(msg: string, data?: unknown): void;
  info?(msg: string, data?: unknown): void;
  warn?(msg: string, data?: unknown): void;
  error?(msg: string, data?: unknown): void;
}

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Default instruments used to price quote assets for risk checks. */
export const DEFAULT_USD_PRICE_INSTRUMENTS: Record<string, Instrument> = {
  SOL: { kind: "perp", venue: "hyperliquid", symbol: "SOL", assetClass: "crypto" },
  USDC: { kind: "token", chain: "solana", mint: USDC_MINT, symbol: "USDC", quote: "USDC", route: "auto", assetClass: "crypto" },
};

export interface EngineOptions {
  store: Store;
  marketData: MarketData;
  signalProviders: SignalProvider[];
  tokenFacts?: TokenFactsProvider;
  /** ms since epoch. Default `Date.now`. */
  clock?: Clock;
  fees?: FeeOverrides;
  logger?: Logger;
  /** Order executor. Default: PaperExecutor over `marketData` with `fees`. */
  executor?: Executor;
  /**
   * Simulate perp funding payments (via `MarketData.getFundingRate`, if implemented)
   * and liquidations at an estimated liquidation price. Default: true when the
   * executor is a paper executor, false for live executors (the venue does both).
   */
  perpRealism?: boolean;
  /** Paper slippage model overrides, bps from mid per instrument kind. */
  slippageBps?: Partial<Record<Instrument["kind"], number>>;
  /** Per signal fetch. Default 10 s. */
  signalTimeoutMs?: number;
  /** Per quote. Default 10 s. */
  quoteTimeoutMs?: number;
  /** Default tick interval for new deployments. Default 30 s. */
  defaultIntervalSec?: number;
  /** How often the scheduler looks for due deployments. Default 1000 ms. */
  schedulerResolutionMs?: number;
  usdPriceInstruments?: Record<string, Instrument>;
  /** Same warning (per deployment + key) at most this often. Default 15 min. */
  warningIntervalMs?: number;
  /** `tick` events at most this often per deployment. Default 60 s. */
  tickEventIntervalMs?: number;
  /** Equity curve sampling (always sampled on fills). Default 5 min. */
  equitySampleIntervalMs?: number;
  newId?: () => string;
}

/** The engine plus a few extras used by tooling and tests. */
export interface EngineRuntime extends Engine {
  readonly store: Store;
  readonly executor: Executor;
}

export function createEngine(opts: EngineOptions): EngineRuntime {
  const { store, marketData } = opts;
  const clockFn = opts.clock ?? Date.now;
  const now = () => (typeof clockFn === "function" ? clockFn() : clockFn.now());
  const log = opts.logger ?? {};
  const newId = opts.newId ?? randomUUID;
  const executor = opts.executor ?? new PaperExecutor({ marketData, fees: opts.fees, slippageBps: opts.slippageBps, quoteTimeoutMs: opts.quoteTimeoutMs });

  const providers = new Map<string, SignalProvider>();
  for (const p of opts.signalProviders) for (const k of p.kinds) if (!providers.has(k)) providers.set(k, p);

  const lastEmit = new Map<string, number>();
  const deps: TickDeps = {
    marketData,
    providers,
    tokenFacts: opts.tokenFacts,
    executor,
    fees: resolveFees(opts.fees),
    perpRealism: opts.perpRealism ?? executor.mode === "paper",
    signalTimeoutMs: opts.signalTimeoutMs ?? 10_000,
    quoteTimeoutMs: opts.quoteTimeoutMs ?? 10_000,
    usdPriceInstruments: opts.usdPriceInstruments ?? DEFAULT_USD_PRICE_INSTRUMENTS,
    newId,
    allow(key, t, gap) {
      const last = lastEmit.get(key);
      if (last != null && t - last < gap && t >= last) return false;
      lastEmit.set(key, t);
      return true;
    },
    hasIntentKey: (id, key) => store.hasIntentKey(id, key),
    warningIntervalMs: opts.warningIntervalMs ?? 15 * 60_000,
    tickEventIntervalMs: opts.tickEventIntervalMs ?? 60_000,
    equitySampleIntervalMs: opts.equitySampleIntervalMs ?? 5 * 60_000,
  };

  /* ---- event bus ---- */
  const listeners = new Set<(e: EngineEvent) => void>();
  const publish = (events: EngineEvent[]) => {
    for (const e of events) {
      for (const l of listeners) {
        try {
          l(e);
        } catch (err) {
          log.error?.("event listener threw", err);
        }
      }
      if (e.type === "error") log.error?.(e.message, e.data);
      else if (e.type === "warning") log.warn?.(e.message, e.data);
      else log.debug?.(e.message, e.data);
    }
  };
  const event = (deploymentId: string, type: EngineEventType, message: string, data?: Record<string, unknown>, ts = now()): EngineEvent => ({
    id: newId(),
    deploymentId,
    ts,
    type,
    message,
    ...(data ? { data } : {}),
  });

  /* ---- per-deployment serialization ---- */
  const locks = new Map<string, Promise<unknown>>();
  function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    locks.set(id, tail);
    void tail.then(() => {
      if (locks.get(id) === tail) locks.delete(id);
    });
    return run;
  }

  async function load(id: string) {
    const d = await store.getDeployment(id);
    if (!d) throw new Error(`unknown deployment ${id}`);
    const rt = (await store.getRuntime(id)) ?? initialRuntime(d, d.createdAt);
    return { d, rt };
  }

  async function doTick(id: string, t: number): Promise<void> {
    const { d, rt } = await load(id);
    if (d.status !== "running") return;
    const s = new Session(d, rt, await store.listPositions(id), deps, t);
    try {
      await runTick(s);
    } catch (e) {
      // Nothing from a failed tick is committed (paper fills have no side effects); record the error.
      const ev = event(id, "error", `Tick failed: ${errMsg(e)}`, undefined, t);
      await store.commit({ deploymentId: id, events: [ev] });
      publish([ev]);
      throw e;
    }
    await store.commit(s.toBatch());
    publish(s.events);
  }

  async function setStatus(id: string, to: DeploymentStatus, allowedFrom: DeploymentStatus[]) {
    return withLock(id, async () => {
      const d = await store.getDeployment(id);
      if (!d) throw new Error(`unknown deployment ${id}`);
      if (d.status === to) return;
      if (!allowedFrom.includes(d.status)) throw new Error(`cannot go from ${d.status} to ${to}`);
      const t = now();
      const next: DeploymentRecord = { ...d, status: to, updatedAt: t };
      const ev = event(id, "status", `Deployment ${to}`, { from: d.status, to }, t);
      await store.commit({ deploymentId: id, deployment: next, events: [ev] });
      publish([ev]);
    });
  }

  /* ---- scheduler ---- */
  let timer: ReturnType<typeof setInterval> | null = null;
  let scanning: Promise<void> | null = null;
  const inFlight = new Map<string, Promise<void>>();
  const lastRun = new Map<string, number>();

  async function scan(): Promise<void> {
    let list: DeploymentRecord[];
    try {
      list = await store.listDeployments();
    } catch (e) {
      log.error?.("scheduler: listDeployments failed", e);
      return;
    }
    const t = now();
    for (const d of list) {
      if (d.status !== "running" || inFlight.has(d.id)) continue;
      let last = lastRun.get(d.id);
      if (last == null) {
        last = (await store.getRuntime(d.id))?.lastTickAt ?? -Infinity;
        lastRun.set(d.id, last);
      }
      if (t - last < d.intervalSec * 1000) continue;
      lastRun.set(d.id, t);
      const p = withLock(d.id, () => doTick(d.id, t))
        .catch((e) => log.error?.(`tick ${d.id} failed`, e))
        .finally(() => inFlight.delete(d.id));
      inFlight.set(d.id, p);
    }
  }

  const engine: EngineRuntime = {
    store,
    executor,

    async createDeployment(input: CreateDeploymentInput): Promise<DeploymentRecord> {
      const v = validateStrategy(input.strategy);
      if (!v.ok) throw new Error(`invalid strategy: ${v.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
      // An engine runs one kind of money: its executor decides. Paper engines never take live deployments.
      const mode = input.mode ?? executor.mode;
      if (mode !== executor.mode) throw new Error(`this engine runs ${executor.mode} deployments, not ${mode}`);
      if (!(input.allocationUsd > 0) || !Number.isFinite(input.allocationUsd)) throw new Error("allocationUsd must be a positive number");
      const caps = RiskCaps.parse(input.caps ?? {});
      const t = now();
      const d: DeploymentRecord = {
        id: newId(),
        strategy: v.strategy,
        mode,
        allocationUsd: input.allocationUsd,
        caps,
        status: "running",
        intervalSec: input.intervalSec ?? opts.defaultIntervalSec ?? 30,
        createdAt: t,
        updatedAt: t,
      };
      const ev = event(d.id, "status", `Deployed "${d.strategy.name}" ${mode === "live" ? "LIVE" : "on paper"} with ${fmtUsd(d.allocationUsd)}`, { to: "running" }, t);
      await store.commit({
        deploymentId: d.id,
        deployment: d,
        runtime: { ...initialRuntime(d, t), lastEquitySampleAt: t },
        events: [ev],
        equitySample: [t, d.allocationUsd],
      });
      publish([ev]);
      return d;
    },

    listDeployments: () => store.listDeployments(),

    async getSnapshot(id: string): Promise<DeploymentSnapshot | null> {
      const d = await store.getDeployment(id);
      if (!d) return null;
      const rt = (await store.getRuntime(id)) ?? initialRuntime(d, d.createdAt);
      const positions = await store.listPositions(id);
      const unrealized = unrealizedOf(positions);
      const equity = rt.cashUsd + marginOf(positions) + unrealized;
      return {
        deployment: d,
        equityUsd: equity,
        cashUsd: rt.cashUsd,
        realizedPnlUsd: rt.realizedPnlUsd,
        unrealizedPnlUsd: unrealized,
        returnPct: ((equity - d.allocationUsd) / d.allocationUsd) * 100,
        positions,
        triggers: rt.triggers,
        signalValues: rt.signalValues,
        lastTickAt: rt.lastTickAt,
        equityCurve: await store.listEquity(id),
        feesUsd: rt.feesUsd,
        builderFeesUsd: rt.builderFeesUsd,
        fundingUsd: rt.fundingUsd ?? 0,
      };
    },

    getEvents: (id, o) => store.listEvents(id, { limit: 200, ...o }),
    getFills: (id): Promise<Fill[]> => store.listFills(id),

    pause: (id) => setStatus(id, "paused", ["running"]),
    resume: (id) => setStatus(id, "running", ["paused"]),
    stop: (id) => setStatus(id, "stopped", ["running", "paused"]),

    kill(id: string): Promise<void> {
      return withLock(id, async () => {
        const { d, rt } = await load(id);
        if (d.status === "killed") return;
        const t = now();
        const s = new Session(d, rt, await store.listPositions(id), deps, t);
        for (const p of s.open()) await s.closePosition(p, 1, "kill", `${p.id}:kill`);
        const next: DeploymentRecord = { ...d, status: "killed", updatedAt: t };
        s.emit("status", `Kill switch: closed all positions, deployment killed`, { from: d.status, to: "killed", remaining: s.positions.size });
        await store.commit(s.toBatch({ deployment: next }));
        publish(s.events);
      });
    },

    tick(id: string, at?: number): Promise<void> {
      const t = at ?? now();
      return withLock(id, async () => {
        lastRun.set(id, t);
        await doTick(id, t);
      });
    },

    start(): void {
      if (timer) return;
      const run = () => {
        if (scanning) return;
        scanning = scan().finally(() => (scanning = null));
      };
      timer = setInterval(run, opts.schedulerResolutionMs ?? 1_000);
      run();
    },

    async shutdown(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = null;
      if (scanning) await scanning;
      await Promise.allSettled([...inFlight.values(), ...locks.values()]);
    },

    subscribe(listener: (e: EngineEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return engine;
}

function initialRuntime(d: DeploymentRecord, t: number): DeploymentRuntime {
  return {
    evalState: initialState(d.strategy),
    cashUsd: d.allocationUsd,
    realizedPnlUsd: 0,
    feesUsd: 0,
    builderFeesUsd: 0,
    day: new Date(t).toISOString().slice(0, 10),
    dayStartEquityUsd: d.allocationUsd,
    realizedTodayUsd: 0,
    lastTickAt: null,
    triggers: [],
    signalValues: {},
    lastSnapshots: {},
    lastEquitySampleAt: null,
  };
}
