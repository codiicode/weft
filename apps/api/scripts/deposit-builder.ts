// Moves the USDC sitting in Weft's builder wallet on Arbitrum into its Hyperliquid account, gas
// paid by the relayer (same permit flow as users' deposits). The builder needs >= 100 USDC there.
// Usage: node --env-file=.env scripts/deposit-builder.ts            (shows balances)
//        node --env-file=.env scripts/deposit-builder.ts --send     (deposits everything)
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { HlDeposits, depositConfigFromEnv } from "../src/live/deposits.ts";

const network = process.env.WEFT_HL_NETWORK === "mainnet" || process.argv.includes("--mainnet") ? "mainnet" : "testnet";
const builder = privateKeyToAccount(JSON.parse(readFileSync(new URL("../../../secrets/weft-builder.json", import.meta.url), "utf8")).privateKey as Hex);
const d = new HlDeposits(depositConfigFromEnv(network));
const st = await d.status("builder", builder.address);
const hl = await fetch(`https://api.hyperliquid${network === "mainnet" ? "" : "-testnet"}.xyz/info`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "clearinghouseState", user: builder.address }),
}).then((r) => r.json() as Promise<{ marginSummary?: { accountValue?: string } }>);
console.log(`builder ${builder.address} on ${network}: ${st.walletUsdc} USDC on ${st.chain}, ${hl.marginSummary?.accountValue ?? 0} USDC on Hyperliquid`);
if (!process.argv.includes("--send")) process.exit(0);
const prep = await d.prepare("builder", builder.address);
const { EIP712Domain: _, ...types } = prep.typedData.types as Record<string, unknown>;
const signature = await builder.signTypedData({ ...(prep.typedData as Record<string, unknown>), types } as never);
const r = await d.submit("builder", signature);
console.log(`deposited ${r.usdc} USDC: ${r.tx}`);
