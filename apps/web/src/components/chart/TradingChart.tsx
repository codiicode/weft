"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IChartApi, IPriceLine, ISeriesApi, ISeriesMarkersPluginApi, MouseEventParams, SeriesType, Time, UTCTimestamp } from "lightweight-charts";
import { instrumentKey, type Instrument } from "@weft/strategy";
import { api, type ChartInterval } from "@/lib/api";
import { useLiveCandle, useLiveStatus, useLiveTrades } from "@/lib/live";
import { bollinger, ema, INDICATORS, rsi, sma, vwap, type IndicatorId, type OhlcBar } from "@/lib/indicators";
import { chartMinMove, priceFormatter } from "@/lib/market-ideas";

/**
 * The trading chart: real candles from 1 minute to 1 week, second bars (5s/15s/30s) from the
 * recorded trade stream, live updates, zoom and pan (wheel, drag, pinch), endless history as you
 * scroll left, an OHLC readout, indicators, your own price lines, log scale, fullscreen and a
 * snapshot. Every preference sticks per browser.
 */

export type Bar = OhlcBar;
export interface TradeMark {
  t: number;
  price: number;
  side: "buy" | "sell";
}
type ChartType = "candles" | "line" | "bars";

const INTERVALS: { id: ChartInterval; label: string; ms: number; hl?: boolean; seconds?: boolean }[] = [
  { id: "5s", label: "5s", ms: 5_000, hl: true, seconds: true },
  { id: "15s", label: "15s", ms: 15_000, hl: true, seconds: true },
  { id: "30s", label: "30s", ms: 30_000, hl: true, seconds: true },
  { id: "1m", label: "1m", ms: 60_000 },
  { id: "5m", label: "5m", ms: 300_000 },
  { id: "15m", label: "15m", ms: 900_000 },
  { id: "30m", label: "30m", ms: 1_800_000, hl: true },
  { id: "1h", label: "1h", ms: 3_600_000 },
  { id: "4h", label: "4h", ms: 14_400_000 },
  { id: "1d", label: "1D", ms: 86_400_000 },
  { id: "1w", label: "1W", ms: 604_800_000, hl: true },
];

const PAGE = 500;

/* ------------------------------------------------------------------ */
/* Small helpers                                                         */
/* ------------------------------------------------------------------ */

const toLocal = (ms: number) => (Math.floor(ms / 1000) - new Date(ms).getTimezoneOffset() * 60) as UTCTimestamp;

function cssVar(name: string, fallback: string) {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
function alpha(color: string, a: number) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function load<T>(k: string, def: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : def;
  } catch {
    return def;
  }
}
function save(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // storage off: preferences just don't stick
  }
}
function compact(v: number) {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v);
}

function useThemeVersion() {
  const [v, setV] = useState(0);
  useEffect(() => {
    const bump = () => setV((x) => x + 1);
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", bump);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", bump);
    };
  }, []);
  return v;
}

/** Merge bars by open time (later wins), sorted. */
function mergeBars(a: Bar[], b: Bar[]): Bar[] {
  const m = new Map<number, Bar>();
  for (const x of a) m.set(x.t, x);
  for (const x of b) m.set(x.t, x);
  return [...m.values()].sort((x, y) => x.t - y.t);
}

/* ------------------------------------------------------------------ */
/* Icons (stroke 1.5, 16px)                                               */
/* ------------------------------------------------------------------ */

const I = {
  candles: <path d="M4.5 2.5v11M11.5 2.5v11M3 5h3v6H3zM10 4h3v5h-3z" />,
  line: <path d="M2 11.5l3.5-4 3 2.5L14 4" />,
  bars: <path d="M4.5 2.5v11M2.5 5h2M4.5 11h2M11.5 3v10M9.5 6h2M11.5 10h2" />,
  hline: <path d="M1.5 8h13M4 5.5v5" />,
  full: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />,
  exit: <path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5" />,
  camera: <path d="M2.5 5.5h2l1.2-2h4.6l1.2 2h2v7.5h-11zM8 11a2 2 0 100-4 2 2 0 000 4z" />,
  fx: <path d="M3 13c2 0 2-2 2.5-5S7 3 9 3M3.5 7.5H8M9.5 8.5l4 4.5M13.5 8.5l-4 4.5" />,
};
function Icon({ d }: { d: React.ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d}
    </svg>
  );
}
function ToolBtn({ on, onClick, label, children, className = "" }: { on?: boolean; onClick: () => void; label: string; children: React.ReactNode; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={on}
      className={`inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-[8px] px-2 text-[13px] transition-colors ${on ? "bg-paper-2 text-ink" : "text-muted hover:bg-paper-2/70 hover:text-ink"} ${className}`}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Component                                                              */
/* ------------------------------------------------------------------ */

export function TradingChart({
  instrument,
  product,
  marks,
  defaultInterval = "15m",
  prefsKey = "market",
  className = "h-[460px]",
  onLast,
}: {
  instrument: Instrument;
  product?: string;
  /** Your trades, pinned at their price. */
  marks?: TradeMark[];
  defaultInterval?: ChartInterval;
  /** Separate remembered settings for different places (market page, run page). */
  prefsKey?: string;
  className?: string;
  /** The newest bar, as it changes (throttled). */
  onLast?: (b: Bar) => void;
}) {
  const key = instrumentKey(instrument);
  const isHl = instrument.kind === "perp" || instrument.kind === "spot" || (instrument.kind === "outcome" && instrument.venue === "hyperliquid");
  const intervals = INTERVALS.filter((i) => isHl || !i.hl);
  const fmt = useMemo(() => priceFormatter(product ? { product: product as never } : instrument.kind === "outcome" ? { product: "predictions" } : null), [product, instrument.kind]);

  // Preferences
  const [interval, setIntervalPref] = useState<ChartInterval>(defaultInterval);
  const [type, setType] = useState<ChartType>("candles");
  const [ind, setInd] = useState<IndicatorId[]>(["volume"]);
  const [logScale, setLogScale] = useState(false);
  const [lines, setLines] = useState<number[]>([]);
  useEffect(() => {
    const iv = load<ChartInterval>(`weft:chart:${prefsKey}:interval`, defaultInterval);
    setIntervalPref(intervals.some((x) => x.id === iv) ? iv : defaultInterval);
    setType(load<ChartType>("weft:chart:type", "candles"));
    setInd(load<IndicatorId[]>("weft:chart:indicators", ["volume"]));
    setLogScale(load("weft:chart:log", false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefsKey, isHl]);
  useEffect(() => setLines(load<number[]>(`weft:lines:${key}`, [])), [key]);
  const pickInterval = (v: ChartInterval) => {
    setIntervalPref(v);
    save(`weft:chart:${prefsKey}:interval`, v);
  };

  // Data
  const bars = useRef<Bar[]>([]);
  const [version, setVersion] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error" | "unsupported">("loading");
  const [errMsg, setErrMsg] = useState("");
  const [liveCoin, setLiveCoin] = useState<string | null>(null);
  const [recordedSince, setRecordedSince] = useState<number | null>(null);
  const loadingOlder = useRef(false);
  const step = INTERVALS.find((x) => x.id === interval)!.ms;
  const seconds = Boolean(INTERVALS.find((x) => x.id === interval)?.seconds);

  const instJson = JSON.stringify(instrument);
  useEffect(() => {
    let alive = true;
    setState("loading");
    api
      .chartBars(JSON.parse(instJson), interval, { bars: PAGE })
      .then((d) => {
        if (!alive) return;
        bars.current = d.candles.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
        setHasMore(d.hasMore);
        setLiveCoin(d.liveCoin);
        setRecordedSince(d.recordedSince ?? null);
        setState("ready");
        setVersion((x) => x + 1);
      })
      .catch((e) => {
        if (!alive) return;
        const m = (e as Error).message;
        setErrMsg(m);
        setState(/available|unsupported|isn.t/i.test(m) ? "unsupported" : "error");
      });
    return () => {
      alive = false;
    };
  }, [instJson, interval]);

  // Chart objects
  const box = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const ctx = useRef<{
    L: typeof import("lightweight-charts");
    chart: IChartApi;
    main: ISeriesApi<SeriesType> | null;
    vol: ISeriesApi<"Histogram"> | null;
    overlays: Map<string, ISeriesApi<"Line">>;
    markers: ISeriesMarkersPluginApi<Time> | null;
    priceLines: IPriceLine[];
  } | null>(null);
  const theme = useThemeVersion();
  const [ready, setReady] = useState(0);
  const [hover, setHover] = useState<number | null>(null); // bar index
  const [atLatest, setAtLatest] = useState(true);
  const [tool, setTool] = useState<"none" | "hline">("none");
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const fmtRef = useRef(fmt);
  fmtRef.current = fmt;
  const olderRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let chart: IChartApi | null = null;
    void import("lightweight-charts").then((L) => {
      if (!alive || !box.current) return;
      const faint = cssVar("--faint", "#75777d");
      const line = cssVar("--line", "rgba(18,18,20,0.08)");
      const line2 = cssVar("--line-2", "rgba(18,18,20,0.15)");
      const ink = cssVar("--ink", "#121214");
      chart = L.createChart(box.current, {
        autoSize: true,
        layout: {
          background: { type: L.ColorType.Solid, color: "transparent" },
          textColor: faint,
          fontFamily: getComputedStyle(document.body).fontFamily,
          fontSize: 11,
          attributionLogo: false,
          panes: { separatorColor: line, separatorHoverColor: line2, enableResize: true },
        },
        grid: { vertLines: { color: line }, horzLines: { color: line } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
        timeScale: { borderVisible: false, rightOffset: 6, barSpacing: 8, minBarSpacing: 1.5, timeVisible: true, secondsVisible: false },
        crosshair: {
          mode: L.CrosshairMode.Normal,
          vertLine: { color: line2, width: 1, style: L.LineStyle.Dashed, labelBackgroundColor: ink },
          horzLine: { color: line2, width: 1, style: L.LineStyle.Dashed, labelBackgroundColor: ink },
        },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true } },
      });
      chart.subscribeCrosshairMove((p: MouseEventParams<Time>) => {
        if (p.logical == null || !p.point || p.point.x < 0) return setHover(null);
        const i = Math.round(p.logical);
        setHover(i >= 0 && i < bars.current.length ? i : null);
      });
      chart.subscribeClick((p: MouseEventParams<Time>) => {
        const c = ctx.current;
        if (toolRef.current !== "hline" || !p.point || !c?.main) return;
        const price = c.main.coordinateToPrice(p.point.y);
        if (price == null) return;
        const next = [...linesRef.current, price as number];
        setLines(next);
        setTool("none");
      });
      chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
        if (!r) return;
        if (r.from < 25) olderRef.current();
        const pos = chart!.timeScale().scrollPosition();
        setAtLatest(pos > -3);
      });
      ctx.current = { L, chart, main: null, vol: null, overlays: new Map(), markers: null, priceLines: [] };
      setReady((x) => x + 1);
    });
    return () => {
      alive = false;
      chart?.remove();
      ctx.current = null;
    };
  }, [theme]);

  /** Indicator values over the current bars. */
  const computeOverlays = useCallback((b: Bar[]) => {
    const out: { id: string; values: (number | null)[]; color: string; dashed?: boolean; pane?: number }[] = [];
    const color = (id: IndicatorId) => INDICATORS.find((x) => x.id === id)!.color;
    if (ind.includes("ma20")) out.push({ id: "ma20", values: sma(b, 20), color: color("ma20") });
    if (ind.includes("ma50")) out.push({ id: "ma50", values: sma(b, 50), color: color("ma50") });
    if (ind.includes("ema21")) out.push({ id: "ema21", values: ema(b, 21), color: color("ema21") });
    if (ind.includes("vwap")) out.push({ id: "vwap", values: vwap(b), color: color("vwap") });
    if (ind.includes("bb")) {
      const { upper, lower } = bollinger(b, 20, 2);
      out.push({ id: "bbu", values: upper, color: color("bb"), dashed: true }, { id: "bbl", values: lower, color: color("bb"), dashed: true });
    }
    if (ind.includes("rsi")) out.push({ id: "rsi", values: rsi(b, 14), color: color("rsi"), pane: 1 });
    return out;
  }, [ind]);

  // Series: rebuilt when type, indicators, data set or theme change.
  useEffect(() => {
    const c = ctx.current;
    if (!c || state !== "ready") return;
    const { L, chart } = c;
    for (const s of [c.main, c.vol, ...c.overlays.values()]) if (s) chart.removeSeries(s);
    c.overlays.clear();
    c.priceLines = [];
    c.markers = null;
    // Remove an RSI pane left from before.
    while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1);

    const long = cssVar("--long", "#0b9466");
    const short = cssVar("--short", "#dc3f2c");
    const signal = cssVar("--signal", "#2b59ff");
    const b = bars.current;
    const hi = b.length ? Math.max(...b.map((x) => x.h)) : 0;
    const priceFormat = { type: "custom" as const, formatter: (p: number) => fmtRef.current(p), minMove: chartMinMove(product ?? (instrument.kind === "outcome" ? "predictions" : undefined), hi) };
    chart.applyOptions({ timeScale: { secondsVisible: seconds } });
    chart.priceScale("right").applyOptions({ mode: logScale ? L.PriceScaleMode.Logarithmic : L.PriceScaleMode.Normal, scaleMargins: { top: 0.08, bottom: ind.includes("volume") ? 0.22 : 0.08 } });

    if (ind.includes("volume")) {
      const v = chart.addSeries(L.HistogramSeries, { priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false, priceFormat: { type: "volume" } });
      v.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      v.setData(b.map((x) => ({ time: toLocal(x.t), value: x.v ?? 0, color: alpha(x.c >= x.o ? long : short, 0.28) })));
      c.vol = v;
    } else c.vol = null;

    if (type === "line") {
      const s = chart.addSeries(L.AreaSeries, {
        lineColor: signal,
        lineWidth: 2,
        topColor: alpha(signal, 0.14),
        bottomColor: alpha(signal, 0),
        crosshairMarkerRadius: 4,
        crosshairMarkerBorderColor: cssVar("--card", "#fff"),
        crosshairMarkerBorderWidth: 2,
        priceLineStyle: L.LineStyle.Dotted,
        lastPriceAnimation: L.LastPriceAnimationMode.OnDataUpdate,
        priceFormat,
      });
      s.setData(b.map((x) => ({ time: toLocal(x.t), value: x.c })));
      c.main = s;
    } else {
      const s = chart.addSeries(type === "bars" ? L.BarSeries : L.CandlestickSeries, {
        upColor: long,
        downColor: short,
        ...(type === "candles" ? { wickUpColor: long, wickDownColor: short, borderVisible: false } : { thinBars: false }),
        priceLineStyle: L.LineStyle.Dotted,
        priceFormat,
      });
      s.setData(b.map((x) => ({ time: toLocal(x.t), open: x.o, high: x.h, low: x.l, close: x.c })));
      c.main = s;
    }

    for (const o of computeOverlays(b)) {
      const s = chart.addSeries(
        L.LineSeries,
        { color: o.color, lineWidth: 1, lineStyle: o.dashed ? L.LineStyle.Dashed : L.LineStyle.Solid, priceLineVisible: false, lastValueVisible: !o.dashed, crosshairMarkerVisible: false, priceFormat: o.pane ? { type: "price", precision: 1, minMove: 0.1 } : priceFormat },
        o.pane ?? 0
      );
      s.setData(b.map((x, i) => (o.values[i] == null ? { time: toLocal(x.t) } : { time: toLocal(x.t), value: o.values[i]! })));
      if (o.id === "rsi") {
        for (const lvl of [70, 30]) s.createPriceLine({ price: lvl, color: cssVar("--line-2", "#ccc"), lineWidth: 1, lineStyle: L.LineStyle.Dashed, axisLabelVisible: false, title: "" });
        chart.panes()[0]?.setStretchFactor(3);
        chart.panes()[1]?.setStretchFactor(1);
      }
      c.overlays.set(o.id, s);
    }

    // Your trades
    if (marks?.length && b.length) {
      const first = b[0]!.t;
      const list = marks
        .filter((m) => m.t >= first)
        .map((m) => ({
          time: toLocal(first + Math.floor((m.t - first) / step) * step),
          position: (m.side === "buy" ? "atPriceBottom" : "atPriceTop") as "atPriceBottom" | "atPriceTop",
          price: m.price,
          shape: (m.side === "buy" ? "arrowUp" : "arrowDown") as "arrowUp" | "arrowDown",
          color: m.side === "buy" ? long : short,
          size: 1,
        }))
        .sort((x, y) => (x.time as number) - (y.time as number));
      c.markers = L.createSeriesMarkers(c.main, list);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, version, type, ind, logScale, state, marks]);

  // Your price lines
  useEffect(() => {
    const c = ctx.current;
    if (!c?.main) return;
    for (const pl of c.priceLines) c.main.removePriceLine(pl);
    c.priceLines = lines.map((price) =>
      c.main!.createPriceLine({ price, color: cssVar("--signal", "#2b59ff"), lineWidth: 1, lineStyle: c.L.LineStyle.Dashed, axisLabelVisible: true, title: "" })
    );
    save(`weft:lines:${key}`, lines);
  }, [lines, ready, version, type, ind, logScale, state, key]);

  // Fit a fresh data set (not on live updates or paging).
  useEffect(() => {
    const c = ctx.current;
    if (!c || state !== "ready") return;
    const n = bars.current.length;
    const ts = c.chart.timeScale();
    if (n >= 150) ts.setVisibleLogicalRange({ from: n - 150, to: n + 5 });
    else {
      // Few bars (a fresh second chart): keep candles a normal width, pinned to the right.
      ts.applyOptions({ barSpacing: 8 });
      ts.scrollToRealTime();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, state, interval, key]);

  // Older history as you scroll left
  olderRef.current = () => {
    const c = ctx.current;
    if (!c || loadingOlder.current || !hasMore || !bars.current.length || seconds) return;
    loadingOlder.current = true;
    const first = bars.current[0]!.t;
    api
      .chartBars(instrument, interval, { end: first, bars: PAGE })
      .then((d) => {
        const older = d.candles.map(([t, o, h, l, cl, v]) => ({ t, o, h, l, c: cl, v }));
        const before = bars.current.length;
        bars.current = mergeBars(older, bars.current);
        const added = bars.current.length - before;
        setHasMore(d.hasMore && added > 0);
        if (added > 0) {
          const r = c.chart.timeScale().getVisibleLogicalRange();
          setVersion((x) => x + 1);
          requestAnimationFrame(() => r && ctx.current?.chart.timeScale().setVisibleLogicalRange({ from: r.from + added, to: r.to + added }));
        }
      })
      .catch(() => setHasMore(false))
      .finally(() => {
        loadingOlder.current = false;
      });
  };

  // Live updates
  const overlayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tickVersion, setTickVersion] = useState(0);
  const lastPaint = useRef(0);
  const applyBar = useCallback(
    (bar: Bar) => {
      const c = ctx.current;
      const b = bars.current;
      if (!c?.main || !b.length) return;
      const last = b[b.length - 1]!;
      if (bar.t < last.t) return;
      if (bar.t === last.t) b[b.length - 1] = bar;
      else b.push(bar);
      const time = toLocal(bar.t);
      try {
        if (type === "line") (c.main as ISeriesApi<"Area">).update({ time, value: bar.c });
        else (c.main as ISeriesApi<"Candlestick">).update({ time, open: bar.o, high: bar.h, low: bar.l, close: bar.c });
        if (c.vol) c.vol.update({ time, value: bar.v ?? 0, color: alpha(cssVar(bar.c >= bar.o ? "--long" : "--short", "#888"), 0.28) });
      } catch {
        return;
      }
      if (!overlayTimer.current && c.overlays.size) {
        overlayTimer.current = setTimeout(() => {
          overlayTimer.current = null;
          const cc = ctx.current;
          if (!cc) return;
          const all = bars.current;
          const lastBar = all[all.length - 1]!;
          for (const o of computeOverlays(all)) {
            const v = o.values[all.length - 1];
            const s = cc.overlays.get(o.id);
            if (s) s.update(v == null ? { time: toLocal(lastBar.t) } : { time: toLocal(lastBar.t), value: v });
          }
        }, 400);
      }
      const now = performance.now();
      if (now - lastPaint.current > 250) {
        lastPaint.current = now;
        setTickVersion((x) => x + 1);
      }
    },
    [type, computeOverlays]
  );
  // Candles from the venue (1 minute and up)
  useLiveCandle(seconds ? null : liveCoin, seconds ? null : interval, (k) => applyBar({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v * k.c }));
  // Seconds: fold trades into the forming bar
  useLiveTrades(seconds ? liveCoin : null, (trades) => {
    for (const [px, sz, time] of trades) {
      const t = Math.floor(time / step) * step;
      const last = bars.current.at(-1);
      const cur: Bar = last && last.t === t ? { ...last, h: Math.max(last.h, px), l: Math.min(last.l, px), c: px, v: (last.v ?? 0) + px * sz } : { t, o: px, h: px, l: px, c: px, v: px * sz };
      if (!last || t >= last.t) applyBar(cur);
    }
  });
  // No live feed (Solana tokens): refresh the newest bars every 15 seconds
  useEffect(() => {
    if (liveCoin || state !== "ready") return;
    const id = setInterval(() => {
      api
        .chartBars(instrument, interval, { bars: 10 })
        .then((d) => {
          for (const [t, o, h, l, c, v] of d.candles) applyBar({ t, o, h, l, c, v });
        })
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveCoin, state, interval, instJson, applyBar]);
  const connected = useLiveStatus(Boolean(liveCoin));

  const lastBar = bars.current.at(-1);
  useEffect(() => {
    if (lastBar && onLast) onLast(lastBar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickVersion, version]);

  // Fullscreen
  const [full, setFull] = useState(false);
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === wrap.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrap.current?.requestFullscreen?.();
  };

  const snapshot = () => {
    const c = ctx.current;
    if (!c) return;
    const canvas = c.chart.takeScreenshot();
    const a = document.createElement("a");
    a.download = `weft-${key.split(":").pop()}-${interval}.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
  };

  // Escape cancels drawing
  useEffect(() => {
    if (tool === "none") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setTool("none");
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool]);

  const [menu, setMenu] = useState(false);
  const toggleInd = (id: IndicatorId) => {
    const next = ind.includes(id) ? ind.filter((x) => x !== id) : [...ind, id];
    setInd(next);
    save("weft:chart:indicators", next);
  };

  // Readout: hovered bar, else the newest
  const shownIdx = hover ?? bars.current.length - 1;
  const shown = bars.current[shownIdx];
  const prev = bars.current[shownIdx - 1];
  const overlaysNow = useMemo(() => (state === "ready" ? computeOverlays(bars.current) : []), [state, version, tickVersion, computeOverlays]); // eslint-disable-line react-hooks/exhaustive-deps
  const chg = shown && prev ? ((shown.c - prev.c) / prev.c) * 100 : null;
  const up = shown ? shown.c >= shown.o : true;

  return (
    <div ref={wrap} className={`flex flex-col ${full ? "bg-paper p-4 sm:p-6" : ""} ${full ? "h-screen" : className}`}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="no-scrollbar -mx-1 flex max-w-full items-center overflow-x-auto px-1" role="tablist" aria-label="Bar size">
          {intervals.map((iv, k) => (
            <span key={iv.id} className="flex items-center">
              {k > 0 && iv.id === "1m" && intervals[0]!.seconds && <span className="mx-1 h-4 w-px bg-line-2" aria-hidden />}
              <button
                role="tab"
                aria-selected={interval === iv.id}
                onClick={() => pickInterval(iv.id)}
                className={`tnum h-8 shrink-0 rounded-[8px] px-2 text-[13px] transition-colors ${interval === iv.id ? "bg-paper-2 font-medium text-ink" : "text-muted hover:text-ink"}`}
              >
                {iv.label}
              </button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-0.5">
          {(["candles", "bars", "line"] as const).map((t) => (
            <ToolBtn key={t} on={type === t} label={{ candles: "Candles", bars: "Bars", line: "Line" }[t]} onClick={() => (setType(t), save("weft:chart:type", t))}>
              <Icon d={I[t]} />
            </ToolBtn>
          ))}
          <span className="mx-1 h-4 w-px bg-line-2" aria-hidden />
          <div className="relative">
            <ToolBtn on={menu || ind.some((x) => x !== "volume")} label="Indicators" onClick={() => setMenu((m) => !m)}>
              <Icon d={I.fx} />
              <span className="hidden sm:inline">Indicators</span>
            </ToolBtn>
            {menu && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
                <div className="absolute right-0 top-9 z-40 w-[280px] rounded-[12px] border border-line bg-card p-1.5 shadow-window">
                  {INDICATORS.map((x) => (
                    <button key={x.id} onClick={() => toggleInd(x.id)} className="flex w-full items-start gap-3 rounded-[8px] px-2.5 py-2 text-left hover:bg-paper-2">
                      <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border ${ind.includes(x.id) ? "border-ink bg-ink text-paper" : "border-line-2"}`}>
                        {ind.includes(x.id) && (
                          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M2.5 6.5l2.2 2L9.5 3.5" />
                          </svg>
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
                          <span className="h-[2px] w-3 rounded" style={{ background: x.color }} />
                          {x.label}
                        </span>
                        <span className="block text-[12px] leading-snug text-muted">{x.hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <ToolBtn on={tool === "hline"} label="Draw a price line (click the chart)" onClick={() => setTool((t) => (t === "hline" ? "none" : "hline"))}>
            <Icon d={I.hline} />
          </ToolBtn>
          <ToolBtn on={logScale} label="Log scale" onClick={() => (setLogScale(!logScale), save("weft:chart:log", !logScale))} className="tnum text-[12px] font-medium">
            log
          </ToolBtn>
          <ToolBtn label="Save as image" onClick={snapshot} className="max-sm:hidden">
            <Icon d={I.camera} />
          </ToolBtn>
          <ToolBtn label={full ? "Exit full screen" : "Full screen"} onClick={toggleFull}>
            <Icon d={full ? I.exit : I.full} />
          </ToolBtn>
        </div>
      </div>

      {/* Chart */}
      <div className={`relative mt-3 min-h-0 flex-1 ${tool === "hline" ? "cursor-crosshair" : ""}`}>
        <div ref={box} className="absolute inset-0" />

        {/* Readout */}
        {shown && state === "ready" && (
          <div className="pointer-events-none absolute left-1 top-1 z-10 max-w-[calc(100%-80px)] space-y-0.5 text-[11.5px] leading-[1.5]">
            <div className="tnum flex flex-wrap items-center gap-x-2.5 text-muted">
              <span>
                O <span className={up ? "text-long" : "text-short"}>{fmt(shown.o)}</span>
              </span>
              <span>
                H <span className={up ? "text-long" : "text-short"}>{fmt(shown.h)}</span>
              </span>
              <span>
                L <span className={up ? "text-long" : "text-short"}>{fmt(shown.l)}</span>
              </span>
              <span>
                C <span className={up ? "text-long" : "text-short"}>{fmt(shown.c)}</span>
              </span>
              {chg != null && <span className={chg >= 0 ? "text-long" : "text-short"}>{`${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(2)}%`}</span>}
              {shown.v != null && shown.v > 0 && <span>Vol {compact(shown.v)}</span>}
              {hover != null && <span className="text-faint">{new Date(shown.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) })}</span>}
            </div>
            {overlaysNow.filter((o) => o.id !== "bbl").length > 0 && (
              <div className="tnum flex flex-wrap gap-x-3 text-muted">
                {overlaysNow
                  .filter((o) => o.id !== "bbl")
                  .map((o) => {
                    const v = o.values[shownIdx];
                    const label = o.id === "bbu" ? "BB" : INDICATORS.find((x) => x.id === o.id)?.label;
                    return (
                      <span key={o.id} className="inline-flex items-center gap-1">
                        <span className="h-[2px] w-2.5 rounded" style={{ background: o.color }} />
                        {label} <span className="text-ink-2">{v == null ? "—" : o.id === "rsi" ? v.toFixed(1) : fmt(v)}</span>
                      </span>
                    );
                  })}
              </div>
            )}
          </div>
        )}

        {/* States */}
        {state === "loading" && <div className="absolute inset-0 animate-pulse rounded-[10px] bg-paper-2/60" />}
        {(state === "error" || state === "unsupported") && (
          <div className="absolute inset-0 grid place-items-center rounded-[10px] border border-dashed border-line-2 bg-paper/80 text-center">
            <div className="px-6">
              <div className="text-[14.5px] font-medium text-ink">{state === "unsupported" ? "Not available for this market" : "Couldn’t load the chart"}</div>
              <p className="mt-1 text-[13px] text-muted">{state === "unsupported" ? errMsg : "The data source didn’t answer. Try another bar size or again in a moment."}</p>
            </div>
          </div>
        )}
        {state === "ready" && seconds && recordedSince != null && Date.now() - recordedSince < 3 * 3_600_000 && (
          <div className="pointer-events-none absolute bottom-8 left-1 z-10 rounded-full bg-paper-2 px-2.5 py-1 text-[11.5px] text-muted">
            Second bars are built from live trades, recorded since {new Date(recordedSince).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          </div>
        )}
        {tool === "hline" && (
          <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full bg-ink px-3 py-1 text-[12px] text-paper">Click to place a line · Esc to cancel</div>
        )}
        {!atLatest && state === "ready" && (
          <button
            onClick={() => ctx.current?.chart.timeScale().scrollToRealTime()}
            className="absolute bottom-9 right-[72px] z-10 rounded-full border border-line-2 bg-card px-3 py-1 text-[12.5px] text-ink-2 shadow-lift hover:text-ink"
          >
            Latest →
          </button>
        )}
      </div>

      {/* Footer: live state, your lines */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-[11.5px] text-faint">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {liveCoin ? (
            <span className="inline-flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-long" : "bg-faint"}`} />
              {connected ? "Live" : "Connecting"}
            </span>
          ) : (
            state === "ready" && <span>Updates every 15 s</span>
          )}
          {lines.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5">
              {lines.map((p, i) => (
                <button
                  key={`${p}-${i}`}
                  onClick={() => setLines(lines.filter((_, k) => k !== i))}
                  className="tnum inline-flex items-center gap-1 rounded-full bg-[var(--signal-soft)] px-2 py-0.5 text-signal hover:opacity-80"
                  title="Remove line"
                >
                  {fmt(p)} <span aria-hidden>×</span>
                </button>
              ))}
            </span>
          )}
          <span className="max-sm:hidden">Scroll to zoom · drag to move</span>
        </span>
        <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noreferrer" className="hover:text-muted">
          Charts by TradingView
        </a>
      </div>
    </div>
  );
}
