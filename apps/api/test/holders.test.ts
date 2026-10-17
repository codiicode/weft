import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { HolderDiscount } from "../src/live/holders.ts";

const MINT = new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
const A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const B = "3ytkirrxK9Hy3GwYUnaumouCUfWwvsWP5z1RCar3BUXc";

describe("$WEFT holder tiers", () => {
  const make = (balances: Record<string, number>, mint: PublicKey | null = MINT) =>
    new HolderDiscount({ mint, minAmount: 100_000, discount: 0.25, bigAmount: 1_000_000, bigDiscount: 0.5 }, { wallets: async () => [A, B, "not-an-address"], balance: async (owner) => balances[owner.toBase58()] ?? 0 });

  it("Holder from 100,000 across the user's wallets: 25% off", async () => {
    const s = await make({ [A]: 60_000, [B]: 50_000 }).status("u");
    expect(s).toMatchObject({ active: true, tier: 1, holds: 110_000, discount: 0.25, feeMultiplier: 0.75 });
  });

  it("Whale from 1,000,000: 50% off", async () => {
    expect(await make({ [A]: 1_000_000 }).status("u")).toMatchObject({ tier: 2, discount: 0.5, feeMultiplier: 0.5 });
  });

  it("charges the full fee below the threshold, and stays off before the token exists", async () => {
    expect((await make({ [A]: 99_999 }).status("u")).feeMultiplier).toBe(1);
    const off = make({ [A]: 5_000_000 }, null);
    expect(off.enabled).toBe(false);
    expect((await off.status("u")).feeMultiplier).toBe(1);
  });
});
