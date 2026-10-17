import { Connection, PublicKey } from "@solana/web3.js";

/**
 * $WEFT holder tiers (decided 2026-10-17): Holder from 100,000 $WEFT pays 25% less in trading fees,
 * Whale from 1,000,000 pays 50% less (and both get a bigger share of the daily rewards). Users holding at least `minAmount` $WEFT pay `discount` less in trading
 * fees. Holdings are read on-chain from Solana wallets that provably belong to the user (their Weft
 * trading wallet and wallets linked to their Privy account), never from anything the client says.
 * Off until the token exists (WEFT_TOKEN_MINT) and a threshold is set (WEFT_HOLDER_MIN).
 */

export interface HolderConfig {
  mint: PublicKey | null;
  /** Tokens (UI units) a wallet set must hold. */
  minAmount: number;
  /** Holder tier: 0.25 = a quarter off the fee. */
  discount: number;
  /** Tokens for the Whale tier. */
  bigAmount: number;
  /** Whale tier: 0.5 = half the fee. */
  bigDiscount: number;
}

export function holderConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HolderConfig {
  let mint: PublicKey | null = null;
  try {
    mint = env.WEFT_TOKEN_MINT ? new PublicKey(env.WEFT_TOKEN_MINT) : null;
  } catch {
    mint = null;
  }
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return {
    mint,
    minAmount: Number(env.WEFT_HOLDER_MIN ?? 100_000),
    discount: clamp(Number(env.WEFT_HOLDER_DISCOUNT ?? 0.25)),
    bigAmount: Number(env.WEFT_BIG_HOLDER_MIN ?? 1_000_000),
    bigDiscount: clamp(Number(env.WEFT_BIG_HOLDER_DISCOUNT ?? 0.5)),
  };
}

export interface HolderStatus {
  active: boolean;
  holds: number;
  minAmount: number;
  discount: number;
  /** Multiply Weft's fee by this (1 = full fee). */
  feeMultiplier: number;
  /** 0 none, 1 holder, 2 big holder. */
  tier: 0 | 1 | 2;
  bigAmount: number;
}

export class HolderDiscount {
  readonly cfg: HolderConfig;
  private readonly balance: (owner: PublicKey, mint: PublicKey) => Promise<number>;
  private readonly wallets: (userId: string) => Promise<string[]>;
  private readonly cache = new Map<string, { at: number; status: HolderStatus }>();

  constructor(cfg: HolderConfig, deps: { conn?: Connection; balance?: (owner: PublicKey, mint: PublicKey) => Promise<number>; wallets: (userId: string) => Promise<string[]> }) {
    this.cfg = cfg;
    this.wallets = deps.wallets;
    this.balance =
      deps.balance ??
      (async (owner, mint) => {
        const r = await deps.conn!.getParsedTokenAccountsByOwner(owner, { mint });
        return r.value.reduce((n, a) => n + Number((a.account.data as { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } }).parsed?.info?.tokenAmount?.uiAmount ?? 0), 0);
      });
  }

  get enabled(): boolean {
    return Boolean(this.cfg.mint && this.cfg.minAmount > 0 && this.cfg.discount > 0);
  }

  /** The user's discount, re-checked at most every 10 minutes. */
  async status(userId: string): Promise<HolderStatus> {
    const off: HolderStatus = { active: false, holds: 0, minAmount: this.cfg.minAmount, discount: 0, feeMultiplier: 1, tier: 0, bigAmount: this.cfg.bigAmount };
    if (!this.enabled) return off;
    const hit = this.cache.get(userId);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.status;
    let holds = 0;
    for (const w of new Set(await this.wallets(userId).catch(() => [] as string[]))) {
      try {
        holds += await this.balance(new PublicKey(w), this.cfg.mint!);
      } catch {
        // not a Solana address, or the RPC hiccuped: count what we can
      }
    }
    const active = holds >= this.cfg.minAmount;
    const tier = !active ? 0 : this.cfg.bigAmount > this.cfg.minAmount && holds >= this.cfg.bigAmount ? 2 : 1;
    const discount = tier === 2 ? this.cfg.bigDiscount : tier === 1 ? this.cfg.discount : 0;
    const status: HolderStatus = { active, holds, minAmount: this.cfg.minAmount, discount, feeMultiplier: 1 - discount, tier, bigAmount: this.cfg.bigAmount };
    this.cache.set(userId, { at: Date.now(), status });
    return status;
  }
}
