import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { PROGRAMS } from "@weft/execution";
import { SolanaWithdrawals } from "../src/live/solana-withdraw.ts";

const user = Keypair.generate();
const dest = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const SRC = Keypair.generate().publicKey;

function fakeConn(opts: { lamports?: number; tokens?: bigint } = {}) {
  const sent: Uint8Array[] = [];
  const mintData = Buffer.alloc(82);
  mintData[44] = 6;
  const conn = {
    getBalance: async () => opts.lamports ?? 1_000_000_000,
    getAccountInfo: async () => ({ owner: PROGRAMS.token, data: mintData, lamports: 1, executable: false }),
    getParsedTokenAccountsByOwner: async () => ({ value: [{ pubkey: SRC, account: { data: { parsed: { info: { tokenAmount: { amount: String(opts.tokens ?? 0n) } } } } } }] }),
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    simulateTransaction: async () => ({ value: { err: null } }),
    sendRawTransaction: async (raw: Uint8Array) => (sent.push(raw), "sig1"),
    confirmTransaction: async () => ({ value: { err: null } }),
  };
  return { conn: conn as never, sent };
}

const sign = (b64: string) => {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  tx.sign([user]);
  return Buffer.from(tx.serialize()).toString("base64");
};

describe("withdrawals from the Weft Solana wallet", () => {
  it("sends SOL, keeping a little back for the fee", async () => {
    const { conn, sent } = fakeConn({ lamports: 500_000_000 });
    const w = new SolanaWithdrawals(conn);
    const prep = await w.prepare("u1", user.publicKey.toBase58(), "SOL", "max", dest.toBase58());
    expect(prep.amount).toBeCloseTo(0.49999, 5);
    await expect(w.prepare("u1", user.publicKey.toBase58(), "SOL", 1, dest.toBase58())).rejects.toThrow(/up to/);
    const again = await w.prepare("u1", user.publicKey.toBase58(), "SOL", 0.2, dest.toBase58());
    expect(await w.submit("u1", sign(again.transaction))).toEqual({ signature: "sig1" });
    const tx = VersionedTransaction.deserialize(sent[0]!);
    const keys = tx.message.staticAccountKeys;
    const transfer = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex]!.equals(SystemProgram.programId))!;
    expect(keys[transfer.accountKeyIndexes[1]!]!.equals(dest)).toBe(true);
  });

  it("sends all of a token with transferChecked and closes the emptied account", async () => {
    const { conn, sent } = fakeConn({ tokens: 2_500_000n });
    const w = new SolanaWithdrawals(conn);
    const prep = await w.prepare("u2", user.publicKey.toBase58(), MINT.toBase58(), "max", dest.toBase58());
    expect(prep.amount).toBe(2.5);
    await w.submit("u2", sign(prep.transaction));
    const tx = VersionedTransaction.deserialize(sent[0]!);
    const keys = tx.message.staticAccountKeys;
    const tokenIxs = tx.message.compiledInstructions.filter((i) => keys[i.programIdIndex]!.equals(PROGRAMS.token)).map((i) => i.data[0]);
    expect(tokenIxs).toEqual([12, 9]); // transferChecked, then closeAccount
  });

  it("refuses a transaction that was changed or not signed by the user", async () => {
    const { conn, sent } = fakeConn();
    const w = new SolanaWithdrawals(conn);
    const prep = await w.prepare("u3", user.publicKey.toBase58(), "SOL", 0.1, dest.toBase58());
    await expect(w.submit("u3", prep.transaction)).rejects.toThrow(/not signed/);
    const other = await w.prepare("u3", user.publicKey.toBase58(), "SOL", 0.1, new PublicKey(Keypair.generate().publicKey).toBase58());
    const forged = await new SolanaWithdrawals(fakeConn().conn).prepare("x", user.publicKey.toBase58(), "SOL", 0.3, dest.toBase58());
    await expect(w.submit("u3", sign(forged.transaction))).rejects.toThrow(/isn’t the one Weft prepared/);
    expect(other.amount).toBe(0.1);
    expect(sent).toHaveLength(0);
    await expect(w.prepare("u3", user.publicKey.toBase58(), "SOL", 0.1, "nope")).rejects.toThrow(/Solana address/);
  });
});
