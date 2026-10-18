import type { Http } from "./http.ts";

/**
 * Papertrade (papertrade.xyz): synthetic BTC and ETH perps on Hyperliquid's HyperEVM, up to 1000×.
 * Every trade is a swap against the protocol's LP at Hyperliquid's mid price: no spread, slippage,
 * funding or fee on the position. Instead a winning close keeps only part of the gain (an "impact
 * haircut" that bites hardest on small moves) and pays 2% of what's left; a losing close pays the
 * loss; crossing the bust price forfeits the whole margin.
 *
 * Read API: https://exchange.papertrade.xyz (public JSON). Trading goes through signed EIP-712
 * intents posted to the same host (see @weft/execution's PapertradeExecutor). The settlement math
 * here follows the community protocol reference (github.com/nirholas/papertrade-sdk, verified there
 * against live settlements) and is checked in our tests against real closed trades.
 */

export const PAPERTRADE = {
  api: "https://exchange.papertrade.xyz",
  chainId: 999,
  rpc: "https://rpc.hyperliquid.xyz/evm",
  contracts: {
    exchange: "0x6cd5661646289fb6e65ea5c032310fded797d0a2",
    batchExecutor: "0x233ff29b239abc1d7748605da9b205c3e008626e",
    depositProxyFactory: "0x1629b7d46bef6e13ff754174fc9f32dea309b38f",
    coreDepositWallet: "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24",
    usdc: "0xb88339cb7199b77e23db6e890353e22632ba630f",
  },
} as const;

/** One market's settlement parameters (USD and plain numbers, already scaled). */
export interface SynthParams {
  instrumentId: number;
  symbol: "BTC" | "ETH";
  /** Prices on chain are integers: raw = price × priceScale. */
  priceScale: number;
  active: boolean;
  rateMultiplier: number;
  positionMultiplier: number;
  maxLeverage: number;
  maxPositionUsd: number;
  /** Liquidation fires this fraction before the zero-equity price (~0.048%). */
  bustBuffer: number;
  baseRate: number;
  referenceNotional: number;
}

export interface SynthLimits {
  paused: boolean;
  minMarginUsd: number;
  minNotionalUsd: number;
  winFeeRate: number;
  markets: Record<"BTC" | "ETH", SynthParams>;
}

/** Live values on 2026-10-18 (GET /state/trading), used when the API can't be reached. */
export const DEFAULT_SYNTH_LIMITS: SynthLimits = {
  paused: false,
  minMarginUsd: 10,
  minNotionalUsd: 1_000,
  winFeeRate: 0.02,
  markets: {
    BTC: { instrumentId: 0, symbol: "BTC", priceScale: 10, active: true, rateMultiplier: 15_000, positionMultiplier: 814.598, maxLeverage: 1000, maxPositionUsd: 10_000_000, bustBuffer: 0.000476041580087574, baseRate: 0.1, referenceNotional: 100_000 },
    ETH: { instrumentId: 1, symbol: "ETH", priceScale: 100, active: true, rateMultiplier: 15_000, positionMultiplier: 483.979, maxLeverage: 1000, maxPositionUsd: 10_000_000, bustBuffer: 0.00048130405018013, baseRate: 0.1, referenceNotional: 100_000 },
  },
};

const wad = (s: string | number | null | undefined) => (s == null ? 0 : Number(BigInt(String(s))) / 1e18);

/** Decode GET /state/trading into limits (instrument tuples by position, see the protocol reference). */
export function decodeTradingState(raw: { tradingPaused?: boolean; minimumTradeSizeRaw?: string; minimumOpenNotionalRaw?: string; winFeeRateRaw?: string; instruments?: unknown[][] }): SynthLimits {
  const markets = { ...DEFAULT_SYNTH_LIMITS.markets };
  for (const t of raw.instruments ?? []) {
    const symbol = t[1] as string;
    if (symbol !== "BTC" && symbol !== "ETH") continue;
    markets[symbol] = {
      instrumentId: Number(t[0]),
      symbol,
      priceScale: Number(t[3]),
      active: t[4] === true && t[5] !== true,
      rateMultiplier: wad(t[12] as string),
      positionMultiplier: wad(t[13] as string),
      maxLeverage: Number(t[14]),
      maxPositionUsd: wad(t[15] as string),
      bustBuffer: wad(t[16] as string),
      baseRate: wad(t[17] as string),
      referenceNotional: wad(t[18] as string),
    };
  }
  return {
    paused: raw.tradingPaused === true,
    minMarginUsd: raw.minimumTradeSizeRaw ? wad(raw.minimumTradeSizeRaw) : DEFAULT_SYNTH_LIMITS.minMarginUsd,
    minNotionalUsd: raw.minimumOpenNotionalRaw ? wad(raw.minimumOpenNotionalRaw) : DEFAULT_SYNTH_LIMITS.minNotionalUsd,
    winFeeRate: raw.winFeeRateRaw ? wad(raw.winFeeRateRaw) : DEFAULT_SYNTH_LIMITS.winFeeRate,
    markets,
  };
}

/**
 * The bust (liquidation) price, in USD. Exact in integer raw units on chain:
 *   long:  p0 = ceil(e·(L−1)/L);  bust = floor(p0·(1+buffer))
 *   short: p0 = floor(e·(L+1)/L); bust = ceil(p0·(1−buffer))
 */
export function synthBustPrice(side: "long" | "short", entry: number, leverage: number, m: Pick<SynthParams, "priceScale" | "bustBuffer">): number {
  const e = Math.round(entry * m.priceScale);
  const bust = side === "long" ? Math.floor(Math.ceil((e * (leverage - 1)) / leverage) * (1 + m.bustBuffer)) : Math.ceil(Math.floor((e * (leverage + 1)) / leverage) * (1 - m.bustBuffer));
  return bust / m.priceScale;
}

/**
 * What a close pays out over the margin, in USD, and what the venue keeps of the raw gain.
 * Winning: the gain after a small deadband shrinks by the impact haircut, then 2% goes as a fee.
 * Losing: exactly the loss (no fee). `notional` is margin × leverage.
 */
export function synthSettlement(side: "long" | "short", entry: number, exit: number, notional: number, m: SynthParams, winFeeRate = 0.02): { pnl: number; rawPnl: number; keptByVenue: number } {
  const dir = side === "long" ? 1 : -1;
  const rawPnl = (notional * (exit - entry) * dir) / entry;
  if (rawPnl <= 0) return { pnl: rawPnl, rawPnl, keptByVenue: 0 };
  const e = Math.round(entry * m.priceScale), x = Math.round(exit * m.priceScale);
  const gainRaw = (x - e) * dir - Math.floor(e / 50_000);
  if (gainRaw <= 0) return { pnl: 0, rawPnl, keptByVenue: rawPnl };
  const move = gainRaw / e;
  const scale = (1 - m.baseRate) / (1 + 1 / (move * m.rateMultiplier) + m.referenceNotional / (1e6 * move * m.positionMultiplier));
  const pnl = notional * move * scale * (1 - winFeeRate);
  return { pnl, rawPnl, keptByVenue: rawPnl - pnl };
}

/** Read-only client for the public API. */
export class PapertradeApi {
  private limits: { at: number; v: SynthLimits } | null = null;
  private readonly http: Http;
  private readonly base: string;
  constructor(http: Http, base: string = PAPERTRADE.api) {
    this.http = http;
    this.base = base;
  }

  /** Current limits and market parameters (cached a minute; defaults if the API is down). */
  async tradingLimits(): Promise<SynthLimits> {
    if (this.limits && Date.now() - this.limits.at < 60_000) return this.limits.v;
    try {
      const raw = await this.http.json<Parameters<typeof decodeTradingState>[0]>(`${this.base}/state/trading`, { ttlMs: 60_000, timeoutMs: 10_000 });
      const v = decodeTradingState(raw);
      this.limits = { at: Date.now(), v };
      return v;
    } catch {
      return this.limits?.v ?? DEFAULT_SYNTH_LIMITS;
    }
  }

  /** 24h volume per market, USD (the API keys markets by instrument id). */
  async marketStats(): Promise<Record<string, number>> {
    const r = await this.http.json<{ markets?: Record<string, { volume_24h?: string }> }>(`${this.base}/query/protocol/market-stats`, { ttlMs: 60_000, timeoutMs: 10_000 });
    const byId: Record<string, string> = { "0": "BTC", "1": "ETH" };
    const out: Record<string, number> = {};
    for (const [id, m] of Object.entries(r.markets ?? {})) if (byId[id] && m.volume_24h) out[byId[id]] = wad(m.volume_24h);
    return out;
  }

  /** Protocol totals: TVL, LP, payout queue, volume, open positions. USD. */
  async summary(): Promise<{ tvlUsd: number; lpUsd: number; queueUsd: number; volumeUsd: number; openPositions: number }> {
    const r = await this.http.json<{ balances: { tvl: string; lp: string; queue: string }; activity: { volume: string; open: number } }>(`${this.base}/query/protocol/summary`, { ttlMs: 60_000, timeoutMs: 10_000 });
    return { tvlUsd: wad(r.balances.tvl), lpUsd: wad(r.balances.lp), queueUsd: wad(r.balances.queue), volumeUsd: wad(r.activity.volume), openPositions: r.activity.open };
  }
}
