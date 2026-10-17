export type NodeKind = "signal" | "trigger" | "action" | "exit";

export type SignalType =
  | "forecast"
  | "odds"
  | "price"
  | "social"
  | "news"
  | "funding"
  | "calendar"
  | "model"
  | "rates"
  | "onchain"
  | "liquidity"
  | "sports"
  | "position";

export interface SignalNode {
  id: string;
  kind: "signal";
  type: SignalType;
  title: string;
  source: string;
  value: string;
  delta?: string;
  deltaDir?: "up" | "down";
  spark?: number[];
}

export interface TriggerNode {
  id: string;
  kind: "trigger";
  logic: "AND" | "OR" | "IF";
  conditions: string[];
  /** Final state when the strategy is running */
  met?: boolean;
}

export type Side = "long" | "short" | "buy" | "sell";

export interface ActionNode {
  id: string;
  kind: "action";
  side: Side;
  asset: string;
  venue: string;
  alloc: string;
  lev?: string;
  tp?: string;
  sl?: string;
  /** Unrealized P&L in %, shown once the action is live */
  pnl?: number;
  spark?: number[];
}

export interface ExitNode {
  id: string;
  kind: "exit";
  title: string;
  detail: string;
}

export type GraphNode = SignalNode | TriggerNode | ActionNode | ExitNode;
export type GraphEdge = [from: string, to: string];

export interface GraphSpec {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Runtime state of a graph, driven by a sequencer or left at defaults. */
export interface GraphRuntime {
  visible: Record<string, boolean>;
  met: Record<string, boolean>;
  active: Record<string, boolean>;
}

export type LayoutPreset = "full" | "medium" | "compact" | "stack";

export interface NodeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
