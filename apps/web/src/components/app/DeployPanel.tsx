"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Strategy } from "@weft/strategy";
import { api, ApiError } from "@/lib/api";
import { useAuth, useRequireAuth } from "@/lib/auth";
import { useApi } from "@/lib/use-api";
import Link from "next/link";
import { Btn, Card } from "./AppShell";

const INTERVALS = [
  [15, "15 s"],
  [30, "30 s"],
  [60, "1 min"],
  [300, "5 min"],
] as const;

function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid rounded-[10px] bg-paper-2 p-0.5" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map(([v, l]) => (
        <button
          key={String(v)}
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`h-8 rounded-[8px] text-[13px] transition-colors ${value === v ? "bg-raised font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,.08)]" : "text-muted hover:text-ink"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/** Start a paper (or live) run of a strategy and jump to its run page. */
export function DeployPanel({ strategy, strategyId, compact = false }: { strategy?: Strategy; strategyId?: string; compact?: boolean }) {
  const router = useRouter();
  const [allocation, setAllocation] = useState(10_000);
  const [interval, setInterval] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requireAuth = useRequireAuth();
  const auth = useAuth();
  const live = useApi(auth.enabled && auth.authenticated ? () => api.liveStatus() : null, [auth.enabled, auth.authenticated]);
  const liveReady = !!live.data?.ready;
  const [mode, setMode] = useState<"paper" | "alerts" | "live">("paper");
  const [confirm, setConfirm] = useState("");
  const isLive = mode === "live";
  const isAlerts = mode === "alerts";
  const alerts = useApi(auth.enabled && auth.authenticated && isAlerts ? () => api.alertsMe() : null, [auth.enabled, auth.authenticated, isAlerts]);
  const cap = live.data?.config.maxAllocationUsd ?? 100;
  const network = live.data?.config.network;

  const deploy = async () => {
    if (!requireAuth()) return;
    if (isLive && confirm.trim().toUpperCase() !== "GO LIVE") return setError("Type GO LIVE to confirm.");
    setBusy(true);
    setError(null);
    try {
      const rec = await api.deploy({
        strategy,
        strategyId,
        allocationUsd: isLive ? Math.min(allocation, cap) : allocation,
        intervalSec: interval,
        mode: isAlerts ? "paper" : mode,
        ...(isAlerts ? { alertsOnly: true } : {}),
        ...(isLive ? { confirm: "GO LIVE" } : {}),
      });
      router.push(`/app/run?id=${encodeURIComponent(rec.id)}`);
    } catch (e) {
      setError(e instanceof ApiError && e.issues?.length ? e.issues.map((i) => `${i.path}: ${i.message}`).join("\n") : (e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Card className={compact ? "p-4" : "p-5"}>
      <div className="text-[15px] font-semibold tracking-[-0.015em] text-ink">Run this strategy</div>
      <div className="mt-3">
        <Segmented
          label="Mode"
          value={mode}
          options={
            auth.enabled
              ? [
                  ["paper", "Paper"],
                  ["alerts", "Alerts"],
                  ["live", "Live"],
                ]
              : [
                  ["paper", "Paper"],
                  ["alerts", "Alerts"],
                ]
          }
            onChange={(m) => {
              setMode(m);
              setError(null);
            if (m === "live") setAllocation((a) => Math.min(a, cap));
          }}
        />
      </div>
      {!auth.enabled && <p className="mt-2 text-[12.5px] text-faint">Live trading needs sign-in.</p>}
      <p className="mt-3 text-[13.5px] leading-relaxed text-muted">
        {isLive ? (
          liveReady ? (
            <>
              Real orders on Hyperliquid{network === "testnet" ? " testnet" : ""}, from your own account. Up to ${cap.toLocaleString()} per run.
            </>
          ) : (
            <>
              Connect your Hyperliquid account first.{" "}
              <Link href="/app/live" className="font-medium text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">
                Set up live trading
              </Link>
            </>
          )
        ) : isAlerts ? (
          <>
            Watch only. You get a message whenever it would trade; nothing is bought or sold.
            {auth.enabled && alerts.data && !alerts.data.telegram && (
              <>
                {" "}
                <Link href="/app/settings" className="font-medium text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">
                  Connect Telegram
                </Link>{" "}
                to get them on your phone.
              </>
            )}
          </>
        ) : (
          "Practice with simulated money against live prices. Fees and slippage included."
        )}
      </p>

      <label className={`mt-5 block ${isAlerts ? "hidden" : ""}`}>
        <span className="text-[13px] text-ink-2">Amount</span>
        <div className="mt-1.5 flex h-10 items-center rounded-[10px] border border-line-2 bg-card px-3 focus-within:border-ink/40">
          <span className="text-muted">$</span>
          <input
            inputMode="numeric"
            value={allocation.toLocaleString("en-US")}
            onChange={(e) => setAllocation(Math.min(isLive ? cap : 10_000_000, Math.max(0, Number(e.target.value.replace(/[^\d]/g, "")) || 0)))}
            onBlur={() => setAllocation((a) => Math.max(isLive ? 10 : 100, a))}
            className="tnum w-full bg-transparent pl-1 text-[15px] text-ink outline-none"
            aria-label="Amount in USD"
          />
        </div>
      </label>
      <div className="mt-4">
        <span className="text-[13px] text-ink-2">Check the market every</span>
        <div className="mt-1.5">
          <Segmented label="Check interval" value={interval} options={INTERVALS} onChange={setInterval} />
        </div>
      </div>

      {isLive && liveReady && (
        <label className="mt-4 block">
          <span className="text-[13px] text-ink-2">
            Type <span className="font-medium text-short">GO LIVE</span> to confirm
          </span>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="GO LIVE"
            className="mt-1.5 h-10 w-full rounded-[10px] border border-line-2 bg-card px-3 text-[15px] text-ink outline-none placeholder:text-faint focus:border-short"
            aria-label="Type GO LIVE to confirm live trading"
          />
        </label>
      )}
      {error && <p className="mt-3 whitespace-pre-wrap rounded-[10px] bg-[var(--short-soft)] px-3 py-2.5 text-[13px] text-short">{error}</p>}
      <Btn onClick={deploy} disabled={busy || (isLive && !liveReady)} variant={isLive ? "danger" : "ink"} className="mt-5 h-10 w-full">
        {busy ? "Starting…" : isLive ? "Start live trading" : isAlerts ? "Start alerts" : "Start on paper"}
      </Btn>
      <p className="mt-2.5 text-center text-[12.5px] text-faint">You can pause or stop it at any time.</p>
    </Card>
  );
}
