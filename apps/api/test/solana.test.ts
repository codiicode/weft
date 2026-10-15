import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { validateStrategy, type Strategy, type StrategyInput } from "@weft/strategy";
import { Accounts } from "../src/lib/accounts.ts";
import { SolanaLive, publicKeyFromPkcs8, tradesSolana, type PrivySolanaApi, type SolanaLiveConfig } from "../src/live/solana.ts";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const strategy = (actions: unknown[]): Strategy => {
  const v = validateStrategy({
    schemaVersion: 1,
    id: "sol-test",
    name: "Sol test",
    thesis: "t",
    signals: [{ id: "p", kind: "price", params: { instrument: { kind: "token", chain: "solana", mint: MINT, quote: "SOL", route: "auto", assetClass: "crypto" } } }],
    triggers: [{ id: "go", when: { op: "gt", left: { ref: "p.price" }, right: { value: 0 } } }],
    actions,
  } as StrategyInput);
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return v.strategy;
};
const buyToken = { id: "b", on: ["go"], type: "open", instrument: { kind: "token", chain: "solana", mint: MINT, quote: "SOL", route: "auto", assetClass: "crypto" }, side: "long", size: { unit: "usd", value: 50 }, order: { type: "market", maxSlippageBps: 300 }, exits: { stopLoss: { pct: 20 } }, reentry: "never" };
const longBtc = { id: "l", on: ["go"], type: "open", instrument: { kind: "perp", venue: "hyperliquid", symbol: "BTC", assetClass: "crypto" }, side: "long", size: { unit: "usd", value: 50 }, leverage: 1, order: { type: "market" }, exits: { stopLoss: { pct: 5 } }, reentry: "never" };

function setup(cfg: Partial<SolanaLiveConfig> = {}, delegated = true) {
  const accounts = new Accounts(join(mkdtempSync(join(tmpdir(), "weft-sol-")), "a.db"));
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const calls: string[] = [];
  const api: PrivySolanaApi = {
    async createSigner(pub) {
      calls.push(`signer:${pub.length > 50}`);
      return "kq_1";
    },
    async createPolicy() {
      calls.push("policy");
      return "pol_1";
    },
    async userWallets(userId) {
      return userId === "alice" ? [{ walletId: "w_1", address: WALLET, delegated }] : [];
    },
    async signTransaction() {
      throw new Error("not in tests");
    },
  };
  const conn = { getBalance: async () => 0.5e9, getParsedTokenAccountsByOwner: async () => ({ value: [] }) } as never;
  const live = new SolanaLive({ enabled: true, rpcUrl: "http://x", maxAllocationUsd: 1000, platformFeeBps: 50, feeWallet: null, authorizationKey: pkcs8, testers: [], ...cfg }, accounts, { ...api, userIdByEmail: async (e) => (e === "alice@example.com" ? "alice" : null) }, conn);
  return { live, accounts, calls, pkcs8 };
}

describe("Solana live", () => {
  it("creates Weft's signer and policy once, from the server's own key", async () => {
    const { live, calls, pkcs8 } = setup();
    expect(await live.signer()).toEqual({ signerId: "kq_1", policyId: "pol_1" });
    await live.signer();
    expect(calls).toEqual(["signer:true", "policy"]);
    expect(publicKeyFromPkcs8(pkcs8)).toMatch(/^MFkw/); // SPKI P-256 in base64
  });

  it("links only the user's own wallet, and only once Weft is its signer", async () => {
    const { live } = setup({}, false);
    await expect(live.link("alice", WALLET)).rejects.toThrow(/signer/);
    await expect(live.link("bob", WALLET)).rejects.toThrow(/isn’t one of your/);
    const ok = setup();
    const s = await ok.live.link("alice", WALLET);
    expect(s.wallet).toEqual({ address: WALLET, delegated: true });
    expect(s.ready).toBe(true);
    expect(s.balances?.sol).toBe(0.5);
  });

  it("checks runs before they start and before every order", async () => {
    const { live } = setup();
    expect(() => live.assertDeployable("alice", strategy([buyToken]), 100)).toThrow(/trading wallet/);
    await live.link("alice", WALLET);
    expect(() => live.assertDeployable("alice", strategy([buyToken]), 100)).not.toThrow();
    expect(() => live.assertDeployable("alice", strategy([buyToken]), 5000)).toThrow(/capped/);
    expect(() => live.assertDeployable("alice", strategy([buyToken, longBtc]), 100)).toThrow(/not both/);
    expect(() => live.assertDeployable("alice", strategy([buyToken]), 100, new Set([MINT]))).toThrow(/already trades/);
    expect(live.blockReason("alice")).toBeNull();
    expect(live.blockReason("bob")).toMatch(/no Solana/);
    expect(tradesSolana(strategy([buyToken]))).toBe(true);
    expect(tradesSolana(strategy([longBtc]))).toBe(false);
  });

  it("stays off until switched on, except for testers resolved through Privy", async () => {
    const { live } = setup({ enabled: false, testers: ["alice@example.com", "nobody@example.com"] });
    expect((await live.status("alice")).blockers[0]).toMatch(/switched on/);
    expect(live.blockReason("alice")).toMatch(/switched off/);
    expect(await live.resolveTesters()).toEqual({ resolved: 1, missing: ["no…@example.com"] });
    expect(live.openFor("alice")).toBe(true);
    expect(live.openFor("bob")).toBe(false);
    expect(live.blockReason("alice")).not.toMatch(/switched off/);
  });
});
