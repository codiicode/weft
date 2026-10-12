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
import { PageHeader, Card, Btn, Pill, Stat, Empty } from "@/components/app/AppShell";
import { StrategyCanvas } from "@/components/app/StrategyCanvas";
import { EquityChart } from "@/components/app/EquityChart";

const EVENT_TONE: Record<string, string> = {
  fill: "text-long",
  trigger_fired: "text-trigger",
  trigger_met: "text-trigger",
  rejected: "text-short",
  error: "text-short",
  warning: "text-trigger",
  notify: "text-signal",
  intent: "text-ink",
  status: "text-ink-2",
  tick: "text-faint",
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
      className="relative inline-flex h-10 select-none items-center gap-2 overflow-hidden rounded-full bg-[var(--short-soft)] px-4 text-[14px] font-medium text-short"
      aria-label="Hold to kill: closes every position"
    >
      <span className="absolute inset-y-0 left-0 bg-short/25" style={{ width: `${p * 100}%` }} />
      <span className="relative">Hold to kill</span>
    </button>
  );
}

function Run() {
  const id = useSearchParams().get("id") ?? "";
  const snap = useApi(id ? () => api.deployment(id) : null, [id], { pollMs: 4_000 });
  const fills = useApi(id ? () => api.fills(id) : null, [id], { pollMs: 8_000 });
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [showTicks, setShowTicks] = useState(false);
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
        {snap.error ? <Empty title="Couldn't load this run" sub={snap.error.message} action={<Btn href="/app/runs">All runs</Btn>} /> : <div className="h-64 animate-pulse rounded-[20px] bg-paper-2" />}
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

  return (
    <>
      <PageHeader
        eyebrow={`Paper run · ${d.id}`}
        title={d.strategy.name}
        sub={<span className="italic">“{d.strategy.thesis}”</span>}
        actions={
          <>
            <Pill tone={status === "running" ? "long" : status === "killed" ? "short" : "neutral"}>
              {status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-long" />}
              {status}
            </Pill>
            {status === "running" && <Btn variant="ghost" onClick={() => control("pause")}>Pause</Btn>}
            {status === "paused" && <Btn variant="ghost" onClick={() => control("resume")}>Resume</Btn>}
            {(status === "running" || status === "paused") && <Btn variant="ghost" onClick={() => control("tick")}>Run tick now</Btn>}
            {(status === "running" || status === "paused") && <HoldToKill onKill={() => control("kill")} />}
          </>
        }
      />
      <div className="space-y-6 px-5 py-6 lg:px-10">
        {controlError && <Card className="p-3 text-[13px] text-short">{controlError}</Card>}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Equity" value={fmtUsd(s.equityUsd, 2)} sub={`of ${fmtUsd(d.allocationUsd, 0)} allocated`} />
          <Stat label="Return" value={fmtPct(s.returnPct)} tone={s.returnPct > 0 ? "long" : s.returnPct < 0 ? "short" : undefined} />
          <Stat label="Unrealized" value={fmtUsd(s.unrealizedPnlUsd, 2)} tone={s.unrealizedPnlUsd > 0 ? "long" : s.unrealizedPnlUsd < 0 ? "short" : undefined} />
          <Stat label="Realized" value={fmtUsd(s.realizedPnlUsd, 2)} tone={s.realizedPnlUsd > 0 ? "long" : s.realizedPnlUsd < 0 ? "short" : undefined} />
          <Stat label="Last check" value={ago(s.lastTickAt)} sub={`every ${d.intervalSec}s${s.builderFeesUsd != null ? ` · fees ${fmtUsd(s.builderFeesUsd, 2)}` : ""}`} />
        </div>

        <StrategyCanvas strategy={d.strategy} live={live} animate={false} />

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className="min-w-0 space-y-6">
            <Card className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-[15px] font-semibold tracking-[-0.02em]">Equity</div>
                <span className="font-mono text-[11px] text-faint">{s.equityCurve.length} samples</span>
              </div>
              <EquityChart points={s.equityCurve} base={d.allocationUsd} />
            </Card>

            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-line px-5 py-4">
                <div className="text-[15px] font-semibold tracking-[-0.02em]">Open positions</div>
                <span className="font-mono text-[11px] text-faint">{s.positions.length}</span>
              </div>
              {s.positions.length === 0 ? (
                <div className="px-5 py-8 text-center text-[13.5px] text-ink-2">No open positions. The agent is waiting for its triggers.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] text-left text-[13px]">
                    <thead className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">
                      <tr className="border-b border-line">
                        <th className="px-5 py-2.5 font-normal">Instrument</th>
                        <th className="px-3 py-2.5 font-normal">Side</th>
                        <th className="px-3 py-2.5 text-right font-normal">Size</th>
                        <th className="px-3 py-2.5 text-right font-normal">Entry</th>
                        <th className="px-3 py-2.5 text-right font-normal">Mark</th>
                        <th className="px-3 py-2.5 text-right font-normal">Liq.</th>
                        <th className="px-3 py-2.5 text-right font-normal">Funding</th>
                        <th className="px-5 py-2.5 text-right font-normal">P&amp;L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.positions.map((p) => (
                        <tr key={p.id} className="border-b border-line last:border-0">
                          <td className="px-5 py-3 font-medium">{instrumentLabel(p.instrument)}</td>
                          <td className="px-3 py-3"><Pill tone={p.side === "long" ? "long" : "short"}>{p.side}{p.leverage > 1 ? ` ${p.leverage}×` : ""}</Pill></td>
                          <td className="tnum px-3 py-3 text-right font-mono">{fmtUsd(p.sizeUsd, 2)}</td>
                          <td className="tnum px-3 py-3 text-right font-mono">{fmtPrice(p.entryPrice)}</td>
                          <td className="tnum px-3 py-3 text-right font-mono">{fmtPrice(p.markPrice)}</td>
                          <td className="tnum px-3 py-3 text-right font-mono text-short/80">{p.liquidationPrice ? fmtPrice(p.liquidationPrice) : "—"}</td>
                          <td className={`tnum px-3 py-3 text-right font-mono ${(p.fundingPaidUsd ?? 0) > 0 ? "text-short" : "text-ink-2"}`}>{p.fundingPaidUsd != null ? fmtUsd(-p.fundingPaidUsd, 2) : "—"}</td>
                          <td className={`tnum px-5 py-3 text-right font-mono ${p.unrealizedPnlUsd >= 0 ? "text-long" : "text-short"}`}>
                            {fmtUsd(p.unrealizedPnlUsd, 2)} <span className="text-[11px]">({fmtPct(p.unrealizedPnlPct)})</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card className="overflow-hidden">
              <div className="border-b border-line px-5 py-4 text-[15px] font-semibold tracking-[-0.02em]">Fills</div>
              {(fills.data?.fills ?? []).length === 0 ? (
                <div className="px-5 py-8 text-center text-[13.5px] text-ink-2">No fills yet.</div>
              ) : (
                <div className="max-h-[360px] overflow-auto">
                  <table className="w-full min-w-[600px] text-left text-[12.5px]">
                    <tbody>
                      {[...(fills.data?.fills ?? [])].reverse().map((f) => (
                        <tr key={f.id} className="border-b border-line last:border-0">
                          <td className="px-5 py-2.5 font-mono text-faint">{new Date(f.ts).toLocaleTimeString()}</td>
                          <td className="px-3 py-2.5"><Pill tone={f.side === "buy" ? "long" : "short"}>{f.side}</Pill></td>
                          <td className="px-3 py-2.5 font-mono text-ink-2">{f.instrumentKey.split(":").slice(-1)[0]?.slice(0, 18)}</td>
                          <td className="tnum px-3 py-2.5 text-right font-mono">{fmtPrice(f.price)}</td>
                          <td className="px-3 py-2.5 font-mono text-[11px] text-muted">{f.reason.replace("_", " ")}</td>
                          <td className={`tnum px-5 py-2.5 text-right font-mono ${f.realizedPnlUsd == null ? "text-faint" : f.realizedPnlUsd >= 0 ? "text-long" : "text-short"}`}>
                            {f.realizedPnlUsd == null ? `fee ${fmtUsd(f.feeUsd, 2)}` : fmtUsd(f.realizedPnlUsd, 2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <Card className="flex max-h-[880px] flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <div className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.02em]">
                <span className="relative flex h-2 w-2"><span className="pulse-ring absolute inset-0 rounded-full bg-volt" /><span className="relative h-2 w-2 rounded-full bg-volt" /></span>
                Execution log
              </div>
              <label className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted">
                <input type="checkbox" checked={showTicks} onChange={(e) => setShowTicks(e.target.checked)} /> ticks
              </label>
            </div>
            <div className="flex-1 overflow-auto bg-[#0b0c0f] p-4 font-mono text-[11.5px] leading-[1.75] text-[#e9e7e2]">
              <AnimatePresence initial={false}>
                {shown.slice(0, 200).map((e) => (
                  <motion.div key={e.id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex gap-3">
                    <span className="shrink-0 text-[#6e717a]">{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span>
                    <span className={`w-[78px] shrink-0 uppercase ${EVENT_TONE[e.type] ?? "text-[#9a9da5]"}`} style={{ color: e.type === "tick" ? "#6e717a" : undefined }}>
                      {e.type.replace("_", " ")}
                    </span>
                    <span className="min-w-0 break-words">{e.message}</span>
                  </motion.div>
                ))}
              </AnimatePresence>
              {shown.length === 0 && <div className="text-[#6e717a]">Waiting for the first tick…</div>}
            </div>
          </Card>
        </div>

        <div className="flex flex-wrap gap-3 font-mono text-[11px] text-faint">
          <Link href="/app/runs" className="hover:text-ink">← All runs</Link>
          <span>Paper trading with live prices. Not financial advice.</span>
        </div>
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
