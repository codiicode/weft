// Mainnet test of live liquidity with a dedicated test wallet (secrets/lp-test.json), not a user's:
// opens a small Meteora DLMM position through DlmmExecutor (the same code the app uses, with the same
// transaction inspection), waits, then withdraws it, and reports every transaction and what came back.
//   node --env-file=.env scripts/lp-mainnet-test.ts            plan only (prices, bins, amounts)
//   node --env-file=.env scripts/lp-mainnet-test.ts --send     really deposit $USD and withdraw
// Flags: --usd 5  --pct 0.5 (range ± around the price)  --pool <DLMM pool>  --hold 30 (seconds)
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { DlmmExecutor, JupiterExecutor, JupiterSwapBuilder, type JupiterRpc, type Signer } from "@weft/execution";

const arg = (n: string, d: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d);
const send = process.argv.includes("--send");
const usd = Number(arg("usd", "5"));
const pct = Number(arg("pct", "0.5"));
const holdSec = Number(arg("hold", "30"));
const pool = { kind: "lp" as const, venue: "meteora" as const, pool: arg("pool", "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"), symbol: "SOL-USDC", baseMint: "So11111111111111111111111111111111111111112", quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", quoteSymbol: "USDC" };

const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL("../../../secrets/lp-test.json", import.meta.url), "utf8"))));
/** Test wallet only: signs with a local key (the app signs through the user's Privy wallet). */
const signer: Signer = { publicKey: key.publicKey, async signTransaction(tx: VersionedTransaction) { tx.sign([key]); return tx; } };
const conn = new Connection(process.env.SOLANA_RPC_URL ?? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, "confirmed");
const rpc = {
  getAccountInfo: (k: PublicKey) => conn.getAccountInfo(k),
  getAddressLookupTable: (k: PublicKey) => conn.getAddressLookupTable(k),
  sendRawTransaction: (raw: Uint8Array, o?: { skipPreflight?: boolean; maxRetries?: number }) => conn.sendRawTransaction(raw, o),
  confirmTransaction: (s: { signature: string; blockhash: string; lastValidBlockHeight: number }, c?: "confirmed" | "finalized") => conn.confirmTransaction(s, c),
  tokenBalance: async (owner: PublicKey, mint: PublicKey) => {
    const r = await conn.getParsedTokenAccountsByOwner(owner, { mint });
    return r.value.reduce((n, a) => n + BigInt((a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount ?? "0"), 0n);
  },
  getLatestBlockhash: () => conn.getLatestBlockhash("confirmed"),
} as JupiterRpc;
const key2 = process.env.JUPITER_API_KEY;
const jupiter = new JupiterSwapBuilder(key2 ? { apiKey: key2, baseUrl: "https://api.jup.ag/swap/v1" } : {});
const swaps = new JupiterExecutor({ builder: jupiter, signer, rpc, maxPriorityFeeLamports: 200_000 });
const lpx = new DlmmExecutor({ conn, signer, swaps, jupiter, rpc, maxPriorityFeeLamports: 200_000, log: (m) => console.log(`  ${m}`) });

const sol = async () => (await conn.getBalance(key.publicKey)) / 1e9;
const q = await fetch(`https://dlmm.datapi.meteora.ag/pools/${pool.pool}`).then((r) => r.json() as Promise<{ current_price: number; token_y: { price: number } }>);
const lower = q.current_price * (1 - pct / 100), upper = q.current_price * (1 + pct / 100);
console.log(`test wallet ${key.publicKey.toBase58()} · ${await sol()} SOL`);
console.log(`pool SOL-USDC ${q.current_price.toFixed(3)} · range ${lower.toFixed(3)}–${upper.toFixed(3)} · deposit $${usd}`);
if (!send) {
  console.log("\nplan only. Run with --send to deposit and withdraw for real.");
  process.exit(0);
}

const t0 = Date.now();
const open = await lpx.execute({ clientId: `lp-test:${t0}:open`, instrument: pool, instrumentKey: `meteora:lp:${pool.pool}`, side: "buy", phase: "open", notionalUsd: usd, lp: { lower, upper, poolPrice: q.current_price, quoteUsd: q.token_y.price } });
console.log("open:", JSON.stringify(open));
if (open.status !== "filled" || !open.lp) process.exit(1);
console.log(`  wallet now ${await sol()} SOL; holding ${holdSec}s…`);
await new Promise((r) => setTimeout(r, holdSec * 1000));
const close = await lpx.execute({ clientId: `lp-test:${t0}:close`, instrument: pool, instrumentKey: `meteora:lp:${pool.pool}`, side: "sell", phase: "close", qty: open.qty, lp: { lower, upper, poolPrice: q.current_price, quoteUsd: q.token_y.price, position: open.lp.position } });
console.log("close:", JSON.stringify(close));
console.log(`  wallet now ${await sol()} SOL`);
process.exit(close.status === "filled" ? 0 : 1);
