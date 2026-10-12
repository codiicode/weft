"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import type { EngineEvent } from "@weft/engine";
import { instrumentLabel } from "@weft/strategy";
import { api } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { useApi, fmtUsd, fmtPct, fmtPrice, ago } from "@/lib/use-api";
import { PageHeader, Card, Btn, Stat, Empty } from "@/components/app/AppShell";
import { RunStatus } from "@/components/app/RunCard";
import { StrategyRules } from "@/components/app/StrategyRules";
import { StrategyCanvas } from "@/components/app/StrategyCanvas";
import { EquityChart } from "@/components/app/EquityChart";

const EVENT: Record<string, [label: string, color: string]> = {
  fill: ["Trade", "var(--long)"],
  trigger_fired: ["Rule fired", "var(--trigger)"],
  trigger_met: ["Conditions met", "var(--trigger)"],
  rejected: ["Blocked", "var(--short)"],
  error: ["Error", "var(--short)"],
  warning: ["Warning", "var(--trigger)"],
  notify: ["Alert", "var(--signal)"],
  intent: ["Order", "var(--ink)"],
  status: ["Status", "var(--muted)"],
  tick: ["Check", "var(--line-2)"],
};

function HoldToKill({ onKill }: { onKill: () => void }) {
  const [p, setP] = useState(0);
  const timer = useRef<number | null>(null);
  const start = () => {
    const t0 = performance.now();
    const step = () => {
      const v = Math.min(1, (performance.now() - t0) / 1100);
      setP(v);
      if (v >= 1) {
        onKill();
        setP(0);
        return;
      }
      timer.current = requestAnimationFrame(step);
    };
    timer.current = requestAnimationFrame(step);
  };
  const cancel = () => {
    if (timer.current) cancelAnimationFrame(timer.current);
    setP(0);
  };
  return (
    <button
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onKeyDown={(e) => (e.key === " " || e.key === "Enter") && !e.repeat && start()}
      onKeyUp={cancel}
      className="relative inline-flex h-9 select-none items-center gap-2 overflow-hidden rounded-[10px] border border-[color-mix(in_oklab,var(--short)_35%,transparent)] px-3.5 text-[14px] font-medium text-short"
      aria-label="Hold to stop: closes every position and cancels every order"
      title="Hold for a second: closes every position and cancels every order"
    >
      <span className="absolute inset-y-0 left-0 bg-[var(--short-soft)]" style={{ width: `${p * 100}%` }} />
      <span className="relative">{p > 0 ? "Keep holding…" : "Hold to stop"}</span>
    </button>
  );
}

function Run() {
  const id = useSearchParams().get("id") ?? "";
  const snap = useApi(id ? () => api.deployment(id) : null, [id], { pollMs: 4_000 });
  const fills = useApi(id ? () => api.fills(id) : null, [id], { pollMs: 8_000 });
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [showTicks, setShowTicks] = useState(false);
  const [view, setView] = useState<"rules" | "graph">("rules");
  const [controlError, setControlError] = useState<string | null>(null);
  const requireAuth = useRequireAuth();

  useEffect(() => {
    if (!id) return;
    let alive = true;
    api.events(id).then((r) => alive && setEvents(r.events.slice(-200).reverse())).catch(() => {});
    const unsub = api.subscribe((e) => {
      setEvents((prev) => [e, ...prev].slice(0, 300));
      if (e.type === "fill" || e.type === "trigger_fired" || e.type === "status") {
        snap.refresh();
        fills.refresh();
      }
    }, id);
    return () => {
      alive = false;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const s = snap.data;
  const live = useMemo(
    () =>
      s
        ? {
            signalValues: s.signalValues,
            triggers: s.triggers.map((t) => ({ id: t.id, met: t.met })),
            positions: s.positions.map((p) => ({ actionId: p.actionId, unrealizedPnlPct: p.unrealizedPnlPct })),
            firedActions: [
              ...new Set(
                events
                  .filter((e) => e.type === "fill" || e.type === "notify" || e.type === "intent")
                  .map((e) => (e.data as { actionId?: string } | undefined)?.actionId)
                  .filter((x): x is string => !!x)
              ),
            ],
          }
        : undefined,
    [s, events]
  );

  if (!id) return <div className="p-10"><Empty title="No run selected" action={<Btn href="/app/runs">All runs</Btn>} /></div>;
  if (!s) {
    return (
      <div className="p-10">
        {snap.error ? <Empty title="Couldn’t load this run" sub={snap.error.message} action={<Btn href="/app/runs">All runs</Btn>} /> : <div className="h-64 animate-pulse rounded-[12px] bg-paper-2" />}
      </div>
    );
  }

  const d = s.deployment;
  const status = d.status;
  const control = async (a: "pause" | "resume" | "stop" | "kill" | "tick") => {
    if (!requireAuth()) return;
    setControlError(null);
    try {
      await api.control(id, a);
    } catch (e) {
      setControlError((e as { status?: number }).status === 403 ? "Only the owner of this run can control it." : (e as Error).message);
      return;
    }
    snap.refresh();
    fills.refresh();
  };
  const shown = showTicks ? events : events.filter((e) => e.type !== "tick");

  const metMap = Object.fromEntries(s.triggers.map((t) => [t.id, t.met]));
  const tone = (v: number) => (v > 0 ? "long" : v < 0 ? "short" : undefined);
  const fillList = [...(fills.data?.fills ?? [])].reverse();

  return (
    <>
      <PageHeader
        back={{ href: "/app/runs", label: "Runs" }}
        title={d.strategy.name}
        sub={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <RunStatus s={s} />
            <span className="text-faint">·</span>
            <span>checks every {d.intervalSec < 60 ? `${d.intervalSec} s` : `${d.intervalSec / 60} min`}</span>
          </span>
        }
        actions={
          <>
            {(status === "running" || status === "paused") && (
              <Btn variant="quiet" onClick={() => control("tick")}>
                Check now
              </Btn>
            )}
            {status === "running" && (
              <Btn variant="ghost" onClick={() => control("pause")}>
                Pause
              </Btn>
            )}
            {status === "paused" && (
              <Btn variant="ghost" onClick={() => control("resume")}>
                Resume
              </Btn>
            )}
            {(status === "running" || status === "paused") && <HoldToKill onKill={() => control("kill")} />}
          </>
        }
      />
      <div className="space-y-8 px-5 pb-16 pt-6 lg:px-10">
        {d.mode === "live" && (
          <div className="rounded-[12px] bg-[var(--short-soft)] px-4 py-3 text-[14px] text-short">This run places real orders from your Hyperliquid account.</div>
        )}
        {controlError && <div className="rounded-[12px] bg-[var(--short-soft)] px-4 py-3 text-[14px] text-short">{controlError}</div>}

        <div className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line py-5 sm:grid-cols-5">
          <Stat label="Value" value={fmtUsd(s.equityUsd, 2)} sub={`started with ${fmtUsd(d.allocationUsd, 0)}`} />
          <Stat label="Return" value={fmtPct(s.returnPct)} tone={tone(s.returnPct)} />
          <Stat label="Open profit" value={fmtUsd(s.unrealizedPnlUsd, 2)} tone={tone(s.unrealizedPnlUsd)} />
          <Stat label="Closed profit" value={fmtUsd(s.realizedPnlUsd, 2)} tone={tone(s.realizedPnlUsd)} />
          <Stat label="Last check" value={ago(s.lastTickAt)} sub={s.builderFeesUsd ? `fees ${fmtUsd(s.builderFeesUsd, 2)}` : undefined} />
        </div>

        <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 space-y-8">
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[15px] font-semibold text-ink">Rules</h2>
                <div className="flex gap-1">
                  {(
                    [
                      ["rules", "Text"],
                      ["graph", "Diagram"],
                    ] as const
                  ).map(([k, l]) => (
                    <button
                      key={k}
                      onClick={() => setView(k)}
                      className={`h-7 rounded-[7px] px-2.5 text-[13px] ${view === k ? "bg-paper-2 font-medium text-ink" : "text-muted hover:text-ink"}`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              {view === "rules" ? <StrategyRules strategy={d.strategy} met={metMap} /> : <StrategyCanvas strategy={d.strategy} live={live} animate={false} />}
            </section>

            <section>
              <h2 className="mb-3 text-[15px] font-semibold text-ink">Value over time</h2>
              <Card className="p-5">
                <EquityChart points={s.equityCurve} base={d.allocationUsd} />
              </Card>
            </section>

            <section>
              <h2 className="mb-3 text-[15px] font-semibold text-ink">
                Open positions <span className="font-normal text-muted">{s.positions.length || ""}</span>
              </h2>
              <Card className="overflow-hidden">
                {s.positions.length === 0 ? (
                  <p className="px-5 py-8 text-center text-[14px] text-muted">No open positions. It’s waiting for a rule to fire.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[680px] text-left text-[13.5px]">
                      <thead className="text-[12.5px] text-muted">
                        <tr className="border-b border-line">
                          <th className="px-5 py-2.5 font-normal">Market</th>
                          <th className="px-3 py-2.5 font-normal">Side</th>
                          <th className="px-3 py-2.5 text-right font-normal">Size</th>
                          <th className="px-3 py-2.5 text-right font-normal">Entry</th>
                          <th className="px-3 py-2.5 text-right font-normal">Now</th>
                          <th className="px-3 py-2.5 text-right font-normal">Liquidation</th>
                          <th className="px-5 py-2.5 text-right font-normal">Profit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.positions.map((p) => (
                          <tr key={p.id} className="border-b border-line last:border-0">
                            <td className="px-5 py-3 font-medium text-ink">{instrumentLabel(p.instrument)}</td>
                            <td className={`px-3 py-3 ${p.side === "long" ? "text-long" : "text-short"}`}>
                              {p.side === "long" ? "Long" : "Short"}
                              {p.leverage > 1 ? <span className="text-muted"> {p.leverage}×</span> : null}
                            </td>
                            <td className="tnum px-3 py-3 text-right">{fmtUsd(p.sizeUsd, 2)}</td>
                            <td className="tnum px-3 py-3 text-right text-ink-2">{fmtPrice(p.entryPrice)}</td>
                            <td className="tnum px-3 py-3 text-right">{fmtPrice(p.markPrice)}</td>
                            <td className="tnum px-3 py-3 text-right text-ink-2">{p.liquidationPrice ? fmtPrice(p.liquidationPrice) : "—"}</td>
                            <td className={`tnum px-5 py-3 text-right ${p.unrealizedPnlUsd >= 0 ? "text-long" : "text-short"}`}>
                              {fmtUsd(p.unrealizedPnlUsd, 2)} <span className="text-[12px] opacity-80">{fmtPct(p.unrealizedPnlPct)}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </section>

            <section>
              <h2 className="mb-3 text-[15px] font-semibold text-ink">
                Trades <span className="font-normal text-muted">{fillList.length || ""}</span>
              </h2>
              <Card className="overflow-hidden">
                {fillList.length === 0 ? (
                  <p className="px-5 py-8 text-center text-[14px] text-muted">No trades yet.</p>
                ) : (
                  <div className="max-h-[360px] overflow-auto">
                    <table className="w-full min-w-[560px] text-left text-[13.5px]">
                      <tbody>
                        {fillList.map((f) => (
                          <tr key={f.id} className="border-b border-line last:border-0">
                            <td className="tnum px-5 py-2.5 text-muted">{new Date(f.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                            <td className={`px-3 py-2.5 ${f.side === "buy" ? "text-long" : "text-short"}`}>{f.side === "buy" ? "Buy" : "Sell"}</td>
                            <td className="px-3 py-2.5 text-ink">{f.instrumentKey.split(":").slice(-1)[0]?.slice(0, 18)}</td>
                            <td className="tnum px-3 py-2.5 text-right">{fmtPrice(f.price)}</td>
                            <td className="px-3 py-2.5 text-muted">{f.reason.replaceAll("_", " ")}</td>
                            <td className={`tnum px-5 py-2.5 text-right ${f.realizedPnlUsd == null ? "text-muted" : f.realizedPnlUsd >= 0 ? "text-long" : "text-short"}`}>
                              {f.realizedPnlUsd == null ? `fee ${fmtUsd(f.feeUsd, 2)}` : fmtUsd(f.realizedPnlUsd, 2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </section>
          </div>

          <section className="min-w-0">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-ink">Activity</h2>
              <label className="flex items-center gap-1.5 text-[13px] text-muted">
                <input type="checkbox" checked={showTicks} onChange={(e) => setShowTicks(e.target.checked)} className="accent-[var(--ink)]" /> Show every check
              </label>
            </div>
            <Card className="max-h-[820px] overflow-auto">
              <ol className="divide-y divide-line">
                <AnimatePresence initial={false}>
                  {shown.slice(0, 200).map((e) => {
                    const [label, color] = EVENT[e.type] ?? [e.type, "var(--muted)"];
                    return (
                      <motion.li key={e.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="px-4 py-3">
                        <div className="flex items-center gap-2 text-[12.5px]">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                          <span className="font-medium text-ink-2">{label}</span>
                          <span className="tnum ml-auto text-faint">{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span>
                        </div>
                        <p className="mt-1 break-words pl-3.5 text-[13.5px] leading-relaxed text-ink">{e.message}</p>
                      </motion.li>
                    );
                  })}
                </AnimatePresence>
              </ol>
              {shown.length === 0 && <p className="px-4 py-8 text-center text-[14px] text-muted">Waiting for the first check…</p>}
            </Card>
          </section>
        </div>

        <p className="text-[12.5px] text-faint">{d.mode === "live" ? "Live trading on Hyperliquid through your agent." : "Paper trading with live prices."} Not financial advice.</p>
      </div>
    </>
  );
}

export default function RunPage() {
  return (
    <Suspense>
      <Run />
    </Suspense>
  );
}
