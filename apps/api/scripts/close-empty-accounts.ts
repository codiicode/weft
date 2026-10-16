// Closes a Weft trading wallet's empty token accounts so their rent goes back to the owner.
// Signs through Privy with Weft's limited signer, after the same inspection as swaps.
// Usage: node --env-file=.env scripts/close-empty-accounts.ts <wallet address> <mint> [<mint>…] [--send]
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { PrivyClient } from "@privy-io/node";
import { JupiterExecutor, JupiterSwapBuilder, type JupiterRpc, type Signer } from "@weft/execution";
import { privySolanaApi } from "../src/live/solana.ts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const send = process.argv.includes("--send");
const [address, ...mints] = args;
if (!address || !mints.length) throw new Error("usage: <wallet address> <mint> [<mint>…] [--send]");
const env = process.env;
const conn = new Connection(env.SOLANA_RPC_URL!, "confirmed");
const api = privySolanaApi(env.PRIVY_APP_ID!, env.PRIVY_APP_SECRET!, env.PRIVY_AUTHORIZATION_KEY || null);

let walletId: string | null = null;
const privy = new PrivyClient({ appId: env.PRIVY_APP_ID!, appSecret: env.PRIVY_APP_SECRET! });
for await (const w of privy.wallets().list({ chain_type: "solana" } as never) as AsyncIterable<{ id: string; address: string }>) if (w.address === address) walletId = w.id;
if (!walletId) throw new Error("no Privy wallet with that address");
const owner = new PublicKey(address);

const signer: Signer = {
  publicKey: owner,
  async signTransaction(tx) {
    const signed = VersionedTransaction.deserialize(await api.signTransaction(walletId!, tx.serialize()));
    if (!Buffer.from(signed.message.serialize()).equals(Buffer.from(tx.message.serialize()))) throw new Error("Privy returned a different transaction");
    return signed;
  },
};
const rpc: JupiterRpc = {
  getAccountInfo: (k) => conn.getAccountInfo(k),
  getAddressLookupTable: (k) => conn.getAddressLookupTable(k),
  sendRawTransaction: (raw, o) => conn.sendRawTransaction(raw, o),
  confirmTransaction: (s, c) => conn.confirmTransaction(s, c),
  emptyTokenAccounts: async (o, mint) =>
    (await conn.getParsedTokenAccountsByOwner(o, { mint }, "confirmed")).value
      .filter((a) => (a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount === "0")
      .map((a) => ({ address: a.pubkey, programId: a.account.owner })),
  getLatestBlockhash: () => conn.getLatestBlockhash("confirmed"),
} as JupiterRpc;

console.log("before:", (await conn.getBalance(owner)) / 1e9, "SOL");
for (const m of mints) {
  const mint = new PublicKey(m);
  const empty = await rpc.emptyTokenAccounts!(owner, mint);
  console.log(m.slice(0, 6), "empty accounts:", empty.map((e) => e.address.toBase58()));
  if (!send || !empty.length) continue;
  const ex = new JupiterExecutor({ builder: new JupiterSwapBuilder({ platformFeeBps: 0 }), signer, rpc, closeRetryMs: 0, onAccountsClosed: (r) => console.log(" ", r) });
  await ex.closeEmptyAccounts(mint);
}
console.log("after:", (await conn.getBalance(owner)) / 1e9, "SOL");
