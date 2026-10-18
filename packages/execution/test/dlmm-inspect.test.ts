import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { DLMM_IX } from "../src/solana/dlmm-ix.ts";
import { inspectSwapTransaction } from "../src/solana/inspect.ts";
import { LP_ALLOWED_PROGRAMS, PROGRAMS, associatedTokenAddress } from "../src/solana/programs.ts";
import { baseShareAt } from "../src/solana/dlmm.ts";

const user = Keypair.generate().publicKey;
const someone = Keypair.generate().publicKey;
const X = new PublicKey("So11111111111111111111111111111111111111112");
const Y = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const pool = Keypair.generate().publicKey;
const any = () => Keypair.generate().publicKey;

/** A DLMM instruction by name, accounts filled by role. */
function dlmm(name: string, roles: Record<string, PublicKey>, signers: string[] = []): TransactionInstruction {
  const [disc, layout] = [...DLMM_IX.entries()].find(([, l]) => l.name === name)!;
  return new TransactionInstruction({
    programId: PROGRAMS.meteoraDlmm,
    keys: layout.accounts.map((n) => ({ pubkey: roles[n] ?? any(), isSigner: signers.includes(n), isWritable: true })),
    data: Buffer.from(disc, "hex"),
  });
}

const tx = (ixs: TransactionInstruction[]) =>
  new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: "11111111111111111111111111111111", instructions: ixs }).compileToV0Message());

const inspect = (ixs: TransactionInstruction[], extraSigners: PublicKey[] = []) =>
  inspectSwapTransaction(tx(ixs), { user, allowedPrograms: LP_ALLOWED_PROGRAMS, extraSigners, maxWrapLamports: 1_000_000_000n });

const userX = associatedTokenAddress(user, X), userY = associatedTokenAddress(user, Y);

describe("liquidity transactions (Meteora DLMM)", () => {
  it("allows opening a position the user owns, with Weft's fresh position account signing", async () => {
    const position = Keypair.generate().publicKey;
    const r = await inspect(
      [
        dlmm("initialize_position", { payer: user, owner: user, position, lb_pair: pool }, ["payer", "position"]),
        SystemProgram.transfer({ fromPubkey: user, toPubkey: userX, lamports: 500_000_000 }),
        dlmm("add_liquidity_by_strategy2", { position, lb_pair: pool, sender: user, user_token_x: userX, user_token_y: userY, token_x_mint: X, token_y_mint: Y }, ["sender"]),
      ],
      [position],
    );
    expect(r.violations).toEqual([]);
    expect(r.instructions.map((i) => i.name)).toEqual(["dlmm.initialize_position", "system.transfer", "dlmm.add_liquidity_by_strategy2"]);
  });

  it("refuses a position owned by someone else", async () => {
    const position = Keypair.generate().publicKey;
    const r = await inspect([dlmm("initialize_position", { payer: user, owner: someone, position }, ["payer", "position"])], [position]);
    expect(r.ok).toBe(false);
    expect(r.violations.join()).toMatch(/owner .* is not the user/);
  });

  it("refuses a position account Weft didn't just generate", async () => {
    const position = Keypair.generate().publicKey;
    const r = await inspect([dlmm("initialize_position", { payer: user, owner: user, position }, ["payer"])]);
    expect(r.violations.join()).toMatch(/new position must be an account Weft just generated/);
  });

  it("refuses withdrawals to token accounts the user doesn't own", async () => {
    const r = await inspect([dlmm("remove_liquidity_by_range2", { sender: user, user_token_x: any(), user_token_y: userY, token_x_mint: X, token_y_mint: Y }, ["sender"])]);
    expect(r.violations.join()).toMatch(/user_token_x .* is not the user's/);
  });

  it("allows withdrawing, claiming and closing to the user", async () => {
    const position = any();
    const r = await inspect([
      dlmm("remove_liquidity_by_range2", { position, sender: user, user_token_x: userX, user_token_y: userY, token_x_mint: X, token_y_mint: Y }, ["sender"]),
      dlmm("claim_fee2", { position, sender: user, user_token_x: userX, user_token_y: userY, token_x_mint: X, token_y_mint: Y }, ["sender"]),
      dlmm("close_position2", { position, sender: user, rent_receiver: user }, ["sender"]),
    ]);
    expect(r.violations).toEqual([]);
  });

  it("refuses rent going to someone else, swaps through the pool, and extra signers", async () => {
    const close = await inspect([dlmm("close_position2", { sender: user, rent_receiver: someone }, ["sender"])]);
    expect(close.violations.join()).toMatch(/rent_receiver .* is not the user/);
    const swap = await inspect([dlmm("swap2", { user })]);
    expect(swap.violations.join()).toMatch(/DLMM instruction not allowed/);
    const stranger = Keypair.generate().publicKey;
    const extra = await inspect([dlmm("claim_fee2", { sender: user, user_token_x: userX, user_token_y: userY, token_x_mint: X, token_y_mint: Y, position: stranger }, ["sender", "position"])]);
    expect(extra.violations.join()).toMatch(/neither the user nor a new position account/);
  });
});

describe("splitting a deposit over a range", () => {
  it("is all base below the range, all quote above, and about half in the middle", () => {
    expect(baseShareAt(80, 90, 110)).toBe(1);
    expect(baseShareAt(120, 90, 110)).toBe(0);
    expect(baseShareAt(Math.sqrt(90 * 110), 90, 110)).toBeCloseTo(0.5, 2);
  });
});

describe("splitting a one-sided or bid-ask deposit", () => {
  it("needs only the quote token below the price and only the base token above it", () => {
    expect(baseShareAt(100, 50, 100)).toBe(0);
    expect(baseShareAt(100, 100, 150)).toBe(1);
    expect(baseShareAt(100, 50, 100, "bid_ask")).toBe(0);
  });
  it("splits a bid-ask range centred on the price about evenly", () => {
    expect(baseShareAt(100, 80, 125, "bid_ask")).toBeCloseTo(0.5, 6);
  });
});
