"use client";
import { useEffect, useRef, useState } from "react";

/**
 * One shared connection to Hyperliquid's public websocket for live prices and candles.
 * Subscriptions are reference-counted: the socket opens with the first listener, resubscribes
 * after a reconnect, and closes a little after the last listener leaves.
 */

const URL = "wss://api.hyperliquid.xyz/ws";

type Sub = { type: "allMids"; dex?: string } | { type: "candle"; coin: string; interval: string };
type Listener = (data: unknown) => void;

export interface LiveCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Base-asset volume. */
  v: number;
}

function keyOf(s: Sub): string {
  return s.type === "allMids" ? `allMids|${s.dex ?? ""}` : `candle|${s.coin}|${s.interval}`;
}

class HlSocket {
  private ws: WebSocket | null = null;
  private subs = new Map<string, { sub: Sub; listeners: Set<Listener> }>();
  private statusListeners = new Set<(up: boolean) => void>();
  private up = false;
  private retry = 0;
  private ping: ReturnType<typeof setInterval> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;

  get connected() {
    return this.up;
  }

  onStatus(fn: (up: boolean) => void) {
    this.statusListeners.add(fn);
    return () => void this.statusListeners.delete(fn);
  }

  subscribe(sub: Sub, fn: Listener): () => void {
    const key = keyOf(sub);
    let entry = this.subs.get(key);
    if (!entry) {
      entry = { sub, listeners: new Set() };
      this.subs.set(key, entry);
      this.send({ method: "subscribe", subscription: sub });
    }
    entry.listeners.add(fn);
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.open();
    return () => {
      const e = this.subs.get(key);
      if (!e) return;
      e.listeners.delete(fn);
      if (e.listeners.size) return;
      this.subs.delete(key);
      this.send({ method: "unsubscribe", subscription: sub });
      if (!this.subs.size) this.idle = setTimeout(() => this.close(), 10_000);
    };
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private setUp(v: boolean) {
    if (this.up === v) return;
    this.up = v;
    for (const fn of this.statusListeners) fn(v);
  }

  private open() {
    if (this.ws || this.reconnect || typeof WebSocket === "undefined") return;
    const ws = new WebSocket(URL);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setUp(true);
      for (const { sub } of this.subs.values()) this.send({ method: "subscribe", subscription: sub });
      this.ping = setInterval(() => this.send({ method: "ping" }), 30_000);
    };
    ws.onmessage = (ev) => {
      let m: { channel?: string; data?: Record<string, unknown> };
      try {
        m = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      const d = m.data;
      if (!d) return;
      const key =
        m.channel === "allMids" ? `allMids|${(d.dex as string) ?? ""}` : m.channel === "candle" ? `candle|${d.s as string}|${d.i as string}` : null;
      if (!key) return;
      for (const fn of this.subs.get(key)?.listeners ?? []) fn(d);
    };
    ws.onclose = () => {
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      this.ws = null;
      this.setUp(false);
      if (!this.subs.size) return;
      const wait = Math.min(15_000, 1_000 * 2 ** this.retry++);
      this.reconnect = setTimeout(() => {
        this.reconnect = null;
        this.open();
      }, wait);
    };
    ws.onerror = () => ws.close();
  }

  private close() {
    this.idle = null;
    if (this.subs.size) return;
    this.ws?.close();
  }
}

let socket: HlSocket | null = null;
const hl = () => (socket ??= new HlSocket());

/** True while the live feed is connected. */
export function useLiveStatus(enabled = true): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    setUp(hl().connected);
    return hl().onStatus(setUp);
  }, [enabled]);
  return enabled && up;
}

/**
 * Live mid prices for Hyperliquid coins ("BTC", "xyz:NVDA", "#114540"), for the given perp
 * dexes ("" is the core dex). Re-renders at most once a second.
 */
export function useLiveMids(dexes: string[]): Record<string, number> {
  const [mids, setMids] = useState<Record<string, number>>({});
  const latest = useRef<Record<string, number>>({});
  const dirty = useRef(false);
  // "" is the core dex, so an empty list and [""] must not share a key.
  const key = dexes.length ? `dex:${[...new Set(dexes)].sort().join(",")}` : "";
  useEffect(() => {
    if (!key) return;
    const offs = [...new Set(dexes)].map((dex) =>
      hl().subscribe(dex ? { type: "allMids", dex } : { type: "allMids" }, (d) => {
        const m = (d as { mids?: Record<string, string> }).mids ?? {};
        for (const [k, v] of Object.entries(m)) {
          const n = Number(v);
          if (Number.isFinite(n)) latest.current[k] = n;
        }
        dirty.current = true;
      })
    );
    const t = setInterval(() => {
      if (!dirty.current) return;
      dirty.current = false;
      setMids({ ...latest.current });
    }, 1_000);
    return () => {
      clearInterval(t);
      for (const off of offs) off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return mids;
}

/** Streams the forming candle of `coin` at `interval` ("1m", "5m", "1h", "4h", "1d"). */
export function useLiveCandle(coin: string | null | undefined, interval: string | null, onCandle: (c: LiveCandle) => void) {
  const cb = useRef(onCandle);
  cb.current = onCandle;
  useEffect(() => {
    if (!coin || !interval) return;
    return hl().subscribe({ type: "candle", coin, interval }, (d) => {
      const r = d as { t: number; o: string; h: string; l: string; c: string; v: string };
      const c = { t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) };
      if ([c.o, c.h, c.l, c.c].every(Number.isFinite)) cb.current(c);
    });
  }, [coin, interval]);
}

/** The Hyperliquid coin for a perp instrument, as the websocket names it. */
export function perpCoin(symbol: string, dex?: string | null): string {
  return dex ? `${dex}:${symbol}` : symbol;
}
