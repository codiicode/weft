import { Connection, PublicKey } from "@solana/web3.js";
import { Reserve } from "@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/Reserve.js";

/**
 * Kamino lending (klend) on Solana: reading a reserve straight from the chain. A deposit into a
 * reserve's liquidity gives back its collateral token (kToken); a kToken is worth more of the token
 * as interest accrues. Its value = the reserve's total supply (cash + borrows − fees) ÷ kTokens out.
 */
export const KLEND_PROGRAM = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const NULL_KEY = "11111111111111111111111111111111";
const SF = 2n ** 60n; // klend's scaled fractions

export interface ReserveInfo {
  reserve: PublicKey;
  lendingMarket: PublicKey;
  liquidityMint: PublicKey;
  liquiditySupply: PublicKey;
  liquidityTokenProgram: PublicKey;
  liquidityDecimals: number;
  collateralMint: PublicKey;
  /** Oracles the reserve refresh reads (null = not used). */
  pyth: PublicKey | null;
  switchboardPrice: PublicKey | null;
  switchboardTwap: PublicKey | null;
  scope: PublicKey | null;
  /** Tokens (raw units) available to withdraw right now. */
  availableRaw: bigint;
  /** Tokens per kToken (both in their own raw units, which share decimals). */
  exchangeRate: number;
}

const key = (a: string) => (a === NULL_KEY ? null : new PublicKey(a));
const big = (x: { toString(): string }) => BigInt(x.toString());

export function decodeReserve(address: PublicKey, data: Buffer): ReserveInfo {
  const r = Reserve.decode(data);
  const liq = r.liquidity, col = r.collateral, ti = r.config.tokenInfo;
  const supplySf = big(liq.totalAvailableAmount) * SF + big(liq.borrowedAmountSf) - big(liq.accumulatedProtocolFeesSf) - big(liq.accumulatedReferrerFeesSf) - big(liq.pendingReferrerFeesSf);
  const kTokens = big(col.mintTotalSupply);
  return {
    reserve: address,
    lendingMarket: new PublicKey(r.lendingMarket),
    liquidityMint: new PublicKey(liq.mintPubkey),
    liquiditySupply: new PublicKey(liq.supplyVault),
    liquidityTokenProgram: new PublicKey(liq.tokenProgram),
    liquidityDecimals: Number(liq.mintDecimals.toString()),
    collateralMint: new PublicKey(col.mintPubkey),
    pyth: key(ti.pythConfiguration.price),
    switchboardPrice: key(ti.switchboardConfiguration.priceAggregator),
    switchboardTwap: key(ti.switchboardConfiguration.twapAggregator),
    scope: key(ti.scopeConfiguration.priceFeed),
    availableRaw: big(liq.totalAvailableAmount),
    exchangeRate: kTokens > 0n ? Number((supplySf * 1_000_000_000n) / (kTokens * SF)) / 1e9 : 1,
  };
}

export async function readReserve(conn: Connection, reserve: PublicKey): Promise<ReserveInfo> {
  const acc = await conn.getAccountInfo(reserve, "confirmed");
  if (!acc) throw new Error(`no Kamino reserve at ${reserve.toBase58()}`);
  if (!acc.owner.equals(KLEND_PROGRAM)) throw new Error("that account isn't a Kamino reserve");
  return decodeReserve(reserve, acc.data);
}

/** Tokens per kToken for a reserve, cached briefly (it moves with every refresh of the reserve). */
export function kaminoRates(conn: Connection, ttlMs = 30_000) {
  const cache = new Map<string, { at: number; v: Promise<ReserveInfo> }>();
  return (reserve: string): Promise<ReserveInfo> => {
    const hit = cache.get(reserve);
    if (hit && Date.now() - hit.at < ttlMs) return hit.v;
    const v = readReserve(conn, new PublicKey(reserve));
    cache.set(reserve, { at: Date.now(), v });
    v.catch(() => cache.delete(reserve));
    return v;
  };
}
