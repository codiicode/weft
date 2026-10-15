// Creates the fee wallet's WSOL and USDC token accounts so swap fees can land there.
// Usage: node scripts/fee-accounts.mjs            (dry run: shows what would be created)
//        node scripts/fee-accounts.mjs --send     (creates them, paid from the fee wallet)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/execution/package.json", import.meta.url));
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } = require("@solana/web3.js");

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MINTS = { WSOL: "So11111111111111111111111111111111111111112", USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL("../secrets/weft-fee-wallet.json", import.meta.url)))));
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const owner = payer.publicKey;
console.log("fee wallet", owner.toBase58(), (await conn.getBalance(owner)) / 1e9, "SOL");

const ixs = [];
for (const [name, m] of Object.entries(MINTS)) {
  const mint = new PublicKey(m);
  const [ata] = PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA);
  const exists = Boolean(await conn.getAccountInfo(ata));
  console.log(name, ata.toBase58(), exists ? "exists" : "missing");
  if (exists) continue;
  ixs.push(new TransactionInstruction({
    programId: ATA,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  }));
}
if (!ixs.length) process.exit(0);
if (!process.argv.includes("--send")) { console.log(`dry run: would create ${ixs.length} account(s), ~${(ixs.length * 0.00204).toFixed(4)} SOL rent`); process.exit(0); }
const tx = new Transaction().add(...ixs);
if (process.argv.includes("--sim")) { tx.feePayer = owner; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(payer); console.log(JSON.stringify((await conn.simulateTransaction(tx)).value, null, 1)); process.exit(0); }
const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
console.log("created:", sig);
