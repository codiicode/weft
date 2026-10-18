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
