import type { Engine } from "@weft/engine";
import { HttpHlInfo, type FetchLike } from "@weft/execution";
import type { Accounts } from "../lib/accounts.ts";
import { hlBaseUrl, type LiveConfig } from "./service.ts";

/**
 * Compares what the live engine believes each user holds on Hyperliquid with
 * what the venue reports. A mismatch (a liquidation, a manual trade in the
 * Hyperliquid UI, an order the engine thinks failed) is written to the run's
 * activity once, until it changes or clears.
 */

export interface Mismatch {
  coin: string;
  expected: number;
  actual: number;
}

const coinOf = (i: { kind: string; symbol?: string; dex?: string }) => (i.kind === "perp" ? (i.dex ? `${i.dex}:${i.symbol}` : i.symbol!) : null);
const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 0.01, Math.abs(b) * 0.01);
const fmt = (n: number, coin: string) => (n === 0 ? `no ${coin} position` : `${n > 0 ? "long" : "short"} ${+Math.abs(n).toPrecision(6)} ${coin}`);

export function diffPositions(expected: Map<string, number>, actual: Map<string, number>): Mismatch[] {
  const coins = new Set([...expected.keys(), ...actual.keys()]);
  const out: Mismatch[] = [];
  for (const coin of coins) {
    const e = expected.get(coin) ?? 0;
    const a = actual.get(coin) ?? 0;
    if (!same(e, a)) out.push({ coin, expected: e, actual: a });
  }
  return out.sort((x, y) => x.coin.localeCompare(y.coin));
}

export class Reconciler {
  private readonly last = new Map<string, string>();
  private readonly engine: Engine;
  private readonly accounts: Accounts;
  private readonly cfg: LiveConfig;
  private readonly fetchFn: FetchLike;
  constructor(engine: Engine, accounts: Accounts, cfg: LiveConfig, fetchFn: FetchLike = globalThis.fetch as unknown as FetchLike) {
    this.engine = engine;
    this.accounts = accounts;
    this.cfg = cfg;
    this.fetchFn = fetchFn;
  }

  /** One pass over every user with running live deployments. Returns the notes written. */
  async run(): Promise<{ deploymentId: string; message: string }[]> {
    const deployments = (await this.engine.listDeployments()).filter((d) => d.mode === "live" && (d.status === "running" || d.status === "paused"));
    const byUser = new Map<string, string[]>();
    for (const d of deployments) {
      const owner = this.accounts.deploymentOwner(d.id);
      if (owner) byUser.set(owner, [...(byUser.get(owner) ?? []), d.id]);
    }
    const notes: { deploymentId: string; message: string }[] = [];
    const info = new HttpHlInfo(hlBaseUrl(this.cfg.network), this.fetchFn);

    for (const [userId, ids] of byUser) {
      const account = this.accounts.liveAccount(userId);
      if (!account || account.network !== this.cfg.network) continue;

      // What the engine thinks is open, per coin (signed size), and which run owns each coin.
      const expected = new Map<string, number>();
      const ownerOf = new Map<string, string>();
      const dexes = new Set<string>([""]);
      for (const id of ids) {
        const snap = await this.engine.getSnapshot(id);
        for (const a of snap?.deployment.strategy.actions ?? []) {
          if (a.type !== "open") continue;
          const c = coinOf(a.instrument as never);
          if (c) ownerOf.set(c, id), a.instrument.kind === "perp" && a.instrument.dex && dexes.add(a.instrument.dex);
        }
        for (const p of snap?.positions ?? []) {
          const c = coinOf(p.instrument as never);
          if (!c) continue;
          expected.set(c, (expected.get(c) ?? 0) + (p.side === "long" ? p.qty : -p.qty));
          ownerOf.set(c, id);
        }
      }

      // What Hyperliquid reports, only for coins one of these runs trades.
      const actual = new Map<string, number>();
      try {
        for (const dex of dexes) {
          const st = (await info.clearinghouseState(account.hlAddress, dex)) as { assetPositions?: { position: { coin: string; szi: string } }[] };
          for (const ap of st.assetPositions ?? []) {
            const coin = dex && !ap.position.coin.includes(":") ? `${dex}:${ap.position.coin}` : ap.position.coin;
            if (ownerOf.has(coin)) actual.set(coin, Number(ap.position.szi));
          }
        }
      } catch {
        continue; // venue unreachable: try again next pass
      }

      const mismatches = diffPositions(expected, actual);
      const key = mismatches.map((m) => `${m.coin}:${m.expected}:${m.actual}`).join("|");
      if (key === (this.last.get(userId) ?? "")) continue;
      this.last.set(userId, key);
      for (const m of mismatches) {
        const id = ownerOf.get(m.coin)!;
        const message = `Hyperliquid shows ${fmt(m.actual, m.coin)}, but this run expects ${fmt(m.expected, m.coin)}. Check your Hyperliquid account; the run keeps going.`;
        await this.engine.note?.(id, "warning", message, { reconcile: m });
        notes.push({ deploymentId: id, message });
      }
    }
    return notes;
  }
}
