// $WEFT on Meteora's Dynamic Bonding Curve.
//   node scripts/token.ts plan      the curve's numbers (start and graduation market cap, what buys get), no chain
//   node scripts/token.ts devnet    the whole life of the token on devnet with throwaway wallets: config,
//                                   pool with metadata, buy, sell, buy to graduation, migrate to DAMM v2,
//                                   claim Weft's trading fees. Uses a 0.5 SOL threshold so a faucet can reach it.
// Mainnet launch is deliberately not here yet: it needs the real fee wallet and a final go.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  SwapMode,
  U64_MAX,
  deriveDbcPoolAddress,
  getCurrentPoint,
  getQuoteFromInputAmount,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { LAUNCH_FEE, MIGRATION_FEE_OPTION, TOKEN_FEE, WEFT_TOKEN, weftCurve } from "../src/token/curve.ts";

const sol = (lamports: BN | number | bigint) => Number(lamports.toString()) / LAMPORTS_PER_SOL;
const tokens = (raw: BN | number | bigint) => Number(raw.toString()) / 10 ** WEFT_TOKEN.decimals;
const fmt = (n: number, d = 4) => n.toLocaleString("en-US", { maximumFractionDigits: d });

function plan(threshold = 85) {
  // Quotes below are after the launch minute, at the steady 3%.
  const cfg = weftCurve({ migrationQuoteThreshold: threshold, launchFee: false });
  const q = (amount: number) => getQuoteFromInputAmount({ config: cfg, swapBaseForQuote: false, amountIn: new BN(Math.round(amount * LAMPORTS_PER_SOL)), slippageBps: 100 } as never) as unknown as { outputAmount: BN; tradingFee: BN; protocolFee: BN };
  // price at the very start, from a tiny buy
  const tiny = q(0.001);
  const startPrice = 0.001 / tokens(tiny.outputAmount);
  console.log(`$${WEFT_TOKEN.symbol}: ${fmt(WEFT_TOKEN.supply, 0)} supply, ${WEFT_TOKEN.decimals} decimals, priced in SOL`);
  console.log(`graduates at ${threshold} SOL in the curve; 20% of the supply goes into the DAMM v2 pool, locked`);
  console.log(`trading fee ${TOKEN_FEE.totalBps / 100}%: Meteora ${TOKEN_FEE.meteoraBps / 100}%, $WEFT buybacks ${TOKEN_FEE.buybackBps / 100}%, Weft ${TOKEN_FEE.protocolBps / 100}%`);
  const step = (LAUNCH_FEE.startBps - TOKEN_FEE.totalBps) / LAUNCH_FEE.periods;
  console.log(`launch: ${LAUNCH_FEE.startBps / 100}% when trading opens, −${step / 100} points a second, ${TOKEN_FEE.totalBps / 100}% from ${LAUNCH_FEE.durationSec} s (${[0, 15, 30, 45, 60].map((s) => `${s} s ${((LAUNCH_FEE.startBps - step * Math.min(s, LAUNCH_FEE.periods)) / 100).toFixed(2)}%`).join(", ")})`);
  console.log(`start price ${startPrice.toExponential(3)} SOL → market cap ≈ ${fmt(startPrice * WEFT_TOKEN.supply, 1)} SOL`);
  for (const a of [0.1, 1, 10]) {
    const r = q(a);
    // tradingFee is what's left for Weft after Meteora's protocol share
    console.log(`buy ${a} SOL → ${fmt(tokens(r.outputAmount), 0)} WEFT (${fmt((tokens(r.outputAmount) / WEFT_TOKEN.supply) * 100, 3)}% of supply), fee ${fmt(sol(r.tradingFee) + sol(r.protocolFee), 5)} SOL: Weft ${fmt(sol(r.tradingFee), 5)} (buybacks ${fmt(sol(r.tradingFee) / 6, 5)}), Meteora ${fmt(sol(r.protocolFee), 5)}`);
  }
}

async function send(conn: Connection, tx: Transaction, signers: Keypair[], label: string) {
  tx.feePayer = signers[0]!.publicKey;
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  console.log(`  ${label}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  return sig;
}

function wallet(path: string) {
  if (existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  const k = Keypair.generate();
  mkdirSync(new URL("../../../secrets/", import.meta.url).pathname, { recursive: true });
  writeFileSync(path, JSON.stringify([...k.secretKey]));
  return k;
}

async function fund(conn: Connection, who: PublicKey, want: number) {
  let have = sol(await conn.getBalance(who));
  for (let i = 0; have < want && i < 4; i++) {
    try {
      const sig = await Promise.race([conn.requestAirdrop(who, 1 * LAMPORTS_PER_SOL), new Promise<never>((_, no) => setTimeout(() => no(new Error("timed out")), 20_000))]);
      await conn.confirmTransaction(sig, "confirmed");
    } catch (e) {
      console.log(`  airdrop refused (${(e as Error).message.slice(0, 80)}); fund ${who.toBase58()} at https://faucet.solana.com`);
      break;
    }
    have = sol(await conn.getBalance(who));
  }
  console.log(`  ${who.toBase58().slice(0, 8)}… has ${fmt(have)} SOL`);
  return have;
}

async function devnet() {
  const conn = new Connection(process.env.DEVNET_RPC ?? "https://api.devnet.solana.com", "confirmed");
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const dir = new URL("../../../secrets/", import.meta.url).pathname;
  // Throwaway devnet wallets, kept so a rerun can reuse their SOL. Weft = partner, fee claimer, pool creator.
  const weft = wallet(`${dir}devnet-weft.json`);
  const buyer = wallet(`${dir}devnet-buyer.json`);
  console.log("wallets");
  await fund(conn, weft.publicKey, 0.5);
  const threshold = Number(process.env.TEST_THRESHOLD ?? 0.5);
  let funds = await fund(conn, buyer.publicKey, threshold * 1.4 + 0.3);
  // When the faucet is stingy, Weft's test wallet passes on what it doesn't need.
  const spare = sol(await conn.getBalance(weft.publicKey)) - 0.15;
  const short = threshold * 1.4 + 0.3 - funds;
  if (short > 0 && spare > 0.05) {
    const move = Math.min(short, spare);
    await send(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: weft.publicKey, toPubkey: buyer.publicKey, lamports: Math.floor(move * LAMPORTS_PER_SOL) })), [weft], `move ${fmt(move, 3)} SOL to the buyer`);
    funds = sol(await conn.getBalance(buyer.publicKey));
  }
  if (funds < threshold * 1.3 + 0.15) throw new Error(`the buyer needs about ${fmt(threshold * 1.4 + 0.3, 2)} SOL on devnet to reach graduation; use the faucet link above and rerun`);

  const resume = process.env.POOL && process.env.MINT ? { pool: new PublicKey(process.env.POOL), mint: new PublicKey(process.env.MINT) } : null;
  let pool: PublicKey, mint: PublicKey, openedAt = 0;
  if (resume) ({ pool, mint } = resume);
  else {
  console.log(`config (${threshold} SOL threshold for the test; mainnet uses 85)`);
  const configKp = Keypair.generate();
  const params = weftCurve({ migrationQuoteThreshold: threshold });
  const cfgTx = await client.partner.createConfig2({ payer: weft.publicKey, config: configKp.publicKey, feeClaimer: weft.publicKey, leftoverReceiver: weft.publicKey, quoteMint: NATIVE_MINT, ...params, transferFeeParameters: null });
  await send(conn, cfgTx, [weft, configKp], "createConfig2");

  console.log("pool with metadata");
  const mintKp = Keypair.generate();
  const poolTx = await client.creator.createPool({ baseMint: mintKp.publicKey, config: configKp.publicKey, name: `${WEFT_TOKEN.name} (devnet test)`, symbol: WEFT_TOKEN.symbol, uri: WEFT_TOKEN.uri, payer: weft.publicKey, poolCreator: weft.publicKey });
  await send(conn, poolTx, [weft, mintKp], "createPool");
  openedAt = Date.now();
  pool = deriveDbcPoolAddress(NATIVE_MINT, mintKp.publicKey, configKp.publicKey);
  mint = mintKp.publicKey;
  console.log(`  mint ${mint.toBase58()}`);
  console.log(`  pool ${pool.toBase58()}`);
  }

  const ata = getAssociatedTokenAddressSync(mint, buyer.publicKey);
  const held = async () => {
    const b = await conn.getTokenAccountBalance(ata).catch(() => null);
    return b ? Number(b.value.amount) : 0;
  };
  const buy = async (amountSol: number, mode: SwapMode = SwapMode.ExactIn) => {
    const vp = (await client.state.getPool(pool))!;
    const cfg = (await client.state.getPoolConfig(vp.poolState.config))!;
    const amountIn = new BN(Math.round(amountSol * LAMPORTS_PER_SOL));
    // A partial fill buys up to graduation and hands back the rest, so an exact-in quote doesn't apply.
    const q = mode === SwapMode.PartialFill ? null : client.pool.swapQuote({ virtualPool: vp, config: cfg, swapBaseForQuote: false, amountIn, slippageBps: 300, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint: await getCurrentPoint(conn, cfg.activationType) });
    const tx = await client.pool.swap2({ owner: buyer.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null, swapMode: mode, amountIn, minimumAmountOut: q ? q.minimumAmountOut : new BN(0) } as never);
    const feePct = q ? ((sol(q.tradingFee) + sol(q.protocolFee)) / amountSol) * 100 : 0;
    await send(conn, tx, [buyer], q ? `buy ${amountSol} SOL (quoted ${fmt(tokens(q.outputAmount), 0)} WEFT, fee ${fmt(feePct, 2)}%)` : `buy up to ${amountSol} SOL, partial fill to graduation`);
  };

  if (!resume) {
  console.log("buy and sell on the curve");
  await buy(threshold * 0.2);
  const afterBuy = await held();
  console.log(`  holds ${fmt(tokens(afterBuy), 0)} WEFT`);
  // the launch fee falls to 3% over the first minute; sell and graduate after it
  const wait = openedAt + (LAUNCH_FEE.durationSec + 3) * 1000 - Date.now();
  if (wait > 0) { console.log(`  waiting ${Math.ceil(wait / 1000)} s for the launch fee to reach ${TOKEN_FEE.totalBps / 100}%`); await new Promise((r) => setTimeout(r, wait)); }
  await buy(threshold * 0.02);
  const solBefore = sol(await conn.getBalance(buyer.publicKey));
  const sellTx = await client.pool.swap({ owner: buyer.publicKey, pool, swapBaseForQuote: true, amountIn: new BN(Math.floor(afterBuy / 2)), minimumAmountOut: new BN(0), referralTokenAccount: null });
  await send(conn, sellTx, [buyer], "sell half");
  console.log(`  got back ${fmt(sol(await conn.getBalance(buyer.publicKey)) - solBefore, 5)} SOL (after network fees)`);
  }

  console.log("buy to graduation");
  await buy(threshold * 1.3, SwapMode.PartialFill);
  const progress = await client.state.getPoolQuoteTokenCurveProgress(pool);
  const vp = (await client.state.getPool(pool))!;
  console.log(`  curve progress ${fmt(progress * 100, 1)}%, quote reserve ${fmt(sol(vp.poolState.quoteReserve))} SOL`);

  console.log("migrate to DAMM v2 (Meteora's keeper does this on mainnet; on devnet we call it)");
  try {
    const m = await client.migration.migrateToDammV2({ payer: weft.publicKey, pool, dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MIGRATION_FEE_OPTION]! });
    await send(conn, m.transaction, [weft, m.firstPositionNftKeypair, m.secondPositionNftKeypair], "migrateToDammV2");
  } catch (e) {
    console.log(`  migration not done here: ${(e as Error).message.slice(0, 200)}`);
  }
  const after = (await client.state.getPool(pool))!;
  console.log(`  migrated: ${after.poolState.isMigrated}`);

  console.log("Weft claims its trading fees");
  const metrics = await client.state.getPoolFeeMetrics(pool);
  // BN amounts in lamports (toString is decimal)
  const lamports = (v: unknown) => (v == null ? 0 : sol(new BN(String(v))));
  console.log(`  unclaimed: ${fmt(lamports(metrics.current.partnerQuoteFee), 6)} SOL for Weft (of ${fmt(lamports(metrics.total.totalTradingQuoteFee), 6)} SOL in trading fees)`);
  const before = sol(await conn.getBalance(weft.publicKey));
  const claimTx = await client.partner.claimPartnerTradingFee({ feeClaimer: weft.publicKey, payer: weft.publicKey, pool, maxBaseAmount: new BN(0), maxQuoteAmount: U64_MAX, receiver: weft.publicKey });
  await send(conn, claimTx, [weft], "claimPartnerTradingFee");
  console.log(`  Weft wallet +${fmt(sol(await conn.getBalance(weft.publicKey)) - before, 5)} SOL (after network fees)`);
  console.log(`done: https://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet`);
}

const cmd = process.argv[2];
if (cmd === "plan") plan(Number(process.argv[3] ?? 85));
else if (cmd === "devnet") await devnet();
else console.log("usage: node scripts/token.ts plan [threshold] | devnet");
process.exit(0);
