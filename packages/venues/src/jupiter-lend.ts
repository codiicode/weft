import { JUPITER_LEND_PROGRAM, type LendInstrument } from "@weft/strategy";
import type { Http } from "./http.ts";
import { JUP_LITE_URL } from "./jupiter/client.ts";

/**
 * Jupiter Lend (Earn), read side: every vault with today's rate, deposits, what a jlToken is worth
 * and how much can be withdrawn right now, from Jupiter's Lend API. A jlToken's value includes the
 * vault's rewards, so its price carries the whole rate.
 */
export interface JupiterLendRow {
  /** The jlToken mint (the vault's receipt token). */
  jlMint: string;
  mint: string;
  symbol: string;
  decimals: number;
  /** Interest + rewards, % a year. */
  apyPct: number;
  supplyApyPct: number;
  rewardsApyPct: number;
  totalSupplyUsd: number;
  /** Tokens per jlToken. */
  rate: number;
  /** Tokens (raw units) that can be withdrawn right now. */
  withdrawableRaw: bigint;
}

interface RawEarnToken {
  address: string;
  decimals: number;
  assetAddress: string;
  asset: { symbol: string; decimals: number; price?: string };
  totalAssets: string;
  convertToAssets: string;
  rewardsRate: string;
  supplyRate: string;
  totalRate: string;
  liquiditySupplyData?: { withdrawable?: string };
}

export class JupiterLend {
  private readonly http: Http;
  private readonly base: string;
  private readonly headers: Record<string, string>;
  constructor(http: Http, o: { url?: string; apiKey?: string } = {}) {
    this.http = http;
    this.base = (o.url ?? JUP_LITE_URL).replace(/\/$/, "");
    this.headers = o.apiKey ? { "x-api-key": o.apiKey } : {};
  }

  async vaults(): Promise<JupiterLendRow[]> {
    const raw = await this.http.json<RawEarnToken[]>(`${this.base}/lend/v1/earn/tokens`, { ttlMs: 60_000, timeoutMs: 20_000, headers: this.headers });
    return raw.map((t) => {
      const dec = t.asset.decimals ?? t.decimals;
      return {
        jlMint: t.address,
        mint: t.assetAddress,
        symbol: t.asset.symbol,
        decimals: dec,
        apyPct: Number(t.totalRate) / 100,
        supplyApyPct: Number(t.supplyRate) / 100,
        rewardsApyPct: Number(t.rewardsRate) / 100,
        totalSupplyUsd: (Number(t.totalAssets) / 10 ** dec) * Number(t.asset.price ?? 0),
        // convertToAssets is the tokens one whole jlToken (10^decimals units) is worth, in raw units.
        rate: Number(t.convertToAssets) / 10 ** t.decimals,
        withdrawableRaw: BigInt(t.liquiditySupplyData?.withdrawable ?? "0"),
      };
    });
  }

  async vault(jlMint: string): Promise<JupiterLendRow | null> {
    return (await this.vaults()).find((v) => v.jlMint === jlMint) ?? null;
  }

  /** Vaults for a token ("usdc", "sol"); everything, biggest first, when the search names none. */
  async search(q: string, limit = 10): Promise<JupiterLendRow[]> {
    const words = q.toLowerCase().replace(/jupiter|jup|lend(ing)?|earn|supply|deposit|kamino/g, " ").split(/[\s,/]+/).filter(Boolean);
    return (await this.vaults())
      .filter((v) => words.every((w) => v.symbol.toLowerCase().includes(w) || v.mint.toLowerCase() === w || (w === "sol" && v.symbol === "WSOL")))
      .sort((a, b) => b.totalSupplyUsd - a.totalSupplyUsd)
      .slice(0, limit);
  }
}

export function jupiterLendInstrument(v: JupiterLendRow): LendInstrument {
  const symbol = v.symbol === "WSOL" ? "SOL" : v.symbol;
  return { kind: "lend", venue: "jupiter", market: JUPITER_LEND_PROGRAM, reserve: v.jlMint, mint: v.mint, symbol, decimals: v.decimals, marketName: "Earn", assetClass: "crypto" };
}
