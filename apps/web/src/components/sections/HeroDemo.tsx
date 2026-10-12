"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { StrategyGraph } from "../graph/StrategyGraph";
import { emptyRuntime, finalRuntime } from "../graph/layout";
import { fireSteps, revealSteps, useTimeline, type Step } from "../graph/sequence";
import type { GraphRuntime } from "../graph/types";
import { heroResearch, heroStrategy } from "@/data/mock";
import { IconCheck, IconModel, IconReplay, IconSend, IconShield } from "../graph/icons";
import { LogoMark } from "../ui/Logo";
import { useInView, useWidth, useReducedMotion } from "@/lib/hooks";

type Phase = "idle" | "typing" | "research" | "graph" | "approve" | "live";
const PHASES: { key: Phase[]; label: string }[] = [
  { key: ["idle", "typing"], label: "Thesis" },
  { key: ["research"], label: "Research" },
  { key: ["graph", "approve"], label: "Graph" },
  { key: ["live"], label: "Live" },
];

const spec = heroStrategy;
const THESIS = spec.thesis;

export function HeroDemo() {
  const reduce = useReducedMotion();
  const root = useRef<HTMLDivElement>(null);
  const approveRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const inView = useInView(root, { once: true, rootMargin: "0px" });
  const width = useWidth(root);
  const { run, clear } = useTimeline();

  const [phase, setPhase] = useState<Phase>("idle");
  const [typed, setTyped] = useState(0);
  const [sent, setSent] = useState(false);
  const [research, setResearch] = useState<{ shown: number; done: number }>({ shown: 0, done: 0 });
  const [runtime, setRuntime] = useState<GraphRuntime>(emptyRuntime);
  const [cursor, setCursor] = useState<{ x: number; y: number; show: boolean; down: boolean }>({ x: 0, y: 0, show: false, down: false });
  const [approved, setApproved] = useState(false);
  const [pressing, setPressing] = useState(false);

  const finish = useCallback(() => {
    setPhase("live");
    setTyped(THESIS.length);
    setSent(true);
    setResearch({ shown: heroResearch.length, done: heroResearch.length });
    setRuntime(finalRuntime(spec));
    setApproved(true);
  }, []);

  const play = useCallback(() => {
    clear();
    if (reduce) return finish();
    setPhase("idle");
    setTyped(0);
    setSent(false);
    setResearch({ shown: 0, done: 0 });
    setRuntime(emptyRuntime());
    setApproved(false);
    setPressing(false);
    setCursor((c) => ({ ...c, show: false, down: false }));

    const steps: Step[] = [];
    let t = 500;
    steps.push({ at: t, run: () => setPhase("typing") });
    for (let i = 1; i <= THESIS.length; i++) {
      t += THESIS[i - 1] === " " ? 55 : 32 + ((i * 7) % 5) * 6;
      const n = i;
      steps.push({ at: t, run: () => setTyped(n) });
    }
    t += 380;
    steps.push({ at: t, run: () => setPressing(true) });
    t += 160;
    steps.push({ at: t, run: () => (setPressing(false), setSent(true), setPhase("research")) });
    t += 300;
    heroResearch.forEach((_, i) => {
      steps.push({ at: t + i * 330, run: () => setResearch((r) => ({ ...r, shown: i + 1 })) });
      steps.push({ at: t + i * 330 + 620, run: () => setResearch((r) => ({ ...r, done: i + 1 })) });
    });
    t += heroResearch.length * 330 + 700;
    steps.push({ at: t, run: () => setPhase("graph") });
    const r = revealSteps(spec, setRuntime, t + 100);
    steps.push(...r.steps);
    t = r.end + 300;

    // cursor glides in and approves
    steps.push({
      at: t,
      run: () => {
        setPhase("approve");
        const host = root.current?.getBoundingClientRect();
        const cv = canvasRef.current?.getBoundingClientRect();
        if (host && cv) setCursor({ x: cv.left - host.left + cv.width * 0.58, y: cv.top - host.top + cv.height * 0.55, show: true, down: false });
      },
    });
    steps.push({
      at: t + 450,
      run: () => {
        const host = root.current?.getBoundingClientRect();
        const btn = approveRef.current?.getBoundingClientRect();
        if (host && btn) setCursor({ x: btn.left - host.left + btn.width * 0.55, y: btn.top - host.top + btn.height * 0.55, show: true, down: false });
      },
    });
    t += 1500;
    steps.push({ at: t, run: () => setCursor((c) => ({ ...c, down: true })) });
    steps.push({ at: t + 140, run: () => (setCursor((c) => ({ ...c, down: false })), setApproved(true), setPhase("live")) });
    steps.push({ at: t + 900, run: () => setCursor((c) => ({ ...c, show: false })) });
    const f = fireSteps(spec, setRuntime, t + 650, 1100);
    steps.push(...f.steps);
    run(steps);
  }, [clear, finish, reduce, run]);

  useEffect(() => {
    if (inView) play();
  }, [inView, play]);

  const activeIdx = PHASES.findIndex((p) => p.key.includes(phase));
  const graphShown = phase === "graph" || phase === "approve" || phase === "live";
  const narrow = width > 0 && width < 640;
  const metCount = Object.values(runtime.met).filter(Boolean).length;
  const liveCount = Object.values(runtime.active).filter(Boolean).length;

  return (
    <div ref={root} className="relative overflow-hidden rounded-[22px] border border-line bg-card/85 shadow-window backdrop-blur-xl sm:rounded-[26px]">
      {/* Top bar */}
      <div className="flex h-12 items-center gap-3 border-b border-line px-3 sm:px-4">
        <LogoMark size={20} />
        <div className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
          <span className="hidden text-muted sm:inline">Strategies</span>
          <span className="hidden text-faint sm:inline">/</span>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={sent ? "named" : "new"}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="truncate font-medium text-ink"
            >
              {sent ? spec.title : "New strategy"}
            </motion.span>
          </AnimatePresence>
        </div>

        {/* phase stepper */}
        <div className="mx-auto hidden items-center gap-1 rounded-full border border-line bg-paper/60 p-1 md:flex">
          {PHASES.map((p, i) => (
            <div key={p.label} className="relative px-3 py-1 font-mono text-[10.5px] uppercase tracking-[0.12em]">
              {i === activeIdx && (
                <motion.span layoutId="phase-pill" className="absolute inset-0 rounded-full bg-ink" transition={{ type: "spring", stiffness: 380, damping: 32 }} />
              )}
              <span className={`relative transition-colors duration-300 ${i === activeIdx ? "text-paper" : i < activeIdx ? "text-ink-2" : "text-faint"}`}>
                {p.label}
              </span>
            </div>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span
            className={`hidden items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.1em] transition-colors duration-500 sm:inline-flex ${
              approved ? "bg-[var(--long-soft)] text-long" : "bg-paper-2 text-muted"
            }`}
          >
            <span className="relative flex h-1.5 w-1.5">
              {approved && <span className="pulse-ring absolute inset-0 rounded-full bg-long" />}
              <span className={`relative h-1.5 w-1.5 rounded-full ${approved ? "bg-long" : "bg-faint"}`} />
            </span>
            {approved ? "Live · Paper" : "Draft · Paper"}
          </span>
          <button
            onClick={play}
            className="group inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-[12px] font-medium text-ink-2 transition-colors hover:bg-paper hover:text-ink"
            aria-label="Replay demo"
          >
            <IconReplay size={13} className="transition-transform duration-500 group-hover:-rotate-[200deg]" />
            Replay
          </button>
        </div>
      </div>

      {/* Prompt */}
      <div className="border-b border-line px-3 py-3 sm:px-5 sm:py-4">
        <div
          className={`flex items-center gap-3 rounded-2xl border bg-card px-3.5 py-3 transition-[border-color,box-shadow] duration-500 sm:px-4 ${
            phase === "typing" ? "border-[color-mix(in_oklab,var(--signal)_45%,transparent)] shadow-[0_0_0_4px_var(--signal-soft)]" : "border-line"
          }`}
        >
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--signal-soft)] text-signal">
            <IconModel size={15} />
          </span>
          <div className="min-w-0 flex-1 text-[15px] leading-6 tracking-[-0.01em] sm:text-[17px]">
            {typed === 0 && phase !== "typing" ? (
              <span className="text-faint">Describe a market thesis in plain language…</span>
            ) : (
              <span className="text-ink">
                {THESIS.slice(0, typed)}
                {!sent && <span className="caret ml-[1px] inline-block h-[1.1em] w-[2px] translate-y-[3px] bg-signal" />}
              </span>
            )}
          </div>
          <motion.span
            animate={{ scale: pressing ? 0.86 : 1 }}
            className={`grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors duration-300 ${
              typed > 0 ? "bg-ink text-paper" : "bg-paper-2 text-faint"
            }`}
          >
            {sent && phase === "research" ? (
              <span className="spin-slow block h-3.5 w-3.5 rounded-full border-2 border-paper/30 border-t-paper" />
            ) : (
              <IconSend size={14} />
            )}
          </motion.span>
        </div>

        {/* Research chips */}
        <div className="mt-3 flex min-h-[28px] flex-wrap items-center gap-1.5">
          <AnimatePresence>
            {!sent && phase !== "typing" && (
              <motion.span key="hint" exit={{ opacity: 0 }} className="font-mono text-[11px] text-faint">
                Weft researches forecasts, odds, prices, news & social before it proposes a graph.
              </motion.span>
            )}
          </AnimatePresence>
          {sent && (
            <span className={`mr-1 font-mono text-[10.5px] uppercase tracking-[0.12em] ${research.done < heroResearch.length ? "shimmer-text" : "text-muted"}`}>
              {research.done < heroResearch.length ? "Researching" : `${heroResearch.length} sources`}
            </span>
          )}
          {heroResearch.slice(0, research.shown).map((r, i) => {
            const done = i < research.done;
            return (
              <motion.span
                key={r.label}
                initial={{ opacity: 0, y: 6, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className={`group relative inline-flex items-center gap-1.5 rounded-full border border-line bg-paper/70 py-1 pl-1.5 pr-2.5 text-[11.5px] text-ink-2 ${i > 2 ? "hidden sm:inline-flex" : ""}`}
                title={r.detail}
              >
                <span className={`grid h-4 w-4 place-items-center rounded-full ${done ? "bg-[var(--long-soft)] text-long" : "text-muted"}`}>
                  {done ? <IconCheck size={10} strokeWidth={2.4} /> : <span className="spin-slow block h-3 w-3 rounded-full border-[1.5px] border-line-2 border-t-ink-2" />}
                </span>
                {r.label}
              </motion.span>
            );
          })}
        </div>
      </div>

      {/* Canvas */}
      <div ref={canvasRef} className="dot-grid relative bg-paper/40 px-3 pb-5 pt-9 sm:px-6 sm:pb-7 sm:pt-11">
        <div className="relative mx-auto max-w-[1070px]">
          {!narrow && (
            <div className="pointer-events-none absolute inset-x-0 -top-6 flex font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
              {[
                ["Signals", "0%"],
                ["Triggers", "36.6%"],
                ["Actions", "75.5%"],
              ].map(([l, x], i) => (
                <motion.span
                  key={l}
                  className="absolute flex items-center gap-1.5"
                  style={{ left: x }}
                  animate={{ opacity: graphShown ? 1 : 0.5 }}
                >
                  <span className="h-1 w-1 rounded-full" style={{ background: ["var(--signal)", "var(--trigger)", "var(--long)"][i] }} />
                  {l}
                </motion.span>
              ))}
            </div>
          )}
          <StrategyGraph spec={spec} runtime={runtime} preset="auto" stackBelow={640} live ghost={phase !== "idle" && phase !== "typing"} ariaLabel="El Niño strategy graph: four signals feed three triggers that fire long and short actions" />
          <AnimatePresence>
            {!graphShown && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.3 } }}
                className="pointer-events-none absolute inset-0 grid place-items-center"
              >
                <div className="rounded-2xl bg-paper/80 px-5 py-4 text-center backdrop-blur-sm">
                  <div className="mx-auto mb-3 flex w-fit items-center gap-2">
                    {[0, 1, 2].map((i) => (
                      <motion.span
                        key={i}
                        className="h-2 w-2 rounded-full"
                        style={{ background: ["var(--signal)", "var(--trigger)", "var(--long)"][i] }}
                        animate={phase === "research" ? { y: [0, -6, 0], opacity: [0.5, 1, 0.5] } : { y: 0, opacity: 0.4 }}
                        transition={{ duration: 0.9, repeat: phase === "research" ? Infinity : 0, delay: i * 0.15 }}
                      />
                    ))}
                  </div>
                  <p className="font-mono text-[11.5px] text-muted">
                    {phase === "research" ? "Weaving signals into a strategy…" : "Your strategy graph appears here"}
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Footer / approval bar */}
      <div className="flex flex-col gap-3 border-t border-line bg-card px-3 py-3 sm:flex-row sm:items-center sm:px-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
          <span>
            <span className="text-ink">4</span> signals · <span className="text-ink">3</span> triggers · <span className="text-ink">5</span> actions
          </span>
          <span className="hidden sm:inline">
            Triggers met <span className="tnum text-ink">{metCount}/3</span>
          </span>
          <span className="hidden lg:inline">
            Positions live <span className="tnum text-ink">{liveCount}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <IconShield size={12} className="text-long" /> Max loss at stops <span className="tnum text-ink">−4.1%</span>
          </span>
        </div>
        <motion.button
          ref={approveRef}
          onClick={() => {
            if (phase === "approve" || phase === "graph") {
              setApproved(true);
              setPhase("live");
              run(fireSteps(spec, setRuntime, 300, 1100).steps);
            }
          }}
          animate={{ scale: cursor.down ? 0.95 : 1 }}
          className={`relative ml-auto inline-flex h-9 items-center gap-2 overflow-hidden rounded-full px-4 text-[13px] font-medium transition-colors duration-500 ${
            approved ? "bg-[var(--long-soft)] text-long" : graphShown ? "bg-ink text-paper" : "bg-paper-2 text-faint"
          }`}
        >
          {approved ? (
            <>
              <IconCheck size={14} strokeWidth={2.2} /> Approved · running on paper
            </>
          ) : (
            <>Review & go live (paper)</>
          )}
        </motion.button>
      </div>

      {/* Fake cursor */}
      <motion.div
        className="pointer-events-none absolute left-0 top-0 z-20"
        initial={false}
        animate={{ x: cursor.x, y: cursor.y, opacity: cursor.show ? 1 : 0, scale: cursor.down ? 0.86 : 1 }}
        transition={{ x: { type: "spring", stiffness: 70, damping: 16 }, y: { type: "spring", stiffness: 70, damping: 16 }, opacity: { duration: 0.25 }, scale: { duration: 0.12 } }}
      >
        <svg width="22" height="24" viewBox="0 0 22 24" className="drop-shadow-[0_4px_8px_rgba(0,0,0,.25)]">
          <path d="M3 2.5 18.5 13l-7 1.2-3.6 6.6z" fill="#0b0c0f" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
        {cursor.down && <span className="pulse-ring absolute -left-2 -top-2 h-6 w-6 rounded-full bg-volt" />}
      </motion.div>
    </div>
  );
}
