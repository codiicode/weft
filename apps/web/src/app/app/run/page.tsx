"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import type { EngineEvent } from "@weft/engine";
import { instrumentLabel } from "@weft/strategy";
import { api, type Snapshot } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { useApi, fmtUsd, fmtPct, fmtPrice, ago } from "@/lib/use-api";
import { PageHeader, Card, Btn, Stat, Empty } from "@/components/app/AppShell";
import { RunStatus } from "@/components/app/RunCard";
import { StrategyRules } from "@/components/app/StrategyRules";
import { AssetIcon } from "@/components/ui/AssetIcon";
import { instrumentIcon, strategyInstruments } from "@/lib/assets";
import { TradesChart } from "@/components/chart/TradesChart";
import { InstructRun, SellButton } from "@/components/app/RunControls";
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
  noop: ["Nothing to do", "var(--muted)"],
  status: ["Status", "var(--muted)"],
  tick: ["Check", "var(--line-2)"],
};

/**
 * One rule firing produces several engine events (conditions met, fired, the
 * order, its outcome). Keep only the most telling one per rule and moment.
 */
function condense(events: EngineEvent[]): EngineEvent[] {
  type D = { intentKey?: string; triggerId?: string; noop?: boolean; intent?: { key: string; triggerId: string }; fill?: { intentKey?: string } };
  const d = (e: EngineEvent) => (e.data ?? {}) as D;
  const isNoop = (e: EngineEvent) => e.type === "intent" && (d(e).noop || /nothing to close/i.test(e.message));
  const bucket = (ts: number) => Math.round(ts / 5000);
  const outcomes = new Set<string>();
  const acted = new Set<string>();
  const fired = new Set<string>();
  for (const e of events) {
    const x = d(e);
    if (e.type === "fill" && x.fill?.intentKey) outcomes.add(x.fill.intentKey);
    if ((e.type === "rejected" || isNoop(e)) && x.intentKey) outcomes.add(x.intentKey);
    const tid = x.intent?.triggerId ?? (isNoop(e) ? x.triggerId : undefined);
    if (tid) for (const k of [-1, 0, 1]) acted.add(`${tid}@${bucket(e.ts) + k}`);
    if (e.type === "trigger_fired" && x.triggerId) for (const k of [-1, 0, 1]) fired.add(`${x.triggerId}@${bucket(e.ts) + k}`);
  }
  return events.filter((e) => {
    const x = d(e);
    if (e.type === "intent" && x.intent && outcomes.has(x.intent.key)) return false;
    if ((e.type === "trigger_fired" || e.type === "trigger_met") && x.triggerId && acted.has(`${x.triggerId}@${bucket(e.ts)}`)) return false;
    if (e.type === "trigger_met" && x.triggerId && fired.has(`${x.triggerId}@${bucket(e.ts)}`)) return false;
    return true;
  });
}

/** Older engine events used raw ids; rewrite them with the names the page shows. */
function readable(msg: string, strategy: Snapshot["deployment"]["strategy"]): string {
  const rule = (id: string) => {
    const i = strategy.triggers.findIndex((t) => t.id === id);
    return i >= 0 ? `Rule ${i + 1}` : id.replaceAll("_", " ");
  };
  const token = (key: string) => {
    for (const a of strategy.actions) if (a.type === "open" && a.instrument.kind === "token" && key.endsWith(a.instrument.mint)) return a.label ?? instrumentLabel(a.instrument);
    const tail = key.split(":").pop() ?? key;
    return tail.length > 16 ? `${tail.slice(0, 4)}…${tail.slice(-4)}` : tail;
  };
  return msg
    .replace(/^Trigger "([^"]+)" is met$/, (_m, id: string) => `Conditions met: ${rule(id)}`)
    .replace(/^Trigger "([^"]+)" fired$/, (_m, id: string) => `${rule(id)} fired`)
    .replace(/\(trigger ([a-z0-9_-]+)\)/g, (_m, id: string) => `(${rule(id).toLowerCase()})`)
    .replace(/^[a-z0-9_-]+: nothing to close \(([^)]+)\)$/, (_m, k: string) => `Nothing to close: no open ${k === "all" ? "positions" : `${token(k)} position`}`)
    .replace(/^[a-z0-9_-]+: close ((?:sol|hl):\S+)/, (_m, k: string) => `Close ${token(k)}`)
    .replace(/^Tick: equity/, "Checked the market: value")
    .replace(/(?:sol|hl):(?:token|perp|spot):(\S+)/g, (m) => token(m));
}

/** Why a trade happened, in plain words. */
const REASON: Record<string, string> = {
  entry: "entry",
  manual: "you sold",
  stop_loss: "stop",
  take_profit: "target",
  trailing_stop: "trailing stop",
  time_exit: "time’s up",
  close_action: "rule",
  kill: "stopped",
  liquidation: "liquidated",
};

/** Real money notice, plus the owner's choice to show this run's return on the leaderboard. */
function ShareRow({ id, shared, onChange }: { id: string; shared: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState(shared);
  useEffect(() => setOn(shared), [shared]);
  const toggle = async () => {
    setBusy(true);
    try {
      await api.shareRun(id, !on);
      setOn(!on);
      onChange();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-line bg-card px-4 py-3 text-[14px] sm:flex-row sm:items-center sm:justify-between">
      <span className="text-ink-2">Trades with real money from your Hyperliquid account.</span>
      <button onClick={toggle} disabled={busy} role="switch" aria-checked={on} className="inline-flex items-center gap-2.5 text-[13.5px] text-ink-2 hover:text-ink disabled:opacity-60">
        <span className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-long" : "bg-line-2"}`}>
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] ${on ? "left-[18px]" : "left-0.5"}`} />
        </span>
        Show the return on the leaderboard
        <span className="text-faint">(percent only)</span>
      </button>
    </div>
  );
}

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
  // Owner actions on a live (or legacy) run that is still going. Alerts-only runs hold nothing.
  const canAct = (status === "running" || status === "paused") && !d.alertsOnly;
  const refreshAll = () => {
    void snap.refresh();
    fills.refresh();
  };
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
  const shown = condense(showTicks ? events : events.filter((e) => e.type !== "tick"));

  const metMap = Object.fromEntries(s.triggers.map((t) => [t.id, t.met]));
  const tone = (v: number) => (v > 0 ? "long" : v < 0 ? "short" : undefined);
  const fillList = [...(fills.data?.fills ?? [])].reverse();
  const quiet = s.positions.length === 0 && fillList.length === 0;

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
            <Btn variant="quiet" href={`/app/new?from=${encodeURIComponent(`run:${d.id}`)}`}>
              Edit a copy
            </Btn>
            {(status === "running" || status === "paused") && (
              <Btn variant="quiet" onClick={() => control("tick")} className="max-sm:hidden">
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
        {d.mode === "live" && <ShareRow id={d.id} shared={Boolean(s.shared)} onChange={() => snap.refresh()} />}
        {d.mode === "paper" && !d.alertsOnly && (
          <div className="rounded-[12px] border border-line bg-card px-4 py-3 text-[14px] text-ink-2">
            A paper run from before Weft traded with real money. Its history stays here.{" "}
            <Link href={`/app/new?from=${encodeURIComponent(`run:${d.id}`)}`} className="text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">
              Start this strategy for real
            </Link>
          </div>
        )}
        {controlError && <div className="rounded-[12px] bg-[var(--short-soft)] px-4 py-3 text-[14px] text-short">{controlError}</div>}

        {d.alertsOnly && (
          <div className="rounded-[12px] border border-line bg-card px-4 py-3 text-[14px] text-ink-2">
            Alerts only. This run never trades: when a rule would buy or sell, you get a message instead.{" "}
            <Link href="/app/settings" className="text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">
              Alert settings
            </Link>
          </div>
        )}
        <div className={`grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line py-5 sm:grid-cols-5 ${d.alertsOnly ? "hidden" : ""}`}>
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
                <h2 className="text-[15px] font-semibold text-ink">How it trades</h2>
                <div role="tablist" className="flex gap-4 text-[13.5px]">
                  {(
                    [
                      ["rules", "Rules"],
                      ["graph", "Diagram"],
                    ] as const
                  ).map(([k, l]) => (
                    <button
                      key={k}
                      role="tab"
                      aria-selected={view === k}
                      onClick={() => setView(k)}
                      className={`border-b-2 pb-1 transition-colors ${view === k ? "border-ink font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              {view === "rules" ? <StrategyRules strategy={d.strategy} met={metMap} /> : <StrategyCanvas strategy={d.strategy} live={live} animate={false} />}
            </section>

            {canAct && (
              <section>
                <InstructRun deploymentId={d.id} onDone={refreshAll} />
              </section>
            )}

            <section>
              <h2 className="mb-3 text-[15px] font-semibold text-ink">The market</h2>
              <Card className="p-5">
                <TradesChart instruments={strategyInstruments(d.strategy)} fills={fills.data?.fills ?? []} startedAt={d.createdAt} />
              </Card>
            </section>

            {quiet && !d.alertsOnly ? (
              <section>
                <Card className="px-5 py-10 text-center">
                  <p className="text-[14.5px] font-medium text-ink">Waiting for a rule to fire</p>
                  <p className="mt-1 text-[14px] text-muted">Trades, open positions and the value chart show up here once it trades.</p>
                </Card>
              </section>
            ) : (
              <>
            <section className={d.alertsOnly ? "hidden" : ""}>
              <h2 className="mb-3 text-[15px] font-semibold text-ink">Value over time</h2>
              <Card className="p-5">
                <EquityChart points={s.equityCurve} base={d.allocationUsd} />
              </Card>
            </section>

            <section className={d.alertsOnly ? "hidden" : ""}>
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
                          <th className="px-3 py-2.5 text-right font-normal">Profit</th>
                          {canAct && <th className="px-5 py-2.5" />}
                        </tr>
                      </thead>
                      <tbody>
                        {s.positions.map((p) => (
                          <tr key={p.id} className="border-b border-line last:border-0">
                            <td className="px-5 py-3 font-medium text-ink">
                              <span className="inline-flex items-center gap-2.5">
                                <AssetIcon {...instrumentIcon(p.instrument)} size={20} />
                                {instrumentLabel(p.instrument)}
                              </span>
                            </td>
                            <td className={`px-3 py-3 ${p.side === "long" ? "text-long" : "text-short"}`}>
                              {p.side === "long" ? "Long" : "Short"}
                              {p.leverage > 1 ? <span className="text-muted"> {p.leverage}×</span> : null}
                            </td>
                            <td className="tnum px-3 py-3 text-right">{fmtUsd(p.sizeUsd, 2)}</td>
                            <td className="tnum px-3 py-3 text-right text-ink-2">{fmtPrice(p.entryPrice)}</td>
                            <td className="tnum px-3 py-3 text-right">{fmtPrice(p.markPrice)}</td>
                            <td className="tnum px-3 py-3 text-right text-ink-2">{p.liquidationPrice ? fmtPrice(p.liquidationPrice) : "—"}</td>
                            <td className={`tnum px-3 py-3 text-right ${p.unrealizedPnlUsd >= 0 ? "text-long" : "text-short"}`}>
                              {fmtUsd(p.unrealizedPnlUsd, 2)} <span className="text-[12px] opacity-80">{fmtPct(p.unrealizedPnlPct)}</span>
                            </td>
                            {canAct && (
                              <td className="px-5 py-3 text-right">
                                <SellButton deploymentId={d.id} positionId={p.id} label={instrumentLabel(p.instrument)} onDone={refreshAll} />
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </section>

            <section className={d.alertsOnly ? "hidden" : ""}>
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
                            <td className="px-3 py-2.5 text-muted">{REASON[f.reason] ?? f.reason.replaceAll("_", " ")}</td>
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
              </>
            )}
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
                    const [label, color] =
                      (e.data as { by?: string } | undefined)?.by === "owner"
                        ? ["You", "var(--ink)"]
                        : (EVENT[e.type === "intent" && /nothing to close|matched, but/i.test(e.message) ? "noop" : e.type] ?? [e.type, "var(--muted)"]);
                    return (
                      <motion.li key={e.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="px-4 py-3">
                        <div className="flex items-center gap-2 text-[12.5px]">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                          <span className="font-medium text-ink-2">{label}</span>
                          <span className="tnum ml-auto text-faint">{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span>
                        </div>
                        <p className="mt-1 break-words pl-3.5 text-[13.5px] leading-relaxed text-ink">{readable(e.message, d.strategy)}</p>
                      </motion.li>
                    );
                  })}
                </AnimatePresence>
              </ol>
              {shown.length === 0 && <p className="px-4 py-8 text-center text-[14px] text-muted">Waiting for the first check…</p>}
            </Card>
          </section>
        </div>

        <p className="text-[12.5px] text-faint">{d.mode === "live" ? "Trades on Hyperliquid through your agent." : d.alertsOnly ? "Alerts only: nothing is bought or sold." : "A paper run from before Weft traded with real money."} Not financial advice.</p>
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
