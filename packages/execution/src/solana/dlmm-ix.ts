import { createRequire } from "node:module";

// The SDK's ESM build has a broken directory import (anchor/utils/bytes); its CommonJS build works.
const { IDL } = createRequire(import.meta.url)("@meteora-ag/dlmm") as typeof import("@meteora-ag/dlmm");

/**
 * Meteora DLMM instructions by discriminator, from the SDK's copy of the program IDL: their names,
 * account names in order (so the inspector checks accounts by role, not by position), and whether a
 * liquidity transaction Weft signs may contain them. Allowed: opening and sizing a position, adding
 * and removing liquidity, claiming its fees and rewards, closing it. Everything else (swaps, pool
 * admin, operators, limit orders, position transfers) is refused.
 */
const ALLOWED = new Set([
  "initialize_position",
  "initialize_position2",
  "increase_position_length",
  "increase_position_length2",
  "add_liquidity_by_strategy",
  "add_liquidity_by_strategy2",
  "remove_liquidity",
  "remove_liquidity2",
  "remove_liquidity_by_range",
  "remove_liquidity_by_range2",
  "remove_all_liquidity",
  "claim_fee",
  "claim_fee2",
  "claim_reward",
  "claim_reward2",
  "close_position",
  "close_position2",
  "close_position_if_empty",
]);

type IdlIx = { name: string; discriminator: number[]; accounts: { name: string }[] };

export const DLMM_IX: Map<string, { name: string; accounts: string[]; allowed: boolean }> = new Map(
  (IDL as unknown as { instructions: IdlIx[] }).instructions.map((i) => [
    Buffer.from(i.discriminator).toString("hex"),
    { name: i.name, accounts: i.accounts.map((a) => a.name), allowed: ALLOWED.has(i.name) },
  ]),
);
