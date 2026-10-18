"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { instrumentLabel, type Strategy } from "@weft/strategy";
import { api, ApiError } from "@/lib/api";
import { useAuth, useRequireAuth } from "@/lib/auth";
import { useApi } from "@/lib/use-api";
import { hlFreeUsd, tradesSolana, useTradingVenues, type Venues } from "@/lib/trading";
import { useHlApprove } from "@/lib/hl-approve";
import Link from "next/link";
import { Btn, Card } from "./AppShell";

/** Seconds between checks: 15 s when a stop, a target or a fast market needs watching, else 30 s. */
export function checkInterval(s: Strategy | undefined): number {
  if (!s) return 30;
  const fast = s.actions.some(
    (a) =>
      a.type === "copy" ||
      (a.type === "open" &&
        (a.instrument.kind === "token" || a.instrument.kind === "outcome" || Boolean(a.exits.stopLoss || a.exits.takeProfit || a.exits.trailingStopPct)))
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
    // Copy trading: room for every copy it may hold at once.
    if (a.type === "copy") {
      const per = a.size.unit === "usd" ? a.size.value : a.size.unit === "native" && solUsd ? a.size.value * solUsd : null;
      if (per == null) return null;
      usd += per * a.maxOpen;
      parts.push(`${a.size.unit === "usd" ? `$${a.size.value.toLocaleString("en-US")}` : `${a.size.value} SOL`} a copy, up to ${a.maxOpen} at once`);
      continue;
    }
    // Liquidity: the amount going into the pool.
    if (a.type === "liquidity") {
      if (a.size.unit !== "usd") return null;
      usd += a.size.value;
      parts.push(`$${a.size.value.toLocaleString("en-US")}`);
      continue;
    }
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
const SIGNAL_NAMES: Record<string, string> = { social: "social sentiment", news: "news", post_match: "match results", model: "model forecasts" };

export function liveBlocker(s: Strategy | undefined, venues: Venues | null = null): string | null {
  if (!s) return null;
  const fake = [...new Set(s.signals.filter((x) => venues?.simulated?.includes(x.kind)).map((x) => SIGNAL_NAMES[x.kind] ?? x.kind))];
  if (fake.length) return `This strategy uses ${fake.join(" and ")}, which Weft doesn’t have live data for yet, so it can’t trade real money.`;
  // Seeded examples point at sample markets until a real one is found (Hyperliquid's own ids are numbers).
  const doc = JSON.stringify(s);
  if (doc.includes("ExampLeMint") || /"venue":"hyperliquid","market":"[^"]*[a-z][^"]*"/.test(doc))
    return "This example still points at a sample market. Make a copy and pick a real market first.";
  for (const a of s.actions) {
    if (a.type === "liquidity" && !venues?.liquidity) return "Liquidity strategies run as practice for now. Live deposits to Meteora are coming.";
    if (a.type === "options") return "Options can’t be traded live yet.";
    if (a.type !== "open") continue;
    if (a.instrument.kind === "synth" && !venues?.papertrade) return "Papertrade runs as practice for now. Live trading there is coming.";
    if (a.order.type === "limit") return "Limit orders can’t be traded live yet. Use a market order with a slippage limit.";
    const k = a.instrument.kind;
    if (k === "token" && venues && !venues.solana) return "Trading Solana tokens opens soon.";
    if (k === "outcome" && a.instrument.venue === "polymarket") return "Polymarket markets are watch-only for now. Use their odds to trade a Hyperliquid market instead.";
    if (k === "outcome" && a.instrument.venue !== "hyperliquid") return "Only Hyperliquid’s prediction markets can be traded.";
  }
  return null;
}

/** "Buy $RAY" when the strategy is a single order that fires right away; null for anything conditional. */
function orderNow(s: Strategy | undefined): string | null {
  if (!s) return null;
  const opens = s.actions.filter((a) => a.type === "open");
  if (opens.length !== 1) return null;
  const open = opens[0] as { on: string[]; side?: string; instrument: Parameters<typeof instrumentLabel>[0] };
  const immediate = open.on.every((id) => {
    const w = s.triggers.find((t) => t.id === id)?.when as { op?: string; right?: { value?: unknown } } | undefined;
    return w?.op === "gt" && w.right?.value === 0;
  });
  if (!immediate) return null;
  return `${open.side === "short" ? "Short" : "Buy"} ${instrumentLabel(open.instrument)}`;
}

export type RunMode = "live" | "practice" | "alerts";

/** Start a strategy with real money, as practice (pretend money, real prices) or as alerts only, and jump to its run page. */
export function DeployPanel({ strategy, strategyId, compact = false, initialMode }: { strategy?: Strategy; strategyId?: string; compact?: boolean; initialMode?: RunMode }) {
  const router = useRouter();
  const requireAuth = useRequireAuth();
  const auth = useAuth();
  const signedIn = auth.enabled && auth.authenticated;
  const venues = useTradingVenues();
  const onSolana = tradesSolana(strategy);
  const live = useApi(signedIn && !onSolana ? () => api.liveStatus() : null, [signedIn, onSolana]);
  const sol = useApi(signedIn && onSolana ? () => api.solanaStatus() : null, [signedIn, onSolana]);
  const ready = onSolana ? !!sol.data?.ready : !!live.data?.ready;
  // An account that only lacks an approval (e.g. Weft's fee was just switched on) is set up: a
  // Weft wallet approves in the background right here, an own wallet gets a clear one-step ask.
  // The approvals sign themselves in the background (WalletAutopilot); the button is the fallback.
  const hl = useHlApprove(onSolana ? null : live.data, live.refresh, false);
  const loadingStatus = onSolana ? sol.loading && !sol.data : live.loading && !live.data;
  // No cap unless the server sets one: people trade whatever amount they choose.
  const cap = (onSolana ? sol.data?.maxAllocationUsd : live.data?.config.maxAllocationUsd) ?? null;
  const testnet = !onSolana && live.data?.config.network === "testnet";
  const available = onSolana ? null : hlFreeUsd(live.data?.venue);
  const solBalance = sol.data?.balances?.sol ?? null;
  const walletUsd = sol.data?.balances?.usd ?? null;
  // Stated amounts need no budget: it's the amount itself plus room for fees and price moves.
  const stated = useMemo(() => statedSpend(strategy, sol.data?.solUsd ?? null), [strategy, sol.data?.solUsd]);
  const [customBudget, setCustomBudget] = useState(false);
  const autoBudget = stated && !customBudget ? Math.max(1, Math.ceil(stated.usd * 1.15 * 100) / 100) : null;
  // A tester can trade Solana before it opens for everyone: the server says so per user.
  const solOpen = Boolean(sol.data?.enabled);
  const blocker = useMemo(() => liveBlocker(strategy, venues && solOpen ? { ...venues, solana: true } : venues), [strategy, venues, solOpen]);

  const practice = useApi(() => api.practice(), [signedIn]);
  const practiceOn = Boolean(practice.data?.enabled);
  // Practice first for anyone who can't trade real money yet (not signed in, no wallet, no money in
  // it); Trade for everyone who can. What the person picks always wins.
  const funded = ready && (onSolana ? (walletUsd ?? 0) >= 1 : (available ?? 0) >= 10);
  const [picked, setPicked] = useState<RunMode | null>(initialMode ?? null);
  const mode: RunMode = picked ?? (blocker ? (practiceOn ? "practice" : "alerts") : funded || !practiceOn ? "live" : "practice");
  const setMode = setPicked;
  const [allocation, setAllocation] = useState(100);
  // How often the agent looks at the market is Weft's job, not the user's: fast where prices move fast.
  const interval = useMemo(() => checkInterval(strategy), [strategy]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isLive = mode === "live";
  const isPractice = mode === "practice";
  const alerts = useApi(signedIn && mode === "alerts" ? () => api.alertsMe() : null, [signedIn, mode]);
  const practiceLeft = practice.data?.leftUsd ?? null;
  const limit = isPractice ? (practiceLeft ?? Infinity) : Math.min(cap ?? Infinity, available ?? Infinity);
  const max = Number.isFinite(limit) ? Math.max(10, limit) : Infinity;
  const now = useMemo(() => orderNow(strategy), [strategy]);

  const deploy = async () => {
    if (!requireAuth()) return;
    setBusy(true);
    setError(null);
    try {
      const rec = await api.deploy({
        strategy,
        strategyId,
        intervalSec: interval,
        ...(isLive
          ? { mode: "live", allocationUsd: autoBudget ?? Math.min(allocation, max), confirm: "GO LIVE" }
          : isPractice
            ? { mode: "paper", allocationUsd: autoBudget ?? Math.min(allocation, max) }
            : { mode: "paper", alertsOnly: true, allocationUsd: 1000 }),
      });
      router.push(`/run?id=${encodeURIComponent(rec.id)}`);
    } catch (e) {
      setError(e instanceof ApiError && e.issues?.length ? e.issues.map((i) => `${i.path}: ${i.message}`).join("\n") : (e as Error).message);
      setBusy(false);
    }
  };

  const link = "font-medium text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink";
  const budgetUi = (
    <>
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
          {Number.isFinite(max) && (
            <button type="button" onClick={() => setAllocation(Math.floor(max))} className="shrink-0 text-[12.5px] text-muted hover:text-ink">
              Max
            </button>
          )}
        </div>
        <span className="mt-1 block text-[12px] leading-relaxed text-faint">
          The most this strategy can put into trades; nothing moves until a rule fires.{cap != null ? ` Up to $${cap.toLocaleString("en-US")} per strategy.` : ""}
        </span>
      </label>
      )}
    </>
  );

  return (
    <Card className={compact ? "p-4" : "p-5"}>
      <div className="text-[15px] font-semibold tracking-[-0.015em] text-ink">Run this strategy</div>
      <div className="mt-3">
        <Segmented
          label="How it runs"
          value={mode}
          options={[
            ["live", "Trade", Boolean(blocker)],
            ...(practiceOn ? ([["practice", "Practice"]] as const) : []),
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
        ) : !ready && !onSolana && hl.needsApproval ? (
          <div className="mt-3 rounded-[10px] bg-paper-2 p-4">
            <p className="text-[13.5px] font-medium text-ink">{hl.agentOk ? "Approve Weft’s trading fee" : "Turn on trading"}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              {hl.agentOk
                ? `Weft takes ${(live.data?.config.builderFeeBps ?? 0) / 100}% on Hyperliquid perps${live.data?.config.builderSpotFeeBps ? ` and ${live.data.config.builderSpotFeeBps / 100}% on spot sales` : ""}. Your account approves it once.`
                : "Your account approves Weft’s trading-only key once."}
              {hl.silent ? (hl.busy ? " Approving in the background…" : "") : " Sign it on the Wallets page."}
            </p>
            {hl.error && <p className="mt-2 text-[12.5px] text-short">{hl.error}</p>}
            {hl.silent ? (
              (hl.error || !hl.busy) && (
                <Btn className="mt-3" onClick={() => void hl.approve()} disabled={hl.busy}>
                  {hl.busy ? "Approving…" : "Approve"}
                </Btn>
              )
            ) : (
              <Link href="/wallets" className="mt-3 inline-flex h-9 items-center rounded-[10px] bg-ink px-3.5 text-[14px] font-medium text-paper hover:bg-ink/85">
                Approve in Wallets
              </Link>
            )}
          </div>
        ) : !ready ? (
          <div className="mt-3 rounded-[10px] bg-paper-2 p-4">
            <p className="text-[13.5px] font-medium text-ink">{onSolana ? "Set up your Solana trading wallet" : "Set up your Hyperliquid wallet"}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              {onSolana
                ? "Create your wallet, allow Weft to swap from it, and add some SOL. About a minute."
                : "Weft makes you a wallet. Send it USDC and you’re ready to trade. About a minute."}
            </p>
            <Link href={onSolana ? "/wallets?venue=solana" : "/wallets"} className="mt-3 inline-flex h-9 items-center rounded-[10px] bg-ink px-3.5 text-[14px] font-medium text-paper hover:bg-ink/85">
              Set up trading
            </Link>
          </div>
        ) : (
          <>
            <p className="mt-3 text-[13.5px] leading-relaxed text-muted">
              {strategy?.actions.some((a) => a.type === "liquidity")
                ? "A real deposit into Meteora from your own Solana wallet, paid in SOL. The position account holds about 0.06 SOL, which comes back when it closes."
                : onSolana
                  ? "Real swaps through Jupiter, from your own Solana wallet."
                  : <>Real orders on Hyperliquid{testnet ? " testnet (test funds)" : ""}, from your own account.</>}
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
            {budgetUi}
          </>
        )
      ) : isPractice ? (
        <>
          <p className="mt-3 text-[13.5px] leading-relaxed text-muted">
            Pretend money, real prices. Every trade is simulated at live prices with fees included, and nothing real is bought or sold.
            {signedIn && practice.data && (
              <>
                {" "}
                <span className="tnum text-ink-2">${Math.floor(practice.data.leftUsd).toLocaleString("en-US")}</span> of your ${practice.data.budgetUsd.toLocaleString("en-US")} practice money left.
              </>
            )}
          </p>
          {budgetUi}
        </>
      ) : (
        <p className="mt-3 text-[13.5px] leading-relaxed text-muted">
          Nothing is bought or sold. You get a message the moment a rule would trade.
          {signedIn && alerts.data && !alerts.data.telegram && (
            <>
              {" "}
              <Link href="/settings" className={link}>
                Connect Telegram
              </Link>{" "}
              to get them on your phone.
            </>
          )}
        </p>
      )}

      {blocker && isLive && <p className="mt-3 rounded-[10px] bg-[var(--trigger-soft)] px-3 py-2.5 text-[13px] leading-relaxed text-ink-2">{blocker} You can practice it or run it as alerts in the meantime.</p>}

      {error && <p className="mt-3 whitespace-pre-wrap rounded-[10px] bg-[var(--short-soft)] px-3 py-2.5 text-[13px] text-short">{error}</p>}

      {isLive && !signedIn ? (
        <Btn onClick={() => requireAuth()} className="mt-5 h-10 w-full">
          Sign in to trade
        </Btn>
      ) : (!isLive || ready) && (
        <Btn onClick={deploy} disabled={busy} className="mt-5 h-11 w-full text-[15px]">
          {busy
            ? "Starting…"
            : isPractice
              ? now && stated
                ? `Practice: ${now} for ${stated.text}`
                : "Start practicing"
            : !isLive
              ? "Start alerts"
              : now && stated
                ? `${now} for ${stated.text}`
                : autoBudget != null
                  ? "Start trading"
                  : `Start trading with $${Math.min(allocation, max).toLocaleString("en-US")}`}
        </Btn>
      )}
      <p className="mt-2.5 text-center text-[12.5px] leading-relaxed text-faint">
        {isLive && ready ? (
          <>
            {`${now ? "Buys right away with" : "Trades"} real money from your ${onSolana ? "wallet" : "account"}, and you can lose it. Stop any time. `}
            <a href="/risk" target="_blank" className="underline decoration-line-2 underline-offset-2 hover:text-ink">
              The risks
            </a>
          </>
        )
          : isLive
            ? "Pause or stop any time. Stopping sells everything the strategy holds."
            : isPractice
              ? "Pretend money only. When you like how it trades, start it for real in one click."
              : "Pause or stop any time."}
      </p>
    </Card>
  );
}
