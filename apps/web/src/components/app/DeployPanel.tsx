"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Strategy } from "@weft/strategy";
import { api, ApiError } from "@/lib/api";
import { useAuth, useRequireAuth } from "@/lib/auth";
import { useApi } from "@/lib/use-api";
import { tradesSolana, useTradingVenues, type Venues } from "@/lib/trading";
import Link from "next/link";
import { Btn, Card } from "./AppShell";

/** Seconds between checks: 15 s when a stop, a target or a fast market needs watching, else 30 s. */
export function checkInterval(s: Strategy | undefined): number {
  if (!s) return 30;
  const fast = s.actions.some(
    (a) =>
      a.type === "open" &&
      (a.instrument.kind === "token" || a.instrument.kind === "outcome" || Boolean(a.exits.stopLoss || a.exits.takeProfit || a.exits.trailingStopPct))
  );
  return fast ? 15 : 30;
}

function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: readonly (readonly [T, string, boolean?])[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid rounded-[10px] bg-paper-2 p-0.5" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map(([v, l, disabled]) => (
        <button
          key={String(v)}
          role="radio"
          aria-checked={value === v}
          disabled={disabled}
          onClick={() => onChange(v)}
          className={`h-8 rounded-[8px] text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${value === v ? "bg-raised font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,.08)]" : "text-muted hover:text-ink"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/**
 * What a strategy with stated amounts ("0.05 SOL", "$50") spends, so the run needs no budget field.
 * Null when any buy is a percentage of the account or can't be priced.
 */
export function statedSpend(s: Strategy | undefined, solUsd: number | null): { usd: number; text: string } | null {
  if (!s) return null;
  let usd = 0;
  const parts: string[] = [];
  for (const a of s.actions) {
    if (a.type === "options") return null;
    if (a.type !== "open") continue;
    const size = a.size;
    if (size.unit === "usd") {
      usd += size.value;
      parts.push(`$${size.value.toLocaleString("en-US")}`);
    } else if (size.unit === "native" && a.instrument.kind === "token") {
      const quote = a.instrument.quote;
      if (quote === "USDC") usd += size.value;
      else if (solUsd) usd += size.value * solUsd;
      else return null;
      parts.push(`${size.value} ${quote}`);
    } else return null;
  }
  return usd > 0 ? { usd, text: parts.join(" + ") } : null;
}

/** Why a strategy can't trade with real money yet (null when it can). */
export function liveBlocker(s: Strategy | undefined, venues: Venues | null = null): string | null {
  if (!s) return null;
  for (const a of s.actions) {
    if (a.type === "options") return "Options can’t be traded live yet.";
    if (a.type !== "open") continue;
    if (a.order.type === "limit") return "Limit orders can’t be traded live yet. Use a market order with a slippage limit.";
    const k = a.instrument.kind;
    if (k === "token" && venues && !venues.solana) return "Trading Solana tokens opens soon.";
    if (k === "outcome" && a.instrument.venue !== "hyperliquid") return "Only Hyperliquid’s prediction markets can be traded.";
  }
  return null;
}

/** Start a strategy with real money (or as alerts only) and jump to its run page. */
export function DeployPanel({ strategy, strategyId, compact = false }: { strategy?: Strategy; strategyId?: string; compact?: boolean }) {
  const router = useRouter();
  const requireAuth = useRequireAuth();
  const auth = useAuth();
  const signedIn = auth.enabled && auth.authenticated;
  const venues = useTradingVenues();
  const onSolana = tradesSolana(strategy);
  const live = useApi(signedIn && !onSolana ? () => api.liveStatus() : null, [signedIn, onSolana]);
  const sol = useApi(signedIn && onSolana ? () => api.solanaStatus() : null, [signedIn, onSolana]);
  const ready = onSolana ? !!sol.data?.ready : !!live.data?.ready;
  const loadingStatus = onSolana ? sol.loading && !sol.data : live.loading && !live.data;
  const cap = (onSolana ? sol.data?.maxAllocationUsd : live.data?.config.maxAllocationUsd) ?? 1000;
  const testnet = !onSolana && live.data?.config.network === "testnet";
  const available = onSolana ? null : (live.data?.venue?.withdrawableUsd ?? live.data?.venue?.accountValueUsd ?? null);
  const solBalance = sol.data?.balances?.sol ?? null;
  const walletUsd = sol.data?.balances?.usd ?? null;
  // Stated amounts need no budget: it's the amount itself plus room for fees and price moves.
  const stated = useMemo(() => statedSpend(strategy, sol.data?.solUsd ?? null), [strategy, sol.data?.solUsd]);
  const [customBudget, setCustomBudget] = useState(false);
  const autoBudget = stated && !customBudget ? Math.max(1, Math.ceil(stated.usd * 1.15 * 100) / 100) : null;
  // A tester can trade Solana before it opens for everyone: the server says so per user.
  const solOpen = Boolean(sol.data?.enabled);
  const blocker = useMemo(() => liveBlocker(strategy, venues && solOpen ? { ...venues, solana: true } : venues), [strategy, venues, solOpen]);

  const [mode, setMode] = useState<"live" | "alerts">(blocker ? "alerts" : "live");
  const [allocation, setAllocation] = useState(100);
  // How often the agent looks at the market is Weft's job, not the user's: fast where prices move fast.
  const interval = useMemo(() => checkInterval(strategy), [strategy]);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isLive = mode === "live";
  const alerts = useApi(signedIn && !isLive ? () => api.alertsMe() : null, [signedIn, isLive]);
  const max = Math.max(10, Math.min(cap, available ?? cap));

  const deploy = async () => {
    if (!requireAuth()) return;
    if (isLive && !agree) return setError("Tick the box to confirm this trades real money.");
    setBusy(true);
    setError(null);
    try {
      const rec = await api.deploy({
        strategy,
        strategyId,
        intervalSec: interval,
        ...(isLive ? { mode: "live", allocationUsd: autoBudget ?? Math.min(allocation, max), confirm: "GO LIVE" } : { mode: "paper", alertsOnly: true, allocationUsd: 1000 }),
      });
      router.push(`/app/run?id=${encodeURIComponent(rec.id)}`);
    } catch (e) {
      setError(e instanceof ApiError && e.issues?.length ? e.issues.map((i) => `${i.path}: ${i.message}`).join("\n") : (e as Error).message);
      setBusy(false);
    }
  };

  const link = "font-medium text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink";

  return (
    <Card className={compact ? "p-4" : "p-5"}>
      <div className="text-[15px] font-semibold tracking-[-0.015em] text-ink">Run this strategy</div>
      <div className="mt-3">
        <Segmented
          label="How it runs"
          value={mode}
          options={[
            ["live", "Trade", Boolean(blocker)],
            ["alerts", "Alerts only"],
          ]}
          onChange={(m) => {
            setMode(m);
            setError(null);
          }}
        />
      </div>

      {isLive ? (
        !signedIn ? (
          <p className="mt-3 text-[13.5px] leading-relaxed text-muted">Trades with real money from your own Hyperliquid account. Sign in to set it up.</p>
        ) : loadingStatus ? (
          <div className="mt-4 h-24 animate-pulse rounded-[10px] bg-paper-2" />
        ) : !ready ? (
          <div className="mt-3 rounded-[10px] bg-paper-2 p-4">
            <p className="text-[13.5px] font-medium text-ink">{onSolana ? "Set up your Solana trading wallet" : "Connect your Hyperliquid account"}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              {onSolana
                ? "Create your wallet, allow Weft to swap from it, and add some SOL. About a minute."
                : "Two signatures from your wallet: one lets Weft place orders, nothing can be withdrawn. Takes about a minute."}
            </p>
            <Link href={onSolana ? "/app/live?venue=solana" : "/app/live"} className="mt-3 inline-flex h-9 items-center rounded-[10px] bg-ink px-3.5 text-[14px] font-medium text-paper hover:bg-ink/85">
              Set up trading
            </Link>
          </div>
        ) : (
          <>
            <p className="mt-3 text-[13.5px] leading-relaxed text-muted">
              {onSolana ? "Real swaps through Jupiter, from your own Solana wallet." : <>Real orders on Hyperliquid{testnet ? " testnet (test funds)" : ""}, from your own account.</>}
              {solBalance != null && (
                <>
                  {" "}
                  Your wallet: <span className="tnum text-ink-2">{solBalance.toFixed(3)} SOL</span>
                  {walletUsd != null && <span className="tnum text-ink-2"> (≈ ${walletUsd < 100 ? walletUsd.toFixed(2) : Math.round(walletUsd).toLocaleString("en-US")})</span>}.
                </>
              )}
              {available != null && (
                <>
                  {" "}
                  <span className="tnum text-ink-2">${Math.floor(available).toLocaleString("en-US")}</span> available.
                </>
              )}
            </p>
            {autoBudget != null && stated ? (
              <div className="mt-4 rounded-[10px] bg-paper-2 px-3.5 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] text-muted">Uses</span>
                  <span className="tnum text-[15px] font-medium text-ink">
                    {stated.text}
                    {!/^\$/.test(stated.text) && <span className="font-normal text-muted"> ≈ ${stated.usd < 100 ? stated.usd.toFixed(2) : Math.round(stated.usd).toLocaleString("en-US")}</span>}
                  </span>
                </div>
                <button type="button" onClick={() => (setCustomBudget(true), setAllocation(Math.max(10, Math.ceil(stated.usd * 2))))} className="mt-1.5 text-[12px] text-faint hover:text-ink">
                  Set a budget instead
                </button>
              </div>
            ) : (
            <label className="mt-4 block">
              <span className="text-[13px] text-ink-2">Budget</span>
              <div className="mt-1.5 flex h-10 items-center rounded-[10px] border border-line-2 bg-card px-3 focus-within:border-ink/40">
                <span className="text-muted">$</span>
                <input
                  inputMode="numeric"
                  value={allocation.toLocaleString("en-US")}
                  onChange={(e) => setAllocation(Math.min(max, Math.max(0, Number(e.target.value.replace(/[^\d]/g, "")) || 0)))}
                  onBlur={() => setAllocation((a) => Math.max(10, a))}
                  className="tnum w-full bg-transparent pl-1 text-[15px] text-ink outline-none"
                  aria-label="Amount in USD"
                />
                <button type="button" onClick={() => setAllocation(Math.floor(max))} className="shrink-0 text-[12.5px] text-muted hover:text-ink">
                  Max
                </button>
              </div>
              <span className="mt-1 block text-[12px] leading-relaxed text-faint">
                The most this strategy can put into trades; nothing moves until a rule fires. Up to ${cap.toLocaleString("en-US")} while Weft is new.
              </span>
            </label>
            )}
          </>
        )
      ) : (
        <p className="mt-3 text-[13.5px] leading-relaxed text-muted">
          Nothing is bought or sold. You get a message the moment a rule would trade.
          {signedIn && alerts.data && !alerts.data.telegram && (
            <>
              {" "}
              <Link href="/app/settings" className={link}>
                Connect Telegram
              </Link>{" "}
              to get them on your phone.
            </>
          )}
        </p>
      )}

      {blocker && <p className="mt-3 rounded-[10px] bg-[var(--trigger-soft)] px-3 py-2.5 text-[13px] leading-relaxed text-ink-2">{blocker} You can run it as alerts in the meantime.</p>}

      {isLive && ready && (
        <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-[13px] leading-relaxed text-ink-2">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-[3px] h-4 w-4 shrink-0 accent-[var(--ink)]" />
          <span>I understand this trades real money from my account, and that I can lose it.</span>
        </label>
      )}

      {error && <p className="mt-3 whitespace-pre-wrap rounded-[10px] bg-[var(--short-soft)] px-3 py-2.5 text-[13px] text-short">{error}</p>}

      {isLive && !signedIn ? (
        <Btn onClick={() => requireAuth()} className="mt-5 h-10 w-full">
          Sign in to trade
        </Btn>
      ) : (!isLive || ready) && (
        <Btn onClick={deploy} disabled={busy || (isLive && !agree)} className="mt-5 h-10 w-full">
          {busy ? "Starting…" : isLive ? (autoBudget != null ? "Start trading" : `Start trading $${Math.min(allocation, max).toLocaleString("en-US")}`) : "Start alerts"}
        </Btn>
      )}
      <p className="mt-2.5 text-center text-[12.5px] text-faint">{isLive ? "Pause or stop any time. Stopping closes every position." : "Pause or stop any time."}</p>
    </Card>
  );
}
