"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { MarketListing, Quote } from "@weft/venues";
import { api } from "@/lib/api";
import { fmtCompact, useApi } from "@/lib/use-api";
import { ideasFor, priceFormatter, venueName } from "@/lib/market-ideas";
import { useTradingVenues } from "@/lib/trading";
import { instrumentIcon } from "@/lib/assets";
import { AssetIcon } from "@/components/ui/AssetIcon";
import { Card, Empty, Pill } from "@/components/app/AppShell";
import { TradingChart, type Bar } from "@/components/chart/TradingChart";
import { FundingChart } from "@/components/chart/FundingChart";

const PRODUCT_LABEL: Record<string, string> = { perps: "Perps", stocks: "Stocks", predictions: "Predictions", tokens: "Solana tokens", options: "Options" };

/** A row handed over from the markets list, so the page paints instantly. */
function cachedRow(key: string): MarketListing | null {
  try {
    const raw = sessionStorage.getItem(`weft:market:${key}`);
    return raw ? (JSON.parse(raw) as MarketListing) : null;
  } catch {
    return null;
  }
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

/** Products that can't trade with real money yet (tokens open with Solana trading). */
const SOON = new Set(["predictions", "options"]);

function IdeasCard({ row }: { row: MarketListing }) {
  const ideas = ideasFor(row);
  const venues = useTradingVenues();
  const soon = SOON.has(row.product) || (row.product === "tokens" && venues != null && !venues.solana);
  return (
    <Card className="p-5">
      <div className="text-[14px] font-medium text-ink">Put {row.product === "predictions" ? "this market" : row.label} to work</div>
      <p className="mt-0.5 text-[13px] text-muted">
        {soon
          ? "Trading this market opens soon. You can already build a strategy and get an alert whenever it would trade."
          : "Pick one to start. You can read and change every rule, and test it on history, before it trades."}
      </p>
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
  const isPrediction = row?.product === "predictions";
  const isPerp = row?.instrument.kind === "perp";
  const instrumentJson = row ? JSON.stringify(row.instrument) : null;
  const instrument = useMemo(() => (instrumentJson ? (JSON.parse(instrumentJson) as MarketListing["instrument"]) : null), [instrumentJson]);

  // The newest price comes from the chart's live feed.
  const [last, setLast] = useState<Bar | null>(null);
  useEffect(() => setLast(null), [key]);
  const price = last?.c ?? row?.price ?? null;
  // 24h change, re-based on the live price: previous close = listed price / (1 + listed change).
  const prevClose = row?.price && row.change24hPct != null ? row.price / (1 + row.change24hPct / 100) : null;
  const change = price != null && prevClose ? price - prevClose : null;
  const changePct = change != null && prevClose ? (change / prevClose) * 100 : null;

  // Funding history for perps (a separate, small request).
  const [funding, setFunding] = useState<[number, number][] | null>(null);
  useEffect(() => {
    setFunding(null);
    if (!instrumentJson || !isPerp) return;
    let alive = true;
    api
      .chartBars(JSON.parse(instrumentJson), "1h", { bars: 10, funding: true })
      .then((d) => alive && setFunding(d.funding ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [instrumentJson, isPerp]);

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
  const fmtChange = (d: number) => (Math.abs(price ?? 0) >= 10_000 ? Math.round(d).toLocaleString("en-US") : fmt(d));

  return (
    <div className="px-5 pb-20 pt-6 lg:px-10 lg:pt-8">
      <Link href={`/app/markets${row ? `?p=${row.product}` : ""}`} className="text-[13.5px] text-muted hover:text-ink">
        ← {row ? PRODUCT_LABEL[row.product] ?? "Markets" : "Markets"}
      </Link>

      {/* Identity and price */}
      <div className="mt-5 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
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
          <div className="mt-5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <div className="tnum text-[clamp(2.1rem,4.6vw,3rem)] font-semibold leading-none tracking-[-0.035em] text-ink">
              {price != null ? `${dollar}${fmt(price)}` : <span className="text-faint">—</span>}
            </div>
            {changePct != null && change != null && (
              <div className="tnum text-[14.5px]">
                <span className={`font-medium ${change >= 0 ? "text-long" : "text-short"}`}>
                  {change >= 0 ? "+" : "−"}
                  {dollar}
                  {fmtChange(Math.abs(change))} ({change >= 0 ? "+" : "−"}
                  {Math.abs(changePct).toFixed(2)}%)
                </span>
                <span className="ml-2 text-muted">24h</span>
              </div>
            )}
          </div>
        </div>
        {stats.length > 0 && (
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            {stats.map(([k, v, sub]) => (
              <div key={k} className="min-w-0">
                <dt className="text-[12px] text-muted">{k}</dt>
                <dd className="tnum mt-0.5 text-[15px] font-medium text-ink">{v}</dd>
                {sub && <dd className="text-[11.5px] text-faint">{sub}</dd>}
              </div>
            ))}
          </dl>
        )}
      </div>

      {/* Chart */}
      <div className="mt-7">
        {instrument ? (
          <TradingChart instrument={instrument} product={row?.product} onLast={setLast} className="h-[460px] sm:h-[540px] lg:h-[600px]" />
        ) : (
          <div className="h-[460px] animate-pulse rounded-[12px] bg-paper-2/70" />
        )}
      </div>

      {/* Below the chart */}
      <div className="mt-10 grid gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-8">
          {funding && funding.length > 8 && <FundingChart points={funding} />}
          {row?.instrument.kind === "token" && (
            <div>
              <div className="text-[12.5px] text-muted">Contract address</div>
              <div className="mt-1 break-all font-mono text-[12.5px] text-ink-2">{row.instrument.mint}</div>
            </div>
          )}
        </div>
        {row && (
          <div className={`grid gap-4 ${funding && funding.length > 8 ? "" : "xl:col-span-2 md:grid-cols-2"}`}>
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
