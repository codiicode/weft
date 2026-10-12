"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Strategy } from "@weft/strategy";
import { useRequireAuth } from "@/lib/auth";
import { api, ApiError, type BacktestInterval, type BacktestResult, type CoverageStatus } from "@/lib/api";
import { fmtPct, fmtPrice, fmtUsd } from "@/lib/use-api";
import { Btn, Card, Pill } from "./AppShell";
import { EquityChart } from "./EquityChart";

const DAY_PRESETS = [7, 30, 90] as const;
const INTERVALS: BacktestInterval[] = ["1h", "15m"];

const fmtDay = (ts: number) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const fmtDayTime = (ts: number) =>
  new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

const QUALITY = {
  full: { tone: "long", label: "Full history", bg: "bg-[var(--long-soft)]", text: "text-long", border: "border-[color-mix(in_oklab,var(--long)_30%,transparent)]" },
  partial: { tone: "trigger", label: "Partial history", bg: "bg-[var(--trigger-soft)]", text: "text-trigger", border: "border-[color-mix(in_oklab,var(--trigger)_35%,transparent)]" },
  none: { tone: "short", label: "Not meaningful", bg: "bg-[var(--short-soft)]", text: "text-short", border: "border-[color-mix(in_oklab,var(--short)_35%,transparent)]" },
} as const;

const STATUS_TONE: Record<CoverageStatus, "long" | "trigger" | "short" | "neutral" | "signal"> = {
  historical: "long",
  partial: "trigger",
  unknown: "short",
  engine: "signal",
  unused: "neutral",
};

function Segmented<T extends string | number>({ value, options, onChange, label, render }: { value: T; options: readonly T[]; onChange: (v: T) => void; label: string; render?: (v: T) => ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid h-9 auto-cols-fr grid-flow-col rounded-xl border border-line bg-paper p-1">
      {options.map((o) => (
        <button
          key={String(o)}
          role="radio"
          aria-checked={value === o}
          onClick={() => onChange(o)}
          className={`rounded-lg px-2.5 font-mono text-[11.5px] transition-colors ${value === o ? "bg-ink text-paper" : "text-ink-2 hover:text-ink"}`}
        >
          {render ? render(o) : String(o)}
        </button>
      ))}
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "long" | "short" }) {
  return (
    <div className="min-w-0 rounded-2xl border border-line bg-card-2 p-3.5">
      <div className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className={`tnum mt-1.5 truncate font-mono text-[19px] tracking-[-0.02em] ${tone === "long" ? "text-long" : tone === "short" ? "text-short" : "text-ink"}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11.5px] text-faint">{sub}</div>}
    </div>
  );
}

function Icon({ quality }: { quality: BacktestResult["coverage"]["quality"] }) {
  const d = quality === "full" ? "M5 10.5l3 3 7-7" : quality === "partial" ? "M10 6v5M10 14h.01" : "M7 7l6 6M13 7l-6 6";
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="10" cy="10" r="8.2" strokeWidth="1.6" />
      <path d={d} />
    </svg>
  );
}

/**
 * "How would this strategy have done?" Runs POST /backtest (same engine via
 * replay(), historical candles + funding) and shows stats, the equity curve,
 * fills and, prominently, which data was historical vs unknown.
 */
export function BacktestPanel({ strategy, strategyId, allocationUsd = 10_000 }: { strategy?: Strategy; strategyId?: string; allocationUsd?: number }) {
  const [days, setDays] = useState<number>(30);
  const [interval, setInterval] = useState<BacktestInterval>("1h");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // A different strategy invalidates the last result.
  const identity = strategyId ?? (strategy ? JSON.stringify(strategy) : "");
  useEffect(() => {
    abort.current?.abort();
    setResult(null);
    setError(null);
    setBusy(false);
  }, [identity]);
  useEffect(() => () => abort.current?.abort(), []);

  const requireAuth = useRequireAuth();
  const run = async () => {
    if (!requireAuth()) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    setError(null);
    try {
      const r = await api.backtest({ strategy: strategyId ? undefined : strategy, strategyId, days, interval, allocationUsd }, ctrl.signal);
      if (!ctrl.signal.aborted) setResult(r);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof ApiError && e.issues?.length ? e.issues.map((i) => `${i.path}: ${i.message}`).join("\n") : (e as Error).message);
    } finally {
      if (abort.current === ctrl) setBusy(false);
    }
  };

  const r = result;
  const q = r ? QUALITY[r.coverage.quality] : null;
  const s = r?.stats;
  const entryFires = r ? r.coverage.triggers.filter((t) => t.entry).reduce((n, t) => n + t.fires, 0) : 0;

  return (
    <Card className="overflow-hidden" >
      <div className="flex flex-col gap-4 border-b border-line p-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-[15px] font-semibold tracking-[-0.02em]">Backtest</div>
            <Pill tone="signal">Same engine</Pill>
          </div>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-ink-2">
            How would this strategy have done? Replays real history through the live engine: fees, slippage, funding, stops and risk checks included.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">Last</span>
            <Segmented label="Lookback" value={days} options={DAY_PRESETS} onChange={setDays} render={(d) => `${d}d`} />
          </div>
          <div className="flex items-center gap-2 sm:ml-1">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">Bars</span>
            <Segmented label="Bar size" value={interval} options={INTERVALS} onChange={setInterval} />
          </div>
          <Btn onClick={run} disabled={busy || (!strategy && !strategyId)} className="h-9 w-full min-w-[124px] sm:ml-auto sm:w-auto" variant="ink">
            {busy ? (
              <>
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-paper/30 border-t-paper" aria-hidden />
                Running
              </>
            ) : r ? (
              "Run again"
            ) : (
              "Run backtest"
            )}
          </Btn>
        </div>
      </div>

      <div className="p-5">
        {error && <pre className="mb-4 whitespace-pre-wrap rounded-xl bg-[var(--short-soft)] p-3 font-mono text-[11.5px] text-short">{error}</pre>}

        {!r && !busy && (
          <div className="dot-grid grid place-items-center rounded-2xl border border-dashed border-line-2 px-6 py-10 text-center">
            <div className="max-w-sm">
              <div className="text-[15px] font-semibold tracking-[-0.02em]">Run it over the last {days} days</div>
              <p className="mt-1 text-[13px] text-ink-2">
                Uses Hyperliquid candles and funding (perps, stocks, spot) and GeckoTerminal for Solana tokens. You’ll see exactly which signals had history.
              </p>
            </div>
          </div>
        )}

        {busy && !r && (
          <div className="space-y-3" aria-live="polite">
            <div className="h-14 animate-pulse rounded-2xl bg-paper-2" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-[78px] animate-pulse rounded-2xl bg-paper-2" />)}
            </div>
            <div className="h-[180px] animate-pulse rounded-2xl bg-paper-2" />
            <div className="shimmer-text text-center font-mono text-[11px]">Fetching history and replaying {days} days…</div>
          </div>
        )}

        <AnimatePresence mode="wait">
          {r && s && q && (
            <motion.div key={`${r.period.end}-${r.period.frames}-${r.interval}-${days}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: busy ? 0.55 : 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-4">
              {/* Coverage: the honest headline */}
              <div className={`rounded-2xl border ${q.border} ${q.bg} p-4`} role="status">
                <div className={`flex items-start gap-2.5 ${q.text}`}>
                  <span className="mt-0.5 shrink-0"><Icon quality={r.coverage.quality} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-[10.5px] uppercase tracking-[0.14em]">{q.label}</span>
                      <span className="font-mono text-[10.5px] text-muted">
                        {fmtDay(r.period.start)} – {fmtDay(r.period.end)} · {r.period.frames.toLocaleString()} × {r.interval} bars
                      </span>
                    </div>
                    <p className="mt-1 text-[14px] font-medium leading-snug text-ink">{r.coverage.note}</p>
                    {r.coverage.notes.length > 0 && (
                      <ul className="mt-2 space-y-1 text-[12.5px] leading-relaxed text-ink-2">
                        {r.coverage.notes.map((n) => <li key={n}>• {n}</li>)}
                      </ul>
                    )}
                    <button onClick={() => setShowDetails((v) => !v)} className="mt-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted hover:text-ink" aria-expanded={showDetails}>
                      {showDetails ? "Hide data sources" : "Show data sources"}
                    </button>
                  </div>
                </div>
                {showDetails && (
                  <div className="mt-3 grid gap-3 border-t border-line pt-3 md:grid-cols-2">
                    <div>
                      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Signals</div>
                      <ul className="mt-1.5 space-y-1.5">
                        {r.coverage.signals.map((x) => (
                          <li key={x.id} className="flex items-start gap-2 text-[12.5px]">
                            <Pill tone={STATUS_TONE[x.status]}>{x.status === "engine" ? "engine" : x.status}</Pill>
                            <span className="min-w-0">
                              <span className="font-medium text-ink">{x.label}</span> <span className="font-mono text-[11px] text-faint">{x.kind}</span>
                              {x.fields.some((f) => f.availability > 0 && f.availability < 0.95) && (
                                <span className="text-faint"> · {x.fields.map((f) => `${f.field} ${Math.round(f.availability * 100)}%`).join(", ")}</span>
                              )}
                              {x.note && <span className="block text-[11.5px] text-ink-2">{x.note}</span>}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Markets</div>
                      <ul className="mt-1.5 space-y-1.5">
                        {r.coverage.instruments.map((x) => (
                          <li key={x.key} className="flex items-start gap-2 text-[12.5px]">
                            <Pill tone={x.status === "historical" ? "long" : "short"}>{x.status === "historical" ? "history" : x.status.replace("_", " ")}</Pill>
                            <span className="min-w-0">
                              <span className="font-medium text-ink">{x.label}</span> <span className="font-mono text-[11px] text-faint">{x.role}</span>
                              <span className="block break-all text-[11.5px] text-ink-2">
                                {x.status === "historical" ? `${x.bars != null ? `${x.bars.toLocaleString()} bars · ` : ""}${x.source ?? ""}` : x.reason}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              </div>

              {/* Stats */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Tile label="Return" value={fmtPct(s.returnPct)} tone={s.returnPct > 0 ? "long" : s.returnPct < 0 ? "short" : undefined} sub={`${fmtUsd(s.endEquityUsd, 0)} end equity`} />
                <Tile label="Max drawdown" value={s.maxDrawdownPct > 0 ? `−${s.maxDrawdownPct.toFixed(2)}%` : "0.00%"} tone={s.maxDrawdownPct > 0 ? "short" : undefined} sub="peak to trough" />
                <Tile label="Trades" value={s.trades} sub={s.winRatePct != null ? `${s.winRatePct.toFixed(0)}% win rate` : s.openPositions ? `${s.openPositions} still open` : "no closed trades"} />
                <Tile label="Fees" value={fmtUsd(s.feesUsd, 2)} sub="venue + builder" />
                <Tile label="Funding" value={fmtUsd(Math.abs(s.fundingUsd) < 0.005 ? 0 : -s.fundingUsd, 2)} tone={s.fundingUsd > 0.005 ? "short" : s.fundingUsd < -0.005 ? "long" : undefined} sub={s.fundingUsd > 0.005 ? "paid" : s.fundingUsd < -0.005 ? "received" : "none"} />
                <Tile label="Exposure" value={`${s.exposurePct.toFixed(1)}%`} sub="time in market" />
              </div>

              {/* Equity */}
              <div className="rounded-2xl border border-line p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[13.5px] font-semibold tracking-[-0.01em]">Equity</div>
                  <div className="flex flex-wrap gap-1.5">
                    {r.coverage.triggers.map((t) => (
                      <Pill key={t.id} tone={t.fires ? "trigger" : "neutral"}>
                        {t.label} · {t.fires}×
                      </Pill>
                    ))}
                  </div>
                </div>
                <EquityChart points={r.equityCurve} base={r.allocationUsd} formatTime={fmtDayTime} emptyLabel="No equity samples" />
                <div className="mt-1.5 flex justify-between font-mono text-[10.5px] text-faint">
                  <span>{fmtDay(r.period.start)}</span>
                  <span>{entryFires ? `${entryFires} entry signal${entryFires === 1 ? "" : "s"}` : "no entry signals"}</span>
                  <span>{fmtDay(r.period.end)}</span>
                </div>
              </div>

              {/* Fills */}
              <div className="overflow-hidden rounded-2xl border border-line">
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                  <div className="text-[13.5px] font-semibold tracking-[-0.01em]">Fills</div>
                  <span className="font-mono text-[11px] text-faint">
                    {r.fills.length}
                    {r.fillsTruncated ? "+ (latest shown)" : ""}
                  </span>
                </div>
                {r.fills.length === 0 ? (
                  <div className="px-4 py-6 text-center text-[13px] text-ink-2">No fills in this period.</div>
                ) : (
                  <div className="max-h-[300px] overflow-auto">
                    <table className="w-full min-w-[560px] text-left text-[12.5px]">
                      <thead className="sticky top-0 bg-card font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                        <tr className="border-b border-line">
                          <th className="px-4 py-2 font-normal">Time</th>
                          <th className="px-2 py-2 font-normal">Side</th>
                          <th className="px-2 py-2 font-normal">Market</th>
                          <th className="px-2 py-2 text-right font-normal">Price</th>
                          <th className="px-2 py-2 font-normal">Reason</th>
                          <th className="px-4 py-2 text-right font-normal">P&amp;L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...r.fills].reverse().map((f, i) => (
                          <tr key={`${f.ts}-${i}`} className="border-b border-line last:border-0">
                            <td className="whitespace-nowrap px-4 py-2 font-mono text-faint">{fmtDayTime(f.ts)}</td>
                            <td className="px-2 py-2"><Pill tone={f.side === "buy" ? "long" : "short"}>{f.side}</Pill></td>
                            <td className="max-w-[180px] truncate px-2 py-2 font-mono text-ink-2" title={f.instrumentKey}>{f.label}</td>
                            <td className="tnum px-2 py-2 text-right font-mono">{fmtPrice(f.price)}</td>
                            <td className="px-2 py-2 font-mono text-[11px] text-muted">{f.reason.replace(/_/g, " ")}</td>
                            <td className={`tnum whitespace-nowrap px-4 py-2 text-right font-mono ${f.realizedPnlUsd == null ? "text-faint" : f.realizedPnlUsd >= 0 ? "text-long" : "text-short"}`}>
                              {f.realizedPnlUsd == null ? `fee ${fmtUsd(f.feeUsd, 2)}` : fmtUsd(f.realizedPnlUsd, 2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <p className="font-mono text-[10.5px] leading-relaxed text-faint">
                Simulated on {fmtUsd(r.allocationUsd, 0)} · {r.period.days.toFixed(r.period.days < 10 ? 1 : 0)} days · history {(r.timing.historyMs / 1000).toFixed(1)}s, replay {(r.timing.replayMs / 1000).toFixed(1)}s. Past results don’t predict future returns.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Card>
  );
}
