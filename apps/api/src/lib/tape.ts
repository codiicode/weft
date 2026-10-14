import type { Candle } from "@weft/venues";

/**
 * Second-level candles for Hyperliquid markets. Hyperliquid only serves candles from one minute
 * up, so this records the public trade stream and builds 5-second bars from it, kept for the last
 * few hours. The busiest markets are recorded all the time; any other market starts recording the
 * first time someone asks for it, and stops after it has gone unwatched for a while.
 */

export const SECOND_INTERVALS = { "5s": 5_000, "15s": 15_000, "30s": 30_000 } as const;
export type SecondInterval = keyof typeof SECOND_INTERVALS;

const BASE_MS = 5_000;

interface Series {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  /** USD traded in the bar. */
  v: number[];
  since: number;
  warm: boolean;
  lastAsked: number;
}

export interface TradeTapeOptions {
  url?: string;
  /** How long bars are kept. Default 8 hours. */
  keepMs?: number;
  /** Drop an on-demand market after this long without a request. Default 30 minutes. */
  idleMs?: number;
  now?: () => number;
  /** For tests: skip the network entirely. */
  offline?: boolean;
  log?: (msg: string) => void;
}

type RawTrade = { coin: string; px: string; sz: string; time: number };

export class TradeTape {
  private readonly series = new Map<string, Series>();
  private readonly opts: Required<Omit<TradeTapeOptions, "log">> & { log?: (m: string) => void };
  private ws: WebSocket | null = null;
  private retry = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(opts: TradeTapeOptions = {}) {
    this.opts = {
      url: opts.url ?? "wss://api.hyperliquid.xyz/ws",
      keepMs: opts.keepMs ?? 8 * 3_600_000,
      idleMs: opts.idleMs ?? 30 * 60_000,
      now: opts.now ?? Date.now,
      offline: opts.offline ?? false,
      log: opts.log,
    };
  }

  /** Start recording `coins` permanently (and keep the connection up). */
  start(coins: string[]) {
    for (const c of coins) this.track(c, true);
    if (this.opts.offline) return;
    this.open();
    this.timers.push(setInterval(() => this.send({ method: "ping" }), 30_000));
    this.timers.push(setInterval(() => this.sweep(), 5 * 60_000));
  }

  /** Make sure `coin` is being recorded; marks it as recently asked for. */
  ensure(coin: string) {
    this.track(coin, false);
  }

  /** Replace the always-recorded set (e.g. when volumes reshuffle). */
  setWarm(coins: string[]) {
    const want = new Set(coins);
    for (const [coin, s] of this.series) if (s.warm && !want.has(coin)) s.warm = false;
    for (const c of coins) this.track(c, true);
  }

  /** When recording of `coin` began (null when it isn't recorded). */
  since(coin: string): number | null {
    return this.series.get(coin)?.since ?? null;
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.ws?.close();
  }

  /** Fold one trade into its 5-second bar. Public for tests. */
  ingest(coin: string, px: number, sz: number, time: number) {
    const s = this.series.get(coin);
    if (!s || !(px > 0) || !(sz > 0)) return;
    const b = Math.floor(time / BASE_MS) * BASE_MS;
    const i = s.t.length - 1;
    if (i >= 0 && s.t[i] === b) {
      if (px > s.h[i]!) s.h[i] = px;
      if (px < s.l[i]!) s.l[i] = px;
      s.c[i] = px;
      s.v[i]! += px * sz;
      return;
    }
    if (i >= 0 && b < s.t[i]!) return; // late trade for a closed bar: ignore
    s.t.push(b);
    s.o.push(px);
    s.h.push(px);
    s.l.push(px);
    s.c.push(px);
    s.v.push(px * sz);
    const cut = this.opts.now() - this.opts.keepMs;
    if (s.t[0]! < cut) {
      let k = 0;
      while (k < s.t.length && s.t[k]! < cut) k++;
      for (const a of [s.t, s.o, s.h, s.l, s.c, s.v]) a.splice(0, k);
    }
  }

  /** Up to `count` bars of `stepMs` (a multiple of 5 s) that open before `endMs`, oldest first. */
  bars(coin: string, stepMs: number, endMs: number, count: number): Candle[] {
    const s = this.series.get(coin);
    if (!s) return [];
    s.lastAsked = this.opts.now();
    const out: Candle[] = [];
    for (let i = 0; i < s.t.length; i++) {
      const t = Math.floor(s.t[i]! / stepMs) * stepMs;
      if (t >= endMs) break;
      const last = out.at(-1);
      if (last && last.t === t) {
        last.h = Math.max(last.h, s.h[i]!);
        last.l = Math.min(last.l, s.l[i]!);
        last.c = s.c[i]!;
        last.volUsd = (last.volUsd ?? 0) + s.v[i]!;
      } else {
        out.push({ t, o: s.o[i]!, h: s.h[i]!, l: s.l[i]!, c: s.c[i]!, volUsd: s.v[i]! });
      }
    }
    return out.slice(-count);
  }

  private track(coin: string, warm: boolean) {
    const now = this.opts.now();
    const s = this.series.get(coin);
    if (s) {
      s.lastAsked = now;
      if (warm) s.warm = true;
      return;
    }
    this.series.set(coin, { t: [], o: [], h: [], l: [], c: [], v: [], since: now, warm, lastAsked: now });
    this.send({ method: "subscribe", subscription: { type: "trades", coin } });
    if (!this.opts.offline) this.open();
  }

  private sweep() {
    const now = this.opts.now();
    for (const [coin, s] of this.series) {
      if (s.warm || now - s.lastAsked < this.opts.idleMs) continue;
      this.series.delete(coin);
      this.send({ method: "unsubscribe", subscription: { type: "trades", coin } });
    }
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private open() {
    if (this.ws || this.reconnect || this.stopped || typeof WebSocket === "undefined") return;
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      for (const coin of this.series.keys()) this.send({ method: "subscribe", subscription: { type: "trades", coin } });
      this.opts.log?.(`tape: recording ${this.series.size} markets`);
    };
    ws.onmessage = (ev) => {
      let m: { channel?: string; data?: RawTrade[] };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.channel !== "trades" || !Array.isArray(m.data)) return;
      for (const t of m.data) this.ingest(t.coin, Number(t.px), Number(t.sz), t.time);
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.stopped) return;
      const wait = Math.min(30_000, 1_000 * 2 ** this.retry++);
      this.reconnect = setTimeout(() => {
        this.reconnect = null;
        this.open();
      }, wait);
    };
    ws.onerror = () => ws.close();
  }
}
