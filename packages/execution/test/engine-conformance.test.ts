import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { Keypair } from "@solana/web3.js";
// Type-only import of the engine's contract (no runtime dependency, no package cycle).
import type { Executor as EngineExecutor, OrderRequest as EngineOrderRequest, ExecutionResult as EngineResult } from "../../engine/src/executor.ts";
import type { ExecutionResult, OrderRequest } from "../src/types.ts";
import { HyperliquidExecutor } from "../src/hyperliquid/executor.ts";
import { JupiterExecutor } from "../src/solana/executor.ts";
import { JupiterSwapBuilder } from "../src/solana/jupiter.ts";
import { LocalKeypairSigner } from "../src/solana/signer.ts";
import { RoutingExecutor } from "../src/router.ts";

/** Compile-time proof that our executors satisfy `@weft/engine`'s Executor interface. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const sameRequest: Equal<OrderRequest, EngineOrderRequest> = true;
const sameResult: Equal<ExecutionResult, EngineResult> = true;

describe("engine Executor conformance", () => {
  it("HyperliquidExecutor and JupiterExecutor are engine Executors", () => {
    const hl: EngineExecutor = new HyperliquidExecutor({
      agentPrivateKey: generatePrivateKey(),
      userAddress: "0x00000000000000000000000000000000000000aa",
      isMainnet: false,
      dryRun: true,
    });
    const jup: EngineExecutor = new JupiterExecutor({
      builder: new JupiterSwapBuilder(),
      signer: new LocalKeypairSigner(Keypair.generate(), "devnet"),
      rpc: { getAddressLookupTable: async () => ({ value: null }), getAccountInfo: async () => null },
      dryRun: true,
    });
    expect([hl.mode, jup.mode]).toEqual(["live", "live"]);
    expect(sameRequest && sameResult).toBe(true);
  });
});

describe("RoutingExecutor", () => {
  const stub = (name: string, mode: "live" | "paper" = "live"): EngineExecutor => ({
    mode,
    execute: async () => ({ status: "pending", reason: name }),
  });
  const req = (instrument: OrderRequest["instrument"]): OrderRequest => ({ clientId: "c", instrument, instrumentKey: "k", side: "buy", phase: "open", notionalUsd: 10 });
  const router: EngineExecutor = new RoutingExecutor({ hyperliquid: stub("hl"), solana: stub("sol") });

  it("routes by instrument kind and rejects unrouted kinds", async () => {
    expect(await router.execute(req({ kind: "perp", venue: "hyperliquid", symbol: "BTC", assetClass: "crypto" }), 0)).toMatchObject({ reason: "hl" });
    expect(await router.execute(req({ kind: "spot", venue: "hyperliquid", symbol: "HYPE/USDC", assetClass: "crypto" }), 0)).toMatchObject({ reason: "hl" });
    expect(await router.execute(req({ kind: "outcome", venue: "hyperliquid", market: "1", outcome: "YES" }), 0)).toMatchObject({ reason: "hl" });
    expect(
      await router.execute(req({ kind: "token", chain: "solana", mint: "So11111111111111111111111111111111111111112", quote: "USDC", route: "auto", assetClass: "crypto" }), 0)
    ).toMatchObject({ reason: "sol" });
    expect(await router.execute(req({ kind: "outcome", venue: "jupiter", market: "m", outcome: "YES" }), 0)).toMatchObject({ status: "rejected" });
    expect(await router.execute(req({ kind: "option", venue: "deribit", underlying: "BTC", expiry: "2026-12-25", strike: 100000, right: "call" }), 0)).toMatchObject({
      status: "rejected",
    });
  });

  it("never routes live orders to a paper executor", async () => {
    const r = new RoutingExecutor({ hyperliquid: stub("paper", "paper") });
    expect(await r.execute(req({ kind: "perp", venue: "hyperliquid", symbol: "BTC", assetClass: "crypto" }), 0)).toMatchObject({ status: "rejected" });
  });
});
