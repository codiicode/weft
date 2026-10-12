"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { strategies, type Strategy } from "@/data/mock";
import { brand } from "@/config/brand";
import { SectionHeading, Reveal } from "../ui/Reveal";
import { StrategyGraph } from "../graph/StrategyGraph";
import { finalRuntime } from "../graph/layout";
import { useGraphSequence } from "../graph/sequence";
import type { GraphRuntime } from "../graph/types";
import { IconArrowRight, IconCheck, IconCopy, IconEye, IconFork, IconX } from "../graph/icons";
import { fmtPct, fmtNum } from "@/lib/rng";

/** All nodes visible, nothing fired yet. */
function armedRuntime(s: Strategy): GraphRuntime {
  const f = finalRuntime(s);
  return { visible: f.visible, met: {}, active: {} };
}

function ModeBadge({ mode }: { mode: Strategy["mode"] }) {
  const live = mode === "Live";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] ${
        live ? "bg-[var(--long-soft)] text-long" : "bg-paper-2 text-muted"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-long" : "bg-faint"}`} />
      {mode}
    </span>
  );
}

function Card({ s, onOpen, wide }: { s: Strategy; onOpen: () => void; wide?: boolean }) {
  const [hover, setHover] = useState(false);
  const armed = useMemo(() => armedRuntime(s), [s]);
  const fired = useMemo(() => finalRuntime(s), [s]);
  return (
    <motion.article
      onHoverStart={() => setHover(true)}
      onHoverEnd={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      whileHover={{ y: -4 }}
      transition={{ type: "spring", stiffness: 300, damping: 26 }}
      className="group relative flex h-full cursor-pointer flex-col overflow-hidden rounded-[22px] border border-line bg-card shadow-card transition-shadow duration-500 hover:shadow-lift"
      onClick={onOpen}
    >
      <div className="flex items-center gap-2 px-5 pt-5">
        <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-2">{s.category}</span>
        <ModeBadge mode={s.mode} />
        <span className="ml-auto font-mono text-[10.5px] text-faint">{s.author}</span>
      </div>
      <h3 className="mt-4 px-5 text-[21px] font-semibold tracking-[-0.03em]">{s.title}</h3>
      <p className="mt-1.5 line-clamp-2 px-5 text-[14px] leading-relaxed text-ink-2">“{s.thesis}”</p>

      <div className="dot-grid relative mx-3 mt-5 flex-1 rounded-2xl border border-line bg-paper/60 px-3 py-4 transition-colors duration-500 group-hover:bg-paper">
        <StrategyGraph spec={s} runtime={hover ? fired : armed} preset="compact" live={hover} interactive={false} instant ariaLabel={`${s.title} strategy graph`} />
      </div>

      <div className="flex items-center gap-5 px-5 py-4">
        <div>
          <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-faint">30d</div>
          <div className="tnum font-mono text-[15px] font-medium" style={{ color: s.stats.ret30d >= 0 ? "var(--long)" : "var(--short)" }}>
            {fmtPct(s.stats.ret30d)}
          </div>
        </div>
        <div>
          <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-faint">Win rate</div>
          <div className="tnum font-mono text-[15px] text-ink">{s.stats.winRate}%</div>
        </div>
        <div>
          <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-faint">Forks</div>
          <div className="tnum font-mono text-[15px] text-ink">{fmtNum(s.stats.forks)}</div>
        </div>
        <span
          className={`ml-auto hidden items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.1em] transition-colors duration-500 sm:inline-flex ${
            hover ? "bg-[var(--long-soft)] text-long" : "text-faint"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${hover ? "bg-long" : "bg-line-2"}`} />
          {wide && (hover ? "Running" : "Hover to run")}
        </span>
        <span className="grid h-9 w-9 place-items-center rounded-full border border-line text-ink-2 transition-all duration-300 group-hover:border-ink group-hover:bg-ink group-hover:text-paper">
          <IconArrowRight size={14} className="transition-transform duration-300 group-hover:-rotate-45" />
        </span>
      </div>
    </motion.article>
  );
}

function Modal({ s, onClose }: { s: Strategy; onClose: () => void }) {
  const { runtime, replay } = useGraphSequence(s, true, 350);
  const [forked, setForked] = useState(false);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const lenis = (window as unknown as { lenis?: { stop(): void; start(): void } }).lenis;
    lenis?.stop();
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.documentElement.style.overflow = prev;
      lenis?.start();
    };
  }, [onClose]);

  const counts = {
    signals: s.nodes.filter((n) => n.kind === "signal").length,
    triggers: s.nodes.filter((n) => n.kind === "trigger").length,
    actions: s.nodes.filter((n) => n.kind === "action" || n.kind === "exit").length,
  };

  return (
    <motion.div
      className="fixed inset-0 z-[80] flex items-end justify-center p-0 sm:items-center sm:p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      role="dialog"
      aria-modal="true"
      aria-label={s.title}
      data-lenis-prevent
    >
      <div className="absolute inset-0 bg-[color-mix(in_oklab,var(--paper)_55%,transparent)] backdrop-blur-md" onClick={onClose} />
      <motion.div
        initial={{ y: 40, scale: 0.97, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ y: 30, scale: 0.98, opacity: 0 }}
        transition={{ type: "spring", stiffness: 260, damping: 30 }}
        className="relative max-h-[92vh] w-full max-w-[1180px] overflow-y-auto rounded-t-[26px] border border-line bg-card shadow-window sm:rounded-[26px]"
      >
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-card/90 px-5 py-4 backdrop-blur sm:px-7">
          <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-2">{s.category}</span>
          <ModeBadge mode={s.mode} />
          <span className="hidden font-mono text-[11px] text-muted sm:inline">
            {brand.domain}/s/{s.id}
          </span>
          <button ref={closeRef} onClick={onClose} aria-label="Close" className="ml-auto grid h-9 w-9 place-items-center rounded-full border border-line text-ink-2 hover:bg-paper hover:text-ink">
            <IconX size={14} />
          </button>
        </div>

        <div className="grid gap-8 px-5 py-6 sm:px-7 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-w-0">
            <h3 className="text-[clamp(1.8rem,4vw,2.6rem)] font-semibold leading-[1.05] tracking-[-0.04em]">{s.title}</h3>
            <p className="mt-3 max-w-2xl font-serif text-[22px] italic leading-snug text-ink-2">“{s.thesis}”</p>
            <div className="dot-grid relative mt-6 rounded-2xl border border-line bg-paper/60 px-3 pb-5 pt-6 sm:px-5">
              <StrategyGraph spec={s} runtime={runtime} preset="auto" wide="medium" stackBelow={600} live ariaLabel={`${s.title} strategy graph`} />
              <button onClick={replay} className="absolute right-3 top-3 rounded-full border border-line bg-card px-3 py-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-2 hover:text-ink">
                Replay
              </button>
            </div>
          </div>

          <aside className="space-y-4">
            <div className="rounded-2xl border border-line p-4">
              <div className="text-[13px] text-muted">by <span className="text-ink">{s.author}</span></div>
              <div className="mt-4 grid grid-cols-2 gap-y-4">
                {[
                  ["30d return", fmtPct(s.stats.ret30d), s.stats.ret30d >= 0 ? "var(--long)" : "var(--short)"],
                  ["Win rate", `${s.stats.winRate}%`],
                  ["Max drawdown", fmtPct(s.stats.maxDD), "var(--short)"],
                  ["Running", `${s.stats.daysLive}d`],
                  ["Forks", fmtNum(s.stats.forks)],
                  ["Followers", fmtNum(s.stats.followers)],
                ].map(([k, v, c]) => (
                  <div key={k}>
                    <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-faint">{k}</div>
                    <div className="tnum mt-0.5 font-mono text-[16px]" style={{ color: c || "var(--ink)" }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-line p-4 font-mono text-[11.5px] text-ink-2">
              <div className="flex justify-between"><span className="text-faint">Signals</span>{counts.signals}</div>
              <div className="mt-1.5 flex justify-between"><span className="text-faint">Triggers</span>{counts.triggers}</div>
              <div className="mt-1.5 flex justify-between"><span className="text-faint">Actions</span>{counts.actions}</div>
              <div className="mt-1.5 flex justify-between"><span className="text-faint">Venues</span>{s.venues.join(" · ")}</div>
            </div>
            <button
              onClick={() => setForked(true)}
              className={`flex h-11 w-full items-center justify-center gap-2 rounded-full text-[14px] font-medium transition-colors ${forked ? "bg-[var(--long-soft)] text-long" : "bg-ink text-paper"}`}
            >
              {forked ? <><IconCheck size={14} /> Forked to your drafts</> : <><IconFork size={14} /> Fork this strategy</>}
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(`https://${brand.domain}/s/${s.id}`);
                  } catch {}
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }}
                className="flex h-10 items-center justify-center gap-1.5 rounded-full border border-line text-[13px] text-ink-2 hover:text-ink"
              >
                {copied ? <IconCheck size={13} /> : <IconCopy size={13} />} {copied ? "Copied" : "Copy link"}
              </button>
              <button className="flex h-10 items-center justify-center gap-1.5 rounded-full border border-line text-[13px] text-ink-2 hover:text-ink">
                <IconEye size={13} /> Paper trade
              </button>
            </div>
            <p className="font-mono text-[10.5px] leading-relaxed text-faint">Demo data. Forking copies the graph, never the author’s funds or size.</p>
          </aside>
        </div>
      </motion.div>
    </motion.div>
  );
}

export function Gallery() {
  const [open, setOpen] = useState<Strategy | null>(null);
  return (
    <section id="gallery" className="relative py-24 md:py-36">
      <div className="mx-auto max-w-[1240px] px-5">
        <div className="flex flex-col justify-between gap-8 md:flex-row md:items-end">
          <SectionHeading
            eyebrow="Workflow gallery"
            title={
              <>
                Theses, <span className="serif-em">woven</span> into trades.
              </>
            }
            sub="Seven strategies people are running right now: weather, rates, posts, funding, earnings, elections and pure mispricing. Hover to run one. Click to open it."
          />
          <Reveal className="shrink-0">
            <div className="flex items-center gap-4 font-mono text-[11px] text-muted">
              <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-signal" /> Signal</span>
              <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-trigger" /> Trigger</span>
              <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-long" /> Action</span>
            </div>
          </Reveal>
        </div>

        <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {strategies.map((s, i) => (
            <Reveal key={s.id} delay={(i % 3) * 0.06} className={i === 0 ? "md:col-span-2" : ""}>
              <Card s={s} onOpen={() => setOpen(s)} wide={i === 0} />
            </Reveal>
          ))}
          <Reveal delay={0.12}>
            <a
              href="#waitlist"
              className="group flex h-full min-h-[340px] flex-col justify-between rounded-[22px] border border-dashed border-line-2 p-6 transition-colors hover:border-ink hover:bg-card"
            >
              <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">Your turn</span>
              <svg viewBox="0 0 240 120" className="mx-auto my-6 w-full max-w-[260px] text-line-2 transition-colors duration-500 group-hover:text-faint" aria-hidden>
                {[[10, 18], [10, 52], [10, 86]].map(([x, y], i) => (
                  <rect key={`s${i}`} x={x} y={y} width="56" height="22" rx="7" fill="none" stroke="currentColor" strokeDasharray="4 4" />
                ))}
                {[[96, 34], [96, 70]].map(([x, y], i) => (
                  <rect key={`t${i}`} x={x} y={y} width="56" height="22" rx="7" fill="none" stroke="currentColor" strokeDasharray="4 4" />
                ))}
                <rect x="182" y="52" width="50" height="22" rx="7" fill="none" stroke="currentColor" strokeDasharray="4 4" />
                <path d="M66 29 C 82 29, 80 45, 96 45 M66 63 C 82 63, 80 45, 96 45 M66 97 C 82 97, 80 81, 96 81 M152 45 C 168 45, 166 63, 182 63 M152 81 C 168 81, 166 63, 182 63" fill="none" stroke="currentColor" />
                <circle cx="207" cy="63" r="3" className="fill-volt" />
              </svg>
              <div>
                <div className="text-[26px] font-semibold leading-[1.1] tracking-[-0.03em]">
                  Got a thesis nobody&apos;s <span className="serif-em">trading</span> yet?
                </div>
                <div className="mt-5 inline-flex items-center gap-2 text-[14px] font-medium">
                  Build it on {brand.name}
                  <IconArrowRight size={14} className="transition-transform group-hover:translate-x-1" />
                </div>
              </div>
            </a>
          </Reveal>
        </div>
      </div>
      <AnimatePresence>{open && <Modal key={open.id} s={open} onClose={() => setOpen(null)} />}</AnimatePresence>
    </section>
  );
}
