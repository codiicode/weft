import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { HyperliquidExecutor } from "../src/hyperliquid/executor.ts";

/**
 * Opt-in live probe (HL_TESTNET_PROBE=1): sends ONE order to the Hyperliquid TESTNET /exchange
 * endpoint, signed by a freshly generated, unfunded, unregistered agent key. The venue must parse
 * the payload and recover our signer, then reject because that wallet does not exist. Nothing
 * can fill. Never mainnet, never real keys.
 */
describe.skipIf(process.env.HL_TESTNET_PROBE !== "1")("hyperliquid testnet probe", () => {
  it("testnet parses our signed order and recovers the throwaway agent address", async () => {
    const key = generatePrivateKey();
    const agent = privateKeyToAccount(key);
    const user = privateKeyToAccount(generatePrivateKey()).address;
    const ex = new HyperliquidExecutor({ agentPrivateKey: key, userAddress: user, isMainnet: false, builder: null });
    const mid = await ex.assets.mid(await ex.assets.perp("ETH"));
    console.log("throwaway testnet agent:", agent.address);
    // A top-level venue error ("status": "err") makes placeOrder throw with the venue's message.
    const err = await ex
      .placeOrder({
        instrument: { kind: "perp", venue: "hyperliquid", symbol: "ETH", assetClass: "crypto" },
        side: "buy",
        size: { qty: 0.01 },
        type: "limit",
        limitPrice: mid * 0.5, // far below market: could never fill even if the wallet existed
        tif: "Alo",
        clientId: `probe:${Date.now()}`,
      })
      .then(
        () => null,
        (e: Error) => e.message
      );
    console.log("testnet response:", err);
    expect(err).toMatch(/does not exist/i);
    // The address the venue recovered from our signature must be our agent.
    expect(err!.toLowerCase()).toContain(agent.address.toLowerCase());
  }, 30_000);
});
