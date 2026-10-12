"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { AnimatePresence, LayoutGroup, motion, useMotionTemplate, useMotionValue, useSpring, useTransform } from "motion/react";
import { brand } from "@/config/brand";
import { leaderboard, strategies, type LeaderRow } from "@/data/mock";
import { fmtNum, fmtPct, walk } from "@/lib/rng";
import { SectionHeading, Reveal } from "../ui/Reveal";
import { CountUp } from "../ui/CountUp";
import { Sparkline } from "../ui/Sparkline";
import { LogoMark } from "../ui/Logo";
import { StrategyGraph } from "../graph/StrategyGraph";
import { IconArrowRight, IconCheck, IconCopy, IconEye, IconFork, IconShield } from "../graph/icons";
import { useReducedMotion } from "@/lib/hooks";

const EASE = [0.22, 1, 0.36, 1] as const;
const ROW_SPRING = { type: "spring", stiffness: 420, damping: 38, mass: 0.9 } as const;

type Range = "7d" | "30d" | "all";
const RANGES: { key: Range; label: string; long: string }[] = [
  { key: "7d", label: "7D", long: "7-day" },
  { key: "30d", label: "30D", long: "30-day" },
  { key: "all", label: "All-time", long: "All-time" },
];

const retOf = (r: LeaderRow, range: Range) => (range === "7d" ? r.r7 : range === "30d" ? r.r30 : r.rAll);

/** Desktop column template (lg+). */
const COLS =
  "lg:grid-cols-[44px_minmax(0,2.3fr)_74px_minmax(0,1fr)_68px_76px_64px_92px_104px]";

const shareStrategy = strategies[0];
const sharePath = `${brand.domain}/s/${shareStrategy.id}`;
const shareUrl = `https://${sharePath}`;

/* ------------------------------------------------------------------ */
/* Small pieces                                                        */
/* ------------------------------------------------------------------ */

function RankBadge({ rank }: { rank: number }) {
  const label = String(rank).padStart(2, "0");
  if (rank === 1)
    return (
      <span className="relative grid h-7 w-7 place-items-center rounded-[8px] bg-volt font-mono text-[11px] font-semibold text-[#0b0c0f] tnum shadow-[0_0_0_1px_rgba(0,0,0,.06)_inset,0_6px_18px_-6px_color-mix(in_oklab,var(--volt)_90%,transparent)]">
        {label}
      </span>
    );
  if (rank <= 3)
    return (
      <span className="grid h-7 w-7 place-items-center rounded-[8px] bg-ink font-mono text-[11px] font-semibold text-paper tnum">
        {label}
      </span>
    );
  return <span className="grid h-7 w-7 place-items-center font-mono text-[11px] text-faint tnum">{label}</span>;
}

function ModeBadge({ mode }: { mode: LeaderRow["mode"] }) {
  const live = mode === "Live";
  return (
    <span
      className={`inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2 font-mono text-[10px] font-medium uppercase tracking-[0.08em] ${
        live ? "border-transparent bg-[var(--long-soft)] text-long" : "border-line-2 text-muted"
      }`}
    >
      <span className={`relative h-[5px] w-[5px] rounded-full ${live ? "bg-long" : "bg-faint"}`}>
        {live && <span className="pulse-ring absolute inset-0 rounded-full bg-long" />}
      </span>
      {mode}
    </span>
  );
}

function CategoryChip({ children }: { children: string }) {
  return (
    <span className="inline-flex h-[18px] items-center rounded-[5px] border border-line bg-paper-2 px-1.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.08em] text-ink-2">
      {children}
    </span>
  );
}

function Ret({ value, className = "" }: { value: number; className?: string }) {
  return (
    <CountUp
      value={value}
      duration={0.9}
      format={(v) => fmtPct(v, 1)}
      className={`font-mono tnum transition-colors duration-500 ${value >= 0 ? "text-long" : "text-short"} ${className}`}
    />
  );
}

function ForkButton({ forked, onFork, name, count }: { forked: boolean; onFork: () => void; name: string; count?: number }) {
  return (
    <motion.button
      type="button"
      layout
      onClick={onFork}
      disabled={forked}
      aria-label={forked ? `${name} forked` : `Fork ${name}`}
      transition={{ layout: { type: "spring", stiffness: 500, damping: 34 } }}
      className={`relative inline-flex h-8 items-center justify-center gap-1.5 overflow-hidden rounded-full px-3 text-[12.5px] font-medium tracking-[-0.01em] transition-colors duration-300 ${
        forked
          ? "cursor-default bg-[var(--long-soft)] text-long"
          : "border border-line-2 bg-card text-ink hover:border-transparent hover:bg-ink hover:text-paper"
      }`}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {forked ? (
          <motion.span
            key="done"
            className="inline-flex items-center gap-1.5"
            initial={{ y: 12, opacity: 0, filter: "blur(3px)" }}
            animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
            transition={{ duration: 0.35, ease: EASE }}
          >
            Forked <IconCheck size={13} strokeWidth={2} />
          </motion.span>
        ) : (
          <motion.span
            key="fork"
            className="inline-flex items-center gap-1.5"
            exit={{ y: -12, opacity: 0, filter: "blur(3px)" }}
            transition={{ duration: 0.25, ease: EASE }}
          >
            <IconFork size={13} /> Fork
            {count != null && <span className="font-mono text-[11px] text-muted tnum sm:hidden">{fmtNum(count)}</span>}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
}

/* ------------------------------------------------------------------ */
/* Row                                                                 */
/* ------------------------------------------------------------------ */

const Row = memo(function Row({
  row,
  rank,
  range,
  forked,
  onFork,
  reduce,
}: {
  row: LeaderRow;
  rank: number;
  range: Range;
  forked: boolean;
  onFork: (id: string) => void;
  reduce: boolean;
}) {
  const ret = retOf(row, range);
  const spark = useMemo(() => {
    const n = range === "7d" ? 18 : range === "30d" ? 30 : 44;
    const seed = row.seed * 13 + (range === "7d" ? 1 : range === "30d" ? 2 : 3);
    const drift = Math.max(-0.5, Math.min(0.9, (ret / n) * 3.2));
    return walk(seed, n, drift, 0.55);
  }, [row.seed, range, ret]);
  const color = ret >= 0 ? "var(--long)" : "var(--short)";
  const top = rank <= 3;
  const fork = () => onFork(row.id);

  return (
    <motion.li
      layout={reduce ? false : "position"}
      transition={ROW_SPRING}
      className={`group relative border-t border-line first:border-t-0 ${top ? "" : ""}`}
    >
      {/* hover wash + accent */}
      <span className="pointer-events-none absolute inset-0 bg-paper-2/0 transition-colors duration-300 group-hover:bg-[color-mix(in_oklab,var(--paper-2)_70%,transparent)]" />
      <span className="pointer-events-none absolute inset-y-2 left-0 w-[2px] origin-center scale-y-0 rounded-full bg-volt transition-transform duration-300 group-hover:scale-y-100" />
      {rank === 1 && (
        <span className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,color-mix(in_oklab,var(--volt)_14%,transparent),transparent_42%)]" />
      )}

      {/* Desktop row */}
      <div className={`relative hidden items-center gap-4 px-5 py-3.5 lg:grid ${COLS}`}>
        <RankBadge rank={rank} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold tracking-[-0.02em] text-ink">{row.name}</span>
            <CategoryChip>{row.category}</CategoryChip>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted">{row.author}</div>
        </div>
        <div>
          <ModeBadge mode={row.mode} />
        </div>
        <div className="text-right">
          <Ret value={ret} className="text-[17px] font-semibold tracking-[-0.02em]" />
        </div>
        <div className="text-right font-mono text-[13px] text-ink-2 tnum">{row.winRate}%</div>
        <div className="text-right font-mono text-[13px] text-ink-2 tnum">{fmtPct(row.maxDD, 1)}</div>
        <div className="flex items-center justify-end gap-1 font-mono text-[13px] text-ink-2 tnum">
          <CountUp value={row.forks + (forked ? 1 : 0)} duration={0.5} format={(v) => fmtNum(v)} />
        </div>
        <div className="flex justify-end">
          <Sparkline data={spark} width={84} height={26} color={color} strokeWidth={1.4} />
        </div>
        <div className="flex justify-end">
          <ForkButton forked={forked} onFork={fork} name={row.name} />
        </div>
      </div>

      {/* Mobile / tablet row */}
      <div className="relative grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-4 sm:px-5 lg:hidden">
        <RankBadge rank={rank} />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[15px] font-semibold tracking-[-0.02em] text-ink">{row.name}</span>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-[11px] text-muted">{row.author}</span>
            <CategoryChip>{row.category}</CategoryChip>
          </div>
        </div>
        <div className="flex flex-col items-end">
          <Ret value={ret} className="text-[17px] font-semibold tracking-[-0.02em]" />
          <Sparkline data={spark} width={64} height={18} color={color} strokeWidth={1.3} className="mt-1" />
        </div>
        <div className="col-start-2 col-end-4 mt-3 flex items-center justify-between gap-x-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 font-mono text-[11px] text-muted tnum">
            <ModeBadge mode={row.mode} />
            <span>
              Win <span className="text-ink-2">{row.winRate}%</span>
            </span>
            <span className="hidden sm:inline">
              DD <span className="text-ink-2">{fmtPct(row.maxDD, 1)}</span>
            </span>
            <span className="hidden items-center gap-1 sm:inline-flex">
              <IconFork size={11} />
              <span className="text-ink-2">{fmtNum(row.forks + (forked ? 1 : 0))}</span>
            </span>
          </div>
          <ForkButton forked={forked} onFork={fork} name={row.name} count={row.forks} />
        </div>
      </div>
    </motion.li>
  );
});

/* ------------------------------------------------------------------ */
/* Board                                                               */
/* ------------------------------------------------------------------ */

function Board({ onFork, forked }: { onFork: (id: string) => void; forked: Set<string> }) {
  const reduce = !!useReducedMotion();
  const [range, setRange] = useState<Range>("30d");
  const rows = useMemo(() => [...leaderboard].sort((a, b) => retOf(b, range) - retOf(a, range)), [range]);
  const active = RANGES.find((r) => r.key === range)!;

  return (
    <div className="overflow-hidden rounded-[20px] border border-line bg-card shadow-card">
      {/* toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <LayoutGroup id="lb-range">
          <div role="tablist" aria-label="Return window" className="relative inline-flex rounded-full border border-line bg-paper-2/60 p-1">
            {RANGES.map((r) => {
              const on = r.key === range;
              return (
                <button
                  key={r.key}
                  role="tab"
                  aria-selected={on}
                  onClick={() => setRange(r.key)}
                  className={`relative h-8 rounded-full px-3.5 font-mono text-[11.5px] font-medium tracking-[0.04em] transition-colors duration-300 sm:px-4 ${
                    on ? "text-paper" : "text-muted hover:text-ink"
                  }`}
                >
                  {on && (
                    <motion.span
                      layoutId="lb-range-pill"
                      className="absolute inset-0 rounded-full bg-ink shadow-[0_6px_16px_-8px_rgba(11,12,15,.6)]"
                      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 480, damping: 36 }}
                    />
                  )}
                  <span className="relative">{r.label}</span>
                </button>
              );
            })}
          </div>
        </LayoutGroup>
        <div className="flex items-center gap-3 font-mono text-[11px] text-muted">
          <span className="hidden items-center gap-1.5 sm:inline-flex">
            <IconShield size={13} className="text-long" />
            Fills verified on-chain
          </span>
          <span className="hidden h-3 w-px bg-line-2 sm:block" />
          <span className="tnum">{leaderboard.length} strategies</span>
        </div>
      </div>

      {/* header (desktop) */}
      <div
        className={`hidden items-center gap-4 border-b border-line bg-card-2 px-5 py-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-faint lg:grid ${COLS}`}
      >
        <span>#</span>
        <span>Strategy</span>
        <span>Mode</span>
        <span className="text-right">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={range}
              className="inline-block"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
            >
              {active.long} return
            </motion.span>
          </AnimatePresence>
        </span>
        <span className="text-right">Win</span>
        <span className="text-right">Max DD</span>
        <span className="text-right">Forks</span>
        <span className="text-right">Equity</span>
        <span />
      </div>

      <ul className="relative">
        {rows.map((row, i) => (
          <Row key={row.id} row={row} rank={i + 1} range={range} forked={forked.has(row.id)} onFork={onFork} reduce={reduce} />
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-card-2 px-4 py-3 font-mono text-[11px] text-muted sm:px-5">
        <span>Ranked by {active.long.toLowerCase()} return · net of fees</span>
        <a href="#gallery" className="group inline-flex items-center gap-1.5 text-ink-2 transition-colors hover:text-ink">
          View all strategies <IconArrowRight size={12} className="transition-transform group-hover:translate-x-0.5" />
        </a>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Share card                                                          */
/* ------------------------------------------------------------------ */

function TiltCard({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);
  const sx = useSpring(px, { stiffness: 180, damping: 20, mass: 0.5 });
  const sy = useSpring(py, { stiffness: 180, damping: 20, mass: 0.5 });
  const rotateY = useTransform(sx, [0, 1], [-7, 7]);
  const rotateX = useTransform(sy, [0, 1], [6, -6]);
  const gx = useTransform(sx, (v) => `${(v * 100).toFixed(1)}%`);
  const gy = useTransform(sy, (v) => `${(v * 100).toFixed(1)}%`);
  const glare = useMotionTemplate`radial-gradient(520px circle at ${gx} ${gy}, rgba(255,255,255,0.10), transparent 45%)`;
  const glareOpacity = useMotionValue(0);
  const glareO = useSpring(glareOpacity, { stiffness: 200, damping: 30 });

  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (reduce || e.pointerType !== "mouse" || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    px.set((e.clientX - r.left) / r.width);
    py.set((e.clientY - r.top) / r.height);
    glareOpacity.set(1);
  };
  const onLeave = () => {
    px.set(0.5);
    py.set(0.5);
    glareOpacity.set(0);
  };

  return (
    <div className="[perspective:1400px]">
      <motion.div
        ref={ref}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        style={reduce ? undefined : { rotateX, rotateY, transformStyle: "preserve-3d" }}
        className="relative will-change-transform"
      >
        {children}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[22px]"
          style={{ background: glare, opacity: glareO }}
        />
      </motion.div>
    </div>
  );
}

function ShareCard() {
  const s = shareStrategy;
  return (
    <TiltCard>
      <div className="night relative overflow-hidden rounded-[22px] border border-line-2 shadow-[0_1px_0_rgba(255,255,255,.06)_inset,0_30px_80px_-30px_rgba(11,12,15,.55),0_12px_30px_-16px_rgba(11,12,15,.35)]">
        {/* backdrop */}
        <div className="pointer-events-none absolute inset-0 dot-grid opacity-70 [mask-image:radial-gradient(120%_90%_at_100%_100%,black,transparent_70%)]" />
        <div className="pointer-events-none absolute -right-24 -top-28 h-[320px] w-[320px] rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--volt)_26%,transparent),transparent)] blur-2xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-20 h-[300px] w-[360px] rounded-full bg-[radial-gradient(closest-side,var(--signal-soft),transparent)] blur-2xl" />

        <div className="relative p-5 sm:p-7">
          {/* top bar */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <LogoMark size={26} />
              <span className="text-[16px] font-semibold tracking-[-0.04em] text-ink">{brand.name.toLowerCase()}</span>
              <span className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-faint sm:inline">/ strategy</span>
            </div>
            <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full border border-line-2 px-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
              <span className="h-[5px] w-[5px] rounded-full bg-volt shadow-[0_0_8px_var(--volt)]" />
              {s.mode} · {s.stats.daysLive}d
            </span>
          </div>

          <div className="mt-6 grid gap-6 sm:mt-7 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] sm:items-end">
            <div className="min-w-0">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint">{s.category}</div>
              <div className="mt-1.5 text-[clamp(1.6rem,3.2vw,2.15rem)] font-semibold leading-[1.02] tracking-[-0.045em] text-ink">
                {s.title}
              </div>
              <div className="mt-1.5 font-mono text-[12px] text-muted">by {s.author}</div>

              <div className="mt-6">
                <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint">30D return</div>
                <div className="mt-1 font-mono text-[clamp(2.6rem,6vw,3.6rem)] font-semibold leading-none tracking-[-0.06em] text-volt tnum [text-shadow:0_0_32px_color-mix(in_oklab,var(--volt)_40%,transparent)]">
                  {fmtPct(s.stats.ret30d, 1)}
                </div>
              </div>
            </div>
            <div className="relative min-w-0 rounded-[14px] border border-line bg-paper-2/60 p-2.5">
              <StrategyGraph spec={s} preset="compact" instant interactive={false} live={false} ariaLabel={`${s.title} strategy graph`} />
            </div>
          </div>

          {/* footer stats */}
          <div className="mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-[12px] border border-line bg-line">
            {[
              ["Win rate", `${s.stats.winRate}%`],
              ["Max DD", fmtPct(s.stats.maxDD, 1)],
              ["Forks", fmtNum(s.stats.forks)],
            ].map(([k, v]) => (
              <div key={k} className="bg-[color-mix(in_oklab,var(--card)_80%,transparent)] px-3 py-2.5">
                <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint">{k}</div>
                <div className="mt-0.5 font-mono text-[14px] text-ink tnum">{v}</div>
              </div>
            ))}
          </div>

          <div className="mt-5 flex items-center justify-between gap-3 font-mono text-[11px] text-muted">
            <span className="truncate">{sharePath}</span>
            <span className="hidden shrink-0 items-center gap-1.5 sm:inline-flex">
              <IconShield size={12} className="text-long" /> verified fills
            </span>
          </div>
        </div>
      </div>
    </TiltCard>
  );
}

function XLogo({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function SharePanel() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      /* clipboard may be blocked; still show feedback for the demo */
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  };

  const s = shareStrategy;
  const tweet = `${s.title} by ${s.author} is up ${fmtPct(s.stats.ret30d, 1)} in 30 days on ${brand.name}. Every fill is on-chain. Fork it:`;
  const intent = `https://x.com/intent/tweet?text=${encodeURIComponent(tweet)}&url=${encodeURIComponent(shareUrl)}`;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-14">
      <Reveal className="order-2 min-w-0 lg:order-1">
        <div className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-muted">Share your strategy</div>
        <h3 className="mt-3 text-[clamp(1.6rem,3vw,2.3rem)] font-semibold leading-[1.05] tracking-[-0.04em] text-ink text-balance">
          One link. The graph, the fills, the P&amp;L. <span className="serif-em text-ink-2">Unfakeable.</span>
        </h3>
        <p className="mt-4 max-w-md text-[15.5px] leading-relaxed text-ink-2 text-pretty">
          Every strategy gets a public page and a share card that renders itself. Anyone who opens it sees the live graph and can fork it in one click.
        </p>
        <ul className="mt-6 space-y-2.5 text-[14px] text-ink-2">
          {[
            [IconEye, "Live graph and positions, read-only"],
            [IconShield, "Returns computed from on-chain fills"],
            [IconFork, "Forks credit the original author"],
          ].map(([Icon, t], i) => {
            const I = Icon as typeof IconEye;
            return (
              <li key={i} className="flex items-center gap-2.5">
                <span className="grid h-6 w-6 place-items-center rounded-full border border-line-2 bg-card text-ink">
                  <I size={12} />
                </span>
                {t as string}
              </li>
            );
          })}
        </ul>

        <div className="mt-8 flex min-w-0 items-center gap-1.5 rounded-full border border-line-2 bg-card p-1.5 pl-4 shadow-card">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-long" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink-2">{sharePath}</span>
          <button
            type="button"
            onClick={copy}
            className="relative inline-flex h-9 shrink-0 items-center gap-1.5 overflow-hidden rounded-full border border-line-2 bg-card-2 px-3.5 text-[13px] font-medium text-ink transition-colors hover:bg-paper-2"
            aria-live="polite"
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={copied ? "y" : "n"}
                className={`inline-flex items-center gap-1.5 ${copied ? "text-long" : ""}`}
                initial={{ y: 10, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -10, opacity: 0 }}
                transition={{ duration: 0.25, ease: EASE }}
              >
                {copied ? <IconCheck size={13} strokeWidth={2} /> : <IconCopy size={13} />}
                {copied ? "Copied" : "Copy link"}
              </motion.span>
            </AnimatePresence>
          </button>
          <a
            href={intent}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Share on X"
            className="inline-flex h-9 min-w-9 shrink-0 justify-center items-center gap-1.5 rounded-full bg-ink px-3.5 text-[13px] font-medium text-paper transition-shadow hover:shadow-[0_10px_24px_-10px_rgba(11,12,15,.6)]"
          >
            <XLogo size={12} /> <span className="hidden min-[420px]:inline">Share on X</span>
          </a>
        </div>
      </Reveal>
      <Reveal delay={0.08} className="relative order-1 min-w-0 lg:order-2">
        <div aria-hidden className="pointer-events-none absolute -inset-10 rounded-[48px] bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--volt)_14%,transparent),transparent)] blur-2xl" />
        <ShareCard />
      </Reveal>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section                                                             */
/* ------------------------------------------------------------------ */

export function Leaderboard() {
  const [forked, setForked] = useState<Set<string>>(() => new Set());
  const [toast, setToast] = useState<{ id: number; name: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (toastTimer.current && clearTimeout(toastTimer.current)), []);

  const onFork = useCallback((id: string) => {
    setForked((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    const row = leaderboard.find((r) => r.id === id);
    setToast({ id: Date.now(), name: row?.name ?? "Strategy" });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  return (
    <section id="leaderboard" className="relative overflow-x-clip py-24 md:py-36">
      <div className="mx-auto max-w-[1240px] px-5">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <SectionHeading
            eyebrow="Public strategies"
            title={
              <>
                Every strategy is <span className="serif-em">public.</span> Fork the ones that work.
              </>
            }
            sub="Returns are computed from fills you can verify on-chain, not screenshots. Every strategy has a shareable link, and any of them can be forked into your drafts in one click."
          />
          <Reveal delay={0.15} className="shrink-0">
            <div className="flex gap-6 font-mono text-[11px] text-muted lg:flex-col lg:gap-3 lg:text-right">
              <div>
                <div className="text-[22px] font-semibold tracking-[-0.04em] text-ink tnum">
                  {fmtNum(leaderboard.reduce((a, r) => a + r.forks, 0))}
                </div>
                forks this month
              </div>
              <div>
                <div className="text-[22px] font-semibold tracking-[-0.04em] text-ink tnum">
                  {leaderboard.filter((r) => r.mode === "Live").length}/{leaderboard.length}
                </div>
                trading live
              </div>
            </div>
          </Reveal>
        </div>

        <Reveal delay={0.1} className="mt-12 md:mt-16">
          <Board onFork={onFork} forked={forked} />
        </Reveal>

        <div className="mt-20 md:mt-28">
          <SharePanel />
        </div>
      </div>

      {/* Toast (outside transformed ancestors so `fixed` is viewport-relative) */}
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-5" aria-live="polite">
        <AnimatePresence>
          {toast && (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 16, scale: 0.96, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: 10, scale: 0.98, filter: "blur(4px)" }}
              transition={{ duration: 0.4, ease: EASE }}
              className="pointer-events-auto inline-flex items-center gap-2.5 rounded-full bg-ink py-2 pl-2 pr-4 text-[13px] text-paper shadow-[0_18px_40px_-14px_rgba(11,12,15,.6)]"
            >
              <span className="grid h-6 w-6 place-items-center rounded-full bg-volt text-[#0b0c0f]">
                <IconCheck size={12} strokeWidth={2.2} />
              </span>
              <span>
                Forked <span className="font-medium">{toast.name}</span> to your drafts <span className="opacity-60">(demo)</span>
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
