import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { associatedTokenAddress, PROGRAMS } from "@weft/execution";

/**
 * Withdrawals from a user's Weft Solana wallet: SOL, USDC or any token, to an address they give.
 * Weft builds the transaction; the user's own wallet signs it in the browser (Weft's limited signer
 * can't move funds out); Weft checks that what came back is exactly what it built, then sends it.
 */

/** SOL kept back so a full withdrawal still pays its own network fee. */
const FEE_RESERVE_LAMPORTS = 10_000;

export interface PreparedWithdraw {
  /** Base64 of the unsigned v0 transaction the wallet signs. */
  transaction: string;
  asset: string;
  amount: number;
  destination: string;
  lastValidBlockHeight: number;
}

type Pending = { message: Uint8Array; owner: string; lastValidBlockHeight: number; blockhash: string; expires: number };

export class SolanaWithdrawals {
  private readonly pending = new Map<string, Pending>();
  private readonly conn: Connection;
  constructor(conn: Connection) {
    this.conn = conn;
  }

  /** `asset` is "SOL" or a mint; `amount` in whole units, or "max". */
  async prepare(userId: string, owner: string, asset: string, amount: number | "max", destination: string): Promise<PreparedWithdraw> {
    let to: PublicKey;
    try {
      to = new PublicKey(destination);
    } catch {
      throw new Error("that isn’t a Solana address");
    }
    const from = new PublicKey(owner);
    if (to.equals(from)) throw new Error("that’s your own Weft wallet; send to another address");
    const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 })];
    let sent: number;

    if (asset === "SOL") {
      const bal = await this.conn.getBalance(from, "confirmed");
      const max = bal - FEE_RESERVE_LAMPORTS;
      const lamports = amount === "max" ? max : Math.floor(amount * 1e9);
      if (lamports <= 0) throw new Error("there’s no SOL to send");
      if (lamports > max) throw new Error(`you can send up to ${(max / 1e9).toFixed(6)} SOL (a little stays for the network fee)`);
      ixs.push(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }));
      sent = lamports / 1e9;
    } else {
      const mint = new PublicKey(asset);
      const info = await this.conn.getAccountInfo(mint);
      if (!info) throw new Error("unknown token");
      const program = info.owner.equals(PROGRAMS.token2022) ? PROGRAMS.token2022 : PROGRAMS.token;
      const decimals = info.data[44]!;
      const accounts = (await this.conn.getParsedTokenAccountsByOwner(from, { mint }, "confirmed")).value
        .map((a) => ({ address: a.pubkey, amount: BigInt((a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount ?? "0") }))
        .filter((a) => a.amount > 0n)
        .sort((a, b) => (b.amount > a.amount ? 1 : -1));
      const source = accounts[0];
      if (!source) throw new Error("there’s none of that token in your wallet");
      const units = amount === "max" ? source.amount : BigInt(Math.floor(amount * 10 ** decimals));
      if (units <= 0n) throw new Error("amount rounds to zero");
      if (units > source.amount) throw new Error(`you can send up to ${Number(source.amount) / 10 ** decimals}`);
      const destAta = associatedTokenAddress(to, mint, program);
      ixs.push(
        // Create the receiver's token account if it doesn't exist yet (paid by the sender, ~0.002 SOL).
        new TransactionInstruction({
          programId: PROGRAMS.associatedToken,
          keys: [
            { pubkey: from, isSigner: true, isWritable: true },
            { pubkey: destAta, isSigner: false, isWritable: true },
            { pubkey: to, isSigner: false, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: program, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([1]),
        }),
        transferChecked(program, source.address, mint, destAta, from, units, decimals),
      );
      // Sending all of it: close the emptied account so its rent comes back to the user.
      if (units === source.amount)
        ixs.push(new TransactionInstruction({ programId: program, keys: [{ pubkey: source.address, isSigner: false, isWritable: true }, { pubkey: from, isSigner: false, isWritable: true }, { pubkey: from, isSigner: true, isWritable: false }], data: Buffer.from([9]) }));
      sent = Number(units) / 10 ** decimals;
    }

    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: from, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const sim = await this.conn.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
    if (sim.value.err) throw new Error(`this transfer would fail: ${JSON.stringify(sim.value.err)}${sim.value.err && JSON.stringify(sim.value.err).includes("InsufficientFunds") ? " (not enough SOL for the fee)" : ""}`);
    this.pending.set(userId, { message: msg.serialize(), owner, lastValidBlockHeight, blockhash, expires: Date.now() + 90_000 });
    return { transaction: Buffer.from(tx.serialize()).toString("base64"), asset, amount: sent, destination: to.toBase58(), lastValidBlockHeight };
  }

  /** Checks the wallet signed exactly the prepared transaction, then sends it and waits for it. */
  async submit(userId: string, signedB64: string): Promise<{ signature: string }> {
    const p = this.pending.get(userId);
    if (!p || p.expires < Date.now()) throw new Error("this withdrawal expired; start again");
    const tx = VersionedTransaction.deserialize(Buffer.from(signedB64, "base64"));
    if (!Buffer.from(tx.message.serialize()).equals(Buffer.from(p.message))) throw new Error("the signed transaction isn’t the one Weft prepared");
    if (!tx.message.staticAccountKeys[0]?.equals(new PublicKey(p.owner)) || !tx.signatures[0] || tx.signatures[0].every((b) => b === 0)) throw new Error("not signed by your wallet");
    this.pending.delete(userId);
    const sig = await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const conf = await this.conn.confirmTransaction({ signature: sig, blockhash: p.blockhash, lastValidBlockHeight: p.lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new Error(`the transfer failed: ${JSON.stringify(conf.value.err)}`);
    return { signature: sig };
  }
}

/** SPL Token TransferChecked (instruction 12). */
function transferChecked(program: PublicKey, source: PublicKey, mint: PublicKey, dest: PublicKey, owner: PublicKey, amount: bigint, decimals: number) {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}
