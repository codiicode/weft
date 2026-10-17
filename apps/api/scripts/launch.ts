// Launch $WEFT on Meteora's Dynamic Bonding Curve.
//   node scripts/launch.ts --network devnet               a full rehearsal on devnet (small threshold)
//   node scripts/launch.ts --network mainnet              prints the plan, sends nothing
//   node scripts/launch.ts --network mainnet --send       launches for real
//
// One run, three transactions:
//   1. the curve's config: Weft's settings, with the treasury as fee claimer (it collects the 2.4% on
//      every $WEFT trade and owns Weft's locked liquidity after graduation);
//   2. the pool and the token, with Weft's dev buy (--dev-buy SOL, default 1) in the same transaction
//      so nobody can buy before it; that one swap pays the minimum fee, not the launch fee;
//   3. a burn of every token the dev buy got. No team tokens.
// Keys: the launch wallet signs (secrets/weft-launch.json; devnet: devnet-weft.json); only the
// treasury's public key is read (secrets/weft-treasury.json; devnet: devnet-treasury.json).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT, createBurnCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { DynamicBondingCurveClient, deriveDbcPoolAddress, getQuoteFromInputAmount } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { LAUNCH_FEE, TOKEN_FEE, WEFT_TOKEN, weftCurve } from "../src/token/curve.ts";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? "") : dflt;
};
const network = arg("network", "devnet") as "devnet" | "mainnet";
if (network !== "devnet" && network !== "mainnet") throw new Error("--network devnet|mainnet");
const sendIt = network === "devnet" || process.argv.includes("--send");
const threshold = Number(arg("threshold", network === "mainnet" ? "85" : "0.06"));
const devBuy = Number(arg("dev-buy", network === "mainnet" ? "1" : "0.02"));
// A throwaway test launch: its own name, symbol and metadata, no link to Weft's treasury.
const test = process.argv.includes("--test");
const TOKEN = test ? { name: arg("name", "TEST")!, symbol: arg("symbol", "TEST")!, uri: arg("uri", "https://weft.fi/token/test.json")! } : { name: WEFT_TOKEN.name, symbol: WEFT_TOKEN.symbol, uri: WEFT_TOKEN.uri };
const signerFile = arg("wallet", network === "mainnet" ? "weft-launch" : "devnet-weft")!;

const secrets = new URL("../../../secrets/", import.meta.url).pathname;
const load = (name: string) => {
  const p = `${secrets}${name}.json`;
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
};
const launch = load(signerFile);
const treasury = test ? load(signerFile).publicKey : load(network === "mainnet" ? "weft-treasury" : "devnet-treasury").publicKey;
const rpc = network === "mainnet" ? process.env.SOLANA_RPC_URL ?? (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "https://api.mainnet-beta.solana.com") : process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
const conn = new Connection(rpc, "confirmed");
const client = new DynamicBondingCurveClient(conn, "confirmed");
const explorer = (kind: "tx" | "address", id: string) => `https://explorer.solana.com/${kind}/${id}${network === "devnet" ? "?cluster=devnet" : ""}`;
const fmt = (n: number, d = 4) => n.toLocaleString("en-US", { maximumFractionDigits: d });

const params = weftCurve({ migrationQuoteThreshold: threshold });
const lamports = new BN(Math.round(devBuy * LAMPORTS_PER_SOL));
// What the dev buy gets at the minimum fee (the steady fee, not the launch fee).
const quote = getQuoteFromInputAmount({ config: weftCurve({ migrationQuoteThreshold: threshold, launchFee: false }), swapBaseForQuote: false, amountIn: lamports, slippageBps: 100 } as never) as unknown as { outputAmount: BN; minimumAmountOut: BN };
const expected = Number(quote.outputAmount.toString()) / 10 ** WEFT_TOKEN.decimals;
const balance = (await conn.getBalance(launch.publicKey)) / LAMPORTS_PER_SOL;

console.log(`$WEFT launch on ${network}`);
console.log(`  launch wallet  ${launch.publicKey.toBase58()} · ${fmt(balance)} SOL`);
console.log(`  fee claimer    ${treasury.toBase58()} (${test ? "the launch wallet itself: a test, nothing goes to Weft" : "treasury"})`);
console.log(`  curve          graduates at ${threshold} SOL · fee ${LAUNCH_FEE.startBps / 100}% → ${TOKEN_FEE.totalBps / 100}% over ${LAUNCH_FEE.durationSec} s, then ${TOKEN_FEE.totalBps / 100}%`);
console.log(devBuy > 0 ? `  dev buy        ${devBuy} SOL → about ${fmt(expected, 0)} ${TOKEN.symbol} (${fmt((expected / WEFT_TOKEN.supply) * 100, 2)}% of supply), all burned` : "  dev buy        none");
console.log(`  token          ${TOKEN.name} (${TOKEN.symbol}) · ${TOKEN.uri} · no mint authority · metadata authority: the launch wallet`);
const need = devBuy + (devBuy > 0 ? 0.06 : 0.04);
if (balance < need) throw new Error(`the launch wallet needs about ${fmt(need, 2)} SOL (has ${fmt(balance)})`);
if (!sendIt) {
  console.log("\nNothing sent. Run again with --send to launch.");
  process.exit(0);
}

const send = async (tx: Transaction, signers: Keypair[], label: string) => {
  tx.feePayer = launch.publicKey;
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  console.log(`  ${label}: ${explorer("tx", sig)}`);
  return sig;
};

const configKp = Keypair.generate(), mintKp = Keypair.generate();
const record: Record<string, string | number> = { network, at: new Date().toISOString(), config: configKp.publicKey.toBase58(), mint: mintKp.publicKey.toBase58(), feeClaimer: treasury.toBase58(), threshold, devBuySol: devBuy };
const save = () => writeFileSync(`${secrets}launch-${network}${test ? "-test" : ""}.json`, JSON.stringify(record, null, 2));
save();

console.log("\n1. config");
record.configTx = await send(
  await client.partner.createConfig2({ payer: launch.publicKey, config: configKp.publicKey, feeClaimer: treasury, leftoverReceiver: treasury, quoteMint: NATIVE_MINT, ...params, transferFeeParameters: null } as never),
  [launch, configKp],
  "createConfig2"
);
save();

console.log("2. pool, token and dev buy");
const pool = deriveDbcPoolAddress(NATIVE_MINT, mintKp.publicKey, configKp.publicKey);
record.pool = pool.toBase58();
const ata = getAssociatedTokenAddressSync(mintKp.publicKey, launch.publicKey);
const createPoolParam = { baseMint: mintKp.publicKey, config: configKp.publicKey, name: TOKEN.name, symbol: TOKEN.symbol, uri: TOKEN.uri, payer: launch.publicKey, poolCreator: launch.publicKey };
record.poolTx = await send(
  devBuy > 0
    ? await client.creator.createPoolWithFirstBuy({ createPoolParam, firstBuyParam: { buyer: launch.publicKey, receiver: launch.publicKey, buyAmount: lamports, minimumAmountOut: quote.minimumAmountOut, referralTokenAccount: null } })
    : await client.creator.createPool(createPoolParam),
  [launch, mintKp],
  devBuy > 0 ? "createPoolWithFirstBuy" : "createPool"
);
save();
if (devBuy <= 0) {
  console.log(`\nlaunched: ${explorer("address", mintKp.publicKey.toBase58())}\n  mint ${record.mint}\n  pool ${record.pool}`);
  process.exit(0);
}
const got = BigInt((await conn.getTokenAccountBalance(ata)).value.amount);
const gotUi = Number(got) / 10 ** WEFT_TOKEN.decimals;
console.log(`  dev buy got ${fmt(gotUi, 0)} WEFT (${fmt((gotUi / WEFT_TOKEN.supply) * 100, 3)}% of supply)`);

console.log("3. burn the dev buy");
record.burnTx = await send(new Transaction().add(createBurnCheckedInstruction(ata, mintKp.publicKey, launch.publicKey, got, WEFT_TOKEN.decimals)), [launch], `burn ${fmt(gotUi, 0)} WEFT`);
record.burnedTokens = gotUi;
save();

console.log(`\nlaunched: ${explorer("address", mintKp.publicKey.toBase58())}`);
console.log(`  mint ${record.mint}\n  pool ${record.pool}\n  saved to secrets/launch-${network}.json`);
console.log("Next: set WEFT_TOKEN_MINT, WEFT_DBC_POOL, WEFT_REWARDS_START, WEFT_HOLDER_MIN and WEFT_TREASURY_KEY on the server.");

process.exit(0);
