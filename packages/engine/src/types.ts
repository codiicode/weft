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
  /** Watch only: every trade the strategy would make becomes an alert instead. */
  alertsOnly?: boolean;
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
  /**
   * Optional (additive): set on legs of a multi-leg options position. Legs that
   * share `group.id` are monitored and exited together.
   */
  group?: PositionGroup;
  /**
   * Optional (additive), perps on paper: net funding paid by this position, USD
   * (positive = paid, negative = received). Already booked to cash and to the
   * deployment's realized P&L as it accrues; reduced pro rata on partial closes.
   */
  fundingPaidUsd?: number;
  /**
   * Optional (additive), leveraged perps on paper: estimated liquidation price
   * (isolated margin, maintenance = 1 / (2 × venue max leverage), 3 % if unknown).
   * The position is closed at this price with reason `liquidation` when the mark crosses it.
   */
  liquidationPrice?: number;
  /** Optional (additive): engine bookkeeping for funding accrual. Not for display. */
  fundingState?: PositionFundingState;
}

/** Funding accrual bookkeeping (additive, optional). */
export interface PositionFundingState {
  /** Funding has been accrued up to this time (ms). */
  accruedAt: number;
  /** Last time a funding event was emitted for this position (ms). */
  lastEventAt: number;
  /** Funding accrued since that event, USD (positive = paid). */
  sinceEventUsd: number;
}

/** Multi-leg grouping for options positions (additive, optional). */
export interface PositionGroup {
  /** Shared by every leg; equals the intent key that opened it. */
  id: string;
  /** Number of spread units opened (leg qty = units × ratio). */
  units: number;
  /** This leg's ratio within one unit. */
  ratio: number;
  /** Best net value per unit seen since entry, for trailing stops on the group. */
  peakValue: number;
}

export type FillReason =
  | "entry"
  | "take_profit"
  | "stop_loss"
  | "trailing_stop"
  | "time_exit"
  | "close_action"
  | "kill"
  | "manual"
  /** Paper perps: the mark crossed the estimated liquidation price; filled at that price. */
  | "liquidation";

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
  /**
   * Optional (additive), closing perp fills: funding paid by the closed part over
   * its life, USD (positive = paid). Already included in the deployment's realized
   * P&L as it accrued, so it is NOT subtracted again from `realizedPnlUsd`.
   */
  fundingUsd?: number;
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
  /** Optional (additive): total fees paid, USD (venue + builder/platform + network). */
  feesUsd?: number;
  /**
   * Optional (additive): Weft's share of fees, USD (Hyperliquid builder fee +
   * Solana platform fee). Funds token buybacks later.
   */
  builderFeesUsd?: number;
  /** Optional (additive): net perp funding paid, USD (positive = paid, negative = received). Included in realizedPnlUsd. */
  fundingUsd?: number;
}

export interface CreateDeploymentInput {
  strategy: Strategy;
  /** Must match the engine's executor ("paper" by default). */
  mode?: "paper" | "live";
  allocationUsd: number;
  caps?: RiskCaps;
  intervalSec?: number;
  /** Watch only: trades become alerts, nothing is bought or sold. */
  alertsOnly?: boolean;
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
  /** Record an outside observation on a deployment (e.g. venue reconciliation). */
  note?(id: string, type: "warning" | "error" | "notify", message: string, data?: Record<string, unknown>): Promise<void>;
  /** The owner sells `fraction` (0–1] of one open position at market, now. Resolves false if nothing filled. */
  closePosition?(id: string, positionId: string, fraction: number): Promise<boolean>;
  /** Change the exits of open positions (all, or the listed ones). `null` clears a level. */
  setExits?(id: string, patch: ExitsPatch, positionIds?: string[]): Promise<number>;
  /** Replace a running deployment's rules, keeping its positions, cash and history. */
  updateStrategy?(id: string, strategy: Strategy): Promise<void>;
}

/** Changes to a position's exits: a value sets it, `null` removes it, absent keeps it. */
export type ExitsPatch = { [K in keyof Exits]?: Exits[K] | null };
