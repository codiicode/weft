import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { inspectSwapTransaction } from "../src/solana/inspect.ts";
import { LEND_ALLOWED_PROGRAMS, PROGRAMS, USDC_MINT, WSOL_MINT } from "../src/solana/programs.ts";
import { depositInstructions, KaminoExecutor, withdrawInstructions } from "../src/solana/lend.ts";
import type { ReserveInfo } from "../src/solana/kamino.ts";
import type { OrderRequest } from "../src/types.ts";

const user = Keypair.generate().publicKey;
const any = () => Keypair.generate().publicKey;
const MARKET = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");

function reserve(mint: PublicKey, o: Partial<ReserveInfo> = {}): ReserveInfo {
  return {
    reserve: any(), lendingMarket: MARKET, liquidityMint: mint, liquiditySupply: any(), liquidityTokenProgram: PROGRAMS.token,
    liquidityDecimals: mint.equals(WSOL_MINT) ? 9 : 6, collateralMint: any(), pyth: null, switchboardPrice: null, switchboardTwap: null, scope: any(),
    availableRaw: 10n ** 15n, exchangeRate: 1.2, ...o,
  };
}

const tx = (ixs: TransactionInstruction[]) =>
  new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: "11111111111111111111111111111111", instructions: ixs }).compileToV0Message());
const inspect = (ixs: TransactionInstruction[], wrap = 0n) => inspectSwapTransaction(tx(ixs), { user, allowedPrograms: LEND_ALLOWED_PROGRAMS, maxWrapLamports: wrap });

describe("lending transactions (Kamino)", () => {
  it("passes a USDC deposit and its withdrawal", async () => {
    const r = reserve(USDC_MINT);
    const dep = await inspect(depositInstructions(r, user, 500_000_000n));
    expect(dep.violations).toEqual([]);
    expect(dep.instructions.map((i) => i.name)).toEqual(["ata.createIdempotent", "klend.refresh_reserve", "klend.deposit_reserve_liquidity"]);
    const wd = await inspect(withdrawInstructions(r, user, 400_000_000n));
    expect(wd.violations).toEqual([]);
  });

  it("passes a SOL deposit that wraps exactly the SOL lent", async () => {
    const r = reserve(WSOL_MINT);
    const ok = await inspect(depositInstructions(r, user, 2_000_000_000n), 2_000_000_000n);
    expect(ok.violations).toEqual([]);
    expect(ok.instructions.at(-1)!.name).toBe("token.closeAccount");
    const over = await inspect(depositInstructions(r, user, 2_000_000_000n), 1_000_000_000n);
    expect(over.violations.join()).toMatch(/exceeds/);
  });

  it("refuses a withdrawal paid out to someone else's account", async () => {
    const ixs = withdrawInstructions(reserve(USDC_MINT), user, 1_000n);
    const redeem = ixs.find((i) => i.programId.equals(PROGRAMS.kaminoLend) && i.keys.length > 6)!;
    redeem.keys[8] = { pubkey: any(), isSigner: false, isWritable: true };
    expect((await inspect(ixs)).violations.join()).toMatch(/is not the user's/);
  });

  it("refuses every other klend instruction (borrowing, obligations)", async () => {
    const borrow = new TransactionInstruction({ programId: PROGRAMS.kaminoLend, keys: [{ pubkey: user, isSigner: true, isWritable: false }], data: Buffer.from("a1808f7a0a7e1f6c00", "hex") });
    expect((await inspect([borrow])).violations.join()).toMatch(/Kamino instruction not allowed/);
  });
});

/* ---------------- executor, against fakes ---------------- */

function harness(o: { mint: PublicKey; held: bigint; kHeld?: bigint; available?: bigint }) {
  const r = reserve(o.mint, o.available != null ? { availableRaw: o.available } : {});
  const bal = new Map<string, bigint>([[o.mint.toBase58(), o.held], [r.collateralMint.toBase58(), o.kHeld ?? 0n]]);
  const sentTx: VersionedTransaction[] = [];
  const swaps: OrderRequest[] = [];
  const ex = new KaminoExecutor({
    conn: { getBalance: async () => 5e9 } as never,
    signer: { publicKey: user, signTransaction: async (t: VersionedTransaction) => t } as never,
    swaps: { execute: async (req: OrderRequest) => (swaps.push(req), { status: "rejected", reason: "no swaps in this test" }) } as never,
    jupiter: { quote: async () => ({ outAmount: "150000000" }) } as never, // 1 SOL = $150
    reserve: async () => r,
    pollMs: 1,
    rpc: {
      getAddressLookupTable: async () => ({ value: null }),
      getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }),
      tokenBalance: async (_o: PublicKey, m: PublicKey) => bal.get(m.toBase58()) ?? 0n,
      sendRawTransaction: async (raw: Uint8Array) => {
        const t = VersionedTransaction.deserialize(raw);
        sentTx.push(t);
        // The chain: a deposit mints kTokens at the rate, a redeem burns them.
        const ix = t.message.compiledInstructions.find((c) => t.message.staticAccountKeys[c.programIdIndex]!.equals(PROGRAMS.kaminoLend) && c.data.length > 8)!;
        const amt = Buffer.from(ix.data).readBigUInt64LE(8);
        const k = r.collateralMint.toBase58();
        if (Buffer.from(ix.data.subarray(0, 8)).toString("hex") === "a9c91e7e06cd6644") bal.set(k, bal.get(k)! + BigInt(Math.floor(Number(amt) / r.exchangeRate)));
        else bal.set(k, bal.get(k)! - amt);
        return "sig" + sentTx.length;
      },
      confirmTransaction: async () => ({ value: { err: null } }),
    } as never,
  });
  const inst = { kind: "lend", venue: "kamino", market: MARKET.toBase58(), reserve: r.reserve.toBase58(), mint: o.mint.toBase58(), symbol: o.mint.equals(WSOL_MINT) ? "SOL" : "USDC", decimals: r.liquidityDecimals, assetClass: "crypto" } as const;
  const req = (x: Partial<OrderRequest>): OrderRequest => ({ clientId: "c" + Math.random(), instrument: inst, instrumentKey: `kamino:lend:${inst.reserve}`, side: "buy", phase: "open", ...x }) as OrderRequest;
  return { ex, req, sentTx, swaps, bal, r };
}

describe("KaminoExecutor", () => {
  it("lends USDC the wallet already holds, without a swap, and books the kTokens", async () => {
    const h = harness({ mint: USDC_MINT, held: 1_000_000_000n });
    const res = await h.ex.execute(h.req({ notionalUsd: 600 }));
    expect(res.status).toBe("filled");
    if (res.status !== "filled") return;
    expect(h.swaps).toHaveLength(0);
    expect(res.qty).toBeCloseTo(500, 6); // $600 at 1.2 USDC per kToken
    expect(res.qty * res.price).toBeCloseTo(600, 6);
    expect(res.builderFeeUsd).toBe(0);
  });

  it("buys only the shortfall with SOL", async () => {
    const h = harness({ mint: USDC_MINT, held: 100_000_000n });
    const res = await h.ex.execute(h.req({ notionalUsd: 600 }));
    expect(h.swaps[0]!.notionalUsd).toBeCloseTo(500, 6);
    expect(res.status).toBe("rejected"); // the fake swap fails, so nothing is lent
    expect(h.sentTx).toHaveLength(0);
  });

  it("keeps SOL back for fees when lending SOL", async () => {
    const h = harness({ mint: WSOL_MINT, held: 0n });
    const res = await h.ex.execute(h.req({ notionalUsd: 750 })); // 5 SOL, the whole (fake) balance
    expect(res.status).toBe("rejected");
    expect(res.status === "rejected" && res.reason).toMatch(/more for fees/);
  });

  it("withdraws everything on a close, and waits when the reserve is lent out", async () => {
    const h = harness({ mint: USDC_MINT, held: 0n, kHeld: 500_000_000n });
    const ok = await h.ex.execute(h.req({ phase: "close", side: "sell", qty: 499.9 }));
    expect(ok.status).toBe("filled");
    expect(h.bal.get(h.r.collateralMint.toBase58())).toBe(0n); // took the dust too
    const dry = harness({ mint: USDC_MINT, held: 0n, kHeld: 500_000_000n, available: 1_000_000n });
    const wait = await dry.ex.execute(dry.req({ phase: "close", side: "sell", qty: 500 }));
    expect(wait.status === "rejected" && wait.reason).toMatch(/lent out too far/);
    expect(dry.sentTx).toHaveLength(0);
  });
});
