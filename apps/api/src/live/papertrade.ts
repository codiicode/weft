import { PrivyClient } from "@privy-io/node";
import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { exchangeDomain, inspectIntent, PT_EXCHANGE, PT_TYPES, type PapertradeAccount, type PtSigner, type WireIntent } from "@weft/execution";
import type { Accounts } from "../lib/accounts.ts";

/**
 * Papertrade accounts for live trading through Weft.
 *
 *  wallet       the user's own EVM wallet (the same one as their Hyperliquid account in Weft)
 *  session key  a Privy server wallet per user whose policy only lets it sign typed data for
 *               Papertrade's exchange on HyperEVM (chain 999). Papertrade itself only accepts
 *               opens and closes from a session key: no withdrawals, staking or key changes.
 *  register     the user's wallet signs RegisterSessionKey once (in the browser); Weft checks the
 *               signature and forwards it to Papertrade's relayer. Keys last up to 30 days.
 *  deposit      each wallet has its own deposit address (DepositProxyFactory); USDC sent there on
 *               HyperCore lands in the Papertrade account (at least 10 USDC; 1 USDC on the first).
 */

const API = "https://exchange.papertrade.xyz";
const FACTORY = "0x1629b7d46bef6e13ff754174fc9f32dea309b38f" as const;
const POLICY_NAME = "Weft Papertrade session key";
const SESSION_DAYS = 30;

export interface PapertradeStatus {
  wallet: Hex | null;
  sessionKey: Hex | null;
  /** Papertrade knows the session key and it hasn't expired. */
  registered: boolean;
  sessionExpiresAt: number | null;
  depositAddress: Hex | null;
  /** Free balance in the Papertrade account, USD. */
  availableUsd: number | null;
  openPositions: number;
}

export class PapertradeAccounts {
  private readonly privy: PrivyClient;
  private readonly accounts: Accounts;
  private readonly f: typeof fetch;
  private policyId: string | null = null;
  private readonly hyperevm = createPublicClient({ transport: http("https://rpc.hyperliquid.xyz/evm") });

  constructor(o: { appId: string; appSecret: string; accounts: Accounts; fetch?: typeof fetch }) {
    this.privy = new PrivyClient({ appId: o.appId, appSecret: o.appSecret });
    this.accounts = o.accounts;
    this.f = o.fetch ?? fetch;
  }

  /** The user's own EVM wallet: the one their Hyperliquid account in Weft uses. */
  walletOf(userId: string): Hex | null {
    return (this.accounts.liveAccount(userId)?.hlAddress?.toLowerCase() as Hex | undefined) ?? null;
  }

  private async policy(): Promise<string> {
    if (this.policyId) return this.policyId;
    const stored = this.accounts.kvGet("privy_pt_policy_id");
    if (stored) return (this.policyId = stored);
    const p = await this.privy.policies().create({
      name: POLICY_NAME,
      version: "1.0",
      chain_type: "ethereum",
      rules: [
        {
          name: "Papertrade exchange intents only",
          method: "eth_signTypedData_v4",
          action: "ALLOW",
          conditions: [
            { field_source: "ethereum_typed_data_domain", field: "chainId", operator: "eq", value: "999" },
            { field_source: "ethereum_typed_data_domain", field: "verifyingContract", operator: "eq", value: PT_EXCHANGE },
          ],
        },
      ],
    });
    this.accounts.kvSet("privy_pt_policy_id", p.id);
    return (this.policyId = p.id);
  }

  /** The user's session key (a Privy server wallet), created on first use. */
  async sessionKey(userId: string): Promise<{ walletId: string; address: Hex }> {
    const raw = this.accounts.kvGet(`pt_session:${userId}`);
    if (raw) return JSON.parse(raw) as { walletId: string; address: Hex };
    const w = await this.privy.wallets().create({ chain_type: "ethereum", policy_ids: [await this.policy()], external_id: `pt-${userId}`.slice(0, 64), display_name: "Weft Papertrade session key" });
    const out = { walletId: w.id, address: (w.address as string).toLowerCase() as Hex };
    this.accounts.kvSet(`pt_session:${userId}`, JSON.stringify(out));
    return out;
  }

  private signer(s: { walletId: string; address: Hex }): PtSigner {
    return {
      address: s.address,
      signTypedData: async (td) => {
        const r = await this.privy.wallets().ethereum().signTypedData(s.walletId, {
          params: { typed_data: { domain: td.domain as never, types: td.types as never, message: jsonable(td.message) as never, primary_type: td.primaryType } },
        });
        return r.signature as Hex;
      },
    };
  }

  /** What the executor needs for a user's run: their wallet and session signer. */
  async account(userId: string): Promise<PapertradeAccount | null> {
    const wallet = this.walletOf(userId);
    const raw = this.accounts.kvGet(`pt_session:${userId}`);
    if (!wallet || !raw) return null;
    return { wallet, session: this.signer(JSON.parse(raw) as { walletId: string; address: Hex }) };
  }

  async depositAddress(wallet: Hex): Promise<Hex> {
    return (await this.hyperevm.readContract({ address: FACTORY, abi: parseAbi(["function computeProxyAddress(address) view returns (address)"]), functionName: "computeProxyAddress", args: [wallet] })).toLowerCase() as Hex;
  }

  /** The wallet's live state from Papertrade (first snapshot of its event stream). */
  async liveState(wallet: Hex): Promise<{ sessionKeys?: [string, string][]; openPositions?: unknown[]; funds?: { availableBalance?: string } } | null> {
    const r = await this.f(`${API}/state/user/live?wallet=${wallet}`, { headers: { accept: "text/event-stream" }, signal: AbortSignal.timeout(12_000) });
    if (!r.ok || !r.body) return null;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        buf += dec.decode(value, { stream: true });
        for (const block of buf.split("\n\n").slice(0, -1))
          if (/^event: wallet$/m.test(block)) return JSON.parse(block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""));
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
  }

  async status(userId: string): Promise<PapertradeStatus> {
    const wallet = this.walletOf(userId);
    const raw = this.accounts.kvGet(`pt_session:${userId}`);
    const key = raw ? (JSON.parse(raw) as { address: Hex }).address : null;
    if (!wallet) return { wallet: null, sessionKey: key, registered: false, sessionExpiresAt: null, depositAddress: null, availableUsd: null, openPositions: 0 };
    const [state, deposit] = await Promise.all([this.liveState(wallet).catch(() => null), this.depositAddress(wallet).catch(() => null)]);
    const entry = state?.sessionKeys?.find(([k]) => k.toLowerCase() === key);
    const expires = entry ? Number(entry[1]) * 1000 : null;
    const avail = state?.funds?.availableBalance;
    return {
      wallet,
      sessionKey: key,
      registered: expires != null && expires > Date.now(),
      sessionExpiresAt: expires,
      depositAddress: deposit,
      availableUsd: avail != null ? Number(BigInt(avail)) / 1e18 : null,
      openPositions: state?.openPositions?.length ?? 0,
    };
  }

  /** The RegisterSessionKey message for the user's wallet to sign in the browser. */
  async registration(userId: string): Promise<{ domain: ReturnType<typeof exchangeDomain>; types: { RegisterSessionKey: (typeof PT_TYPES)["RegisterSessionKey"] }; primaryType: "RegisterSessionKey"; message: Record<string, string> }> {
    const wallet = this.walletOf(userId);
    if (!wallet) throw new Error("Set up your Hyperliquid wallet in Weft first: Papertrade uses the same wallet.");
    const key = await this.sessionKey(userId);
    const now = Math.floor(Date.now() / 1000);
    return {
      domain: exchangeDomain(),
      types: { RegisterSessionKey: PT_TYPES.RegisterSessionKey },
      primaryType: "RegisterSessionKey",
      message: { user: wallet, key: key.address, expiry: String(now + SESSION_DAYS * 86_400), feeAddress: "0x0000000000000000000000000000000000000000", nonce: String(BigInt(Date.now()) * 1000n), deadline: String(now + 1_800) },
    };
  }

  /** Check the wallet's signature over the registration, then hand it to Papertrade's relayer. */
  async register(userId: string, signed: WireIntent): Promise<{ intentId: string }> {
    const wallet = this.walletOf(userId);
    const key = await this.sessionKey(userId);
    if (!wallet) throw new Error("no wallet");
    if (String(signed.user).toLowerCase() !== wallet || String(signed.key).toLowerCase() !== key.address) throw new Error("that registration isn’t for this account’s wallet and key");
    if (String(signed.feeAddress).toLowerCase() !== "0x0000000000000000000000000000000000000000") throw new Error("unexpected fee address");
    const { signer, intentId } = await inspectIntent("RegisterSessionKey", signed);
    if (signer !== wallet) throw new Error("the signature isn’t from this account’s wallet");
    const r = await this.f(`${API}/intents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "registerSessionKey", signed }), signal: AbortSignal.timeout(20_000) });
    const body = (await r.json().catch(() => ({}))) as { code?: string; reason?: string; message?: string; intentId?: string };
    if (!r.ok) throw new Error(`Papertrade refused the key: ${body.reason ?? body.message ?? body.code ?? `HTTP ${r.status}`}`);
    return { intentId: body.intentId ?? intentId };
  }
}

/** Privy's API takes JSON: bigints as decimal strings. */
function jsonable(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonable);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonable(x)]));
  return v;
}
