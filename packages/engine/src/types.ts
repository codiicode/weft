/**
 * CONTRACT: the engine's public surface, consumed by the API server and the web app.
 * Implementation details are free; these shapes are stable.
 */
import type { Deployment, Exits, Instrument, RiskCaps, Strategy, TriggerResult } from "@weft/strategy";

export type DeploymentStatus = "running" | "paused" | "stopped" | "killed";

export interface DeploymentRecord {
  id: string;
  strategy: Strategy;
  mode: Deployment["mode"];
  allocationUsd: number;
  caps: RiskCaps;
  status: DeploymentStatus;
  /** Seconds between ticks. */
  intervalSec: number;
  createdAt: number;
  updatedAt: number;
}

export interface Position {
  id: string;
  deploymentId: string;
  actionId: string;
  instrument: Instrument;
  instrumentKey: string;
  side: "long" | "short";
  /** Units of the instrument (contracts, tokens, shares). */
  qty: number;
  entryPrice: number;
  /** Margin / cost basis in USD. */
  sizeUsd: number;
  leverage: number;
  exits: Exits;
  openedAt: number;
  markPrice: number;
  markedAt: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  /** Best price seen since entry, for trailing stops. */
  peakPrice: number;
}

export type FillReason =
  | "entry"
  | "take_profit"
  | "stop_loss"
  | "trailing_stop"
  | "time_exit"
  | "close_action"
  | "kill"
  | "manual";

export interface Fill {
  id: string;
  deploymentId: string;
  positionId: string;
  intentKey?: string;
  instrumentKey: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  feeUsd: number;
  /** Realized P&L for closing fills. */
  realizedPnlUsd?: number;
  reason: FillReason;
  ts: number;
}

export type EngineEventType =
  | "status"
  | "tick"
  | "trigger_met"
  | "trigger_fired"
  | "intent"
  | "rejected"
  | "fill"
  | "notify"
  | "warning"
  | "error";

export interface EngineEvent {
  id: string;
  deploymentId: string;
  ts: number;
  type: EngineEventType;
  message: string;
  data?: Record<string, unknown>;
}

export interface DeploymentSnapshot {
  deployment: DeploymentRecord;
  equityUsd: number;
  cashUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  /** (equity − allocation) / allocation × 100 */
  returnPct: number;
  positions: Position[];
  /** Results from the last tick. */
  triggers: TriggerResult[];
  /** Latest value per signal ref, for the UI ("nino.value" → 1.7). */
  signalValues: Record<string, number | boolean | null>;
  lastTickAt: number | null;
  /** Equity curve samples [ts, equityUsd]. */
  equityCurve: [number, number][];
}

export interface CreateDeploymentInput {
  strategy: Strategy;
  mode?: "paper";
  allocationUsd: number;
  caps?: RiskCaps;
  intervalSec?: number;
}

export interface Engine {
  createDeployment(input: CreateDeploymentInput): Promise<DeploymentRecord>;
  listDeployments(): Promise<DeploymentRecord[]>;
  getSnapshot(id: string): Promise<DeploymentSnapshot | null>;
  getEvents(id: string, opts?: { sinceTs?: number; limit?: number }): Promise<EngineEvent[]>;
  getFills(id: string): Promise<Fill[]>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  /** Kill switch: close every position at market, then stop. */
  kill(id: string): Promise<void>;
  /** Run one tick now (also used by tests and the "Run now" button). */
  tick(id: string, now?: number): Promise<void>;
  /** Start/stop the background scheduler. */
  start(): void;
  shutdown(): Promise<void>;
  /** Live event stream (SSE in the API). Returns an unsubscribe function. */
  subscribe(listener: (e: EngineEvent) => void): () => void;
}
