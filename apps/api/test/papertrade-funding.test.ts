import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../src/lib/accounts.ts";
import { PapertradeAccounts } from "../src/live/papertrade.ts";

const user = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const WALLET = user.address.toLowerCase() as `0x${string}`;
const DEPOSIT = "0x0bd22985c9e15002d48a8790fd50c906b8fc27d3";
const FEE = "0x4ede000000000000000000000000000000001a74";

function setup(o: { unified: boolean; free: number; mult?: number }) {
  const accounts = new Accounts(join(mkdtempSync(join(tmpdir(), "weft-pt-")), "a.db"));
  accounts.setLiveAccount("u1", "mainnet", WALLET);
  const sent: unknown[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.endsWith("/info")) {
      if (body.type === "userAbstraction") return Response.json(o.unified ? "unifiedAccount" : null);
      if (body.type === "spotClearinghouseState") return Response.json({ balances: [{ coin: "USDC", total: String(o.unified ? o.free : 0), hold: "0" }] });
      if (body.type === "clearinghouseState") return Response.json({ withdrawable: String(o.free) });
    }
    if (url.endsWith("/exchange")) {
      sent.push(body);
      return Response.json({ status: "ok", response: { type: "default" } });
    }
    if (url.includes("/funding/deposits/check")) return Response.json({ proxy: DEPOSIT });
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  const pt = new PapertradeAccounts({ appId: "app", appSecret: "secret", accounts, fetch, feeAddress: FEE, feeMultiplier: async () => o.mult ?? 1 });
  pt.depositAddress = async () => DEPOSIT;
  return { pt, sent };
}

const sign = (tds: { domain: never; types: Record<string, unknown>; primaryType: string; message: never }[]) =>
  Promise.all(tds.map((td) => { const { EIP712Domain: _d, ...types } = td.types; return user.signTypedData({ ...td, types } as never); }));

describe("Papertrade deposits through Weft", () => {
  it("takes 1% for Weft and sends the rest to the Papertrade deposit address (separate spot and perps)", async () => {
    const { pt, sent } = setup({ unified: false, free: 500 });
    const p = await pt.prepareDeposit("u1", 100, "0xa4b1");
    expect(p).toMatchObject({ feeUsd: 1, toPapertradeUsd: 99, depositAddress: DEPOSIT });
    expect(p.typedData.map((t) => t.primaryType)).toEqual(["HyperliquidTransaction:UsdClassTransfer", "HyperliquidTransaction:SpotSend", "HyperliquidTransaction:SpotSend"]);
    expect(p.typedData[1]!.message).toMatchObject({ destination: DEPOSIT, token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054", amount: "99" });
    expect(p.typedData[2]!.message).toMatchObject({ destination: FEE, amount: "1" });
    await pt.submitDeposit("u1", await sign(p.typedData as never));
    expect(sent.map((x) => (x as { action: { type: string } }).action.type)).toEqual(["usdClassTransfer", "spotSend", "spotSend"]);
  });

  it("skips the perp-to-spot step on unified accounts, and holders pay less", async () => {
    const { pt } = setup({ unified: true, free: 500, mult: 0.5 });
    const p = await pt.prepareDeposit("u1", 200, "0xa4b1");
    expect(p).toMatchObject({ feeUsd: 1, toPapertradeUsd: 199 });
    expect(p.typedData.map((t) => t.primaryType)).toEqual(["HyperliquidTransaction:SpotSend", "HyperliquidTransaction:SpotSend"]);
  });

  it("refuses too little, more than is free, and signatures from another wallet", async () => {
    const { pt, sent } = setup({ unified: true, free: 50 });
    await expect(pt.prepareDeposit("u1", 5, "0xa4b1")).rejects.toThrow(/at least \$11/);
    await expect(pt.prepareDeposit("u1", 80, "0xa4b1")).rejects.toThrow(/\$50\.00 free/);
    const p = await pt.prepareDeposit("u1", 20, "0xa4b1");
    const other = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
    const bad = await Promise.all(p.typedData.map((td) => { const { EIP712Domain: _d, ...types } = td.types; return other.signTypedData({ ...td, types } as never); }));
    await expect(pt.submitDeposit("u1", bad)).rejects.toThrow(/expected/);
    expect(sent).toHaveLength(0);
  });
});
