"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { IChartApi, ISeriesApi, MouseEventParams, SeriesType, Time, UTCTimestamp } from "lightweight-charts";

/**
 * The market chart: an area line by default (easy to read), candles on request, a quiet volume
 * band underneath. Colours come from the site's tokens and follow the theme. Hovering reports the
 * bar under the pointer so the page header can show it (no floating tooltip to chase).
 */

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

export interface ChartApi {
  /** Add or replace the newest bar (live updates). */
  update(bar: Bar): void;
}

type Mode = "line" | "candles";

/** A trade to pin on the chart at its price. */
export interface TradeMark {
  t: number;
  price: number;
  side: "buy" | "sell";
}
type Tone = "long" | "short" | "neutral";

/** lightweight-charts draws in UTC: shift times so the axis reads in the viewer's local time. */
const toLocal = (ms: number) => (Math.floor(ms / 1000) - new Date(ms).getTimezoneOffset() * 60) as UTCTimestamp;

function cssVar(name: string, fallback: string) {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function alpha(color: string, a: number) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Bumps whenever the light/dark theme changes, so the chart re-reads its colours. */
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

export function PriceChart({
  bars,
  mode = "line",
  tone = "neutral",
  format,
  intraday,
  onHover,
  apiRef,
  volume = true,
  minMove = 0.01,
  marks,
  className = "",
}: {
  bars: Bar[];
  mode?: Mode;
  tone?: Tone;
  format: (p: number) => string;
  /** Show clock times on the axis (bars shorter than a day). */
  intraday: boolean;
  onHover?: (bar: Bar | null) => void;
  apiRef?: RefObject<ChartApi | null>;
  volume?: boolean;
  /** Smallest price step: axis ticks land on multiples of it. */
  minMove?: number;
  /** Trades to pin on the line; each snaps to the bar it happened in. */
  marks?: TradeMark[];
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const lib = useRef<typeof import("lightweight-charts") | null>(null);
  const main = useRef<ISeriesApi<SeriesType> | null>(null);
  const vol = useRef<ISeriesApi<"Histogram"> | null>(null);
  const byTime = useRef(new Map<number, Bar>());
  const hover = useRef(onHover);
  hover.current = onHover;
  const fmt = useRef(format);
  fmt.current = format;
  const theme = useThemeVersion();
  const [ready, setReady] = useState(0);

  // The chart itself: created once per theme (colours are baked into its options).
  useEffect(() => {
    let alive = true;
    let c: IChartApi | null = null;
    void import("lightweight-charts").then((L) => {
      if (!alive || !box.current) return;
      lib.current = L;
      const faint = cssVar("--faint", "#75777d");
      const line = cssVar("--line", "rgba(18,18,20,0.08)");
      const line2 = cssVar("--line-2", "rgba(18,18,20,0.15)");
      c = L.createChart(box.current, {
        autoSize: true,
        layout: {
          background: { type: L.ColorType.Solid, color: "transparent" },
          textColor: faint,
          fontFamily: getComputedStyle(document.body).fontFamily,
          fontSize: 11,
          attributionLogo: false,
        },
        grid: { vertLines: { visible: false }, horzLines: { color: line } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.14, bottom: 0.2 }, entireTextOnly: true },
        timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true, secondsVisible: false },
        crosshair: {
          mode: L.CrosshairMode.Magnet,
          vertLine: { color: line2, width: 1, style: L.LineStyle.Solid, labelVisible: false },
          horzLine: { visible: false, labelVisible: false },
        },
        // Drag to pan and pinch to zoom; the mouse wheel keeps scrolling the page.
        handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: false, axisDoubleClickReset: true },
        localization: { priceFormatter: (p: number) => fmt.current(p) },
      });
      c.subscribeCrosshairMove((p: MouseEventParams<Time>) => {
        const b = p.time != null && p.point && p.point.x >= 0 ? byTime.current.get(p.time as number) : undefined;
        hover.current?.(b ?? null);
      });
      chart.current = c;
      setReady((x) => x + 1);
    });
    return () => {
      alive = false;
      c?.remove();
      chart.current = null;
      main.current = null;
      vol.current = null;
    };
  }, [theme]);

  // Series: rebuilt when the data, mode or tone changes.
  useEffect(() => {
    const c = chart.current;
    const L = lib.current;
    if (!c || !L) return;
    if (main.current) c.removeSeries(main.current);
    if (vol.current) c.removeSeries(vol.current);
    main.current = null;
    vol.current = null;
    const color = tone === "long" ? cssVar("--long", "#0b9466") : tone === "short" ? cssVar("--short", "#dc3f2c") : cssVar("--ink", "#121214");
    const card = cssVar("--card", "#ffffff");
    const priceFormat = { type: "custom" as const, formatter: (p: number) => fmt.current(p), minMove };
    c.applyOptions({ timeScale: { timeVisible: intraday } });

    byTime.current = new Map(bars.map((b) => [toLocal(b.t), b]));
    if (volume && bars.some((b) => b.v)) {
      const v = c.addSeries(L.HistogramSeries, {
        priceScaleId: "vol",
        color: cssVar("--line-2", "rgba(18,18,20,0.15)"),
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat: { type: "volume" },
      });
      v.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
      v.setData(bars.map((b) => ({ time: toLocal(b.t), value: b.v ?? 0 })));
      vol.current = v;
    }
    if (mode === "candles") {
      const s = c.addSeries(L.CandlestickSeries, {
        upColor: cssVar("--long", "#0b9466"),
        downColor: cssVar("--short", "#dc3f2c"),
        wickUpColor: cssVar("--long", "#0b9466"),
        wickDownColor: cssVar("--short", "#dc3f2c"),
        borderVisible: false,
        priceLineVisible: true,
        priceLineStyle: L.LineStyle.Dotted,
        priceLineWidth: 1,
        priceFormat,
      });
      s.setData(bars.map((b) => ({ time: toLocal(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
      main.current = s;
    } else {
      const s = c.addSeries(L.AreaSeries, {
        lineColor: color,
        lineWidth: 2,
        topColor: alpha(color, 0.16),
        bottomColor: alpha(color, 0),
        lineType: L.LineType.Simple,
        crosshairMarkerRadius: 4.5,
        crosshairMarkerBorderWidth: 2,
        crosshairMarkerBorderColor: card,
        crosshairMarkerBackgroundColor: color,
        priceLineVisible: true,
        priceLineColor: alpha(color, 0.5),
        priceLineStyle: L.LineStyle.Dotted,
        priceLineWidth: 1,
        lastPriceAnimation: L.LastPriceAnimationMode.OnDataUpdate,
        priceFormat,
      });
      s.setData(bars.map((b) => ({ time: toLocal(b.t), value: b.c })));
      main.current = s;
    }
    if (marks?.length && bars.length > 1 && main.current) {
      const step = bars[1]!.t - bars[0]!.t;
      const first = bars[0]!.t;
      const long = cssVar("--long", "#0b9466");
      const short = cssVar("--short", "#dc3f2c");
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
        .sort((a, b) => (a.time as number) - (b.time as number));
      L.createSeriesMarkers(main.current, list);
    }
    c.timeScale().fitContent();
  }, [bars, mode, tone, intraday, volume, minMove, marks, ready]);

  // Live updates without re-rendering.
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      update(b: Bar) {
        const s = main.current;
        if (!s) return;
        const time = toLocal(b.t);
        const last = s.data().at(-1);
        if (last && (last.time as number) > time) return; // stale
        byTime.current.set(time, b);
        try {
          if (mode === "candles") (s as ISeriesApi<"Candlestick">).update({ time, open: b.o, high: b.h, low: b.l, close: b.c });
          else (s as ISeriesApi<"Area">).update({ time, value: b.c });
          if (vol.current && b.v != null) vol.current.update({ time, value: b.v });
        } catch {
          // out-of-order bar: ignore
        }
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, mode, ready, bars]);

  return <div ref={box} className={`relative ${className}`} onPointerLeave={() => hover.current?.(null)} />;
}
