"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "motion/react";
import type { MarketListing, Product } from "@weft/venues";
import { api } from "@/lib/api";
import { useApi, fmtCompact, fmtPct, fmtPrice } from "@/lib/use-api";
import { PageHeader, Card, Pill, Empty } from "@/components/app/AppShell";
import { perpCoin, useLiveMids, useLiveStatus } from "@/lib/live";
import { priceFormatter } from "@/lib/market-ideas";
import { useTradingVenues } from "@/lib/trading";
import { AssetIcon } from "@/components/ui/AssetIcon";
import { instrumentIcon } from "@/lib/assets";

/** Products Weft can't trade with real money yet: prices and charts only, for now. Tokens open with Solana trading. */
const SOON = new Set<Product>(["options"]);

const PRODUCTS: { id: Product; label: string; blurb: string }[] = [
  { id: "perps", label: "Perps", blurb: "Crypto perpetuals on Hyperliquid" },
  { id: "stocks", label: "Stocks", blurb: "Shares, indices and commodities as perps on Hyperliquid, plus tokenized stocks on Solana" },
  { id: "predictions", label: "Predictions", blurb: "Outcome markets on Hyperliquid: crypto prices, sports, companies and more" },
  { id: "tokens", label: "Solana tokens", blurb: "Any Solana token, matched by contract address" },
  { id: "options", label: "Options", blurb: "Listed options. Only strategies with a known worst case" },
];

/** A price that flashes green or red when it moves. */
function TickPrice({ value, children }: { value: number | null | undefined; children: React.ReactNode }) {
  const prev = useRef(value);
  const dir = value != null && prev.current != null && value !== prev.current ? (value > prev.current ? "up" : "down") : null;
  useEffect(() => {
    prev.current = value;
  }, [value]);
  return (
    <span key={dir ? String(value) : "still"} className={`-mx-1 inline-block rounded-[5px] px-1 ${dir ? `tick-${dir}` : ""}`}>
      {children}
    </span>
  );
}

type SortKey = "price" | "change24hPct" | "volume24hUsd" | "openInterestUsd" | "fundingHourlyPct" | "liquidityUsd" | "marketCapUsd" | "maxLeverage";

function liveCoin(r: MarketListing): string | null {
  return r.instrument.kind === "perp" ? perpCoin(r.instrument.symbol, r.instrument.dex) : null;
}

function Markets() {
  const params = useSearchParams();
  const router = useRouter();
  const product = (PRODUCTS.find((p) => p.id === params.get("p"))?.id ?? "perps") as Product;
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  const { data, loading, error } = useApi(() => api.markets(product, { search: q || undefined, limit: product === "predictions" ? 300 : 80 }), [product, q], { pollMs: 12_000 });
  const rawRows = data?.rows ?? [];
  // Click a column to sort by it (high to low first, click again for low to high).
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return rawRows;
    const val = (r: MarketListing) => r[sort.key] ?? null;
    return [...rawRows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (y - x) * (sort.dir === -1 ? 1 : -1);
    });
  }, [rawRows, sort]);
  useEffect(() => setSort(null), [product]);
  const sortBy = (key: SortKey) => setSort((cur) => (cur?.key === key ? (cur.dir === -1 ? { key, dir: 1 } : null) : { key, dir: -1 }));
  const Th = ({ k, label, className = "" }: { k: SortKey; label: string; className?: string }) => (
    <th className={`px-3 py-3 text-right font-normal ${className}`} aria-sort={sort?.key === k ? (sort.dir === -1 ? "descending" : "ascending") : "none"}>
      <button onClick={() => sortBy(k)} className={`inline-flex items-center gap-1 transition-colors hover:text-ink ${sort?.key === k ? "text-ink" : ""}`}>
        {label}
        <span className={`text-[10px] ${sort?.key === k ? "opacity-100" : "opacity-0"}`} aria-hidden>
          {sort?.dir === 1 ? "▲" : "▼"}
        </span>
      </button>
    </th>
  );
  const venues = useTradingVenues();
  const soon = (p: Product) => SOON.has(p) || (p === "tokens" && venues != null && !venues.solana);
  const dexes = useMemo(() => [...new Set(rows.flatMap((r) => (r.instrument.kind === "perp" ? [r.instrument.dex ?? ""] : [])))], [rows]);
  const mids = useLiveMids(dexes);
  const live = useLiveStatus(dexes.length > 0);
  const openRow = (r: MarketListing) => {
    try {
      sessionStorage.setItem(`weft:market:${r.instrumentKey}`, JSON.stringify(r));
    } catch {
      // storage off: the page fetches it instead
    }
    router.push(`/market?key=${encodeURIComponent(r.instrumentKey)}`);
  };
  const cols = useMemo(() => {
    const has = (k: keyof MarketListing) => rows.some((r) => r[k] != null);
    return { vol: has("volume24hUsd"), oi: has("openInterestUsd"), fund: has("fundingHourlyPct"), liq: has("liquidityUsd"), mcap: has("marketCapUsd"), lev: has("maxLeverage") };
  }, [rows]);

  return (
    <>
      <PageHeader title="Markets" sub="Live prices from the venues. Open any market for its chart, or build a strategy on it." />
      <div className="space-y-4 px-5 pb-16 pt-6 lg:px-10">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="no-scrollbar fade-r flex gap-1 overflow-x-auto">
            {PRODUCTS.map((p) => (
              <button
                key={p.id}
                onClick={() => router.replace(`/markets?p=${p.id}`)}
                className={`relative h-8 shrink-0 rounded-[8px] px-3 text-[13.5px] ${product === p.id ? "font-medium text-ink" : "text-muted hover:text-ink"}`}
              >
                {product === p.id && <motion.span layoutId="mk-tab" className="absolute inset-0 rounded-[8px] bg-paper-2" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
                <span className="relative">
                  {p.label}
                  {soon(p.id) && <span className="ml-1.5 text-[11px] font-normal text-faint">soon</span>}
                </span>
              </button>
            ))}
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={product === "tokens" ? "Search name, ticker or address" : "Search"}
            className="h-9 w-full rounded-[10px] border border-line-2 bg-card px-3.5 text-[14px] text-ink outline-none placeholder:text-faint focus:border-ink/40 md:w-72"
            aria-label="Search markets"
          />
        </div>
        <p className="flex items-center gap-2 text-[13px] text-muted">
          {live && (
            <span className="inline-flex items-center gap-1.5 text-ink-2">
              <span className="relative grid h-2 w-2 place-items-center">
                <span className="absolute h-2 w-2 animate-ping rounded-full bg-long opacity-50" />
                <span className="relative h-1.5 w-1.5 rounded-full bg-long" />
              </span>
              Live
            </span>
          )}
          {live && <span className="text-faint">·</span>}
          {PRODUCTS.find((p) => p.id === product)?.blurb}
          {soon(product) && <span className="text-faint">· Trading opens soon; charts and alerts work today.</span>}
        </p>

        {error && !rows.length ? (
          <Empty title="Market data is unavailable" sub="Can’t reach the Weft server. Try again in a moment." />
        ) : loading && !rows.length ? (
          <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-12 animate-pulse rounded-[10px] bg-paper-2" />)}</div>
        ) : !rows.length ? (
          <Empty title="No markets found" sub={product === "options" ? "Options listings come from the options venue; try BTC or ETH." : "Try another search."} />
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13.5px] sm:min-w-[720px]">
                <thead className="text-[12.5px] text-muted">
                  <tr className="border-b border-line">
                    <th className="px-5 py-3 font-normal">Market</th>
                    <Th k="price" label="Price" />
                    <Th k="change24hPct" label="24h" />
                    {cols.vol && <Th k="volume24hUsd" label="Volume" className="hidden sm:table-cell" />}
                    {cols.oi && <Th k="openInterestUsd" label="Open interest" className="hidden sm:table-cell" />}
                    {cols.fund && <Th k="fundingHourlyPct" label="Funding / h" className="hidden sm:table-cell" />}
                    {cols.liq && <Th k="liquidityUsd" label="Liquidity" className="hidden sm:table-cell" />}
                    {cols.mcap && <Th k="marketCapUsd" label="Market cap" className="hidden sm:table-cell" />}
                    {cols.lev && <Th k="maxLeverage" label="Max leverage" className="hidden sm:table-cell pr-5" />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const coin = liveCoin(r);
                    const mid = coin ? mids[coin] : undefined;
                    const price = mid ?? r.price;
                    // Re-base the 24h change on the live price: previous close = price / (1 + change).
                    const chg = mid != null && r.price && r.change24hPct != null ? ((mid / (r.price / (1 + r.change24hPct / 100))) - 1) * 100 : r.change24hPct;
                    return (
                    <tr key={r.instrumentKey} onClick={() => openRow(r)} className="group cursor-pointer border-b border-line transition-colors last:border-0 hover:bg-paper-2/60">
                      <td className="max-w-[320px] px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <AssetIcon {...instrumentIcon(r.instrument, r.meta)} size={22} />
                          <Link
                            href={`/market?key=${encodeURIComponent(r.instrumentKey)}`}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openRow(r);
                            }}
                            className="truncate font-medium text-ink outline-none focus-visible:underline"
                          >
                            {r.label}
                          </Link>
                          {r.instrument.kind === "perp" && r.instrument.dex && <Pill tone="signal">HIP-3 · {r.instrument.dex}</Pill>}
                          {r.instrument.kind === "token" && r.instrument.assetClass === "equity" && <Pill tone="signal">xStock</Pill>}
                        </div>
                        {r.name && <div className="truncate pl-[32px] text-[12px] text-faint">{r.name}</div>}
                      </td>
                      <td className="tnum px-3 py-3 text-right">
                        <TickPrice value={price}>{price == null ? "—" : r.product === "predictions" ? `${Math.round(price * 100)}¢` : priceFormatter(r)(price)}</TickPrice>
                      </td>
                      <td className={`tnum px-3 py-3 text-right ${(chg ?? 0) >= 0 ? "text-long" : "text-short"}`}>{fmtPct(chg)}</td>
                      {cols.vol && <td className="hidden sm:table-cell tnum px-3 py-3 text-right text-ink-2">{fmtCompact(r.volume24hUsd)}</td>}
                      {cols.oi && <td className="hidden sm:table-cell tnum px-3 py-3 text-right text-ink-2">{fmtCompact(r.openInterestUsd)}</td>}
                      {cols.fund && <td className={`hidden sm:table-cell tnum px-3 py-3 text-right ${(r.fundingHourlyPct ?? 0) >= 0 ? "text-ink-2" : "text-short"}`}>{r.fundingHourlyPct == null ? "—" : `${r.fundingHourlyPct.toFixed(4)}%`}</td>}
                      {cols.liq && <td className="hidden sm:table-cell tnum px-3 py-3 text-right text-ink-2">{fmtCompact(r.liquidityUsd)}</td>}
                      {cols.mcap && <td className="hidden sm:table-cell tnum px-3 py-3 text-right text-ink-2">{fmtCompact(r.marketCapUsd)}</td>}
                      {cols.lev && <td className="hidden sm:table-cell tnum px-5 py-3 text-right text-ink-2">{r.maxLeverage ? `${r.maxLeverage}×` : "—"}</td>}
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

export default function MarketsPage() {
  return (
    <Suspense>
      <Markets />
    </Suspense>
  );
}
