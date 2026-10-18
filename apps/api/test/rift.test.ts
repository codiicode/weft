import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../src/lib/accounts.ts";
import { RiftFunding } from "../src/live/rift.ts";

const user = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const WALLET = user.address.toLowerCase();
const QID = "11111111-1111-4111-8111-111111111111";

function setup(o: { unified?: boolean; spot?: number; perp?: number } = {}) {
  const accounts = new Accounts(join(mkdtempSync(join(tmpdir(), "weft-rift-")), "a.db"));
  accounts.setLiveAccount("u1", "mainnet", WALLET);
  const rift: { path: string; body: Record<string, unknown> }[] = [];
  const hl: unknown[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.startsWith("https://api.rift.trade")) {
      const path = url.slice("https://api.rift.trade".length);
      rift.push({ path, body });
      if (path === "/quote") return Response.json({ id: QID, from: body.from, to: body.to, from_amount: body.from_amount, estimated_amount_out: "97.7", expires_at: "2099-01-01T00:00:00Z" });
      if (path === "/order") return Response.json({ id: "ord1", deposit_address: body.to_address === WALLET ? "bc1qdeposit" : "0x00000000000000000000000000000000000000dd", deposit_deadline: null, status: "awaiting_deposit" });
      if (path.startsWith("/order/")) return Response.json({ status: "delivered" });
    }
    if (url.endsWith("/info")) {
      if (body.type === "userAbstraction") return Response.json(o.unified ? "unifiedAccount" : "default");
      if (body.type === "spotClearinghouseState") return Response.json({ balances: [{ coin: "USDC", total: String(o.spot ?? 0), hold: "0" }] });
      if (body.type === "clearinghouseState") return Response.json({ withdrawable: String(o.perp ?? 0) });
    }
    if (url.endsWith("/exchange")) {
      hl.push(body);
      return Response.json({ status: "ok", response: { type: "default" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  return { r: new RiftFunding({ accounts, fetch }), rift, hl };
}

const sign = (tds: { types: Record<string, unknown> }[]) => Promise.all(tds.map((td) => { const { EIP712Domain: _d, ...types } = td.types; return user.signTypedData({ ...(td as object), types } as never); }));

describe("Rift funding", () => {
  it("pays deposits to the user's own Hyperliquid account, and only from Weft's own quotes", async () => {
    const { r, rift } = setup();
    await expect(r.depositOrder("u1", QID)).rejects.toThrow(/expired/);
    await r.quote("u1", "in", "bitcoin.btc", 0.001);
    const o = await r.depositOrder("u1", QID);
    expect(rift.at(-1)).toEqual({ path: "/order", body: { quote_id: QID, to_address: WALLET } });
    expect(o).toMatchObject({ kind: "in", from: "bitcoin.btc", to: "hyperliquid.usdc", depositAddress: "bc1qdeposit", status: "awaiting_deposit" });
    expect((await r.list("u1"))[0]!.status).toBe("delivered");
  });

  it("refuses assets it doesn't offer", async () => {
    await expect(setup().r.quote("u1", "in", "ethereum.pepe", 1)).rejects.toThrow(/isn’t offered/);
  });

  it("withdraws: perps to spot first on a default account, then sends the USDC to Rift", async () => {
    const { r, hl } = setup({ spot: 5, perp: 200 });
    await r.quote("u1", "out", "base.usdc", 50);
    const w = await r.withdrawOrder("u1", QID, "0x00000000000000000000000000000000000000aa", "0xa4b1");
    expect(w.typedData.map((t) => t.primaryType)).toEqual(["HyperliquidTransaction:UsdClassTransfer", "HyperliquidTransaction:SpotSend"]);
    expect(w.typedData[0]!.message).toMatchObject({ amount: "45", toPerp: false });
    expect(w.typedData[1]!.message).toMatchObject({ destination: "0x00000000000000000000000000000000000000dd", amount: "50" });
    await r.submitWithdraw("u1", await sign(w.typedData as never));
    expect(hl.map((x) => (x as { action: { type: string } }).action.type)).toEqual(["usdClassTransfer", "spotSend"]);
  });

  it("won't withdraw more than is free", async () => {
    const { r } = setup({ spot: 0, perp: 20 });
    await r.quote("u1", "out", "base.usdc", 50);
    await expect(r.withdrawOrder("u1", QID, "0x00000000000000000000000000000000000000aa", "0xa4b1")).rejects.toThrow(/\$20\.00 free/);
  });

  it("moves only what a delivered deposit brought from spot to perps, once, on a default account", async () => {
    const d = setup({ spot: 500 });
    await d.r.quote("u1", "in", "bitcoin.btc", 0.001);
    await d.r.depositOrder("u1", QID);
    await d.r.list("u1"); // → delivered
    const p = await d.r.prepareToPerps("u1", "ord1", "0xa4b1");
    expect(p.typedData[0]!.message).toMatchObject({ amount: "97.7", toPerp: true });
    await d.r.submitToPerps("u1", await sign(p.typedData as never));
    expect((await d.r.prepareToPerps("u1", "ord1", "0xa4b1")).typedData).toHaveLength(0);
    const u = setup({ unified: true, spot: 500 });
    await u.r.quote("u1", "in", "bitcoin.btc", 0.001);
    await u.r.depositOrder("u1", QID);
    await u.r.list("u1");
    expect((await u.r.prepareToPerps("u1", "ord1", "0xa4b1")).typedData).toHaveLength(0);
  });
});
