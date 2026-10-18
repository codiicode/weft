import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { inspectSwapTransaction } from "../src/solana/inspect.ts";
import { associatedTokenAddress, LEND_ALLOWED_PROGRAMS, PROGRAMS, USDC_MINT, WSOL_MINT } from "../src/solana/programs.ts";
import { depositInstructions, LendExecutor, withdrawInstructions } from "../src/solana/lend.ts";
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
    expect((await inspect([borrow])).violations.join()).toMatch(/lending instruction not allowed/);
  });
});

/* ---------------- executor, against fakes ---------------- */

function harness(o: { mint: PublicKey; held: bigint; kHeld?: bigint; available?: bigint }) {
  const r = reserve(o.mint, o.available != null ? { availableRaw: o.available } : {});
  const bal = new Map<string, bigint>([[o.mint.toBase58(), o.held], [r.collateralMint.toBase58(), o.kHeld ?? 0n]]);
  const sentTx: VersionedTransaction[] = [];
  const swaps: OrderRequest[] = [];
  const ex = new LendExecutor({
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

describe("LendExecutor", () => {
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
    expect(wait.status === "rejected" && wait.reason).toMatch(/can't pay this back right now/);
    expect(dry.sentTx).toHaveLength(0);
  });
});

/* ---------------- Jupiter Lend ---------------- */

import { JupiterLendApi } from "../src/solana/lend.ts";

const JL_USDC = new PublicKey("9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D");

/** A fake Jupiter Lend API: one USDC vault at 1.065 USDC per jlToken; `tamper` corrupts the instruction it sends. */
function fakeJupiter(tamper?: (ix: { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }) => void, withdrawable = "1000000000000") {
  const calls: string[] = [];
  const fetchFn = (async (url: string, init?: { body?: string }) => {
    const path = String(url).split("/earn/")[1]!;
    calls.push(path);
    if (path === "tokens")
      return new Response(JSON.stringify([{ address: JL_USDC.toBase58(), decimals: 6, assetAddress: USDC_MINT.toBase58(), asset: { decimals: 6, symbol: "USDC" }, convertToAssets: "1065000", liquiditySupplyData: { withdrawable } }]));
    const body = JSON.parse(init!.body!);
    const deposit = path === "deposit-instructions";
    const amount = BigInt(deposit ? body.amount : body.shares);
    const disc = deposit ? "f223c68952e1f2b6" : "b80c569546c461e1";
    const data = Buffer.concat([Buffer.from(disc, "hex"), Buffer.alloc(8)]);
    data.writeBigUInt64LE(amount, 8);
    const userUsdc = associatedTokenAddress(new PublicKey(body.signer), USDC_MINT).toBase58();
    const userJl = associatedTokenAddress(new PublicKey(body.signer), JL_USDC).toBase58();
    const k = (pubkey: string, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
    const rest = () => k(any().toBase58());
    const accounts = deposit
      ? [k(body.signer, true), k(userUsdc), k(userJl), k(USDC_MINT.toBase58()), rest(), rest(), k(JL_USDC.toBase58()), rest(), rest(), rest()]
      : [k(body.signer, true), k(userJl), k(userUsdc), rest(), rest(), k(USDC_MINT.toBase58()), k(JL_USDC.toBase58()), rest(), rest(), rest()];
    const ix = { programId: PROGRAMS.jupiterLend.toBase58(), accounts, data: data.toString("base64") };
    tamper?.(ix);
    return new Response(JSON.stringify({ instructions: [ix] }));
  }) as unknown as typeof fetch;
  return { api: new JupiterLendApi({ baseUrl: "https://jup.test", fetch: fetchFn }), calls };
}

function jupHarness(api: JupiterLendApi, o: { held: bigint; jlHeld?: bigint }) {
  const bal = new Map<string, bigint>([[USDC_MINT.toBase58(), o.held], [JL_USDC.toBase58(), o.jlHeld ?? 0n]]);
  const sentTx: VersionedTransaction[] = [];
  const ex = new LendExecutor({
    conn: { getBalance: async () => 5e9 } as never,
    signer: { publicKey: user, signTransaction: async (t: VersionedTransaction) => t } as never,
    swaps: { execute: async () => ({ status: "rejected", reason: "no swaps" }) } as never,
    jupiter: { quote: async () => ({ outAmount: "150000000" }) } as never,
    jupiterLend: api,
    pollMs: 1,
    rpc: {
      getAddressLookupTable: async () => ({ value: null }),
      getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }),
      tokenBalance: async (_o: PublicKey, m: PublicKey) => bal.get(m.toBase58()) ?? 0n,
      sendRawTransaction: async (raw: Uint8Array) => {
        const t = VersionedTransaction.deserialize(raw);
        sentTx.push(t);
        const c = t.message.compiledInstructions.find((x) => t.message.staticAccountKeys[x.programIdIndex]!.equals(PROGRAMS.jupiterLend))!;
        const amt = Buffer.from(c.data).readBigUInt64LE(8);
        const jl = JL_USDC.toBase58();
        if (Buffer.from(c.data.subarray(0, 8)).toString("hex") === "f223c68952e1f2b6") bal.set(jl, bal.get(jl)! + BigInt(Math.floor(Number(amt) / 1.065)));
        else bal.set(jl, bal.get(jl)! - amt);
        return "sig";
      },
      confirmTransaction: async () => ({ value: { err: null } }),
    } as never,
  });
  const inst = { kind: "lend", venue: "jupiter", market: PROGRAMS.jupiterLend.toBase58(), reserve: JL_USDC.toBase58(), mint: USDC_MINT.toBase58(), symbol: "USDC", decimals: 6, assetClass: "crypto" } as const;
  const req = (x: Partial<OrderRequest>): OrderRequest => ({ clientId: "j" + Math.random(), instrument: inst, instrumentKey: `jupiter:lend:${inst.reserve}`, side: "buy", phase: "open", ...x }) as OrderRequest;
  return { ex, req, sentTx, bal };
}

describe("Jupiter Lend", () => {
  it("lends and withdraws through the checked API instructions", async () => {
    const { api } = fakeJupiter();
    const h = jupHarness(api, { held: 1_000_000_000n });
    const dep = await h.ex.execute(h.req({ notionalUsd: 106.5 }));
    expect(dep.status).toBe("filled");
    if (dep.status !== "filled") return;
    expect(dep.qty).toBeCloseTo(100, 4);
    expect(h.sentTx).toHaveLength(1);
    const wd = await h.ex.execute(h.req({ phase: "close", side: "sell", qty: dep.qty }));
    expect(wd.status).toBe("filled");
    expect(h.bal.get(JL_USDC.toBase58())).toBe(0n);
  });

  it("refuses an API instruction with another amount, signer or vault, before signing", async () => {
    for (const tamper of [
      (ix: any) => { const d = Buffer.from(ix.data, "base64"); d.writeBigUInt64LE(1n, 8); ix.data = d.toString("base64"); },
      (ix: any) => { ix.accounts[0].pubkey = any().toBase58(); },
      (ix: any) => { ix.accounts[6].pubkey = any().toBase58(); },
      (ix: any) => { ix.programId = PROGRAMS.kaminoLend.toBase58(); },
      (ix: any) => { ix.accounts[3].isSigner = true; },
    ]) {
      const h = jupHarness(fakeJupiter(tamper).api, { held: 1_000_000_000n });
      const r = await h.ex.execute(h.req({ notionalUsd: 50 }));
      expect(r.status).toBe("rejected");
      expect(h.sentTx).toHaveLength(0);
    }
  });

  it("inspection refuses a deposit that pays the jlTokens to someone else", async () => {
    const data = Buffer.concat([Buffer.from("f223c68952e1f2b6", "hex"), Buffer.alloc(8)]);
    const keys = [user, associatedTokenAddress(user, USDC_MINT), any(), USDC_MINT, any(), any(), JL_USDC].map((pubkey, n) => ({ pubkey, isSigner: n === 0, isWritable: true }));
    const r = await inspect([new TransactionInstruction({ programId: PROGRAMS.jupiterLend, keys, data })]);
    expect(r.violations.join()).toMatch(/is not the user's/);
  });

  it("waits when the vault can't pay out", async () => {
    const h = jupHarness(fakeJupiter(undefined, "1000").api, { held: 0n, jlHeld: 100_000_000n });
    const r = await h.ex.execute(h.req({ phase: "close", side: "sell", qty: 100 }));
    expect(r.status === "rejected" && r.reason).toMatch(/can't pay this back right now/);
    expect(h.sentTx).toHaveLength(0);
  });
});

describe("Jupiter Lend rate limits", () => {
  it("asks again after a 429, and marks a lasting one as worth retrying later", async () => {
    let n = 0;
    const flaky = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("deposit-instructions") && n++ < 2) return new Response('{"code":429}', { status: 429 });
      return realFetch(url, init);
    }) as unknown as typeof fetch;
    const { api: base } = fakeJupiter();
    const realFetch = (base as unknown as { fetchFn: typeof fetch }).fetchFn;
    const api = new JupiterLendApi({ baseUrl: "https://jup.test", fetch: flaky });
    api.backoffMs = [1, 1, 1];
    const h = jupHarness(api, { held: 1_000_000_000n });
    expect((await h.ex.execute(h.req({ notionalUsd: 10 }))).status).toBe("filled");

    const always = (async (url: string, init?: RequestInit) => (String(url).includes("deposit-instructions") ? new Response("{}", { status: 429 }) : realFetch(url, init))) as unknown as typeof fetch;
    const api2 = new JupiterLendApi({ baseUrl: "https://jup.test", fetch: always });
    api2.backoffMs = [1];
    const h2 = jupHarness(api2, { held: 1_000_000_000n });
    const r = await h2.ex.execute(h2.req({ notionalUsd: 10 }));
    expect(r.status === "rejected" && r.retry).toBe(true);
    expect(h2.sentTx).toHaveLength(0);
  });
});
