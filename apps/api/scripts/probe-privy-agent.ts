// Proves Privy-held agent wallets produce valid Hyperliquid signatures, and that the agent
// policy refuses anything that isn't a Hyperliquid L1 action. Testnet only; nothing can fill.
// Usage: node --env-file=.env scripts/probe-privy-agent.ts
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HyperliquidExecutor } from "@weft/execution";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { Accounts } from "../src/lib/accounts.ts";
import { AgentWallets, privyAgentApi } from "../src/live/agents.ts";

const appId = process.env.PRIVY_APP_ID!;
const secret = process.env.PRIVY_APP_SECRET!;
if (!appId || !secret) throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET are required");

const dataDir = process.env.WEFT_DATA_DIR ?? fileURLToPath(new URL("../.data/", import.meta.url));
const accounts = new Accounts(join(dataDir, "accounts.db"));
const api = privyAgentApi(appId, secret);
const agents = new AgentWallets(api, accounts);

const wallet = await agents.forUser("weft-probe");
console.log("probe agent wallet:", wallet.address, `(privy wallet ${wallet.walletId})`);

// 1) A real Hyperliquid order, signed by Privy, sent to TESTNET for an unfunded fake user.
const user = privateKeyToAccount(generatePrivateKey()).address;
const ex = new HyperliquidExecutor({ agentSigner: agents.signer(wallet), userAddress: user, isMainnet: false, builder: null });
const mid = await ex.assets.mid(await ex.assets.perp("ETH"));
const err = await ex
  .placeOrder({
    instrument: { kind: "perp", venue: "hyperliquid", symbol: "ETH", assetClass: "crypto" },
    side: "buy",
    size: { qty: 0.01 },
    type: "limit",
    limitPrice: mid * 0.5,
    tif: "Alo",
    clientId: `privy-probe:${Date.now()}`,
  })
  .then(() => "UNEXPECTED: order accepted", (e: Error) => e.message);
console.log("testnet response:", err);
const recovered = err.toLowerCase().includes(wallet.address.toLowerCase());
console.log(recovered ? "✓ Hyperliquid recovered the Privy agent address from the signature" : "✗ address mismatch");

// 2) The policy must refuse a user-signed action (e.g. a withdraw-style payload, chainId 0x66eee).
const denied = await api
  .signTypedData(wallet.walletId, {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 0x66eee, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: { "HyperliquidTransaction:Withdraw": [{ name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "amount", type: "string" }, { name: "time", type: "uint64" }] },
    primaryType: "HyperliquidTransaction:Withdraw",
    message: { hyperliquidChain: "Testnet", destination: user, amount: "1", time: Date.now() },
  })
  .then(() => false, (e: Error) => (console.log("policy refused withdraw signing:", e.message.slice(0, 160)), true));
console.log(denied ? "✓ policy blocks non-L1 signatures" : "✗ POLICY DID NOT BLOCK A WITHDRAW SIGNATURE");
accounts.close();
process.exit(recovered && denied ? 0 : 1);
