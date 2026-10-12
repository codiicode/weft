import type { Http } from "./http.ts";
import { num } from "./util.ts";

/**
 * Fallback sources for Solana token facts:
 *  - DexScreener (https://api.dexscreener.com, free, ~300 req/min): pairs, liquidity, age, txns.
 *  - Solana JSON-RPC getAccountInfo (jsonParsed): mint/freeze authority straight from the mint account.
 *    The public mainnet-beta endpoint is heavily rate limited; pass a private RPC (Helius etc.) in prod.
 */

export const DEXSCREENER_URL = "https://api.dexscreener.com";
export const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";

export interface RawDexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  txns?: Record<string, { buys: number; sells: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

export interface DexSummary {
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  /** Earliest pair creation, ms. */
  firstPairAt: number | null;
  buys1h: number | null;
  sells1h: number | null;
  priceChange: { m5: number | null; h1: number | null; h24: number | null };
  pairs: number;
}

/** Aggregate all pairs where the mint is the base token. */
export function summarizeDexPairs(pairs: RawDexPair[], mint: string): DexSummary | null {
  const own = pairs.filter((p) => p.chainId === "solana" && p.baseToken?.address === mint);
  if (!own.length) return null;
  const byLiq = [...own].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const top = byLiq[0]!;
  const sumOf = (f: (p: RawDexPair) => number | undefined) => {
    const xs = own.map(f).filter((x): x is number => typeof x === "number");
    return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
  };
  const created = own.map((p) => p.pairCreatedAt).filter((x): x is number => typeof x === "number");
  return {
    priceUsd: num(top.priceUsd),
    liquidityUsd: sumOf((p) => p.liquidity?.usd),
    marketCapUsd: top.marketCap ?? top.fdv ?? null,
    volume24hUsd: sumOf((p) => p.volume?.h24),
    firstPairAt: created.length ? Math.min(...created) : null,
    buys1h: sumOf((p) => p.txns?.h1?.buys),
    sells1h: sumOf((p) => p.txns?.h1?.sells),
    priceChange: { m5: top.priceChange?.m5 ?? null, h1: top.priceChange?.h1 ?? null, h24: top.priceChange?.h24 ?? null },
    pairs: own.length,
  };
}

export class DexScreenerClient {
  private readonly http: Http;
  private readonly url: string;

  constructor(http: Http, url: string = DEXSCREENER_URL) {
    this.http = http;
    this.url = url;
  }

  async tokenPairs(mint: string): Promise<RawDexPair[]> {
    const r = await this.http.json<RawDexPair[] | { pairs?: RawDexPair[] }>(`${this.url}/tokens/v1/solana/${mint}`, { ttlMs: 30_000 });
    return Array.isArray(r) ? r : (r.pairs ?? []);
  }

  async summary(mint: string): Promise<DexSummary | null> {
    return summarizeDexPairs(await this.tokenPairs(mint), mint);
  }
}

export interface MintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number | null;
  supply: number | null;
  program: string | null;
}

export function parseMintAccount(raw: unknown): MintInfo | null {
  const v = (raw as { result?: { value?: { data?: { parsed?: { info?: Record<string, unknown>; type?: string }; program?: string } } } })
    ?.result?.value;
  const info = v?.data?.parsed?.info;
  if (!info || v?.data?.parsed?.type !== "mint") return null;
  const decimals = typeof info.decimals === "number" ? info.decimals : null;
  const supplyRaw = num(info.supply);
  return {
    mintAuthority: typeof info.mintAuthority === "string" ? info.mintAuthority : null,
    freezeAuthority: typeof info.freezeAuthority === "string" ? info.freezeAuthority : null,
    decimals,
    supply: supplyRaw != null && decimals != null ? supplyRaw / 10 ** decimals : null,
    program: v?.data?.program ?? null,
  };
}

export class SolanaRpcClient {
  private readonly http: Http;
  private readonly url: string;

  constructor(http: Http, url: string = SOLANA_RPC_URL) {
    this.http = http;
    this.url = url;
  }

  async mintInfo(mint: string): Promise<MintInfo | null> {
    const raw = await this.http.json(this.url, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [mint, { encoding: "jsonParsed" }] },
      ttlMs: 10 * 60_000,
      retries: 1,
    });
    return parseMintAccount(raw);
  }
}
