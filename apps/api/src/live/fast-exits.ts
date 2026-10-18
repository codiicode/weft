import { exitReason, liquidationCrossed, markPosition, type Engine, type Position } from "@weft/engine";

/**
 * Stops and targets between ticks. A run is checked every 15 s or so; at high leverage that is far
 * too slow, so this watches Hyperliquid's prices as they stream (a couple of updates a second, over
 * a websocket) and, the moment a position's stop, target, trailing stop or bust price is crossed,
 * runs the engine's exit check for that run right away with that price.
 *
 * It decides with the engine's own exit rules (on a copy of the position) and acts through the
 * engine, so the close is exactly what the next tick would have done, only seconds earlier.
 *
 * Prices: Hyperliquid's best bid and offer per watched coin (`bbo`, a couple of updates a second),
 * whose middle is exactly the price Papertrade settles at. (`allMids` only updates every few seconds.)
 *
 * Covers Papertrade (priced at Hyperliquid's mid) in every mode, and Hyperliquid core perps in
 * practice. Live Hyperliquid perps already have real stop orders on the venue. If the stream drops,
 * the regular ticks carry on as before, and it reconnects.
 */

const WS_URL = "wss://api.hyperliquid.xyz/ws";

interface Watched {
  deploymentId: string;
  mode: string;
  coin: string;
  position: Position;
}

export interface FastExitsOptions {
  engine: Engine;
  /** Which runs to watch (deployment ids → mode), refreshed every few seconds. */
  listRuns: () => Promise<{ id: string; mode: string; status: string }[]>;
  log?: (m: string) => void;
  /** Re-read open positions this often (ms). */
  refreshMs?: number;
  WebSocketImpl?: typeof WebSocket;
}

/** Hyperliquid coin for a position the stream can price, or null. */
export function coinOf(p: Position, mode: string): string | null {
  const i = p.instrument;
  if (i.kind === "synth") return i.symbol;
  if (i.kind === "perp" && !i.dex && mode !== "live") return i.symbol;
  return null;
}

/**
 * Would the engine close this position at `price`? (Decided on a copy: the position isn't touched.)
 * A live Papertrade bust happens on chain, not in the engine, so only its stops and targets count.
 */
export function wouldExit(p: Position, price: number, now: number, mode = "paper"): boolean {
  const c: Position = structuredClone(p);
  markPosition(c, price, now);
  return (mode !== "live" && liquidationCrossed(c)) || exitReason(c, now) != null;
}

export class FastExits {
  private readonly o: FastExitsOptions;
  private ws: WebSocket | null = null;
  private watched: Watched[] = [];
  private readonly busy = new Set<string>();
  private readonly subscribed = new Set<string>();
  private readonly lastRun = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private backoff = 1_000;
  /** Updates seen and exit checks run, for the status line. */
  readonly stats = { updates: 0, checks: 0, connectedAt: 0 };

  constructor(o: FastExitsOptions) {
    this.o = o;
  }

  start() {
    this.stopped = false;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.o.refreshMs ?? 4_000);
    this.timer.unref?.();
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.ws?.close();
  }

  /** Open positions the stream can price, across running runs. */
  async refresh() {
    try {
      const out: Watched[] = [];
      for (const r of await this.o.listRuns()) {
        if (r.status !== "running" && r.status !== "paused") continue;
        const snap = await this.o.engine.getSnapshot(r.id);
        for (const p of snap?.positions ?? []) {
          const coin = coinOf(p, r.mode);
          if (coin) out.push({ deploymentId: r.id, mode: r.mode, coin, position: p });
        }
      }
      this.watched = out;
      for (const c of new Set(out.map((w) => w.coin))) this.subscribe(c);
    } catch (e) {
      this.o.log?.(`fast exits: refresh failed: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  private connect() {
    if (this.stopped) return;
    const WS = this.o.WebSocketImpl ?? WebSocket;
    const ws = new WS(WS_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1_000;
      this.stats.connectedAt = Date.now();
      this.subscribed.clear();
      for (const c of new Set(this.watched.map((w) => w.coin))) this.subscribe(c);
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as { channel?: string; data?: { coin?: string; bbo?: ({ px: string } | null)[] } };
        if (m.channel !== "bbo" || !m.data?.coin) return;
        const [bid, ask] = m.data.bbo ?? [];
        if (bid && ask) this.onMids({ [m.data.coin]: String((Number(bid.px) + Number(ask.px)) / 2) });
      } catch {
        /* not ours */
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.subscribed.clear();
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.backoff).unref?.();
      this.backoff = Math.min(30_000, this.backoff * 2);
    };
    ws.onerror = () => ws.close();
  }

  private subscribe(coin: string) {
    if (this.subscribed.has(coin) || this.ws?.readyState !== 1) return;
    this.ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "bbo", coin } }));
    this.subscribed.add(coin);
  }

  /** Every price update: any watched position whose exit is crossed gets its run checked now. */
  onMids(mids: Record<string, string>, now = Date.now()) {
    this.stats.updates++;
    const due = new Map<string, Record<string, number>>();
    for (const w of this.watched) {
      const px = Number(mids[w.coin]);
      if (!(px > 0)) continue;
      if (!wouldExit(w.position, px, now, w.mode)) continue;
      const prices = due.get(w.deploymentId) ?? {};
      prices[w.position.instrumentKey] = px;
      due.set(w.deploymentId, prices);
    }
    for (const [id, prices] of due) void this.check(id, prices, now);
  }

  private async check(id: string, prices: Record<string, number>, now: number) {
    // One check at a time per run, at most one a second: the engine's close takes a moment.
    if (this.busy.has(id) || now - (this.lastRun.get(id) ?? 0) < 1_000) return;
    this.busy.add(id);
    this.lastRun.set(id, now);
    this.stats.checks++;
    try {
      await this.o.engine.checkExits?.(id, prices);
      await this.refresh();
    } catch (e) {
      this.o.log?.(`fast exits: check of ${id.slice(0, 8)} failed: ${(e as Error).message.slice(0, 160)}`);
    } finally {
      this.busy.delete(id);
    }
  }
}
