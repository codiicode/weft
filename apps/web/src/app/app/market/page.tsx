"use client";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { MarketListing, Quote } from "@weft/venues";
import { api, type ChartData, type ChartRange } from "@/lib/api";
import { fmtCompact, useApi } from "@/lib/use-api";
import { useLiveCandle, useLiveStatus } from "@/lib/live";
import { chartMinMove, ideasFor, priceFormatter, venueName } from "@/lib/market-ideas";
import { instrumentIcon } from "@/lib/assets";
import { AssetIcon } from "@/components/ui/AssetIcon";
import { Card, Empty, Pill } from "@/components/app/AppShell";
import { PriceChart, type Bar, type ChartApi } from "@/components/chart/PriceChart";
import { FundingChart } from "@/components/chart/FundingChart";
import { Segmented } from "@/components/ui/Segmented";

const RANGES: { id: ChartRange; label: string; past: string }[] = [
  { id: "1H", label: "1H", past: "Past hour" },
  { id: "1D", label: "1D", past: "Past day" },
  { id: "1W", label: "1W", past: "Past week" },
  { id: "1M", label: "1M", past: "Past month" },
  { id: "1Y", label: "1Y", past: "Past year" },
];

const PRODUCT_LABEL: Record<string, string> = { perps: "Perps", stocks: "Stocks", predictions: "Predictions", tokens: "Solana tokens", options: "Options" };

function readPref<T extends string>(k: string, allowed: readonly T[], def: T): T {
  try {
    const v = localStorage.getItem(k) as T | null;
    return v && allowed.includes(v) ? v : def;
  } catch {
    return def;
  }
}
function writePref(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    // private mode: fine
  }
}

/** A row handed over from the markets list, so the page paints instantly. */
function cachedRow(key: string): MarketListing | null {
  try {
    const raw = sessionStorage.getItem(`weft:market:${key}`);
    return raw ? (JSON.parse(raw) as MarketListing) : null;
  } catch {
    return null;
  }
}

function toBars(d: ChartData | null): Bar[] {
  return (d?.candles ?? []).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
}

function when(t: number, intervalMs: number) {
  const d = new Date(t);
  if (intervalMs >= 86_400_000) return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function QuoteCard({ row }: { row: MarketListing }) {
  const [size, setSize] = useState(1000);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fmt = priceFormatter(row);
  useEffect(() => {
    let alive = true;
    setErr(null);
    const t = setTimeout(() => {
      api
        .quote(row.instrument, { side: "buy", sizeUsd: size })
        .then((q) => alive && setQuote(q))
        .catch((e) => alive && setErr((e as Error).message));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [row.instrument, size]);
  const pay = quote ? (quote.fillPrice ?? quote.ask ?? quote.price) : null;
  return (
    <Card className="p-5">
      <div className="text-[14px] font-medium text-ink">What buying costs right now</div>
      <div className="mt-3 flex gap-1.5">
        {[100, 1000, 10000].map((v) => (
          <button
            key={v}
            onClick={() => setSize(v)}
            className={`tnum h-7 rounded-[8px] px-2.5 text-[13px] transition-colors ${size === v ? "bg-ink text-paper" : "border border-line-2 text-ink-2 hover:border-ink/30"}`}
          >
            ${v.toLocaleString()}
          </button>
        ))}
      </div>
      {err ? (
        <p className="mt-4 text-[13px] text-muted">No quote for this market right now.</p>
      ) : quote ? (
        <dl className="mt-4 space-y-2 text-[13.5px]">
          <div className="flex justify-between"><dt className="text-muted">Market price</dt><dd className="tnum text-ink">{quote.price != null ? fmt(quote.price) : "—"}</dd></div>
          <div className="flex justify-between"><dt className="text-muted">You’d pay</dt><dd className="tnum text-ink">{pay != null ? fmt(pay) : "—"}</dd></div>
          <div className="flex justify-between">
            <dt className="text-muted">Price impact</dt>
            <dd className="tnum text-ink">{quote.priceImpactBps != null ? `${(quote.priceImpactBps / 100).toFixed(2)}%` : "—"}</dd>
          </div>
        </dl>
      ) : (
        <div className="mt-4 space-y-2.5">{[0, 1, 2].map((i) => <div key={i} className="h-4 animate-pulse rounded bg-paper-2" />)}</div>
      )}
    </Card>
  );
}

function IdeasCard({ row }: { row: MarketListing }) {
  const ideas = ideasFor(row);
  return (
    <Card className="p-5">
      <div className="text-[14px] font-medium text-ink">Put {row.product === "predictions" ? "this market" : row.label} to work</div>
      <p className="mt-0.5 text-[13px] text-muted">Pick one to start. You can change every rule before it runs, on paper.</p>
      <ul className="mt-3 divide-y divide-line">
        {ideas.map((t) => (
          <li key={t}>
            <Link href={`/app/new?go=1&thesis=${encodeURIComponent(t)}`} className="group flex items-start justify-between gap-3 py-3 text-[13.5px] leading-snug text-ink-2 hover:text-ink">
              <span>{t}</span>
              <span className="mt-px text-faint transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-ink">→</span>
            </Link>
          </li>
        ))}
      </ul>
      <Link
        href={`/app/new?thesis=${encodeURIComponent(`${row.label.replace(/^\$/, "")} `)}`}
        className="mt-2 inline-flex h-9 w-full items-center justify-center rounded-[10px] bg-ink text-[14px] font-medium text-paper transition-colors hover:bg-ink/85"
      >
        Write your own
      </Link>
    </Card>
  );
}

function Market() {
  const key = useSearchParams().get("key") ?? "";
  const [seed] = useState(() => (typeof window === "undefined" ? null : cachedRow(key)));
  const fetched = useApi(key ? () => api.market(key) : null, [key], { pollMs: 15_000 });
  const row = fetched.data ?? seed;
  const fmt = useMemo(() => priceFormatter(row), [row?.product]); // eslint-disable-line react-hooks/exhaustive-deps

  const [range, setRange] = useState<ChartRange>("1D");
  const [mode, setMode] = useState<"line" | "candles">("line");
  useEffect(() => {
    setRange(readPref("weft:chart:range", ["1H", "1D", "1W", "1M", "1Y"] as const, "1D"));
    setMode(readPref("weft:chart:mode", ["line", "candles"] as const, "line"));
  }, []);

  const [chart, setChart] = useState<ChartData | null>(null);
  const [chartErr, setChartErr] = useState<{ msg: string; unsupported: boolean } | null>(null);
  const [loadingRange, setLoadingRange] = useState<ChartRange | null>(null);
  const instrumentJson = row ? JSON.stringify(row.instrument) : null;
  const isPerp = row?.instrument.kind === "perp";

  const load = useCallback(
    async (quiet: boolean) => {
      if (!instrumentJson) return;
      if (!quiet) setLoadingRange(range);
      try {
        const d = await api.chart(JSON.parse(instrumentJson), range, { funding: isPerp });
        setChart((prev) => (quiet && prev && !d.funding ? { ...d, funding: prev.funding } : d));
        setChartErr(null);
      } catch (e) {
        const msg = (e as Error).message;
        if (!quiet) setChartErr({ msg, unsupported: /isn.t available|only available|unsupported/i.test(msg) });
      } finally {
        if (!quiet) setLoadingRange(null);
      }
    },
    [instrumentJson, range, isPerp]
  );
  useEffect(() => {
    void load(false);
  }, [load]);
  // Markets without a live feed (Solana tokens) refresh every 30 seconds.
  useEffect(() => {
    if (!chart || chart.liveCoin) return;
    const t = setInterval(() => void load(true), 30_000);
    return () => clearInterval(t);
  }, [chart, load]);

  const bars = useMemo(() => toBars(chart), [chart]);
  const apiRef = useRef<ChartApi | null>(null);
  const [live, setLive] = useState<Bar | null>(null);
  const lastPaint = useRef(0);
  useEffect(() => setLive(null), [chart?.interval, key]);
  const interval = chart?.interval ?? null;
  useLiveCandle(chart?.liveCoin, interval, (c) => {
    const bar: Bar = { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v * c.c };
    apiRef.current?.update(bar);
    const now = performance.now();
    if (now - lastPaint.current > 250) {
      lastPaint.current = now;
      setLive(bar);
    }
  });
  const connected = useLiveStatus(Boolean(chart?.liveCoin));

  const [hover, setHover] = useState<Bar | null>(null);
  const first = bars[0];
  const latest = live && (!bars.length || live.t >= bars.at(-1)!.t) ? live : bars.at(-1);
  const price = hover?.c ?? latest?.c ?? row?.price ?? null;
  const base = first?.o ?? null;
  const change = price != null && base ? price - base : null;
  const changePct = change != null && base ? (change / base) * 100 : null;
  const tone: "long" | "short" = (latest?.c ?? 0) >= (base ?? 0) ? "long" : "short";
  const lo = bars.length ? Math.min(...bars.map((b) => b.l), latest?.l ?? Infinity) : null;
  const hi = bars.length ? Math.max(...bars.map((b) => b.h), latest?.h ?? -Infinity) : null;
  const rangeInfo = RANGES.find((r) => r.id === range)!;
  const isPrediction = row?.product === "predictions";

  if (!key) return <div className="px-5 pt-10 lg:px-10"><Empty title="No market picked" sub="Choose one from the markets list." action={<Link href="/app/markets" className="text-[14px] font-medium text-ink underline">Markets</Link>} /></div>;
  if (!row && fetched.error) return <div className="px-5 pt-10 lg:px-10"><Empty title="Market not found" sub="It may have closed or been delisted." action={<Link href="/app/markets" className="text-[14px] font-medium text-ink underline">Back to markets</Link>} /></div>;

  const stats: [string, string, string?][] = [];
  if (row) {
    if (isPrediction && row.price != null) stats.push(["Chance", `${Math.round(row.price * 100)}%`, "What the market thinks"]);
    if (row.volume24hUsd != null) stats.push(["24h volume", fmtCompact(row.volume24hUsd)]);
    if (row.openInterestUsd != null) stats.push(["Open interest", fmtCompact(row.openInterestUsd)]);
    if (row.fundingHourlyPct != null) stats.push(["Funding", `${row.fundingHourlyPct.toFixed(4)}% / h`, `${(row.fundingHourlyPct * 24 * 365).toFixed(1)}% a year`]);
    if (row.liquidityUsd != null) stats.push(["Liquidity", fmtCompact(row.liquidityUsd)]);
    if (row.marketCapUsd != null) stats.push(["Market cap", fmtCompact(row.marketCapUsd)]);
    if (row.maxLeverage) stats.push(["Max leverage", `${row.maxLeverage}×`]);
  }
  const dollar = isPrediction ? "" : "$";

  return (
    <div className="px-5 pb-20 pt-6 lg:px-10 lg:pt-10">
      <Link href={`/app/markets${row ? `?p=${row.product}` : ""}`} className="text-[13.5px] text-muted hover:text-ink">
        ← {row ? PRODUCT_LABEL[row.product] ?? "Markets" : "Markets"}
      </Link>

      <div className="mt-5 grid gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          {/* Identity */}
          <div className="flex items-center gap-3">
            {row ? <AssetIcon {...instrumentIcon(row.instrument, row.meta)} size={36} /> : <div className="h-9 w-9 animate-pulse rounded-full bg-paper-2" />}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-[20px] font-semibold tracking-[-0.02em] text-ink">{(isPrediction ? row?.name : null) ?? row?.label ?? " "}</h1>
                {row?.instrument.kind === "perp" && row.instrument.dex && <Pill tone="signal">HIP-3 · {row.instrument.dex}</Pill>}
                {row?.instrument.kind === "outcome" && <Pill tone="signal">{row.instrument.outcome}</Pill>}
              </div>
              <div className="truncate text-[13px] text-muted">{[isPrediction ? null : row?.name, venueName(row?.venue)].filter(Boolean).join(" · ")}</div>
            </div>
          </div>

          {/* Price */}
          <div className="mt-6">
            <div className="tnum text-[clamp(2.25rem,5vw,3.25rem)] font-semibold leading-none tracking-[-0.035em] text-ink">
              {price != null ? `${dollar}${fmt(price)}` : <span className="text-faint">—</span>}
            </div>
            <div className="mt-2.5 flex min-h-[20px] flex-wrap items-center gap-x-2.5 gap-y-1 text-[14px]">
              {changePct != null && change != null ? (
                <span className={`tnum font-medium ${change >= 0 ? "text-long" : "text-short"}`}>
                  {change >= 0 ? "+" : "−"}
                  {dollar}
                  {Math.abs(price ?? 0) >= 10_000 ? Math.round(Math.abs(change)).toLocaleString("en-US") : fmt(Math.abs(change))} ({change >= 0 ? "+" : "−"}
                  {Math.abs(changePct).toFixed(2)}%)
                </span>
              ) : null}
              <span className="text-muted">{hover ? when(hover.t, chart?.intervalMs ?? 0) : rangeInfo.past}</span>
              {!hover && chart?.liveCoin && (
                <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
                  <span className="relative grid h-2 w-2 place-items-center">
                    {connected && <span className="absolute h-2 w-2 animate-ping rounded-full bg-long opacity-50" />}
                    <span className={`relative h-1.5 w-1.5 rounded-full ${connected ? "bg-long" : "bg-faint"}`} />
                  </span>
                  {connected ? "Live" : "Connecting"}
                </span>
              )}
            </div>
          </div>

          {/* Chart */}
          <div className="mt-6 flex items-center justify-between gap-3">
            <Segmented
              id="range"
              value={range}
              options={RANGES}
              onChange={(r) => {
                setRange(r);
                writePref("weft:chart:range", r);
              }}
            />
            <Segmented
              id="mode"
              value={mode}
              options={[
                { id: "line", label: "Line" },
                { id: "candles", label: "Candles" },
              ]}
              onChange={(m) => {
                setMode(m);
                writePref("weft:chart:mode", m);
              }}
            />
          </div>
          <div className="relative mt-4 h-[300px] sm:h-[380px] lg:h-[420px]">
            {chartErr && !bars.length ? (
              <div className="grid h-full place-items-center rounded-[12px] border border-dashed border-line-2 text-center">
                <div>
                  <div className="text-[14.5px] font-medium text-ink">{chartErr.unsupported ? "No price history for this market yet" : "Couldn’t load the chart"}</div>
                  <p className="mt-1 text-[13px] text-muted">{chartErr.unsupported ? "Live price and quotes still work." : "The data source didn’t answer."}</p>
                  {!chartErr.unsupported && (
                    <button onClick={() => void load(false)} className="mt-3 text-[13.5px] font-medium text-ink underline underline-offset-4">
                      Try again
                    </button>
                  )}
                </div>
              </div>
            ) : !bars.length ? (
              <div className="h-full animate-pulse rounded-[12px] bg-paper-2/70" />
            ) : (
              <PriceChart
                bars={bars}
                mode={mode}
                tone={tone}
                format={fmt}
                intraday={(chart?.intervalMs ?? 0) < 86_400_000}
                minMove={chartMinMove(row?.product, hi ?? 0)}
                onHover={setHover}
                apiRef={apiRef}
                className={`h-full w-full transition-opacity duration-200 ${loadingRange ? "opacity-40" : ""}`}
              />
            )}
          </div>
          <div className="mt-2 flex justify-between text-[11.5px] text-faint">
            <span>{chart ? `Data: ${venueName(chart.source.split(":")[0])}` : " "}</span>
            {hi != null && lo != null && Number.isFinite(hi) && Number.isFinite(lo) && (
              <span className="tnum hidden sm:inline">
                Low <span className="text-ink-2">{fmt(lo)}</span> · High <span className="text-ink-2">{fmt(hi)}</span>
              </span>
            )}
            <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noreferrer" className="hover:text-muted">
              Charts by TradingView
            </a>
          </div>

          {/* Stats */}
          {stats.length > 0 && (
            <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-line pt-6 sm:grid-cols-4">
              {stats.map(([k, v, sub]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-[12.5px] text-muted">{k}</dt>
                  <dd className="tnum mt-1 truncate text-[15.5px] font-medium text-ink">{v}</dd>
                  {sub && <dd className="mt-0.5 text-[12px] text-faint">{sub}</dd>}
                </div>
              ))}
            </dl>
          )}

          {chart?.funding && chart.funding.length > 8 && (
            <div className="mt-8 border-t border-line pt-6">
              <FundingChart points={chart.funding} />
            </div>
          )}

          {row?.instrument.kind === "token" && (
            <div className="mt-8 border-t border-line pt-6">
              <div className="text-[12.5px] text-muted">Contract address</div>
              <div className="mt-1 break-all font-mono text-[12.5px] text-ink-2">{row.instrument.mint}</div>
            </div>
          )}
        </div>

        {/* Act on it */}
        {row && (
          <div className="space-y-4 xl:sticky xl:top-6 xl:self-start">
            <IdeasCard row={row} />
            <QuoteCard row={row} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function MarketPage() {
  return (
    <Suspense>
      <Market />
    </Suspense>
  );
}
