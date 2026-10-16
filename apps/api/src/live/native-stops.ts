import { cloidFromKey, levelToPrice, postJson, type FetchLike, type HyperliquidExecutor } from "@weft/execution";
import type { Engine } from "@weft/engine";
import type { Instrument } from "@weft/strategy";
import type { Accounts } from "../lib/accounts.ts";

/**
 * Venue-side stops for live Hyperliquid perps. Weft's engine checks exits on every tick, but if
 * Weft were down a leveraged position would have no stop. So every live perp position with a
 * stop-loss or take-profit also gets a real trigger order on Hyperliquid ("positionTpsl", which
 * the venue resizes with the position and drops when it closes), kept in line with the strategy:
 *  - placed right after an entry fills (`poke`) and checked every pass;
 *  - moved when the owner changes the stop, removed when they remove it;
 *  - only orders Weft placed are ever cancelled (tracked by cloid), never the user's own.
 * When Hyperliquid's stop fires first, the engine's position is booked out (`reconcilePosition`)
 * once the venue shows the position gone on two passes in a row.
 */

type Kind = "sl" | "tp";
type Placed = { cloid: string; px: number };
type Tracked = { userId: string; deploymentId: string; positionId: string; instrument: Instrument; sl?: Placed; tp?: Placed };
type OpenOrder = { coin: string; cloid?: string | null; isTrigger?: boolean; reduceOnly?: boolean; triggerPx?: string };

const KEY = "native-stops";
/** Prices within this fraction count as the same trigger (venue tick rounding). */
const SAME_PX = 0.0015;

export interface NativeStopsDeps {
  engine: Engine;
  accounts: Accounts;
  /** The user's Hyperliquid executor (agent-signed), and their account address. */
  executorFor: (userId: string) => Promise<HyperliquidExecutor>;
  addressOf: (userId: string) => string | null;
  baseUrl: string;
  fetch?: FetchLike;
  log?: (msg: string) => void;
}

export class NativeStops {
  private readonly d: NativeStopsDeps;
  private tracked = new Map<string, Tracked>();
  private readonly goneOnce = new Set<string>();
  private readonly failedAt = new Map<string, string>();
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private poked: ReturnType<typeof setTimeout> | null = null;

  constructor(d: NativeStopsDeps) {
    this.d = d;
    try {
      for (const t of JSON.parse(d.accounts.kvGet(KEY) ?? "[]") as Tracked[]) this.tracked.set(t.positionId, t);
    } catch {
      /* start empty */
    }
  }

  start(everyMs = 20_000) {
    this.timer = setInterval(() => void this.run().catch((e) => this.d.log?.(`native stops: ${(e as Error).message}`)), everyMs);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Sync soon (after a fill or an exits change), coalescing bursts. */
  poke(delayMs = 2_500) {
    if (this.poked) return;
    this.poked = setTimeout(() => {
      this.poked = null;
      void this.run().catch((e) => this.d.log?.(`native stops: ${(e as Error).message}`));
    }, delayMs);
    this.poked.unref?.();
  }

  run(): Promise<void> {
    this.running ??= this.pass().finally(() => (this.running = null));
    return this.running;
  }

  private save() {
    this.d.accounts.kvSet(KEY, JSON.stringify([...this.tracked.values()]));
  }

  private post<T>(body: unknown) {
    return postJson<T>(this.d.fetch ?? (globalThis.fetch as unknown as FetchLike), `${this.d.baseUrl}/info`, body);
  }

  private async pass() {
    const live = new Set<string>();
    const ordersByUser = new Map<string, OpenOrder[]>();
    const positionsByUser = new Map<string, Map<string, number>>();

    for (const dep of await this.d.engine.listDeployments()) {
      if (dep.mode !== "live" || (dep.status !== "running" && dep.status !== "paused")) continue;
      const userId = this.d.accounts.deploymentOwner(dep.id);
      const address = userId ? this.d.addressOf(userId) : null;
      if (!userId || !address) continue;
      const snap = await this.d.engine.getSnapshot(dep.id);
      for (const p of snap?.positions ?? []) {
        if (p.instrument.kind !== "perp") continue;
        live.add(p.id);
        const coin = coinOf(p.instrument);

        // Did Hyperliquid's own stop (or anything else) close it? Core perps only, and only after a minute.
        if (!p.instrument.dex && Date.now() - p.openedAt > 60_000) {
          let venue = positionsByUser.get(userId);
          if (!venue) {
            venue = await this.venuePositions(address);
            positionsByUser.set(userId, venue);
          }
          if (!venue.has(coin)) {
            if (this.goneOnce.has(p.id)) {
              this.goneOnce.delete(p.id);
              const booked = (await this.d.engine.reconcilePosition?.(dep.id, p.id, 0)) ?? 0;
              if (booked > 0) this.d.log?.(`[native stops ${dep.id.slice(0, 8)}] ${coin} closed on Hyperliquid (its stop or take-profit fired); booked out`);
              this.forget(p.id);
              continue;
            }
            this.goneOnce.add(p.id);
            continue;
          }
          this.goneOnce.delete(p.id);
        }

        const want: Record<Kind, number | null> = {
          sl: p.exits.stopLoss && !("prob" in p.exits.stopLoss) ? levelToPrice(p.exits.stopLoss, p.entryPrice, p.side === "long", "sl", p.leverage) : null,
          tp: p.exits.takeProfit && !("prob" in p.exits.takeProfit) ? levelToPrice(p.exits.takeProfit, p.entryPrice, p.side === "long", "tp", p.leverage) : null,
        };
        let open = ordersByUser.get(userId);
        if (!open) {
          open = await this.post<OpenOrder[]>({ type: "frontendOpenOrders", user: address, ...(p.instrument.dex ? { dex: p.instrument.dex } : {}) }).catch(() => []);
          ordersByUser.set(userId, open);
        }
        const t: Tracked = this.tracked.get(p.id) ?? { userId, deploymentId: dep.id, positionId: p.id, instrument: p.instrument };
        for (const kind of ["sl", "tp"] as const) {
          const have = t[kind];
          const onVenue = have ? open.some((o) => o.cloid?.toLowerCase() === have.cloid.toLowerCase()) : false;
          const target = want[kind];
          if (target == null) {
            if (have && onVenue) await this.cancel(userId, p.instrument, have.cloid);
            delete t[kind];
            continue;
          }
          if (have && onVenue && Math.abs(have.px - target) / target <= SAME_PX) continue;
          if (have && onVenue) await this.cancel(userId, p.instrument, have.cloid);
          delete t[kind];
          const placed = await this.place(userId, p, kind, target, dep.id);
          if (placed) t[kind] = placed;
        }
        if (t.sl || t.tp) this.tracked.set(p.id, t);
        else this.tracked.delete(p.id);
      }
    }

    // Positions that are gone from the engine: cancel any of our orders still resting.
    for (const [pid, t] of this.tracked) {
      if (live.has(pid)) continue;
      for (const kind of ["sl", "tp"] as const) {
        const have = t[kind];
        if (have) await this.cancel(t.userId, t.instrument, have.cloid).catch(() => {});
      }
      this.tracked.delete(pid);
    }
    this.save();
  }

  private forget(positionId: string) {
    this.tracked.delete(positionId);
  }

  private async venuePositions(address: string): Promise<Map<string, number>> {
    const st = await this.post<{ assetPositions?: { position?: { coin?: string; szi?: string } }[] }>({ type: "clearinghouseState", user: address });
    const out = new Map<string, number>();
    for (const a of st.assetPositions ?? []) {
      const sz = Math.abs(Number(a.position?.szi ?? 0));
      if (a.position?.coin && sz > 0) out.set(a.position.coin, sz);
    }
    return out;
  }

  private async place(userId: string, p: { id: string; instrument: Instrument; side: "long" | "short"; qty: number }, kind: Kind, px: number, deploymentId: string): Promise<Placed | null> {
    const clientId = `nstop:${p.id}:${kind}:${Date.now()}`;
    try {
      const ex = await this.d.executorFor(userId);
      const r = await ex.setPositionTpsl({ instrument: p.instrument, positionSide: p.side, size: p.qty, clientId, ...(kind === "sl" ? { stopLoss: px } : { takeProfit: px }) });
      const statuses = (r as { statuses?: { error?: string }[] }).statuses ?? [];
      const err = statuses.find((s) => s && typeof s === "object" && "error" in s)?.error;
      if (err) throw new Error(err);
      this.failedAt.delete(`${p.id}:${kind}`);
      this.d.log?.(`[native stops ${deploymentId.slice(0, 8)}] ${kind === "sl" ? "stop-loss" : "take-profit"} for ${coinOf(p.instrument)} placed on Hyperliquid at ${px}`);
      return { cloid: cloidFromKey(`${clientId}:${kind}`), px };
    } catch (e) {
      // A stop already beyond the price can't rest; the engine closes on its next tick. Log once per level.
      const k = `${p.id}:${kind}`;
      const msg = (e as Error).message;
      if (this.failedAt.get(k) !== `${px}:${msg}`) {
        this.failedAt.set(k, `${px}:${msg}`);
        this.d.log?.(`[native stops ${deploymentId.slice(0, 8)}] could not place ${kind} for ${coinOf(p.instrument)} at ${px}: ${msg.slice(0, 200)}`);
      }
      return null;
    }
  }

  /** Best effort: an order that already fired or was cancelled is simply gone. */
  private async cancel(userId: string, instrument: Instrument, cloid: string) {
    try {
      const ex = await this.d.executorFor(userId);
      await ex.cancel({ instrument, cloid: cloid as `0x${string}` });
    } catch (e) {
      this.d.log?.(`native stops: cancel ${coinOf(instrument)} ${cloid.slice(0, 10)} failed: ${(e as Error).message.slice(0, 160)}`);
    }
  }
}

function coinOf(i: Instrument): string {
  return i.kind === "perp" ? (i.dex ? `${i.dex}:${i.symbol}` : i.symbol) : "";
}
