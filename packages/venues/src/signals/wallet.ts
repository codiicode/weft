import type { Http } from "../http.ts";
import type { SignalProvider } from "../types.ts";
import { defineProvider, type Fields } from "./common.ts";

/**
 * Wallet tracking on Solana through Helius. A cheap signature check (1 credit) runs on every read;
 * the parsed history (Enhanced Transactions, ~100 credits) is only fetched when the wallet has done
 * something new, so a quiet wallet costs next to nothing.
 */
export const HELIUS_RPC_URL = "https://mainnet.helius-rpc.com";
export const HELIUS_API_URL = "https://api-mainnet.helius-rpc.com";

const QUOTES = new Set([
  "So11111111111111111111111111111111111111112", // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);
const WSOL = "So11111111111111111111111111111111111111112";

export interface HeliusTx {
  signature: string;
  timestamp: number;
  transactionError?: unknown;
  tokenTransfers?: { mint: string; tokenAmount: number; fromUserAccount?: string; toUserAccount?: string }[];
  accountData?: { account: string; nativeBalanceChange: number }[];
}

export interface WalletTrade {
  at: number;
  side: "buy" | "sell";
  mints: string[];
  /** SOL (incl. wrapped) spent on a buy or received on a sell. */
  sol: number;
}

/** A wallet's swaps from its parsed history: tokens in for SOL/stables out is a buy, the reverse a sell. */
export function walletTrades(txs: HeliusTx[], wallet: string): WalletTrade[] {
  const out: WalletTrade[] = [];
  for (const tx of txs) {
    if (tx.transactionError) continue;
    const tt = tx.tokenTransfers ?? [];
    const into = tt.filter((t) => t.toUserAccount === wallet && !QUOTES.has(t.mint)).map((t) => t.mint);
    const outOf = tt.filter((t) => t.fromUserAccount === wallet && !QUOTES.has(t.mint)).map((t) => t.mint);
    const wsol = tt.filter((t) => t.mint === WSOL).reduce((s, t) => s + (t.toUserAccount === wallet ? t.tokenAmount : t.fromUserAccount === wallet ? -t.tokenAmount : 0), 0);
    const native = (tx.accountData?.find((a) => a.account === wallet)?.nativeBalanceChange ?? 0) / 1e9;
    const sol = Math.round((native + wsol) * 1e6) / 1e6;
    const at = tx.timestamp * 1000;
    if (into.length && !outOf.length) out.push({ at, side: "buy", mints: [...new Set(into)], sol: Math.max(0, -sol) });
    else if (outOf.length && !into.length) out.push({ at, side: "sell", mints: [...new Set(outOf)], sol: Math.max(0, sol) });
  }
  return out;
}

export function walletFields(trades: WalletTrade[], now: number, mint: string | undefined, balance: number | null): Fields {
  const mine = mint ? trades.filter((t) => t.mints.includes(mint)) : trades;
  const hour = mine.filter((t) => t.at > now - 3_600_000);
  const last = (side: "buy" | "sell") => {
    const t = mine.filter((x) => x.side === side).sort((a, b) => b.at - a.at)[0];
    return t ? Math.max(0, Math.round((now - t.at) / 60_000)) : null;
  };
  const sum = (side: "buy" | "sell") => Math.round(hour.filter((t) => t.side === side).reduce((s, t) => s + t.sol, 0) * 1e4) / 1e4;
  return {
    buys_1h: hour.filter((t) => t.side === "buy").length,
    sells_1h: hour.filter((t) => t.side === "sell").length,
    sol_spent_1h: sum("buy"),
    sol_received_1h: sum("sell"),
    minutes_since_buy: last("buy"),
    minutes_since_sell: last("sell"),
    token_balance: balance,
  };
}

/** One trade per token for copying: buys and sells with the signature as a stable id. */
export interface LeaderTrade {
  id: string;
  at: number;
  side: "buy" | "sell";
  mint: string;
}

export function leaderTrades(trades: WalletTrade[], ids: string[]): LeaderTrade[] {
  return trades.flatMap((t, i) => t.mints.map((mint) => ({ id: `${ids[i]}:${mint}`, at: t.at, side: t.side, mint })));
}

/**
 * Parsed wallet histories from Helius, shared by the wallet signal, copy trading and the webhook.
 * A cheap signature check decides whether the (paid) parsed history needs refreshing; a webhook
 * can push transactions straight in, so the next read is instant and free.
 */
export class HeliusWallets {
  private readonly history = new Map<string, { top: string; txs: HeliusTx[]; at: number }>();
  private readonly rpc: string;
  private readonly api: string;
  private readonly http: Http;
  private readonly key: string;

  constructor(http: Http, key: string, opts: { rpc?: string; api?: string } = {}) {
    this.http = http;
    this.key = key;
    this.rpc = `${opts.rpc ?? HELIUS_RPC_URL}/?api-key=${key}`;
    this.api = opts.api ?? HELIUS_API_URL;
  }

  call<T>(method: string, params: unknown[], ttlMs: number): Promise<T | null> {
    return this.http.json<{ result?: T }>(this.rpc, { method: "POST", body: { jsonrpc: "2.0", id: 1, method, params }, ttlMs, timeoutMs: 15_000 }).then((r) => r.result ?? null);
  }

  /** The wallet's recent parsed transactions (newest first, as Helius returns them). */
  async txs(address: string): Promise<HeliusTx[]> {
    const h = this.history.get(address);
    // Pushed by the webhook moments ago: no need to ask.
    if (h && Date.now() - h.at < 20_000) return h.txs;
    const sigs = await this.call<{ signature: string }[]>("getSignaturesForAddress", [address, { limit: 1 }], 15_000);
    const top = sigs?.[0]?.signature ?? "";
    if (h && h.top === top) {
      h.at = Date.now();
      return h.txs;
    }
    const txs = top ? await this.http.json<HeliusTx[]>(`${this.api}/v0/addresses/${address}/transactions?api-key=${this.key}&limit=100`, { ttlMs: 15_000, timeoutMs: 20_000 }) : [];
    const list = Array.isArray(txs) ? txs : [];
    this.remember(address, top, list);
    return list;
  }

  /** Transactions a webhook delivered: merged in front, so reads see them immediately. */
  ingest(address: string, txs: HeliusTx[]): void {
    const h = this.history.get(address);
    const known = new Set((h?.txs ?? []).map((t) => t.signature));
    const fresh = txs.filter((t) => !known.has(t.signature)).sort((a, b) => b.timestamp - a.timestamp);
    if (!fresh.length) return;
    const merged = [...fresh, ...(h?.txs ?? [])].slice(0, 150);
    this.remember(address, merged[0]!.signature, merged);
  }

  private remember(address: string, top: string, txs: HeliusTx[]) {
    this.history.delete(address);
    this.history.set(address, { top, txs, at: Date.now() });
    if (this.history.size > 2_000) this.history.delete(this.history.keys().next().value!);
  }

  /** Buys and sells per token, oldest first, for copy trading. */
  async trades(address: string): Promise<LeaderTrade[]> {
    const txs = (await this.txs(address)).filter((t) => !t.transactionError);
    return leaderTrades(walletTrades(txs, address), txs.map((t) => t.signature)).sort((a, b) => a.at - b.at);
  }

  async tokenBalance(address: string, mint: string): Promise<number | null> {
    const r = await this.call<{ value: { account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }[] }>(
      "getTokenAccountsByOwner",
      [address, { mint }, { encoding: "jsonParsed" }],
      60_000
    );
    return r ? r.value.reduce((sum, a) => sum + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0) : null;
  }
}

export function walletProvider(wallets: HeliusWallets, onError?: (k: string, e: unknown) => void): SignalProvider {
  return defineProvider(
    ["wallet"],
    "live",
    async (s, now) => {
      const { address, mint } = s.params;
      const txs = await wallets.txs(address);
      const balance = mint ? await wallets.tokenBalance(address, mint) : null;
      return walletFields(walletTrades(txs, address), now, mint, balance);
    },
    onError
  );
}
