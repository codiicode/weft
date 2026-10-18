import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { inspectIntent, PapertradeExecutor, signIntent, type PtSigner, type WireIntent } from "../src/index.ts";

// Two Close intents from a real batched HyperEVM tx. Papertrade's own live state lists
// 0x2671…e111 as this wallet's session key, so the schema below is the one the relayer uses.
const MAINNET_CLOSES: WireIntent[] = [
  { user: "0x49e96e255ba418d08e66c35b588e2f2f3766e1d0", positionIds: ["3969"], nonce: "1580842831", deadline: "1791657237", v: "28", r: "0x085663262127fce37fe74a64648221e1508c3f8ca59dbb2dd7dad071cdbd372e", s: "0x19745cb095da0755b02daab4196116d3520ef2e88167114b73672ede2f27ca89" },
  { user: "0x49e96e255ba418d08e66c35b588e2f2f3766e1d0", positionIds: ["3912"], nonce: "1580842832", deadline: "1791657238", v: "27", r: "0xf2bc0f99a5110c476bd74d55e9212c4461ae833397b0ff180b9c061a46245b9c", s: "0x5392291625f7b0c93bf64f1b7422a71413b3508dee81f3b3975267f24fd622dd" },
];

const key = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const session: PtSigner = { address: key.address, signTypedData: (td) => key.signTypedData(td as never) };
const WALLET = "0x00000000000000000000000000000000000000aa" as const;

describe("Papertrade intents", () => {
  it("recovers the registered session key from real mainnet Close intents", async () => {
    for (const c of MAINNET_CLOSES) expect((await inspectIntent("Close", c)).signer).toBe("0x267187775a7d539f23a0fdeb673cc61163fbe111");
  });

  it("signs in wire form and the intent id matches what the relayer recomputes", async () => {
    const { signed, intentId } = await signIntent(session, "OpenPosition", { user: WALLET, instrumentId: 0, isLong: true, size: 10n ** 19n, leverage: 1000, useDebt: false, nonce: 7n, deadline: 1_900_000_000n });
    expect(signed).toMatchObject({ user: WALLET, instrumentId: "0", isLong: true, size: "10000000000000000000", leverage: "1000", useDebt: false, nonce: "7" });
    const back = await inspectIntent("OpenPosition", signed);
    expect(back).toEqual({ signer: key.address.toLowerCase(), intentId });
  });
});

/** A fake relayer: records intents, shows opens in the live state and closes in the trades list. */
function relayer() {
  const posted: { action: string; signed: WireIntent }[] = [];
  let open: unknown[] = [];
  const trades: unknown[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/intents")) {
      const b = JSON.parse(String(init!.body)) as { action: string; signed: WireIntent };
      posted.push(b);
      const { intentId } = await inspectIntent(b.action === "openPosition" ? "OpenPosition" : "Close", b.signed);
      if (b.action === "openPosition") open = [["9001", 0, true, false, "1000000", b.signed.size, Number(b.signed.leverage), "999600", Date.now(), intentId]];
      else trades.push({ positionId: "9001", kind: "PositionClosed", isLong: true, entryPriceRaw: "1000000", exitPriceRaw: "1010000", priceScaleRaw: "10", marginRaw: "100000000000000000000", leverage: 100, adjustedPnlRaw: "60000000000000000000", userPaidFeeRaw: "1200000000000000000" });
      return new Response(JSON.stringify({ action: b.action, intentId }), { status: 200 });
    }
    if (url.includes("/state/user/live")) return new Response(`event: liveness\ndata: {"heartbeatIntervalMs":15000}\n\nevent: wallet\ndata: ${JSON.stringify({ openPositions: open })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    if (url.includes("/trades")) return new Response(JSON.stringify({ items: trades }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  return { posted, fetch };
}

describe("PapertradeExecutor", () => {
  const BTC = { kind: "synth", venue: "papertrade", symbol: "BTC", assetClass: "crypto" } as const;

  it("opens with the session key and fills at the position's entry", async () => {
    const r = relayer();
    const ex = new PapertradeExecutor({ account: async () => ({ wallet: WALLET, session }), fetch: r.fetch, pollMs: 1 });
    const res = await ex.execute({ clientId: "o1", instrument: BTC, instrumentKey: "papertrade:synth:BTC", side: "buy", phase: "open", notionalUsd: 10_000, leverage: 100, deploymentId: "d" });
    expect(res).toMatchObject({ status: "filled", price: 100_000, feeUsd: 0, venueId: "9001" });
    expect(res.status === "filled" && res.qty).toBeCloseTo(0.1, 9);
    expect(r.posted[0]).toMatchObject({ action: "openPosition", signed: { user: WALLET, size: "100000000000000000000", leverage: "100", isLong: true } });
  });

  it("closes and books exactly what Papertrade paid", async () => {
    const r = relayer();
    const ex = new PapertradeExecutor({ account: async () => ({ wallet: WALLET, session }), fetch: r.fetch, pollMs: 1 });
    await ex.execute({ clientId: "o1", instrument: BTC, instrumentKey: "papertrade:synth:BTC", side: "buy", phase: "open", notionalUsd: 10_000, leverage: 100, deploymentId: "d" });
    const res = await ex.execute({ clientId: "c1", instrument: BTC, instrumentKey: "papertrade:synth:BTC", side: "sell", phase: "close", qty: 0.1, deploymentId: "d", position: { entryPrice: 100_000, leverage: 100, side: "long", sizeUsd: 100, venueId: "9001" } });
    expect(res.status).toBe("filled");
    if (res.status !== "filled") return;
    // +1% at 100×: $100 raw on $10,000; Papertrade paid $60 − $1.20
    expect(res.price).toBe(101_000);
    expect(res.qty * (res.price - 100_000) - res.feeUsd).toBeCloseTo(58.8, 9);
    expect(r.posted[1]).toMatchObject({ action: "closePositions", signed: { positionIds: ["9001"] } });
  });

  it("refuses without a session, and never sends an open twice", async () => {
    const r = relayer();
    expect(await new PapertradeExecutor({ account: async () => null, fetch: r.fetch }).execute({ clientId: "x", instrument: BTC, instrumentKey: "k", side: "buy", phase: "open", notionalUsd: 1000, leverage: 10, deploymentId: "d" })).toMatchObject({ status: "rejected" });
    const ex = new PapertradeExecutor({ account: async () => ({ wallet: WALLET, session }), fetch: r.fetch, pollMs: 1 });
    await ex.execute({ clientId: "o1", instrument: BTC, instrumentKey: "k", side: "buy", phase: "open", notionalUsd: 10_000, leverage: 100, deploymentId: "d" });
    await ex.execute({ clientId: "o1", instrument: BTC, instrumentKey: "k", side: "buy", phase: "open", notionalUsd: 10_000, leverage: 100, deploymentId: "d" });
    expect(r.posted).toHaveLength(1);
  });
});
