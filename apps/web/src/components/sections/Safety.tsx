"use client";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "motion/react";
import { SectionHeading, Reveal } from "../ui/Reveal";
import { IconCheck, IconKey, IconLock, IconPower, IconShield, IconX } from "../graph/icons";
import { ThreadField } from "../ui/ThreadField";
import { useReducedMotion } from "@/lib/hooks";

/* ---------- Trading key credentials ---------- */
type Perm = { label: string; ok: boolean; note: string };
const KEYS: { id: "hl" | "sol"; tab: string; title: string; addr: string; scope: string; perms: Perm[]; foot: string }[] = [
  {
    id: "hl",
    tab: "Hyperliquid",
    title: "Agent (API) wallet",
    addr: "0x7a3c · · · · f19c",
    scope: "scoped · revocable · expires in 30d",
    perms: [
      { label: "Place orders", ok: true, note: "perps · HIP-3 · HIP-4" },
      { label: "Cancel & amend", ok: true, note: "any open order" },
      { label: "Set TP / SL", ok: true, note: "required on every action" },
      { label: "Withdraw funds", ok: false, note: "not granted, ever" },
      { label: "Transfer assets", ok: false, note: "not granted, ever" },
    ],
    foot: "Funds stay in your Hyperliquid account",
  },
  {
    id: "sol",
    tab: "Solana",
    title: "Policy-scoped wallet",
    addr: "7Fq2 · · · · Wm9K",
    scope: "policy-bound · revocable · per-swap limits",
    perms: [
      { label: "Swap via allowed programs", ok: true, note: "Jupiter routes only" },
      { label: "Proceeds back to you", ok: true, note: "destination is your wallet" },
      { label: "Rug checks before signing", ok: true, note: "mint · holders · LP · dev" },
      { label: "Transfer out", ok: false, note: "blocked by policy" },
      { label: "Call unlisted programs", ok: false, note: "blocked by policy" },
    ],
    foot: "Tokens and SOL stay in your Solana wallet",
  },
];

function TradingKey() {
  const reduce = useReducedMotion();
  const [k, setK] = useState<"hl" | "sol">("hl");
  const key = KEYS.find((x) => x.id === k)!;
  const PERMS = key.perms;
  return (
    <div className="relative overflow-hidden rounded-[24px] border border-line-2 bg-[linear-gradient(160deg,#16191f,#0c0d10_60%)] p-6 shadow-[0_40px_100px_-30px_rgba(0,0,0,.9),inset_0_1px_0_rgba(255,255,255,.06)]">
      {/* holographic sheen */}
      <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-[radial-gradient(closest-side,rgba(205,255,63,.18),transparent)] blur-2xl" />
      {!reduce && (
        <motion.div
          className="pointer-events-none absolute inset-x-0 h-24 bg-gradient-to-b from-transparent via-[rgba(205,255,63,.07)] to-transparent"
          animate={{ y: ["-30%", "420%"] }}
          transition={{ duration: 4.5, repeat: Infinity, ease: "linear", repeatDelay: 1.5 }}
        />
      )}
      <div className="relative mb-5 inline-grid grid-cols-2 rounded-full border border-line bg-black/30 p-1 font-mono text-[10.5px] uppercase tracking-[0.12em]" role="group" aria-label="Venue">
        {KEYS.map((x) => (
          <button key={x.id} type="button" aria-pressed={k === x.id} onClick={() => setK(x.id)} className="relative z-10 rounded-full px-3.5 py-1.5">
            {k === x.id && <motion.span layoutId="key-tab" className="absolute inset-0 -z-10 rounded-full bg-card-2 shadow-card" transition={{ type: "spring", stiffness: 500, damping: 36 }} />}
            <span className={k === x.id ? "text-ink" : "text-muted"}>{x.tab}</span>
          </button>
        ))}
      </div>
      <div className="relative flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted">
            <IconKey size={13} className="text-volt" /> {key.title}
          </div>
          <div className="mt-3 font-mono text-[15px] tracking-wider text-ink">{key.addr}</div>
          <div className="mt-1 font-mono text-[11px] text-faint">{key.scope}</div>
        </div>
        <div className="grid h-12 w-12 place-items-center rounded-2xl border border-line-2 bg-card/50 text-volt">
          <IconShield size={22} />
        </div>
      </div>
      <div className="relative mt-6 divide-y divide-[var(--line)] rounded-2xl border border-line bg-black/20">
        {PERMS.map((p, i) => (
          <motion.div
            key={`${k}-${p.label}`}
            initial={{ opacity: 0, x: -10 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.2 + i * 0.08, duration: 0.5 }}
            className="flex items-center gap-3 px-4 py-3"
          >
            <span
              className={`grid h-6 w-6 place-items-center rounded-full ${p.ok ? "bg-[var(--long-soft)] text-long" : "bg-[var(--short-soft)] text-short"}`}
            >
              {p.ok ? <IconCheck size={12} strokeWidth={2.2} /> : <IconLock size={12} />}
            </span>
            <span className={`text-[14px] ${p.ok ? "text-ink" : "text-ink-2 line-through decoration-short/60"}`}>{p.label}</span>
            <span className="ml-auto hidden text-right font-mono text-[10.5px] text-faint sm:inline">{p.note}</span>
          </motion.div>
        ))}
      </div>
      <div className="relative mt-5 flex items-center justify-between font-mono text-[10.5px] text-faint">
        <span className="max-w-[60%]">{key.foot}</span>
        <span className="shrink-0 text-volt">Revoke anytime</span>
      </div>
    </div>
  );
}

/* ---------- Control tiles ---------- */
function Toggle({ on, onClick, locked, label }: { on: boolean; onClick?: () => void; locked?: boolean; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors duration-300 ${on ? "bg-volt" : "bg-line-2"}`}
    >
      <motion.span
        layout
        transition={{ type: "spring", stiffness: 600, damping: 32 }}
        className={`absolute top-1 grid h-5 w-5 place-items-center rounded-full bg-[#0b0c0f] text-volt ${on ? "right-1" : "left-1"}`}
        style={on ? {} : { background: "var(--ink)" }}
      >
        {locked && <IconLock size={9} />}
      </motion.span>
    </button>
  );
}

function Tile({ title, body, children, className = "" }: { title: string; body: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex h-full flex-col rounded-[20px] border border-line bg-card/60 p-5 backdrop-blur-sm ${className}`}>
      <div className="text-[16px] font-semibold tracking-[-0.02em] text-ink">{title}</div>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{body}</p>
      <div className="mt-auto pt-5">{children}</div>
    </div>
  );
}

function ApprovalTile() {
  const [on, setOn] = useState(true);
  return (
    <Tile title="Approval before live" body="Nothing touches real money until you review the graph and press approve.">
      <div className="flex items-center justify-between rounded-xl border border-line bg-black/20 px-3 py-2.5">
        <span className="font-mono text-[11px] text-ink-2">{on ? "Ask me before going live" : "Auto-promote after 7d paper"}</span>
        <Toggle on={on} onClick={() => setOn(!on)} label="Require approval" />
      </div>
    </Tile>
  );
}

function CapsTile() {
  const [perTrade, setPerTrade] = useState(10);
  const [total, setTotal] = useState(40);
  const Slider = ({ v, set, min, max, label }: { v: number; set: (n: number) => void; min: number; max: number; label: string }) => (
    <label className="block">
      <div className="flex justify-between font-mono text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="tnum text-ink">{v}%</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={v}
        onChange={(e) => set(+e.target.value)}
        className="mt-2 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-line-2 accent-[#cdff3f] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-volt [&::-webkit-slider-thumb]:shadow-[0_0_0_4px_rgba(205,255,63,.2)]"
        style={{ background: `linear-gradient(to right, var(--volt) ${((v - min) / (max - min)) * 100}%, var(--line-2) 0)` }}
      />
    </label>
  );
  return (
    <Tile title="Hard caps" body="Per-trade and total exposure limits the agent can't exceed, whatever the graph says.">
      <div className="space-y-4">
        <Slider v={perTrade} set={setPerTrade} min={1} max={25} label="Max per trade" />
        <Slider v={total} set={setTotal} min={10} max={100} label="Max total exposure" />
      </div>
    </Tile>
  );
}

function StopsTile() {
  const [nudge, setNudge] = useState(0);
  return (
    <Tile title="Mandatory stops" body="Every action ships with a stop-loss. No stop, no trade. This one doesn't switch off.">
      <motion.div
        key={nudge}
        animate={nudge ? { x: [0, -7, 7, -5, 5, 0] } : {}}
        transition={{ duration: 0.45 }}
        className="flex items-center justify-between rounded-xl border border-line bg-black/20 px-3 py-2.5"
      >
        <span className="font-mono text-[11px] text-ink-2">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={nudge > 0 ? "n" : "d"} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="block">
              {nudge > 0 ? "Nice try. Stops are required." : "Stop-loss on every action"}
            </motion.span>
          </AnimatePresence>
        </span>
        <Toggle on locked onClick={() => setNudge((n) => n + 1)} label="Mandatory stops (locked)" />
      </motion.div>
    </Tile>
  );
}

function PaperTile() {
  const [mode, setMode] = useState<"paper" | "live">("paper");
  return (
    <Tile title="Paper by default" body="Every new or forked strategy starts on paper with simulated fills against live prices.">
      <div className="relative grid grid-cols-2 rounded-xl border border-line bg-black/20 p-1 font-mono text-[11px] uppercase tracking-[0.1em]">
        {(["paper", "live"] as const).map((m) => (
          <button key={m} onClick={() => setMode(m)} className="relative z-10 py-2 text-center">
            {mode === m && <motion.span layoutId="paper-pill" className="absolute inset-0 -z-10 rounded-lg bg-card-2 shadow-card" />}
            <span className={mode === m ? "text-ink" : "text-muted"}>{m}</span>
          </button>
        ))}
      </div>
      <div className="mt-2 h-4 font-mono text-[10.5px] text-trigger">{mode === "live" ? "Requires your approval + caps set" : ""}</div>
    </Tile>
  );
}

const RUG_RULES = [
  { k: "Mint authority", v: "must be revoked" },
  { k: "Freeze authority", v: "must be revoked" },
  { k: "Top-10 holders", v: "≤ 30% of supply" },
  { k: "Liquidity", v: "≥ $250k" },
  { k: "Dev wallet", v: "sold < 20%" },
  { k: "Price impact", v: "< 1% at your size" },
];

function RugTile() {
  return (
    <Tile
      title="Rug checks on every token"
      body="Solana tokens are matched by mint, never by ticker. Before any swap the agent checks the token itself. Fail one rule and the swap doesn't happen."
    >
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {RUG_RULES.map((r, i) => (
          <motion.li
            key={r.k}
            initial={{ opacity: 0, y: 6 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.15 + i * 0.06, duration: 0.45 }}
            className="flex items-center gap-2.5 rounded-lg border border-line bg-black/20 px-3 py-2 font-mono text-[11px]"
          >
            <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-[var(--long-soft)] text-long">
              <IconCheck size={10} strokeWidth={2.4} />
            </span>
            <span className="text-ink">{r.k}</span>
            <span className="ml-auto truncate text-faint">{r.v}</span>
          </motion.li>
        ))}
      </ul>
    </Tile>
  );
}

function AlertsTile() {
  const [alertsOnly, setAlertsOnly] = useState(false);
  return (
    <Tile title="Alerts-only mode" body="Any strategy can just notify you on Telegram or push instead of trading. The graph watches; you decide.">
      <div className="flex items-center justify-between rounded-xl border border-line bg-black/20 px-3 py-2.5">
        <span className="font-mono text-[11px] text-ink-2">{alertsOnly ? "Notify me, never trade" : "Trade when triggers fire"}</span>
        <Toggle on={alertsOnly} onClick={() => setAlertsOnly(!alertsOnly)} label="Alerts-only mode" />
      </div>
      <div className="mt-2 h-4 font-mono text-[10.5px] text-volt">{alertsOnly ? "Telegram + push · no orders, no swaps" : ""}</div>
    </Tile>
  );
}

const POSITIONS = [
  { a: "LONG WHEAT 3×", pnl: "+4.2%" },
  { a: "BUY YES · El Niño", pnl: "+9.6%" },
  { a: "SHORT SOL 2×", pnl: "+5.2%" },
  { a: "HOLD PUMP · 0.5 SOL", pnl: "+12.6%" },
];

function KillTile() {
  const reduce = useReducedMotion();
  const progress = useMotionValue(0);
  const dash = useTransform(progress, (p) => 2 * Math.PI * 26 * (1 - p));
  const [state, setState] = useState<"armed" | "firing" | "done">("armed");
  const [closed, setClosed] = useState(0);
  const ctrl = useRef<ReturnType<typeof animate> | null>(null);

  const start = () => {
    if (state !== "armed") return;
    ctrl.current?.stop();
    ctrl.current = animate(progress, 1, {
      duration: reduce ? 0.01 : 1.1,
      ease: "linear",
      onComplete: () => setState("firing"),
    });
  };
  const cancel = () => {
    if (state !== "armed") return;
    ctrl.current?.stop();
    ctrl.current = animate(progress, 0, { duration: 0.3 });
  };
  useEffect(() => {
    if (state !== "firing") return;
    setClosed(0);
    const ids = POSITIONS.map((_, i) => window.setTimeout(() => setClosed(i + 1), 250 + i * 280));
    const done = window.setTimeout(() => setState("done"), 250 + POSITIONS.length * 280 + 200);
    return () => [...ids, done].forEach(clearTimeout);
  }, [state]);
  const reset = () => {
    setState("armed");
    setClosed(0);
    progress.set(0);
  };

  return (
    <div className="relative flex flex-col overflow-hidden rounded-[20px] border border-[color-mix(in_oklab,var(--short)_35%,transparent)] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--short)_10%,transparent),transparent)] p-5 h-full min-h-[360px]">
      <div className="text-[16px] font-semibold tracking-[-0.02em] text-ink">Kill switch</div>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">One hold closes every position, cancels every order and revokes the key. Try it.</p>
      <div className="mt-5 space-y-1.5">
        {POSITIONS.map((p, i) => {
          const isClosed = closed > i || state === "done";
          return (
            <div key={p.a} className="flex items-center justify-between rounded-lg border border-line bg-black/20 px-3 py-2 font-mono text-[11px]">
              <span className={isClosed ? "text-faint line-through" : "text-ink-2"}>{p.a}</span>
              <AnimatePresence mode="wait" initial={false}>
                {isClosed ? (
                  <motion.span key="c" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} className="text-muted">
                    closed
                  </motion.span>
                ) : (
                  <motion.span key="o" className="text-long">{p.pnl}</motion.span>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
      <div className="mt-auto flex flex-col items-center pt-6">
        {state === "done" ? (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="text-center">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[var(--short-soft)] text-short">
              <IconX size={22} />
            </div>
            <div className="mt-3 text-[13.5px] text-ink">All positions closed · key revoked</div>
            <button onClick={reset} className="mt-2 font-mono text-[11px] uppercase tracking-[0.1em] text-muted underline-offset-4 hover:text-ink hover:underline">
              Reset demo
            </button>
          </motion.div>
        ) : (
          <>
            <button
              onPointerDown={start}
              onPointerUp={cancel}
              onPointerLeave={cancel}
              onKeyDown={(e) => (e.key === " " || e.key === "Enter") && !e.repeat && start()}
              onKeyUp={cancel}
              aria-label="Hold to activate kill switch"
              className="relative grid h-[76px] w-[76px] touch-none select-none place-items-center rounded-full"
            >
              <svg width="76" height="76" viewBox="0 0 76 76" className="absolute inset-0 -rotate-90">
                <circle cx="38" cy="38" r="26" fill="none" strokeWidth="3" style={{ stroke: "var(--line-2)" }} />
                <motion.circle cx="38" cy="38" r="26" fill="none" strokeWidth="3" strokeLinecap="round" strokeDasharray={2 * Math.PI * 26} style={{ strokeDashoffset: dash, stroke: "var(--short)" }} />
              </svg>
              <span className="grid h-[46px] w-[46px] place-items-center rounded-full bg-short text-white shadow-[0_10px_30px_-6px_var(--short)] transition-transform active:scale-95">
                <IconPower size={18} />
              </span>
            </button>
            <div className="mt-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">{state === "firing" ? "Closing…" : "Hold to kill"}</div>
          </>
        )}
      </div>
    </div>
  );
}

export function Safety() {
  return (
    <section id="safety" className="night grain relative overflow-hidden py-24 md:py-36">
      <div className="absolute inset-0 opacity-50 [mask-image:radial-gradient(ellipse_at_70%_20%,black,transparent_70%)]">
        <ThreadField className="absolute inset-0 h-full w-full" density={26} accentEvery={9} />
      </div>
      <div className="relative mx-auto max-w-[1240px] px-5">
        <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <SectionHeading
            eyebrow="Control & safety"
            title={
              <>
                It can trade. <br />
                It <span className="serif-em text-volt">can&apos;t</span> withdraw.
              </>
            }
            sub="On Hyperliquid the agent uses an API wallet that can trade but not withdraw. On Solana it signs through a policy-scoped wallet: swaps through allowed programs, straight back into your wallet, with transfers out blocked. Every guardrail is yours to set."
          />
          <Reveal delay={0.1}>
            <TradingKey />
          </Reveal>
        </div>

        <div className="mt-16 grid gap-3 md:grid-cols-2 lg:grid-cols-[repeat(2,minmax(0,1fr))_minmax(0,1.05fr)]">
          <Reveal><ApprovalTile /></Reveal>
          <Reveal delay={0.05}><CapsTile /></Reveal>
          <Reveal delay={0.1} className="md:col-span-2 lg:col-span-1 lg:row-span-2"><KillTile /></Reveal>
          <Reveal delay={0.1}><StopsTile /></Reveal>
          <Reveal delay={0.15}><PaperTile /></Reveal>
          <Reveal className="md:col-span-2"><RugTile /></Reveal>
          <Reveal delay={0.08} className="md:col-span-2 lg:col-span-1"><AlertsTile /></Reveal>
        </div>
      </div>
    </section>
  );
}
