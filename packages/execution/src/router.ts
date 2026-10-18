import type { ExecutionResult, Executor, OrderRequest } from "./types.ts";

/**
 * One engine `Executor` that routes each order to the venue executor for its instrument:
 * Hyperliquid perps / HIP-3 perps / spot (+ HIP-4 outcomes when enabled) → `hyperliquid`,
 * Solana tokens → `solana`. Anything without a configured route is rejected, never paper-filled.
 * Pass it to `createEngine({ executor })`.
 */
export class RoutingExecutor implements Executor {
  readonly mode = "live" as const;
  private readonly routes: { hyperliquid?: Executor; solana?: Executor };
  constructor(routes: { hyperliquid?: Executor; solana?: Executor }) {
    this.routes = routes;
  }

  route(req: OrderRequest): Executor | null {
    const i = req.instrument;
    switch (i.kind) {
      case "perp":
      case "spot":
        return this.routes.hyperliquid ?? null;
      case "outcome":
        return i.venue === "hyperliquid" ? (this.routes.hyperliquid ?? null) : null; // TODO: Jupiter prediction orders
      case "token":
        return this.routes.solana ?? null;
      case "option":
        return null; // TODO: options venues (Derive / Deribit / HL options)
      case "lp":
        return null; // liquidity runs as practice for now; live Meteora deposits come next
    }
  }

  async execute(req: OrderRequest, now: number): Promise<ExecutionResult> {
    const ex = this.route(req);
    if (!ex) return { status: "rejected", reason: `no live route for ${req.instrument.kind} (${req.instrumentKey})` };
    if (ex.mode !== "live") return { status: "rejected", reason: "refusing to route a live order to a paper executor" };
    return ex.execute(req, now);
  }
}
