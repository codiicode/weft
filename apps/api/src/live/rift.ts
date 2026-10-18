import { buildSpotSend, buildUsdClassTransfer, HlExchangeClient, type UserSignRequest } from "@weft/execution";
import type { Hex } from "viem";
import type { Accounts } from "../lib/accounts.ts";

/**
 * Money in and out of the user's Hyperliquid account from any chain, through Rift
 * (rift.trade: one-step swaps and bridges, best price across venues, no added fee).
 *
 *  in   the user picks what they have (BTC, ETH, USDC on Ethereum/Base/Arbitrum…); Rift quotes it
 *       into USDC on Hyperliquid and gives a one-time deposit address. Weft sets the receiving
 *       address to the user's own Hyperliquid account, never anything the browser sends. USDC lands
 *       in the spot balance; on a default (not unified) account Weft then moves it to perps (one
 *       background signature) so it can trade.
 *  out  USDC from the account to BTC/ETH/USDC on another chain: Rift quotes it, the user's wallet
 *       signs a Hyperliquid send of the USDC to Rift's deposit address (and, on a default account,
 *       the perp-to-spot move first), and Rift delivers to the address the user gave.
 *
 * Rift holds the money for the minutes it takes (in its TEE-secured one-time wallets).
 */

const RIFT = "https://api.rift.trade";
const HL = "https://api.hyperliquid.xyz";
const HL_USDC = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054";

/** What we offer, in Rift's `<chain>.<asset>` names, with a label for the picker. */
export const RIFT_ASSETS: { id: string; label: string; symbol: string; chain: string }[] = [
  { id: "bitcoin.btc", label: "BTC on Bitcoin", symbol: "BTC", chain: "Bitcoin" },
  { id: "ethereum.eth", label: "ETH on Ethereum", symbol: "ETH", chain: "Ethereum" },
  { id: "base.eth", label: "ETH on Base", symbol: "ETH", chain: "Base" },
  { id: "arbitrum.eth", label: "ETH on Arbitrum", symbol: "ETH", chain: "Arbitrum" },
  { id: "ethereum.usdc", label: "USDC on Ethereum", symbol: "USDC", chain: "Ethereum" },
  { id: "base.usdc", label: "USDC on Base", symbol: "USDC", chain: "Base" },
  { id: "arbitrum.usdc", label: "USDC on Arbitrum", symbol: "USDC", chain: "Arbitrum" },
  { id: "ethereum.usdt", label: "USDT on Ethereum", symbol: "USDT", chain: "Ethereum" },
];
const ASSET_IDS = new Set(RIFT_ASSETS.map((a) => a.id));
const TERMINAL = new Set(["delivered", "refunded", "expired", "frozen"]);

export interface RiftQuote {
  id: string;
  from: string;
  to: string;
  fromAmount: string;
  estimatedOut: string;
  expiresAt: string;
}
export interface RiftOrder {
  id: string;
  kind: "in" | "out";
  from: string;
  to: string;
  fromAmount: string;
  estimatedOut: string;
  depositAddress: string;
  depositDeadline: string | null;
  toAddress: string;
  status: string;
  createdAt: number;
  /** Money in: moved from spot to the trading (perp) balance already. */
  movedToPerps?: boolean;
}

export class RiftFunding {
  private readonly accounts: Accounts;
  private readonly f: typeof fetch;
  private readonly apiKey: string | null;
  private readonly quotes = new Map<string, RiftQuote & { kind: "in" | "out"; userId: string; at: number }>();
  private readonly pending = new Map<string, { reqs: UserSignRequest<Record<string, unknown> & { signatureChainId: string }>[]; wallet: Hex; expires: number; orderId: string }>();

  constructor(o: { accounts: Accounts; apiKey?: string | null; fetch?: typeof fetch }) {
    this.accounts = o.accounts;
    this.apiKey = o.apiKey ?? null;
    this.f = o.fetch ?? fetch;
  }

  private walletOf(userId: string): Hex {
    const a = this.accounts.liveAccount(userId);
    if (!a || a.network !== "mainnet") throw new Error("Set up your Hyperliquid wallet in Weft first.");
    return a.hlAddress.toLowerCase() as Hex;
  }

  private async rift<T>(path: string, body?: unknown): Promise<T> {
    const r = await this.f(`${RIFT}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...(this.apiKey ? { "x-api-key": this.apiKey } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await r.json().catch(() => ({}))) as T & { error?: string; message?: string; reason?: string };
    if (!r.ok) throw new Error(`Rift: ${j.message ?? j.error ?? j.reason ?? `HTTP ${r.status}`}`);
    return j;
  }

  private async hlInfo<T>(body: Record<string, unknown>): Promise<T> {
    const r = await this.f(`${HL}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`Hyperliquid info: HTTP ${r.status}`);
    return (await r.json()) as T;
  }

  private async unified(wallet: Hex): Promise<boolean> {
    const m = await this.hlInfo<string | null>({ type: "userAbstraction", user: wallet }).catch(() => null);
    return m === "unifiedAccount" || m === "portfolioMargin";
  }

  async quote(userId: string, kind: "in" | "out", asset: string, amount: number): Promise<RiftQuote> {
    if (!ASSET_IDS.has(asset)) throw new Error("that asset isn’t offered");
    if (!(amount > 0)) throw new Error("enter an amount");
    const [from, to] = kind === "in" ? [asset, "hyperliquid.usdc"] : ["hyperliquid.usdc", asset];
    const q = await this.rift<{ id: string; from: string; to: string; from_amount: string; estimated_amount_out: string; expires_at: string }>("/quote", {
      from,
      to,
      from_amount: String(amount),
      return_full_route: false,
      quote_mode: "fast",
    });
    const out: RiftQuote = { id: q.id, from, to, fromAmount: q.from_amount, estimatedOut: q.estimated_amount_out, expiresAt: q.expires_at };
    // Orders are made from quotes Weft fetched for this user, never from what the browser sends.
    for (const [k, v] of this.quotes) if (Date.now() - v.at > 15 * 60_000) this.quotes.delete(k);
    this.quotes.set(q.id, { ...out, kind, userId, at: Date.now() });
    return out;
  }

  private quoteFor(userId: string, id: string, kind: "in" | "out") {
    const q = this.quotes.get(id);
    if (!q || q.userId !== userId || q.kind !== kind) throw new Error("that quote has expired: get a new one");
    return q;
  }

  private orders(userId: string): RiftOrder[] {
    return JSON.parse(this.accounts.kvGet(`rift:${userId}`) || "[]") as RiftOrder[];
  }
  private save(userId: string, list: RiftOrder[]) {
    this.accounts.kvSet(`rift:${userId}`, JSON.stringify(list.slice(-30)));
  }

  /** Money in: an order paying out to the user's own Hyperliquid account. */
  async depositOrder(userId: string, quoteId: string): Promise<RiftOrder> {
    const wallet = this.walletOf(userId);
    const q = this.quoteFor(userId, quoteId, "in");
    const o = await this.rift<{ id: string; deposit_address: string; deposit_deadline?: string; status: string }>("/order", { quote_id: quoteId, to_address: wallet });
    const order: RiftOrder = { id: o.id, kind: "in", from: q.from, to: "hyperliquid.usdc", fromAmount: q.fromAmount, estimatedOut: q.estimatedOut, depositAddress: o.deposit_address, depositDeadline: o.deposit_deadline ?? null, toAddress: wallet, status: o.status, createdAt: Date.now() };
    this.save(userId, [...this.orders(userId).filter((x) => x.id !== order.id), order]);
    return order;
  }

  /**
   * Money out: an order to the user's address on another chain, and the Hyperliquid steps their
   * wallet signs to pay it (move from perps to spot on a default account, then send the USDC).
   */
  async withdrawOrder(userId: string, quoteId: string, toAddress: string, signatureChainId: string) {
    const wallet = this.walletOf(userId);
    const q = this.quoteFor(userId, quoteId, "out");
    const amount = Number(q.fromAmount);
    const spot = await this.hlInfo<{ balances?: { coin: string; total: string; hold: string }[] }>({ type: "spotClearinghouseState", user: wallet });
    const u = spot.balances?.find((b) => b.coin === "USDC");
    const spotFree = u ? Number(u.total) - Number(u.hold) : 0;
    const unified = await this.unified(wallet);
    const perpFree = unified ? 0 : Number((await this.hlInfo<{ withdrawable?: string }>({ type: "clearinghouseState", user: wallet })).withdrawable ?? 0);
    if (amount > spotFree + perpFree + 1e-6) throw new Error(`You have $${(Math.floor((spotFree + perpFree) * 100) / 100).toFixed(2)} free in your Hyperliquid account.`);
    const o = await this.rift<{ id: string; deposit_address: string; deposit_deadline?: string; status: string }>("/order", { quote_id: quoteId, to_address: toAddress.trim(), refund_address: wallet });
    const t = Date.now();
    const amt = (n: number) => n.toFixed(6).replace(/\.?0+$/, "");
    const reqs: UserSignRequest<Record<string, unknown> & { signatureChainId: string }>[] = [];
    const fromPerps = Math.max(0, amount - spotFree);
    if (!unified && fromPerps > 0) reqs.push(buildUsdClassTransfer({ isMainnet: true, amount: amt(Math.ceil(fromPerps * 1e6) / 1e6), toPerp: false, signatureChainId, nonce: t }));
    reqs.push(buildSpotSend({ isMainnet: true, destination: o.deposit_address as Hex, token: HL_USDC, amount: amt(amount), signatureChainId, nonce: t + 1 }));
    const order: RiftOrder = { id: o.id, kind: "out", from: "hyperliquid.usdc", to: q.to, fromAmount: q.fromAmount, estimatedOut: q.estimatedOut, depositAddress: o.deposit_address, depositDeadline: o.deposit_deadline ?? null, toAddress: toAddress.trim(), status: o.status, createdAt: t };
    this.save(userId, [...this.orders(userId).filter((x) => x.id !== order.id), order]);
    this.pending.set(userId, { reqs, wallet, expires: t + 10 * 60_000, orderId: o.id });
    return { order, typedData: reqs.map((r) => withDomainType(r.typedData)) };
  }

  /** Send the signed withdrawal steps to Hyperliquid (each signature checked first). */
  async submitWithdraw(userId: string, signatures: Hex[]) {
    const p = this.pending.get(userId);
    if (!p || p.expires < Date.now()) throw new Error("no withdrawal waiting (start again)");
    if (signatures.length !== p.reqs.length) throw new Error("every step needs its signature");
    const requests = await Promise.all(p.reqs.map((r, i) => r.toRequest(signatures[i]!, p.wallet)));
    this.pending.delete(userId);
    await this.postHl(requests);
    return { ok: true as const, orderId: p.orderId };
  }

  /** After money arrives in spot on a default account: move the free spot USDC to perps, to trade. */
  async prepareToPerps(userId: string, orderId: string, signatureChainId: string) {
    const wallet = this.walletOf(userId);
    const order = this.orders(userId).find((o) => o.id === orderId && o.kind === "in" && o.status === "delivered" && !o.movedToPerps);
    if (!order || (await this.unified(wallet))) return { typedData: [] };
    // Only what this deposit brought (never other spot money the user keeps for spot trades).
    const spot = await this.hlInfo<{ balances?: { coin: string; total: string; hold: string }[] }>({ type: "spotClearinghouseState", user: wallet });
    const u = spot.balances?.find((b) => b.coin === "USDC");
    const free = u ? Number(u.total) - Number(u.hold) : 0;
    const amount = Math.floor(Math.min(free, Number(order.estimatedOut)) * 1e6) / 1e6;
    if (amount < 1) return { typedData: [] };
    const req = buildUsdClassTransfer({ isMainnet: true, amount: amount.toFixed(6).replace(/\.?0+$/, ""), toPerp: true, signatureChainId, nonce: Date.now() });
    this.pending.set(`${userId}:perps`, { reqs: [req], wallet, expires: Date.now() + 10 * 60_000, orderId });
    return { amountUsd: amount, typedData: [withDomainType(req.typedData)] };
  }

  async submitToPerps(userId: string, signatures: Hex[]) {
    const p = this.pending.get(`${userId}:perps`);
    if (!p || p.expires < Date.now()) throw new Error("nothing to move (start again)");
    const requests = await Promise.all(p.reqs.map((r, i) => r.toRequest(signatures[i]!, p.wallet)));
    this.pending.delete(`${userId}:perps`);
    await this.postHl(requests);
    this.save(userId, this.orders(userId).map((o) => (o.id === p.orderId ? { ...o, movedToPerps: true } : o)));
    return { ok: true as const };
  }

  private async postHl(requests: unknown[]) {
    const client = new HlExchangeClient({ baseUrl: HL, isMainnet: true, fetch: this.f, allowMainnetSend: true } as never);
    for (const [i, request] of requests.entries()) {
      const res = (await client.post(request as never)) as { status?: string; response?: unknown };
      if (res.status !== "ok") throw new Error(`Hyperliquid refused step ${i + 1}: ${typeof res.response === "string" ? res.response : JSON.stringify(res).slice(0, 200)}`);
    }
  }

  /** The user's recent orders, with the status of any that are still moving refreshed from Rift. */
  async list(userId: string): Promise<RiftOrder[]> {
    const list = this.orders(userId);
    let changed = false;
    await Promise.all(
      list.map(async (o) => {
        if (TERMINAL.has(o.status) || Date.now() - o.createdAt > 8 * 86_400_000) return;
        const r = await this.rift<{ status: string }>(`/order/${encodeURIComponent(o.id)}`).catch(() => null);
        if (r && r.status !== o.status) {
          o.status = r.status;
          changed = true;
        }
      })
    );
    if (changed) this.save(userId, list);
    return [...list].reverse();
  }
}

function withDomainType(td: { domain: Record<string, unknown>; types: Record<string, readonly { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> }) {
  if (td.types.EIP712Domain) return td;
  return { ...td, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...td.types } };
}
