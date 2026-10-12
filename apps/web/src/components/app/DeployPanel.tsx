"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Strategy } from "@weft/strategy";
import { api, ApiError } from "@/lib/api";
import { Btn, Card } from "./AppShell";

const INTERVALS = [
  [15, "15s"],
  [30, "30s"],
  [60, "1m"],
  [300, "5m"],
] as const;

/** Start a paper deployment of a strategy and jump to its live run page. */
export function DeployPanel({ strategy, strategyId, compact = false }: { strategy?: Strategy; strategyId?: string; compact?: boolean }) {
  const router = useRouter();
  const [allocation, setAllocation] = useState(10_000);
  const [interval, setInterval] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deploy = async () => {
    setBusy(true);
    setError(null);
    try {
      const rec = await api.deploy({ strategy, strategyId, allocationUsd: allocation, intervalSec: interval });
      router.push(`/app/run?id=${encodeURIComponent(rec.id)}`);
    } catch (e) {
      setError(e instanceof ApiError && e.issues?.length ? e.issues.map((i) => `${i.path}: ${i.message}`).join("\n") : (e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Card className={compact ? "p-4" : "p-5"}>
      <div className="flex items-center justify-between">
        <div className="text-[15px] font-semibold tracking-[-0.02em]">Run it on paper</div>
        <span className="rounded-full bg-[var(--long-soft)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-long">Live prices</span>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
        Simulated fills against live market data, with fees, slippage, stops and risk checks. Nothing touches real funds.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">Allocation</span>
          <div className="mt-1.5 flex h-10 items-center rounded-xl border border-line bg-paper px-3 focus-within:border-ink">
            <span className="text-faint">$</span>
            <input
              type="number"
              min={100}
              step={100}
              value={allocation}
              onChange={(e) => setAllocation(Math.max(100, Number(e.target.value) || 0))}
              className="tnum w-full bg-transparent pl-1 font-mono text-[14px] outline-none"
              aria-label="Paper allocation in USD"
            />
          </div>
        </label>
        <div>
          <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">Check every</span>
          <div className="mt-1.5 grid h-10 grid-cols-4 rounded-xl border border-line bg-paper p-1">
            {INTERVALS.map(([v, l]) => (
              <button
                key={v}
                onClick={() => setInterval(v)}
                className={`rounded-lg font-mono text-[11.5px] transition-colors ${interval === v ? "bg-ink text-paper" : "text-ink-2 hover:text-ink"}`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      </div>
      {error && <pre className="mt-3 whitespace-pre-wrap rounded-xl bg-[var(--short-soft)] p-3 font-mono text-[11.5px] text-short">{error}</pre>}
      <Btn onClick={deploy} disabled={busy} variant="volt" className="mt-4 w-full">
        {busy ? "Starting…" : "Start paper trading →"}
      </Btn>
      <p className="mt-2.5 text-center font-mono text-[10.5px] text-faint">Live mode requires approval + a connected agent wallet (coming soon)</p>
    </Card>
  );
}
