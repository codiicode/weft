import { PublicKey } from "@solana/web3.js";

/** Program ids (mainnet = devnet for these). */
export const PROGRAMS = {
  system: new PublicKey("11111111111111111111111111111111"),
  computeBudget: new PublicKey("ComputeBudget111111111111111111111111111111"),
  token: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  token2022: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
  associatedToken: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  /** Jupiter Aggregator v6. */
  jupiterV6: new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
  /** Meteora DLMM (liquidity positions). */
  meteoraDlmm: new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"),
  /** Kamino Lend (klend): reserve deposits and withdrawals. */
  kaminoLend: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
  /** Jupiter Lend Earn (deposits and withdrawals; the liquidity layer is only reached through it). */
  jupiterLend: new PublicKey("jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9"),
  /** SPL Memo (DLMM's *2 instructions pass it for transfer hooks). */
  memo: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
} as const;

export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/** The allow-list a Jupiter swap needs: aggregator, SPL Token, Token-2022, ATA, Compute Budget, System. */
export const DEFAULT_ALLOWED_PROGRAMS: readonly PublicKey[] = [
  PROGRAMS.jupiterV6,
  PROGRAMS.token,
  PROGRAMS.token2022,
  PROGRAMS.associatedToken,
  PROGRAMS.computeBudget,
  PROGRAMS.system,
];

/** What a liquidity transaction may call: the swap set plus Meteora DLMM and Memo. */
export const LP_ALLOWED_PROGRAMS: readonly PublicKey[] = [...DEFAULT_ALLOWED_PROGRAMS, PROGRAMS.meteoraDlmm, PROGRAMS.memo];

/** What a lending transaction may call: the swap set plus Kamino Lend and Jupiter Lend. */
export const LEND_ALLOWED_PROGRAMS: readonly PublicKey[] = [...DEFAULT_ALLOWED_PROGRAMS, PROGRAMS.kaminoLend, PROGRAMS.jupiterLend];

/** A lending instruction the inspector allows, with the positions of the accounts it checks. */
export interface LendIxLayout {
  name: string;
  /** Must be the user. */
  owner?: number;
  /** Mints whose user ATAs count as the user's (the token lent, the receipt token). */
  liquidityMint?: number;
  collateralMint?: number;
  /** Token accounts that must be the user's (where tokens come from and go to). */
  userAccounts?: number[];
}

/**
 * The klend instructions a lending transaction may contain, by Anchor discriminator, with the
 * positions of the accounts the inspector checks (from the program's IDL, as in klend-sdk's codegen).
 * Everything else klend does (obligations, borrowing, liquidations, admin) is refused.
 */
export const KLEND_IX: Record<string, LendIxLayout> = {
  "02da8aeb4fc91966": { name: "refresh_reserve" },
  a9c91e7e06cd6644: { name: "deposit_reserve_liquidity", owner: 0, liquidityMint: 4, collateralMint: 6, userAccounts: [7, 8] },
  ea75b57db98edc1d: { name: "redeem_reserve_collateral", owner: 0, liquidityMint: 4, collateralMint: 5, userAccounts: [7, 8] },
};

/**
 * Jupiter Lend Earn instructions a lending transaction may contain (layouts from Jupiter's Earn CPI
 * docs: deposit = signer, depositor token account, recipient jlToken account, mint, …, jlToken mint
 * at 6; withdraw/redeem = signer, jlToken account, recipient token account, …, mint at 5, jlToken
 * mint at 6). Borrowing, flashloans and admin are refused.
 */
export const JLEND_IX: Record<string, LendIxLayout> = {
  f223c68952e1f2b6: { name: "deposit", owner: 0, liquidityMint: 3, collateralMint: 6, userAccounts: [1, 2] },
  b80c569546c461e1: { name: "redeem", owner: 0, liquidityMint: 5, collateralMint: 6, userAccounts: [1, 2] },
  b712469c946da122: { name: "withdraw", owner: 0, liquidityMint: 5, collateralMint: 6, userAccounts: [1, 2] },
};

/** Lending programs and their allowed instructions, by program id. */
export const LEND_IX: ReadonlyMap<string, { prefix: string; ix: Record<string, LendIxLayout> }> = new Map([
  [PROGRAMS.kaminoLend.toBase58(), { prefix: "klend", ix: KLEND_IX }],
  [PROGRAMS.jupiterLend.toBase58(), { prefix: "jlend", ix: JLEND_IX }],
]);

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey = PROGRAMS.token): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], PROGRAMS.associatedToken)[0];
}

/**
 * Jupiter v6 instructions, from the program's on-chain Anchor IDL
 * (account C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa). Indices are positions in the
 * instruction's account list. Discriminator = sha256("global:<name>")[0..8].
 *
 * - `authority`: the account whose tokens are spent (must be the user);
 * - `destinations`: accounts that receive the output (must be the user's, unless the
 *   optional slot holds the program-id placeholder = None);
 * - `platformFee`: the integrator fee account (must be the configured fee account or None).
 */
export interface JupiterIxLayout {
  name: string;
  discriminator: string;
  kind: "swap" | "setup" | "admin";
  authority?: number;
  destinations?: number[];
  platformFee?: number;
  /** For setup instructions: the account that must be the user. */
  user?: number;
}

export const JUPITER_IX: readonly JupiterIxLayout[] = [
  { name: "route", discriminator: "e517cb977ae3ad2a", kind: "swap", authority: 1, destinations: [3, 4], platformFee: 6 },
  { name: "route_with_token_ledger", discriminator: "96564774a75d0e68", kind: "swap", authority: 1, destinations: [3, 4], platformFee: 6 },
  { name: "exact_out_route", discriminator: "d033ef977b2bed5c", kind: "swap", authority: 1, destinations: [3, 4], platformFee: 7 },
  { name: "shared_accounts_route", discriminator: "c1209b3341d69c81", kind: "swap", authority: 2, destinations: [6], platformFee: 9 },
  { name: "shared_accounts_route_with_token_ledger", discriminator: "e6798f50779f6aaa", kind: "swap", authority: 2, destinations: [6], platformFee: 9 },
  { name: "shared_accounts_exact_out_route", discriminator: "b0d169a89a7d453e", kind: "swap", authority: 2, destinations: [6], platformFee: 9 },
  { name: "route_v2", discriminator: "bb64facc31c4af14", kind: "swap", authority: 0, destinations: [2, 7] },
  { name: "exact_out_route_v2", discriminator: "9d8ab85215f4f324", kind: "swap", authority: 0, destinations: [2, 7] },
  { name: "shared_accounts_route_v2", discriminator: "d19853937cfed8e9", kind: "swap", authority: 1, destinations: [5] },
  { name: "shared_accounts_exact_out_route_v2", discriminator: "3560e5cad8bbfa18", kind: "swap", authority: 1, destinations: [5] },
  { name: "create_token_ledger", discriminator: "e8f2c5fdf08f8134", kind: "setup", user: 1 },
  { name: "set_token_ledger", discriminator: "e455b9704e4f4d02", kind: "setup" },
  { name: "create_token_account", discriminator: "93f17b64f484ae76", kind: "setup", user: 1 },
  { name: "create_idempotent_associated_token_account", discriminator: "5368c096b4479cc6", kind: "setup", user: 0 },
  { name: "close_wsol_token_account", discriminator: "cb816785c57d6b56", kind: "setup", user: 1 },
  { name: "claim", discriminator: "3ec6d6c1d59f6cd2", kind: "admin" },
  { name: "claim_token", discriminator: "74ce1bbfa6130049", kind: "admin" },
  { name: "close_token", discriminator: "1a4aec976840b7f9", kind: "admin" },
  { name: "withdraw_token_account_excess_lamports", discriminator: "927c0e00b5717293", kind: "admin" },
];
