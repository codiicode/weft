"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import type { MarketListing, Product, Quote } from "@weft/venues";
import { api } from "@/lib/api";
import { useApi, fmtCompact, fmtPct, fmtPrice } from "@/lib/use-api";
import { PageHeader, Card, Btn, Pill, Empty } from "@/components/app/AppShell";
import { IconX } from "@/components/graph/icons";
import { AssetIcon } from "@/components/ui/AssetIcon";
import { instrumentIcon } from "@/lib/assets";

const PRODUCTS: { id: Product; label: string; blurb: string }[] = [
  { id: "perps", label: "Perps", blurb: "Crypto perpetuals on Hyperliquid" },
  { id: "stocks", label: "Stocks", blurb: "Shares, indices and commodities as perps on Hyperliquid, plus tokenized stocks on Solana" },
  { id: "predictions", label: "Predictions", blurb: "Outcome markets on Hyperliquid and Jupiter" },
  { id: "tokens", label: "Solana tokens", blurb: "Any Solana token, matched by contract address" },
  { id: "options", label: "Options", blurb: "Listed options. Only strategies with a known worst case" },
];

function thesisFor(r: MarketListing): string {
  const name = r.label.replace(/^\$/, "");
  switch (r.product) {
    case "tokens":
      return `Buy $${name} when it dips 10% and sentiment turns bullish, 0.5 SOL, stop −20%`;
    case "predictions":
      return `Buy ${r.name ?? r.label} if our model disagrees with the market by 10+ points`;
    case "options":
      return `${r.instrument.kind === "option" ? r.instrument.underlying : name} call spread if it breaks out this week`;
    case "stocks":
      return `${name.split(":").pop()} momentum: go long on a 3% breakout with a 5% stop`;
    default:
      return `${name} breakout: long 2× on a 3% move up with a trailing stop`;
  }
}

function Detail({ row, onClose }: { row: MarketListing; onClose: () => void }) {
  const router = useRouter();
  const [size, setSize] = useState(1000);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setErr(null);
    const t = setTimeout(() => {
      api
        .quote(row.instrument, { side: "buy", sizeUsd: size })
        .then((q) => alive && setQuote(q))
        .catch((e) => alive && setErr((e as Error).message));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [row, size]);
  const meta = Object.entries(row.meta ?? {}).filter(([, v]) => v != null && v !== "");
  return (
    <motion.aside
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      className="fixed inset-y-0 right-0 z-50 w-full max-w-[420px] overflow-y-auto border-l border-line bg-card p-6 shadow-window"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <AssetIcon {...instrumentIcon(row.instrument, row.meta)} size={40} />
          <div className="mt-3 text-[12.5px] text-muted">{row.venue}</div>
          <div className="mt-1 text-[24px] font-semibold tracking-[-0.03em]">{row.label}</div>
          {row.name && <div className="text-[14px] text-ink-2">{row.name}</div>}
        </div>
        <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-[10px] text-muted hover:bg-paper-2 hover:text-ink" aria-label="Close"><IconX size={14} /></button>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <div className="rounded-[10px] border border-line p-3">
          <div className="text-[12px] text-muted">Price</div>
          <div className="tnum mt-1 text-[18px]">{fmtPrice(row.price)}</div>
        </div>
        <div className="rounded-[10px] border border-line p-3">
          <div className="text-[12px] text-muted">24h</div>
          <div className={`tnum mt-1 text-[18px] ${(row.change24hPct ?? 0) >= 0 ? "text-long" : "text-short"}`}>{fmtPct(row.change24hPct)}</div>
        </div>
      </div>
      <div className="mt-5 rounded-[10px] border border-line p-4">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-ink">Quote for buying</span>
          <span className="text-[12.5px] text-faint">{quote?.source}</span>
        </div>
        <div className="mt-3 flex items-center gap-2">
          {[100, 1000, 10000].map((v) => (
            <button key={v} onClick={() => setSize(v)} className={`rounded-[8px] px-3 py-1 text-[13px] ${size === v ? "bg-ink text-paper" : "border border-line text-ink-2"}`}>
              ${v.toLocaleString()}
            </button>
          ))}
        </div>
        {err ? (
          <div className="mt-3 text-[12px] text-short">{err}</div>
        ) : quote ? (
          <dl className="mt-3 grid grid-cols-2 gap-y-1.5 text-[12.5px]">
            <dt className="text-muted">Market price</dt><dd className="tnum text-right">{fmtPrice(quote.price)}</dd>
            <dt className="text-muted">You’d pay</dt><dd className="tnum text-right">{fmtPrice(quote.fillPrice ?? quote.ask ?? quote.price)}</dd>
            <dt className="text-muted">Price impact</dt><dd className="tnum text-right">{quote.priceImpactBps != null ? `${(quote.priceImpactBps / 100).toFixed(2)}%` : "—"}</dd>
          </dl>
        ) : (
          <div className="mt-3 h-14 animate-pulse rounded-[8px] bg-paper-2" />
        )}
      </div>
      {meta.length > 0 && (
        <dl className="mt-5 grid grid-cols-2 gap-y-1.5 text-[12px]">
          {meta.slice(0, 12).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="truncate text-faint">{k}</dt>
              <dd className="truncate text-right text-ink-2">{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {row.instrument.kind === "token" && (
        <div className="mt-4 break-all rounded-[10px] bg-paper-2 p-3 font-mono text-[12px] text-ink-2"><span className="font-sans text-muted">Address </span>{row.instrument.mint}</div>
      )}
      <Btn onClick={() => router.push(`/app/new?go=1&thesis=${encodeURIComponent(thesisFor(row))}`)} className="mt-6 h-10 w-full">
        Build a strategy on {row.label}
      </Btn>
    </motion.aside>
  );
}

function Markets() {
  const params = useSearchParams();
  const router = useRouter();
  const product = (PRODUCTS.find((p) => p.id === params.get("p"))?.id ?? "perps") as Product;
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<MarketListing | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setQ(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  const { data, loading, error } = useApi(() => api.markets(product, { search: q || undefined, limit: 80 }), [product, q], { pollMs: 12_000 });
  const rows = data?.rows ?? [];
  const cols = useMemo(() => {
    const has = (k: keyof MarketListing) => rows.some((r) => r[k] != null);
    return { vol: has("volume24hUsd"), oi: has("openInterestUsd"), fund: has("fundingHourlyPct"), liq: has("liquidityUsd"), mcap: has("marketCapUsd"), lev: has("maxLeverage") };
  }, [rows]);

  return (
    <>
      <PageHeader title="Markets" sub="Live prices. Pick any market to get a quote or build a strategy on it." />
      <div className="space-y-4 px-5 pb-16 pt-6 lg:px-10">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="no-scrollbar fade-r flex gap-1 overflow-x-auto">
            {PRODUCTS.map((p) => (
              <button
                key={p.id}
                onClick={() => router.replace(`/app/markets?p=${p.id}`)}
                className={`relative h-8 shrink-0 rounded-[8px] px-3 text-[13.5px] ${product === p.id ? "font-medium text-ink" : "text-muted hover:text-ink"}`}
              >
                {product === p.id && <motion.span layoutId="mk-tab" className="absolute inset-0 rounded-[8px] bg-paper-2" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
                <span className="relative">{p.label}</span>
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
        <p className="text-[13px] text-muted">{PRODUCTS.find((p) => p.id === product)?.blurb}</p>

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
                    <th className="px-3 py-3 text-right font-normal">Price</th>
                    <th className="px-3 py-3 text-right font-normal">24h</th>
                    {cols.vol && <th className="hidden sm:table-cell px-3 py-3 text-right font-normal">Volume</th>}
                    {cols.oi && <th className="hidden sm:table-cell px-3 py-3 text-right font-normal">Open interest</th>}
                    {cols.fund && <th className="hidden sm:table-cell px-3 py-3 text-right font-normal">Funding / h</th>}
                    {cols.liq && <th className="hidden sm:table-cell px-3 py-3 text-right font-normal">Liquidity</th>}
                    {cols.mcap && <th className="hidden sm:table-cell px-3 py-3 text-right font-normal">Market cap</th>}
                    {cols.lev && <th className="hidden sm:table-cell px-5 py-3 text-right font-normal">Max leverage</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.instrumentKey} onClick={() => setOpen(r)} className="cursor-pointer border-b border-line transition-colors last:border-0 hover:bg-paper-2/60">
                      <td className="max-w-[320px] px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <AssetIcon {...instrumentIcon(r.instrument, r.meta)} size={22} />
                          <span className="truncate font-medium">{r.label}</span>
                          {r.instrument.kind === "perp" && r.instrument.dex && <Pill tone="signal">HIP-3 · {r.instrument.dex}</Pill>}
                          {r.instrument.kind === "token" && r.instrument.assetClass === "equity" && <Pill tone="signal">xStock</Pill>}
                        </div>
                        {r.name && <div className="truncate pl-[32px] text-[12px] text-faint">{r.name}</div>}
                      </td>
                      <td className="tnum px-3 py-3 text-right">{r.product === "predictions" && r.price != null ? `${Math.round(r.price * 100)}¢` : fmtPrice(r.price)}</td>
                      <td className={`tnum px-3 py-3 text-right ${(r.change24hPct ?? 0) >= 0 ? "text-long" : "text-short"}`}>{fmtPct(r.change24hPct)}</td>
                      {cols.vol && <td className="hidden sm:table-cell tnum px-3 py-3 text-right text-ink-2">{fmtCompact(r.volume24hUsd)}</td>}
                      {cols.oi && <td className="hidden sm:table-cell tnum px-3 py-3 text-right text-ink-2">{fmtCompact(r.openInterestUsd)}</td>}
                      {cols.fund && <td className={`hidden sm:table-cell tnum px-3 py-3 text-right ${(r.fundingHourlyPct ?? 0) >= 0 ? "text-ink-2" : "text-short"}`}>{r.fundingHourlyPct == null ? "—" : `${r.fundingHourlyPct.toFixed(4)}%`}</td>}
                      {cols.liq && <td className="hidden sm:table-cell tnum px-3 py-3 text-right text-ink-2">{fmtCompact(r.liquidityUsd)}</td>}
                      {cols.mcap && <td className="hidden sm:table-cell tnum px-3 py-3 text-right text-ink-2">{fmtCompact(r.marketCapUsd)}</td>}
                      {cols.lev && <td className="hidden sm:table-cell tnum px-5 py-3 text-right text-ink-2">{r.maxLeverage ? `${r.maxLeverage}×` : "—"}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(null)} className="fixed inset-0 z-40 bg-black/20" />
            <Detail key={open.instrumentKey} row={open} onClose={() => setOpen(null)} />
          </>
        )}
      </AnimatePresence>
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
