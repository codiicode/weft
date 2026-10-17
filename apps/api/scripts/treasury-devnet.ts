// The treasury's money flow on devnet, with the roles in separate wallets as on mainnet:
//   launch (creates the token), treasury (fee claimer, runs ticks), buyer (trades, and stands in for
//   the revenue wallet). Checks: fees claimed and split 2.0/2.4 to revenue and 0.4/2.4 into a buy,
//   30% of the buy burned, the rest in today's pot, and who owns the locked LP after graduation.
//   DEVNET_RPC=… node scripts/treasury-devnet.ts        (TEST_THRESHOLD, default 0.06 SOL)
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { DAMM_V2_MIGRATION_FEE_ADDRESS, DynamicBondingCurveClient, SwapMode, deriveDammV2PoolAddress, deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { JupiterSwapBuilder } from "@weft/execution";
import { MIGRATION_FEE_OPTION, WEFT_TOKEN, weftCurve } from "../src/token/curve.ts";
import { Treasury } from "../src/token/treasury.ts";
import { Rewards } from "../src/lib/rewards.ts";

const conn = new Connection(process.env.DEVNET_RPC ?? "https://api.devnet.solana.com", "confirmed");
const client = new DynamicBondingCurveClient(conn, "confirmed");
const secrets = new URL("../../../secrets/", import.meta.url).pathname;
const key = (name: string) => {
  const p = `${secrets}${name}.json`;
  if (!existsSync(p)) writeFileSync(p, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
};
const launch = key("devnet-weft"), treasuryKey = key("devnet-treasury");
const buyer = process.env.BUYER === "launch" ? launch : key("devnet-buyer");
const sol = (n: number | bigint) => Number(n) / LAMPORTS_PER_SOL;
const bal = async (k: Keypair) => sol(await conn.getBalance(k.publicKey));
const send = async (tx: Transaction, signers: Keypair[], label: string) => {
  tx.feePayer = signers[0]!.publicKey;
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  console.log(`  ${label}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
};
const threshold = Number(process.env.TEST_THRESHOLD ?? 0.06);

console.log(`wallets: launch ${launch.publicKey.toBase58().slice(0, 8)} ${await bal(launch)} · treasury ${treasuryKey.publicKey.toBase58().slice(0, 8)} ${await bal(treasuryKey)} · buyer ${buyer.publicKey.toBase58().slice(0, 8)} ${await bal(buyer)}`);
if (buyer !== launch && (await bal(launch)) < 0.06) await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: launch.publicKey, lamports: 0.08 * LAMPORTS_PER_SOL })), [buyer], "SOL for the launch wallet");
if ((await bal(treasuryKey)) < 0.015) await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: treasuryKey.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL })), [buyer], "gas for the treasury");

// A token from scripts/launch.ts (POOL and MINT), or a fresh one.
let pool: PublicKey, mintKp: { publicKey: PublicKey };
if (process.env.POOL && process.env.MINT) {
  pool = new PublicKey(process.env.POOL);
  mintKp = { publicKey: new PublicKey(process.env.MINT) };
  console.log(`token ${mintKp.publicKey.toBase58().slice(0, 8)}… from the launch script`);
} else {
  console.log(`token (threshold ${threshold} SOL, fee claimer = treasury)`);
  const configKp = Keypair.generate(), m = Keypair.generate();
  await send(await client.partner.createConfig2({ payer: launch.publicKey, config: configKp.publicKey, feeClaimer: treasuryKey.publicKey, leftoverReceiver: treasuryKey.publicKey, quoteMint: NATIVE_MINT, ...weftCurve({ migrationQuoteThreshold: threshold }), transferFeeParameters: null } as never), [launch, configKp], "createConfig2");
  await send(await client.creator.createPool({ baseMint: m.publicKey, config: configKp.publicKey, name: "Weft (treasury test)", symbol: "WEFT", uri: WEFT_TOKEN.uri, payer: launch.publicKey, poolCreator: launch.publicKey }), [launch, m], "createPool");
  pool = deriveDbcPoolAddress(NATIVE_MINT, m.publicKey, configKp.publicKey);
  mintKp = m;
  console.log(`  mint ${m.publicKey.toBase58()} · pool ${pool.toBase58()}`);
}

const buy = async (amount: number, mode = SwapMode.ExactIn) =>
  send(await client.pool.swap2({ owner: buyer.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null, swapMode: mode, amountIn: new BN(Math.round(amount * LAMPORTS_PER_SOL)), minimumAmountOut: new BN(0) } as never), [buyer], `buy ${amount} SOL`);
await buy(Number(process.env.FIRST_BUY ?? threshold * 0.3)); // a fee to claim

const rewards = new Rewards(join(mkdtempSync(join(tmpdir(), "treasury-")), "rewards.db"), { startDay: "2026-01-01" });
const treasury = new Treasury({ conn, keypair: treasuryKey, mint: mintKp.publicKey, decimals: 6, dbcPool: pool, revenueWallet: buyer.publicKey, jupiter: new JupiterSwapBuilder(), minClaimSol: 0.0001, log: (m) => console.log(`  ${m}`) });

console.log("treasury run 1: claim, split, buy, burn");
const revenueBefore = await bal(buyer);
const r1 = await treasury.tick(rewards);
const st = rewards.stats();
console.log(`  claimed ${r1.claimedSol.toFixed(6)} SOL → revenue ${r1.protocolSol.toFixed(6)} (${((r1.protocolSol / r1.claimedSol) * 100).toFixed(1)}%), buyback ${st.tokenFees.buybackSol.toFixed(6)}`);
console.log(`  revenue wallet +${(await bal(buyer)) - revenueBefore} SOL`);
console.log(`  bought ${r1.boughtTokens.toFixed(0)} WEFT, burned ${r1.burnedTokens.toFixed(0)} (${((r1.burnedTokens / r1.boughtTokens) * 100).toFixed(1)}%), today's pot ${st.todayPotTokens.toFixed(0)}`);
const held = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(mintKp.publicKey, treasuryKey.publicKey)).catch(() => null);
console.log(`  treasury holds ${held?.value.uiAmountString ?? 0} WEFT (= the pot)`);

if (process.env.SKIP_GRADUATION) process.exit(0);
console.log("graduate and migrate");
await buy(threshold * 1.4, SwapMode.PartialFill);
const m = await client.migration.migrateToDammV2({ payer: buyer.publicKey, pool, dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MIGRATION_FEE_OPTION]! });
await send(m.transaction, [buyer, m.firstPositionNftKeypair, m.secondPositionNftKeypair], "migrateToDammV2");
const dammPool = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS[MIGRATION_FEE_OPTION]!, mintKp.publicKey, NATIVE_MINT);
const damm = new CpAmm(conn);
for (const [name, k] of [["treasury", treasuryKey], ["launch", launch]] as const) {
  const ps = await damm.getUserPositionByPool(dammPool, k.publicKey);
  console.log(`  LP positions owned by ${name}: ${ps.length}${ps.length ? ` (liquidity ${ps.map((p) => p.positionState.permanentLockedLiquidity.toString().slice(0, 8)).join(", ")}… permanently locked)` : ""}`);
}
// A trade in the graduated pool, so the locked position has fees to claim.
{
  const st = await damm.fetchPoolState(dammPool);
  const tx = await damm.swap({ payer: buyer.publicKey, pool: dammPool, inputTokenMint: NATIVE_MINT, outputTokenMint: mintKp.publicKey, amountIn: new BN(Math.round(0.05 * LAMPORTS_PER_SOL)), minimumAmountOut: new BN(0), tokenAMint: st.tokenAMint, tokenBMint: st.tokenBMint, tokenAVault: st.tokenAVault, tokenBVault: st.tokenBVault, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null });
  await send(tx, [buyer], "buy 0.05 SOL in the graduated pool");
}
console.log("treasury run 2 (after graduation)");
const r2 = await treasury.tick(rewards);
console.log(`  claimed ${r2.claimedSol.toFixed(6)} SOL from the locked position → revenue ${r2.protocolSol.toFixed(6)} (${r2.claimedSol ? ((r2.protocolSol / r2.claimedSol) * 100).toFixed(1) : 0}%), bought ${r2.boughtTokens.toFixed(0)} WEFT, burned ${r2.burnedTokens.toFixed(0)}`);
console.log(`done: https://explorer.solana.com/address/${mintKp.publicKey.toBase58()}?cluster=devnet`);

process.exit(0);
