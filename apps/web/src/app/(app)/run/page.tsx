"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTitle } from "@/lib/use-title";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import type { EngineEvent } from "@weft/engine";
import { instrumentLabel } from "@weft/strategy";
import { api, type Snapshot } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { runMoney } from "@/lib/run-money";
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
import { ShareResult } from "@/components/app/ShareResult";

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
  out_of_range: "out of range",
};

/** Real money notice, plus the owner's choice to show this run's return on the leaderboard. */
function ShareRow({ id, shared, onChange, venue }: { id: string; shared: boolean; onChange: () => void; venue: string }) {
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
      <span className="text-ink-2">Trades with real money from your {venue}.</span>
      <button onClick={toggle} disabled={busy} role="switch" aria-checked={on} className="inline-flex items-center gap-2.5 text-[13.5px] text-ink-2 hover:text-ink disabled:opacity-60">
        <span className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-long" : "bg-line-2"}`}>
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] ${on ? "left-[18px]" : "left-0.5"}`} />
        </span>
        <span className="text-left">
          Show the return on the leaderboard <span className="text-faint">(percent only)</span>
        </span>
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
      aria-label="Hold to stop: sells everything this strategy holds"
      title="Hold for a second to sell everything this strategy holds"
    >
      <span className="absolute inset-y-0 left-0 bg-[var(--short-soft)]" style={{ width: `${p * 100}%` }} />
      <span className="relative">{p > 0 ? "Keep holding…" : "Hold to stop"}</span>
    </button>
  );
}

/** "SOL-USDC pool" for a liquidity fill's instrument key. */
const lpName = (st: { actions: { type: string; pool?: { pool: string; symbol: string } }[] }, key: string) =>
  `${st.actions.find((a) => a.type === "liquidity" && key.endsWith(a.pool!.pool))?.pool?.symbol ?? "Liquidity"} pool`;

function Run() {
  const id = useSearchParams().get("id") ?? "";
  const snap = useApi(id ? () => api.deployment(id) : null, [id], { pollMs: 4_000 });
  useTitle(snap.data?.deployment.strategy.name);
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

  // A trade can land between loading the list and the live stream connecting (a strategy that buys
  // right away does exactly that): whenever the number of trades changes, reload the list.
  const fillCount = fills.data?.fills.length ?? 0;
  useEffect(() => {
    if (!id || !fillCount) return;
    let alive = true;
    api.events(id).then((r) => alive && setEvents(r.events.slice(-200).reverse())).catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, fillCount]);

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

  if (!id) return <div className="p-10"><Empty title="No run selected" action={<Btn href="/portfolio">Portfolio</Btn>} /></div>;
  if (!s) {
    return (
      <div className="p-10">
        {snap.error ? <Empty title="Couldn’t load this run" sub={snap.error.message} action={<Btn href="/portfolio">Portfolio</Btn>} /> : <div className="h-64 animate-pulse rounded-[12px] bg-paper-2" />}
      </div>
    );
  }

  const d = s.deployment;
  const money = runMoney(s);
  // The engine books every fee as realized, including the one paid to open a position that's still
  // open: "closed profit" leaves that out (it's in Return), so it reads $0 until something closes.
  const openIds = new Set(s.positions.map((p) => p.id));
  const closedPnl = s.realizedPnlUsd + (fills.data?.fills ?? []).filter((f) => f.reason === "entry" && openIds.has(f.positionId)).reduce((n, f) => n + f.feeUsd, 0);
  // With leverage, the money put in and the position differ: $5 at 20× holds $100 of ETH.
  const levs = s.positions.map((p) => p.leverage ?? 1);
  const lev = { max: Math.max(1, ...levs), min: Math.min(...(levs.length ? levs : [1])), positionUsd: s.positions.reduce((n, p) => n + p.sizeUsd * (p.leverage ?? 1), 0) };
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
  // What to chart: the strategy's own markets, plus whatever it holds (a copy strategy has no
  // markets of its own, only the ones the leader trades).
  const charted = [...new Map([...strategyInstruments(d.strategy), ...s.positions.map((p) => p.instrument)].map((i) => [JSON.stringify(i), i])).values()];

  return (
    <>
      <PageHeader
        back={{ href: "/portfolio", label: "Portfolio" }}
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
            {!d.alertsOnly && money.traded && <ShareResult id={d.id} name={d.strategy.name} />}
            <Btn variant="quiet" href={`/new?from=${encodeURIComponent(`run:${d.id}`)}`}>
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
        {d.mode === "live" && (
          <ShareRow
            id={d.id}
            shared={Boolean(s.shared)}
            onChange={() => snap.refresh()}
            venue={d.strategy.actions.some((a) => a.type === "open" && a.instrument.kind === "token") ? "Solana trading wallet" : "Hyperliquid account"}
          />
        )}
        {d.mode === "paper" && !d.alertsOnly && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-line bg-[var(--trigger-soft)] px-4 py-3">
            <p className="text-[14px] text-ink-2">
              <span className="font-semibold text-ink">Practice.</span> Pretend money at real prices: these trades aren’t real, and nothing here is yours to withdraw.
            </p>
            <Btn href={`/new?from=${encodeURIComponent(`run:${d.id}`)}&mode=live`}>Start it for real</Btn>
          </div>
        )}
        {controlError && <div className="rounded-[12px] bg-[var(--short-soft)] px-4 py-3 text-[14px] text-short">{controlError}</div>}

        {d.alertsOnly && (
          <div className="rounded-[12px] border border-line bg-card px-4 py-3 text-[14px] text-ink-2">
            Alerts only. This run never trades: when a rule would buy or sell, you get a message instead.{" "}
            <Link href="/settings" className="text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">
              Alert settings
            </Link>
          </div>
        )}
        <div className={`grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line py-5 sm:grid-cols-5 ${d.alertsOnly ? "hidden" : ""}`}>
          <Stat
            label={money.traded ? "Put in" : "Budget"}
            value={fmtUsd(money.putIn, 2)}
            sub={
              money.open
                ? lev.max > 1
                  ? `a ${fmtUsd(lev.positionUsd, 2)} position at ${lev.max === lev.min ? "" : "up to "}${lev.max}×`
                  : `worth ${fmtUsd(money.worth, 2)} now`
                : money.traded
                  ? `got back ${fmtUsd(money.worth, 2)}`
                  : undefined
            }
          />
          <Stat
            label="Return"
            value={fmtPct(money.returnPct)}
            tone={tone(money.returnPct)}
            sub={money.fees > 0 ? `after ${fmtUsd(money.fees, 2)} fees${s.builderFeesUsd ? ` (Weft ${fmtUsd(s.builderFeesUsd, 2)})` : ""}` : undefined}
          />
          <Stat label="Open profit" value={fmtUsd(s.unrealizedPnlUsd, 2)} tone={tone(s.unrealizedPnlUsd)} sub={s.positions.length ? fmtPct(money.openPct) : undefined} />
          <Stat label="Closed profit" value={fmtUsd(closedPnl, 2)} tone={tone(closedPnl)} />
          <Stat label="Last check" value={ago(s.lastTickAt)} />
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

            {charted.length > 0 && (
              <section>
                <h2 className="mb-3 text-[15px] font-semibold text-ink">The market</h2>
                <Card className="p-5">
                  <TradesChart instruments={charted} fills={fills.data?.fills ?? []} startedAt={d.createdAt} />
                </Card>
              </section>
            )}

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
                    <table className="w-full text-left text-[13.5px] sm:min-w-[680px]">
                      <thead className="text-[12.5px] text-muted">
                        <tr className="border-b border-line">
                          <th className="py-2.5 pl-4 pr-3 font-normal sm:pl-5">Market</th>
                          <th className="px-3 py-2.5 font-normal">Side</th>
                          <th className="hidden px-3 py-2.5 text-right font-normal sm:table-cell">Size</th>
                          <th className="hidden px-3 py-2.5 text-right font-normal sm:table-cell">Entry</th>
                          <th className="hidden px-3 py-2.5 text-right font-normal sm:table-cell">Now</th>
                          <th className="hidden px-3 py-2.5 text-right font-normal sm:table-cell">Liquidation</th>
                          <th className="px-3 py-2.5 text-right font-normal">Profit</th>
                          {canAct && <th className="py-2.5 pl-2 pr-4 sm:px-5" />}
                        </tr>
                      </thead>
                      <tbody>
                        {s.positions.map((p) => (
                          <tr key={p.id} className="border-b border-line last:border-0">
                            <td className="py-3 pl-4 pr-3 font-medium text-ink sm:pl-5">
                              <span className="inline-flex items-center gap-2.5 whitespace-nowrap">
                                <AssetIcon {...instrumentIcon(p.instrument)} size={20} />
                                {instrumentLabel(p.instrument)}
                              </span>
                              {/* on a phone, size and prices go under the market */}
                              <div className="tnum mt-0.5 whitespace-nowrap text-[12px] font-normal text-muted sm:hidden">
                                {p.lp ? `${fmtUsd(p.qty * p.markPrice, 0)} · ${fmtPrice(p.lp.lower)}–${fmtPrice(p.lp.upper)}` : `${fmtUsd(p.sizeUsd, 0)} · ${fmtPrice(p.entryPrice)} → ${fmtPrice(p.markPrice)}`}
                              </div>
                            </td>
                            {p.lp ? (
                              // A liquidity position: the pool's price, its range, and the fees it has earned.
                              <>
                                <td className={`px-3 py-3 ${p.lp.outSince == null ? "text-long" : "text-trigger"}`}>
                                  {p.lp.outSince == null ? "In range" : "Out of range"}
                                  <span className="block text-[12px] text-muted">{fmtPrice(p.lp.lower)}–{fmtPrice(p.lp.upper)}</span>
                                </td>
                                <td className="tnum hidden px-3 py-3 text-right sm:table-cell">
                                  {fmtUsd(p.qty * p.markPrice, 2)}
                                  <span className="block text-[12px] text-muted">{Math.round(p.lp.baseShare * 100)}% {p.instrument.kind === "lp" ? p.instrument.symbol.split("-")[0] : ""}</span>
                                </td>
                                <td className="tnum hidden px-3 py-3 text-right text-ink-2 sm:table-cell">{fmtPrice(p.lp.entryPoolPrice)}</td>
                                <td className="tnum hidden px-3 py-3 text-right sm:table-cell">{fmtPrice(p.lp.poolPrice)}</td>
                                <td className="tnum hidden px-3 py-3 text-right text-ink-2 sm:table-cell">—</td>
                                <td className={`tnum whitespace-nowrap px-3 py-3 text-right ${p.unrealizedPnlUsd >= 0 ? "text-long" : "text-short"}`}>
                                  {fmtUsd(p.unrealizedPnlUsd, 2)} <span className="block text-[12px] opacity-80 sm:inline">{fmtPct(p.unrealizedPnlPct)}</span>
                                  <span className="block text-[12px] text-muted">fees {fmtUsd(p.lp.feesUsd, 2)}</span>
                                </td>
                              </>
                            ) : (
                              <>
                                <td className={`px-3 py-3 ${p.side === "long" ? "text-long" : "text-short"}`}>
                                  {p.side === "long" ? "Long" : "Short"}
                                  {p.leverage > 1 ? <span className="text-muted"> {p.leverage}×</span> : null}
                                </td>
                                <td className="tnum hidden px-3 py-3 text-right sm:table-cell">{fmtUsd(p.sizeUsd, 2)}</td>
                                <td className="tnum hidden px-3 py-3 text-right text-ink-2 sm:table-cell">{fmtPrice(p.entryPrice)}</td>
                                <td className="tnum hidden px-3 py-3 text-right sm:table-cell">{fmtPrice(p.markPrice)}</td>
                                <td className="tnum hidden px-3 py-3 text-right text-ink-2 sm:table-cell">{p.liquidationPrice ? fmtPrice(p.liquidationPrice) : "—"}</td>
                                <td className={`tnum whitespace-nowrap px-3 py-3 text-right ${p.unrealizedPnlUsd >= 0 ? "text-long" : "text-short"}`}>
                                  {fmtUsd(p.unrealizedPnlUsd, 2)} <span className="block text-[12px] opacity-80 sm:inline">{fmtPct(p.unrealizedPnlPct)}</span>
                                </td>
                              </>
                            )}
                            {canAct && (
                              <td className="py-3 pl-2 pr-4 text-right sm:px-5">
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
                    <table className="w-full text-left text-[13.5px] sm:min-w-[560px]">
                      <tbody>
                        {fillList.map((f) => (
                          <tr key={f.id} className="border-b border-line last:border-0">
                            <td className="tnum py-2.5 pl-4 pr-3 text-muted sm:pl-5">{new Date(f.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                            <td className={`px-3 py-2.5 ${f.side === "buy" ? "text-long" : "text-short"}`}>{f.instrumentKey.startsWith("meteora:lp:") ? (f.side === "buy" ? "Deposit" : "Withdraw") : f.side === "buy" ? "Buy" : "Sell"}</td>
                            <td className="px-3 py-2.5 text-ink">{f.instrumentKey.startsWith("meteora:lp:") ? lpName(d.strategy, f.instrumentKey) : f.instrumentKey.split(":").slice(-1)[0]?.slice(0, 18)}</td>
                            <td className="tnum px-3 py-2.5 text-right">{f.instrumentKey.startsWith("meteora:lp:") ? fmtUsd(f.qty * f.price, 2) : fmtPrice(f.price)}</td>
                            <td className="hidden px-3 py-2.5 text-muted sm:table-cell">{REASON[f.reason] ?? f.reason.replaceAll("_", " ")}</td>
                            <td className={`tnum whitespace-nowrap py-2.5 pl-3 pr-4 text-right sm:pr-5 ${f.realizedPnlUsd == null ? "text-muted" : f.realizedPnlUsd >= 0 ? "text-long" : "text-short"}`}>
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

        <p className="text-[12.5px] text-faint">{d.mode === "live" ? (d.strategy.actions.some((a) => a.type === "open" && a.instrument.kind === "token") ? "Swaps through Jupiter from your own Solana wallet." : "Trades on Hyperliquid through your agent.") : d.alertsOnly ? "Alerts only: nothing is bought or sold." : "Practice: pretend money at real prices, fees included."} Not financial advice.</p>
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
