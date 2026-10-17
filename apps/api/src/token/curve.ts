import {
  ActivationType,
  BaseFeeMode,
  buildCurve,
  CollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

/**
 * $WEFT on Meteora's Dynamic Bonding Curve (decided 2026-10-17): priced in SOL, the whole supply on
 * the curve (no team allocation, no vesting, no first buy by Weft), and once the curve holds
 * `migrationQuoteThreshold` SOL it graduates to a DAMM v2 pool whose liquidity is locked for good.
 *
 * Weft is the "partner": it receives the partner share of the curve's trading fee (after Meteora's
 * 20%) and owns the locked LP of the graduated pool, so its fees too. Half of what comes in buys
 * back $WEFT, like every other fee.
 */
export const WEFT_TOKEN = {
  name: "Weft",
  symbol: "WEFT",
  /** Metaplex JSON served by the website. */
  uri: "https://weft.fi/token/weft.json",
  supply: 1_000_000_000,
  decimals: 6,
} as const;

export interface CurveOptions {
  /** SOL in the curve when it graduates. 85 on mainnet; small on devnet so a test can reach it. */
  migrationQuoteThreshold: number;
  /** Trading fee on the curve, in bps (Meteora's minimum is 25). */
  curveFeeBps?: number;
  /** Fee tier of the graduated DAMM v2 pool. */
  migratedPoolFee?: MigrationFeeOption;
}

export function weftCurve({ migrationQuoteThreshold, curveFeeBps = 100, migratedPoolFee = MigrationFeeOption.FixedBps100 }: CurveOptions): ConfigParameters {
  return buildCurve({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE, // SOL
      // Mint authority is gone at creation (no more $WEFT can ever be made). Weft keeps the metadata
      // update authority until the links are final, then revokes it.
      tokenAuthorityOption: TokenAuthorityOption.PartnerUpdateAuthority,
      totalTokenSupply: WEFT_TOKEN.supply,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: curveFeeBps, endingFeeBps: curveFeeBps, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken, // fees in SOL
      creatorTradingFeePercentage: 0, // Weft is both partner and creator: everything to the partner side
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: migratedPoolFee,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      // All of the graduated pool's liquidity is locked forever; its trading fees still go to Weft.
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold,
  });
}
