import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { defineStrategy } from "@weft/strategy";
import { Accounts } from "../src/lib/accounts.ts";
import { AgentWallets, type PrivyAgentApi } from "../src/live/agents.ts";
import { LiveRouterExecutor, LiveService, liveConfigFromEnv, type LiveConfig } from "../src/live/service.ts";

const userKey = privateKeyToAccount(generatePrivateKey()); // the user's own wallet
const agentKey = privateKeyToAccount(generatePrivateKey()); // stands in for the Privy-held agent

function fakePrivy(): PrivyAgentApi & { created: number } {
  const api = {
    created: 0,
    async createPolicy() {
      return "pol_1";
    },
    async createWallet() {
      api.created++;
      return { walletId: "w_1", address: agentKey.address };
    },
    async signTypedData(_id: string, td: Parameters<PrivyAgentApi["signTypedData"]>[1]) {
      return agentKey.signTypedData(td as never);
    },
  };
  return api;
}

/** A fake Hyperliquid: /info answers from state, /exchange records posts. */
function fakeHl() {
  const state = { accountValue: "250", agents: [] as { address: string; name: string }[], maxBuilderFee: 0 };
  const posts: Record<string, unknown>[] = [];
  const fetchFn = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    let out: unknown = null;
    if (url.endsWith("/info")) {
      if (body.type === "clearinghouseState") out = { marginSummary: { accountValue: state.accountValue }, withdrawable: state.accountValue, assetPositions: [] };
      if (body.type === "extraAgents") out = state.agents;
      if (body.type === "maxBuilderFee") out = state.maxBuilderFee;
    } else {
      posts.push(body);
      if (body.action?.type === "approveAgent") state.agents.push({ address: body.action.agentAddress, name: body.action.agentName });
      if (body.action?.type === "approveBuilderFee") state.maxBuilderFee = 50;
      out = { status: "ok", response: { type: "default" } };
    }
    return new Response(JSON.stringify(out), { status: 200 });
  }) as never;
  return { state, posts, fetchFn };
}

function setup(cfg: Partial<LiveConfig> = {}) {
  const accounts = new Accounts(join(mkdtempSync(join(tmpdir(), "weft-live-")), "a.db"));
  const privy = fakePrivy();
  const hl = fakeHl();
  const config: LiveConfig = { ...liveConfigFromEnv({ WEFT_LIVE_ENABLED: "1" }), ...cfg };
  const live = new LiveService(config, accounts, new AgentWallets(privy, accounts), hl.fetchFn);
  return { accounts, privy, hl, live, config };
}

const btcLong = defineStrategy({
  schemaVersion: 1,
  id: "btc-live",
  name: "BTC live",
  thesis: "t",
  signals: [{ id: "px", kind: "price", params: { instrument: { kind: "perp", venue: "hyperliquid", symbol: "BTC" } } }],
  triggers: [{ id: "go", when: { op: "gt", left: { ref: "px.price" }, right: { value: 0 } } }],
  actions: [{ id: "buy", type: "open", on: ["go"], instrument: { kind: "perp", venue: "hyperliquid", symbol: "BTC" }, side: "long", size: { unit: "usd", value: 50 }, leverage: 2, exits: { stopLoss: { pct: 3 } } }],
});

describe("live trading", () => {
  it("defaults to testnet, off, $100 cap", () => {
    const c = liveConfigFromEnv({});
    expect(c).toMatchObject({ enabled: false, network: "testnet", maxAllocationUsd: 100, maxLeverage: 3, builder: null });
    expect(liveConfigFromEnv({ WEFT_HL_NETWORK: "mainnet", WEFT_BUILDER_ADDRESS: "0xnope" }).builder).toBeNull();
  });

  it("walks a user from unlinked to ready: link, sign approvals in their wallet, verified on the venue", async () => {
    const builder = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as `0x${string}`;
    const { live, hl, privy } = setup({ builder: { address: builder, feeTenthsBps: 50 } });

    let s = await live.status("u1");
    expect(s.ready).toBe(false);
    expect(s.blockers.join(" ")).toMatch(/Link your Hyperliquid account/);

    live.linkAccount("u1", userKey.address);
    s = await live.status("u1");
    expect(s.blockers.join(" ")).toMatch(/Approve the Weft agent/);

    const prep = await live.prepareApprovals("u1", "0xa4b1");
    expect(prep.agentAddress).toBe(agentKey.address);
    expect(prep.requests.map((r) => r.kind)).toEqual(["agent", "builder"]);
    expect(privy.created).toBe(1);
    // The browser wallet signs exactly the typed data we hand it (domain on the wallet's chain).
    for (const r of prep.requests) {
      const td = r.typedData as { domain: { chainId: number }; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
      expect(td.domain.chainId).toBe(0xa4b1);
      expect(td.types.EIP712Domain).toBeDefined();
      const { EIP712Domain: _d, ...types } = td.types;
      const sig = await userKey.signTypedData({ ...td, types } as never);
      await live.submitApproval("u1", r.kind, sig);
    }
    expect(hl.posts.map((p) => (p.action as { type: string }).type)).toEqual(["approveAgent", "approveBuilderFee"]);
    expect((hl.posts[0]!.action as { agentName: string }).agentName).toBe("weft");

    s = await live.status("u1");
    expect(s.venue?.agentApprovedOnVenue).toBe(true);
    expect(s.ready).toBe(true);
    // Agent wallet is reused, not recreated.
    await live.prepareApprovals("u1", "0xa4b1");
    expect(privy.created).toBe(1);
  });

  it("refuses an approval signed by a different wallet than the linked account", async () => {
    const { live } = setup();
    live.linkAccount("u1", userKey.address);
    const prep = await live.prepareApprovals("u1", "0x1");
    const td = prep.requests[0]!.typedData as { types: Record<string, unknown> };
    const { EIP712Domain: _d, ...types } = td.types;
    const imposter = privateKeyToAccount(generatePrivateKey());
    const sig = await imposter.signTypedData({ ...(td as object), types } as never);
    await expect(live.submitApproval("u1", "agent", sig)).rejects.toThrow(/expected/);
  });

  it("guards live deployments: approval, caps, products, netting", async () => {
    const { live, accounts } = setup();
    expect(() => live.assertDeployable("u1", btcLong, 50, new Set())).toThrow(/approve the Weft agent/);
    live.linkAccount("u1", userKey.address);
    accounts.markApproved("u1", "agent");
    expect(() => live.assertDeployable("u1", btcLong, 50, new Set())).not.toThrow();
    expect(() => live.assertDeployable("u1", btcLong, 500, new Set())).toThrow(/capped at \$100/);
    expect(() => live.assertDeployable("u1", btcLong, 50, new Set(["hl:perp:BTC"]))).toThrow(/already trades BTC/);
    const token = defineStrategy({ ...btcLong, actions: [{ id: "buy", type: "open", on: ["go"], instrument: { kind: "token", chain: "solana", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" }, side: "long", size: { unit: "usd", value: 10 }, exits: { stopLoss: { pct: 10 } } }] });
    expect(() => live.assertDeployable("u1", token, 50, new Set())).toThrow(/token instruments can't trade live yet/);
    const lev = defineStrategy({ ...btcLong, risk: { maxLeverage: 10 }, actions: [{ ...(btcLong.actions[0] as object), leverage: 5 } as never] });
    expect(() => live.assertDeployable("u1", lev, 50, new Set())).toThrow(/capped at 3×/);
    const { live: off } = setup({ enabled: false });
    expect(() => off.assertDeployable("u1", btcLong, 50, new Set())).toThrow(/switched off/);
  });

  it("the live router only trades for the deployment's owner, and not at all when disabled", async () => {
    const { live } = setup();
    const router = new LiveRouterExecutor(live, (id) => (id === "dep1" ? "u1" : null));
    const req = { clientId: "k", instrument: (btcLong.actions[0] as unknown as { instrument: never }).instrument, instrumentKey: "hl:perp:BTC", side: "buy" as const, phase: "open" as const, notionalUsd: 10 };
    expect((await router.execute({ ...req, deploymentId: "nobody" }, 0)).status).toBe("rejected");
    const r = await router.execute({ ...req, deploymentId: "dep1" }, 0);
    expect(r.status === "rejected" && r.reason).toMatch(/no live account or agent/);
    const { live: off } = setup({ enabled: false });
    const r2 = await new LiveRouterExecutor(off, () => "u1").execute({ ...req, deploymentId: "dep1" }, 0);
    expect(r2.status === "rejected" && r2.reason).toMatch(/switched off/);
  });
});

describe("live reconciliation", async () => {
  const { Reconciler, diffPositions } = await import("../src/live/reconcile.ts");
  it("diffs signed sizes with a 1% tolerance", () => {
    const m = diffPositions(new Map([["BTC", 0.01], ["ETH", -1]]), new Map([["BTC", 0.01005], ["SOL", 3]]));
    expect(m).toEqual([
      { coin: "ETH", expected: -1, actual: 0 },
      { coin: "SOL", expected: 0, actual: 3 },
    ]);
  });
  it("notes a mismatch on the owning run once, and again only when it changes", async () => {
    const { accounts } = setup();
    accounts.setLiveAccount("u1", "testnet", userKey.address);
    accounts.setDeploymentOwner("dep1", "u1");
    const notes: string[] = [];
    let venueSzi = "0";
    const engine = {
      listDeployments: async () => [{ id: "dep1", mode: "live", status: "running" }],
      getSnapshot: async () => ({
        deployment: { strategy: btcLong },
        positions: [{ instrument: { kind: "perp", venue: "hyperliquid", symbol: "BTC" }, side: "long", qty: 0.002 }],
      }),
      note: async (_id: string, _t: string, m: string) => void notes.push(m),
    } as never;
    const fetchFn = (async () =>
      new Response(JSON.stringify({ assetPositions: venueSzi === "0" ? [] : [{ position: { coin: "BTC", szi: venueSzi } }] }), { status: 200 })) as never;
    const r = new Reconciler(engine, accounts, liveConfigFromEnv({ WEFT_LIVE_ENABLED: "1" }), fetchFn);
    await r.run();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/Hyperliquid shows no BTC position, but this run expects long 0.002 BTC/);
    await r.run();
    expect(notes).toHaveLength(1); // unchanged: not repeated
    venueSzi = "0.002";
    await r.run();
    expect(notes).toHaveLength(1); // matches now: nothing to say
  });
});
