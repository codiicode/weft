"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { StrategyGraph } from "../graph/StrategyGraph";
import { emptyRuntime, finalRuntime } from "../graph/layout";
import { fireSteps, revealSteps, useTimeline, type Step } from "../graph/sequence";
import type { GraphRuntime } from "../graph/types";
import { heroResearch, heroStrategy } from "@/data/mock";
import { IconCheck, IconReplay, IconSend } from "../graph/icons";
import { useInView, useReducedMotion } from "@/lib/hooks";

type Phase = "idle" | "typing" | "research" | "graph" | "approve" | "live";
const STEPS: { key: Phase[]; label: string }[] = [
  { key: ["idle", "typing"], label: "Write" },
  { key: ["research"], label: "Research" },
  { key: ["graph", "approve"], label: "Review" },
  { key: ["live"], label: "Run" },
];

const spec = heroStrategy;
const THESIS = spec.thesis;

/** The landing-page product demo: a thesis typed, researched, drafted and approved. */
export function Demo() {
  const reduce = useReducedMotion();
  const root = useRef<HTMLDivElement>(null);
  const approveRef = useRef<HTMLButtonElement>(null);
  const inView = useInView(root, { once: true, rootMargin: "0px" });
  const { run, clear } = useTimeline();

  const [phase, setPhase] = useState<Phase>("idle");
  const [typed, setTyped] = useState(0);
  const [sent, setSent] = useState(false);
  const [research, setResearch] = useState({ shown: 0, done: 0 });
  const [runtime, setRuntime] = useState<GraphRuntime>(emptyRuntime);
  const [approved, setApproved] = useState(false);
  const [press, setPress] = useState(false);

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
    setPress(false);

    const steps: Step[] = [];
    let t = 400;
    steps.push({ at: t, run: () => setPhase("typing") });
    for (let i = 1; i <= THESIS.length; i++) {
      t += THESIS[i - 1] === " " ? 55 : 30 + ((i * 7) % 5) * 6;
      const n = i;
      steps.push({ at: t, run: () => setTyped(n) });
    }
    t += 350;
    steps.push({ at: t, run: () => (setSent(true), setPhase("research")) });
    t += 250;
    heroResearch.forEach((_, i) => {
      steps.push({ at: t + i * 300, run: () => setResearch((r) => ({ ...r, shown: i + 1 })) });
      steps.push({ at: t + i * 300 + 560, run: () => setResearch((r) => ({ ...r, done: i + 1 })) });
    });
    t += heroResearch.length * 300 + 650;
    steps.push({ at: t, run: () => setPhase("graph") });
    const r = revealSteps(spec, setRuntime, t + 100);
    steps.push(...r.steps);
    t = r.end + 500;
    steps.push({ at: t, run: () => setPhase("approve") });
    t += 1100;
    steps.push({ at: t, run: () => setPress(true) });
    steps.push({ at: t + 150, run: () => (setPress(false), setApproved(true), setPhase("live")) });
    steps.push(...fireSteps(spec, setRuntime, t + 600, 1100).steps);
    run(steps);
  }, [clear, finish, reduce, run]);

  useEffect(() => {
    if (inView) play();
  }, [inView, play]);

  const active = STEPS.findIndex((s) => s.key.includes(phase));
  const graphShown = phase === "graph" || phase === "approve" || phase === "live";

  return (
    <div ref={root} className="overflow-hidden rounded-[14px] border border-line bg-card shadow-window">
      {/* Window bar */}
      <div className="flex h-12 items-center gap-4 border-b border-line px-4">
        <ol className="flex items-center gap-4 text-[13px] sm:gap-6">
          {STEPS.map((s, i) => (
            <li key={s.label} className={`flex items-center gap-2 transition-colors duration-300 ${i === active ? "text-ink" : i < active ? "text-ink-2" : "text-faint"}`}>
              <span
                className={`grid h-[18px] w-[18px] place-items-center rounded-full text-[10.5px] font-medium tnum transition-colors duration-300 ${
                  i < active || (i === active && approved) ? "bg-ink text-paper" : i === active ? "border border-ink text-ink" : "border border-line-2"
                }`}
              >
                {i < active || (i === active && approved) ? <IconCheck size={10} strokeWidth={2.6} /> : i + 1}
              </span>
              <span className={i === active ? "" : "hidden sm:inline"}>{s.label}</span>
            </li>
          ))}
        </ol>
        <button onClick={play} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-[12.5px] text-muted transition-colors hover:bg-paper-2 hover:text-ink" aria-label="Replay demo">
          <IconReplay size={13} /> Replay
        </button>
      </div>

      {/* Prompt */}
      <div className="px-4 pt-4 sm:px-6 sm:pt-5">
        <div
          className={`flex items-center gap-3 rounded-[12px] border px-4 py-3.5 transition-colors duration-300 ${
            phase === "typing" ? "border-ink/40" : "border-line"
          }`}
        >
          <div className="min-w-0 flex-1 text-[16px] leading-6 tracking-[-0.01em] sm:text-[18px]">
            {typed === 0 && phase !== "typing" ? (
              <span className="text-faint">What do you think will happen?</span>
            ) : (
              <span className="text-ink">
                {THESIS.slice(0, typed)}
                {!sent && <span className="caret ml-[1px] inline-block h-[1.1em] w-[1.5px] translate-y-[3px] bg-ink" />}
              </span>
            )}
          </div>
          <motion.span
            animate={{ scale: phase === "typing" && typed === THESIS.length ? 0.9 : 1 }}
            className={`grid h-8 w-8 shrink-0 place-items-center rounded-[8px] transition-colors ${typed > 0 ? "bg-ink text-paper" : "bg-paper-2 text-faint"}`}
          >
            {phase === "research" ? <span className="spin-slow block h-3.5 w-3.5 rounded-full border-2 border-paper/30 border-t-paper" /> : <IconSend size={14} />}
          </motion.span>
        </div>

        {/* Research */}
        <div className="flex min-h-[44px] flex-wrap items-center gap-x-4 gap-y-1 py-3 text-[12.5px]">
          {!sent ? (
            <span className="text-faint">Weft checks forecasts, prices, odds, news and social before it drafts anything.</span>
          ) : (
            heroResearch.slice(0, research.shown).map((r, i) => (
              <motion.span
                key={r.label}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className={`inline-flex items-center gap-1.5 ${i > 2 ? "hidden md:inline-flex" : ""} ${i < research.done ? "text-ink-2" : "text-muted"}`}
              >
                {i < research.done ? (
                  <IconCheck size={12} strokeWidth={2.4} className="text-long" />
                ) : (
                  <span className="spin-slow block h-3 w-3 rounded-full border-[1.5px] border-line-2 border-t-ink-2" />
                )}
                {r.label}
              </motion.span>
            ))
          )}
        </div>
      </div>

      {/* Graph */}
      <div className="relative border-t border-line bg-paper/60 px-4 py-5 md:hidden">
        {graphShown ? (
          <motion.dl initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3 text-[14px]">
            {[
              ["Watch", "NOAA’s El Niño forecast, the prediction market on it, wheat prices, ag-weather posts on X", "var(--signal)"],
              ["When", "El Niño strengthens while the market still prices it low", "var(--trigger)"],
              ["Do", "Buy YES on “El Niño by winter”, go long wheat and sugar, short Brazil", "var(--long)"],
            ].map(([k, v, c]) => (
              <div key={k} className="rounded-[10px] border border-line bg-card px-3.5 py-3" style={{ boxShadow: `inset 2px 0 0 ${c}` }}>
                <dt className="text-[12.5px] text-muted">{k}</dt>
                <dd className="mt-0.5 leading-snug text-ink">{v}</dd>
              </div>
            ))}
          </motion.dl>
        ) : (
          <p className="grid h-[260px] place-items-center text-[13px] text-muted">{phase === "research" ? "Drafting a strategy…" : "The strategy appears here"}</p>
        )}
      </div>
      <div className="relative hidden border-t border-line bg-paper/60 px-3 pb-6 pt-6 sm:px-6 md:block">
        <div className="relative mx-auto max-w-[1070px]">
          <StrategyGraph
            spec={spec}
            runtime={runtime}
            preset="auto"
            stackBelow={640}
            live
            ariaLabel="Strategy graph: four signals feed three triggers that open long and short positions"
          />
          <AnimatePresence>
            {!graphShown && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="pointer-events-none absolute inset-0 grid place-items-center text-[13px] text-muted"
              >
                {phase === "research" ? "Drafting a strategy…" : "The strategy appears here"}
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Approval bar */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line px-4 py-3 text-[13px] sm:px-6">
        <span className="text-muted">
          <span className="text-ink">4</span> signals <span className="mx-1 text-faint">·</span> <span className="text-ink">3</span> triggers{" "}
          <span className="mx-1 text-faint">·</span> <span className="text-ink">5</span> actions
        </span>
        <span className="hidden text-muted sm:inline">
          Worst case if every stop hits <span className="tnum text-ink">−4.1%</span>
        </span>
        <motion.button
          ref={approveRef}
          onClick={() => {
            if (phase === "approve" || phase === "graph") {
              setApproved(true);
              setPhase("live");
              run(fireSteps(spec, setRuntime, 300, 1100).steps);
            }
          }}
          animate={{ scale: press ? 0.96 : 1 }}
          className={`ml-auto inline-flex h-9 items-center gap-2 rounded-[10px] px-4 font-medium transition-colors duration-300 ${
            approved ? "bg-[var(--long-soft)] text-long" : graphShown ? "bg-ink text-paper" : "bg-paper-2 text-faint"
          }`}
        >
          {approved ? (
            <>
              <IconCheck size={14} strokeWidth={2.4} /> Running on paper
            </>
          ) : (
            "Approve"
          )}
        </motion.button>
      </div>
    </div>
  );
}
