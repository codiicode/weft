import type { Instrument, OrderSpec } from "@weft/strategy";

/**
 * Structural mirror of the engine's executor contract (`packages/engine/src/executor.ts`).
 *
 * `@weft/execution` deliberately does NOT depend on `@weft/engine` (the engine will depend on
 * this package to route live intents, and a cycle would follow). TypeScript is structural, so
 * every executor here is assignable to the engine's `Executor`; `test/engine-conformance.test.ts`
 * proves it against the engine's actual source at type-check time.
 */
export interface Executor {
  readonly mode: "paper" | "live";
  execute(req: OrderRequest, now: number): Promise<ExecutionResult>;
}

export interface OrderRequest {
  /** Deterministic idempotency id (derived from the intent key / position id). */
  clientId: string;
  instrument: Instrument;
  instrumentKey: string;
  side: "buy" | "sell";
  /** "open" adds to a position, "close" reduces one (reduce-only; never blocked by slippage limits). */
  phase: "open" | "close";
  /** Opens: USD notional to trade (perps: margin × leverage). */
  notionalUsd?: number;
  /** Closes and option legs: units to trade. */
  qty?: number;
  order?: Partial<OrderSpec>;
  /** Paper only: price to use if no quote is available. Ignored by live executors. */
  fallbackPrice?: number;
  /** The deployment placing the order (routing to the right user's account/agent). */
  deploymentId?: string;
  /** Opens on perps: leverage to set on the venue before trading. */
  leverage?: number;
  /**
   * Liquidity pools: where the range sits and what the pool and its quote token are worth now;
   * closes name the on-chain position to withdraw from.
   */
  lp?: { lower: number; upper: number; poolPrice: number; quoteUsd: number; position?: string };
}

export type ExecutionResult =
  | {
      status: "filled";
      qty: number;
      price: number;
      markPrice: number;
      feeUsd: number;
      builderFeeUsd: number;
      /** Liquidity opens on chain: the position account that holds it. */
      lp?: { position: string };
      slippageBps: number;
    }
  | { status: "rejected" | "pending"; reason: string };
