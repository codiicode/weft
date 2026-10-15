import { PublicKey } from "@solana/web3.js";
import type { Engine } from "@weft/engine";
import type { Accounts } from "../lib/accounts.ts";

/**
 * Keeps live Solana positions honest about the wallet. A user owns their trading wallet and can move
 * or sell tokens by hand; when the wallet holds less than a position says, the difference is booked
 * out at the current price (no order) so the run never tries to sell coins that aren't there.
 *
 * To avoid acting on a lagging RPC, a shortfall must show on two checks in a row, and positions
 * younger than three minutes are left alone.
 */

export interface SolanaBalances {
  /** Atomic-unit balance and decimals of `mint` across the owner's token accounts. */
  tokenBalance(owner: string, mint: string): Promise<{ amount: bigint; decimals: number } | null>;
}

export function connectionBalances(conn: { getParsedTokenAccountsByOwner: (o: PublicKey, f: { mint: PublicKey }) => Promise<{ value: { account: { data: unknown } }[] }> }): SolanaBalances {
  return {
    async tokenBalance(owner, mint) {
      const r = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
      let amount = 0n;
      let decimals = 0;
      for (const a of r.value) {
        const t = (a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } } }).parsed?.info?.tokenAmount;
        amount += BigInt(t?.amount ?? "0");
        decimals = t?.decimals ?? decimals;
      }
      return { amount, decimals };
    },
  };
}

export class SolanaReconciler {
  private readonly suspects = new Map<string, number>();
  private readonly engine: Engine;
  private readonly accounts: Accounts;
  private readonly balances: SolanaBalances;
  private readonly now: () => number;
  constructor(engine: Engine, accounts: Accounts, balances: SolanaBalances, now: () => number = Date.now) {
    this.engine = engine;
    this.accounts = accounts;
    this.balances = balances;
    this.now = now;
  }

  /** One pass. Returns the positions that were adjusted. */
  async run(): Promise<{ deploymentId: string; positionId: string; bookedOut: number }[]> {
    const out: { deploymentId: string; positionId: string; bookedOut: number }[] = [];
    const seen = new Set<string>();
    for (const d of await this.engine.listDeployments()) {
      if (d.mode !== "live" || (d.status !== "running" && d.status !== "paused")) continue;
      const owner = this.accounts.deploymentOwner(d.id);
      const wallet = owner ? this.accounts.solanaAccount(owner) : null;
      if (!wallet) continue;
      const snap = await this.engine.getSnapshot(d.id);
      for (const p of snap?.positions ?? []) {
        if (p.instrument.kind !== "token") continue;
        const key = `${d.id}|${p.id}`;
        seen.add(key);
        if (this.now() - p.openedAt < 3 * 60_000) continue;
        const bal = await this.balances.tokenBalance(wallet.address, p.instrument.mint).catch(() => null);
        if (!bal) continue;
        const held = Number(bal.amount) / 10 ** bal.decimals;
        if (held >= p.qty * 0.98) {
          this.suspects.delete(key);
          continue;
        }
        // First sighting: wait for the next pass to confirm it.
        if (!this.suspects.has(key)) {
          this.suspects.set(key, this.now());
          continue;
        }
        const booked = (await this.engine.reconcilePosition?.(d.id, p.id, held)) ?? 0;
        this.suspects.delete(key);
        if (booked > 0) out.push({ deploymentId: d.id, positionId: p.id, bookedOut: booked });
      }
    }
    for (const k of [...this.suspects.keys()]) if (!seen.has(k)) this.suspects.delete(k);
    return out;
  }
}
