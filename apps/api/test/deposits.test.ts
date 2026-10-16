import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, parseAbi, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { HlDeposits } from "../src/live/deposits.ts";

const BRIDGE_ABI = parseAbi([
  "struct Signature { uint256 r; uint256 s; uint8 v; }",
  "struct DepositWithPermit { address user; uint64 usd; uint64 deadline; Signature signature; }",
  "function batchedDepositWithPermit(DepositWithPermit[] deposits)",
]);

function fakeChain(balance: bigint, opts: { revert?: string } = {}) {
  const calls: { fn: string; args?: unknown }[] = [];
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => (functionName === "balanceOf" ? balance : 7n),
    simulateContract: async (req: { functionName: string; args: unknown; address: string; abi: unknown }) => {
      calls.push({ fn: "simulate", args: req.args });
      if (opts.revert) throw new Error(opts.revert);
      return { request: req };
    },
    waitForTransactionReceipt: async () => ({ status: "success" }),
    getBalance: async () => 10n ** 15n,
  } as unknown as PublicClient;
  const sent: unknown[] = [];
  const write = async (request: unknown) => {
    sent.push(request);
    return "0xabc" as Hex;
  };
  return { client, write, calls, sent };
}

describe("HlDeposits", () => {
  const user = privateKeyToAccount(generatePrivateKey());
  const relayerKey = generatePrivateKey();

  it("builds a permit for the whole wallet balance into the bridge, and relays it once the user signs", async () => {
    const chain = fakeChain(25_500_000n); // 25.5 USDC
    const d = new HlDeposits({ network: "mainnet", relayerKey }, chain);
    const prep = await d.prepare("u1", user.address);
    expect(prep.usdc).toBe(25.5);
    expect(prep.typedData.domain).toMatchObject({ name: "USD Coin", version: "2", chainId: 42161 });
    expect(prep.typedData.message).toMatchObject({ owner: user.address, spender: "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7", value: "25500000", nonce: "7" });

    const { EIP712Domain: _, ...types } = prep.typedData.types;
    const signature = await user.signTypedData({ domain: prep.typedData.domain, types, primaryType: "Permit", message: prep.typedData.message as never });
    const r = await d.submit("u1", signature);
    expect(r).toEqual({ tx: "0xabc", usdc: 25.5 });
    expect(chain.sent).toHaveLength(1);

    const req = chain.sent[0] as { address: string; abi: typeof BRIDGE_ABI; functionName: string; args: readonly [readonly { user: string; usd: bigint; deadline: bigint }[]] };
    expect(req.functionName).toBe("batchedDepositWithPermit");
    expect(req.args[0][0]).toMatchObject({ user: user.address, usd: 25_500_000n });
    // Encodes to the selector found in the deployed bridge's bytecode, and decodes back to the same deposit.
    const data = encodeFunctionData({ abi: BRIDGE_ABI, functionName: "batchedDepositWithPermit", args: req.args as never });
    expect(data.slice(0, 10)).toBe("0xb30b5bce");
    const back = decodeFunctionData({ abi: BRIDGE_ABI, data }).args[0][0] as { user: string; signature: { v: number } };
    expect(back.user).toBe(user.address);
    expect([27, 28]).toContain(back.signature.v);

    // The permit is single-use.
    await expect(d.submit("u1", signature)).rejects.toThrow(/no pending deposit/);
  });

  it("refuses a signature from anyone but the wallet owner, and amounts below Hyperliquid's minimum", async () => {
    const chain = fakeChain(10_000_000n);
    const d = new HlDeposits({ network: "testnet", relayerKey }, chain);
    const prep = await d.prepare("u2", user.address);
    expect(prep.typedData.domain).toMatchObject({ name: "USDC2", version: "1", chainId: 421614 });
    const stranger = privateKeyToAccount(generatePrivateKey());
    const { EIP712Domain: _, ...types } = prep.typedData.types;
    const bad = await stranger.signTypedData({ domain: prep.typedData.domain, types, primaryType: "Permit", message: prep.typedData.message as never });
    await expect(d.submit("u2", bad)).rejects.toThrow(/isn't from your wallet/);
    expect(chain.sent).toHaveLength(0);

    const small = new HlDeposits({ network: "testnet", relayerKey }, fakeChain(4_990_000n));
    await expect(small.prepare("u3", user.address)).rejects.toThrow(/at least 5 USDC/);
  });

  it("spends no gas when the simulation fails, and clears the in-flight deposit", async () => {
    const chain = fakeChain(6_000_000n, { revert: "execution reverted: permit expired" });
    const d = new HlDeposits({ network: "mainnet", relayerKey }, chain);
    const prep = await d.prepare("u4", user.address);
    const { EIP712Domain: _, ...types } = prep.typedData.types;
    const sig = await user.signTypedData({ domain: prep.typedData.domain, types, primaryType: "Permit", message: prep.typedData.message as never });
    await expect(d.submit("u4", sig)).rejects.toThrow(/permit expired/);
    expect(chain.sent).toHaveLength(0);
    expect((await d.status("u4", user.address)).inFlight).toBeNull();
  });

  it("without a relayer key, deposits through Weft are off", async () => {
    const d = new HlDeposits({ network: "mainnet", relayerKey: null }, fakeChain(9_000_000n));
    expect((await d.status("u5", user.address)).relayer.ready).toBe(false);
    await expect(d.prepare("u5", user.address)).rejects.toThrow(/aren't set up/);
  });
});
