import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { HolderDiscount } from "../src/live/holders.ts";

const MINT = new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
const A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const B = "3ytkirrxK9Hy3GwYUnaumouCUfWwvsWP5z1RCar3BUXc";

describe("$WEFT holder discount", () => {
  const make = (min: number, balances: Record<string, number>, mint: PublicKey | null = MINT) =>
    new HolderDiscount({ mint, minAmount: min, discount: 0.5 }, { wallets: async () => [A, B, "not-an-address"], balance: async (owner) => balances[owner.toBase58()] ?? 0 });

  it("halves the fee when the user's wallets together hold enough", async () => {
    const s = await make(1000, { [A]: 600, [B]: 500 }).status("u");
    expect(s).toMatchObject({ active: true, holds: 1100, feeMultiplier: 0.5 });
  });

  it("charges the full fee below the threshold, and stays off before the token exists", async () => {
    expect((await make(1000, { [A]: 999 }).status("u")).feeMultiplier).toBe(1);
    const off = make(1000, { [A]: 5000 }, null);
    expect(off.enabled).toBe(false);
    expect((await off.status("u")).feeMultiplier).toBe(1);
  });
});
