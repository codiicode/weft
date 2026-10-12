import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { inspectSwapTransaction } from "../src/solana/inspect.ts";
import { JupiterSwapBuilder } from "../src/solana/jupiter.ts";
import { associatedTokenAddress, WSOL_MINT } from "../src/solana/programs.ts";

/**
 * Opt-in (JUP_LIVE=1): build a REAL Jupiter swap for a throwaway public key and inspect it.
 * Read-only: the transaction is never signed or sent (the key is never even generated as a
 * signer we keep). Mainnet RPC is used only for getAddressLookupTable / getAccountInfo.
 */
describe.skipIf(process.env.JUP_LIVE !== "1")("jupiter live (read-only)", () => {
  it("quote → swap tx for a throwaway key passes inspection with the platform fee account", async () => {
    const JUP = new PublicKey("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN");
    const user = Keypair.generate().publicKey;
    // Fee account: an ATA for the output mint (Jupiter only requires the mint to be in the pair).
    const feeAccount = associatedTokenAddress(Keypair.generate().publicKey, JUP);
    const builder = new JupiterSwapBuilder({ platformFeeBps: 50, feeAccounts: { [JUP.toBase58()]: feeAccount } });
    const quote = await builder.quote({ inputMint: WSOL_MINT, outputMint: JUP, amount: 10_000_000n, slippageBps: 50 });
    expect(quote.platformFee?.feeBps).toBe(50);
    const swap = await builder.buildSwap({ quote, userPublicKey: user });
    const rpc = new Connection(process.env.SOLANA_RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
    const report = await inspectSwapTransaction(swap.transaction, {
      user,
      rpc,
      platformFeeAccount: swap.feeAccount,
      maxPriorityFeeLamports: 1_000_000,
      maxWrapLamports: BigInt(quote.inAmount),
    });
    console.log(report.instructions.map((i) => i.name).join(" → "), report.warnings);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.instructions.some((i) => i.name.startsWith("jupiter."))).toBe(true);
  }, 60_000);
});
