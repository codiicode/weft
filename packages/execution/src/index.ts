/**
 * @weft/execution: live, non-custodial execution.
 *
 * - Hyperliquid (perps, HIP-3 builder-dex perps, spot; HIP-4 outcomes experimental) through an
 *   approved AGENT wallet: can trade, cannot withdraw. Signing is a 1:1 port of the official SDK.
 * - Solana tokens through Jupiter: unsigned swap transactions for the USER's key, inspected
 *   before a policy-controlled signer (Turnkey) is asked to sign.
 */
export type { Executor, OrderRequest, ExecutionResult } from "./types.ts";
export { RoutingExecutor } from "./router.ts";

export * from "./hyperliquid/signing.ts";
export * from "./hyperliquid/wire.ts";
export * from "./hyperliquid/ticks.ts";
export * from "./hyperliquid/info.ts";
export * from "./hyperliquid/exchange.ts";
export * from "./hyperliquid/approvals.ts";
export * from "./hyperliquid/executor.ts";

export * from "./solana/programs.ts";
export * from "./solana/inspect.ts";
export * from "./solana/jupiter.ts";
export * from "./solana/signer.ts";
export * from "./solana/executor.ts";
export * from "./solana/dlmm.ts";
export { DLMM_IX } from "./solana/dlmm-ix.ts";
export * from "./papertrade/intents.ts";
export { PapertradeExecutor, PapertradeError, type PapertradeAccount, type PapertradeExecutorConfig } from "./papertrade/executor.ts";
