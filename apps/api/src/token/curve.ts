import {
  ActivationType,
  BaseFeeMode,
  buildCurve,
  CollectFeeMode,
  DammV2DynamicFeeMode,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

/**
 * $WEFT on Meteora's Dynamic Bonding Curve (decided 2026-10-17): priced in SOL, the whole supply on
 * the curve (no team allocation, no vesting). Weft makes a dev buy in the creating transaction and
 * burns all of it (decided 2026-10-17): buying pressure and a smaller supply, no team tokens. Once the curve holds
 * `migrationQuoteThreshold` SOL it graduates to a DAMM v2 pool whose liquidity is locked for good.
 *
 * Trading fee (decided 2026-10-17): 3% on every $WEFT trade, on the curve and in the graduated pool.
 * Meteora keeps 20% of it (0.6%); Weft, the "partner", gets the other 2.4% and owns the locked LP of
 * the graduated pool. Of Weft's 2.4%, 0.4% buys back $WEFT and 2% is protocol revenue.
 */
export const TOKEN_FEE = { totalBps: 300, meteoraBps: 60, buybackBps: 40, protocolBps: 200 } as const;
/**
 * Against snipers (decided 2026-10-17): the curve's fee starts at 30% when trading opens and falls in a
 * straight line to 3% over the first minute, one step a second (−0.45 points each). Split the same way.
 */
export const LAUNCH_FEE = { startBps: 3000, durationSec: 60, periods: 60 } as const;
/** The part of Weft's own share of $WEFT trading fees that goes to buybacks (0.4 of 2.4). */
export const TOKEN_FEE_BUYBACK_SHARE = TOKEN_FEE.buybackBps / (TOKEN_FEE.buybackBps + TOKEN_FEE.protocolBps);
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
  /** Trading fee of the graduated DAMM v2 pool, in bps. */
  migratedPoolFeeBps?: number;
  /** Start at LAUNCH_FEE and fall to curveFeeBps over its first minute (default true). */
  launchFee?: boolean;
  /**
   * The swap made in the same transaction as the pool (Weft's dev buy, burned right after) pays the
   * minimum fee instead of the launch fee. Only that one swap can: it has to be in the creating
   * transaction. Default true.
   */
  firstSwapMinFee?: boolean;
}

/** The DAMM v2 config the graduated pool uses: a custom fee tier, so 3% carries on after graduation. */
export const MIGRATION_FEE_OPTION = MigrationFeeOption.Customizable;

export function weftCurve({ migrationQuoteThreshold, curveFeeBps = TOKEN_FEE.totalBps, migratedPoolFeeBps = TOKEN_FEE.totalBps, launchFee = true, firstSwapMinFee = true }: CurveOptions): ConfigParameters {
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
        feeSchedulerParam: launchFee
          ? { startingFeeBps: LAUNCH_FEE.startBps, endingFeeBps: curveFeeBps, numberOfPeriod: LAUNCH_FEE.periods, totalDuration: LAUNCH_FEE.durationSec }
          : { startingFeeBps: curveFeeBps, endingFeeBps: curveFeeBps, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken, // fees in SOL
      creatorTradingFeePercentage: 0, // Weft is both partner and creator: everything to the partner side
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: firstSwapMinFee,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MIGRATION_FEE_OPTION,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: { collectFeeMode: MigratedCollectFeeMode.QuoteToken, dynamicFee: DammV2DynamicFeeMode.Disabled, poolFeeBps: migratedPoolFeeBps },
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
