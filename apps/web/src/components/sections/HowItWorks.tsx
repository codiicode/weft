"use client";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValueEvent, useScroll } from "motion/react";
import { SectionHeading } from "../ui/Reveal";
import { StrategyGraph } from "../graph/StrategyGraph";
import { useGraphSequence } from "../graph/sequence";
import { strategies, thesisExamples } from "@/data/mock";
import { IconCheck, IconModel, IconSend } from "../graph/icons";
import { Sparkline } from "../ui/Sparkline";
import { useInView, useInterval, useReducedMotion } from "@/lib/hooks";
import { walk } from "@/lib/rng";

const STEPS = [
  {
    n: "01",
    title: "Write the thesis",
    body: "Say what you believe the way you'd say it to a friend. A memecoin at a price, weather, rates, earnings, a post you're waiting for. No indicators, no code.",
    meta: ["Plain language", "5 products", "Any horizon"],
  },
  {
    n: "02",
    title: "Read the graph",
    body: "The agent researches it and proposes a strategy you can read node by node: signals feed triggers, triggers fire actions with size, stops and targets. Edit anything.",
    meta: ["Signals", "AND / OR triggers", "Sized actions"],
  },
  {
    n: "03",
    title: "It runs on its own",
    body: "Approve it and the graph watches the market around the clock, trading through keys that can't withdraw, with rug checks before every token swap. Paper first, live when you say so, or alerts-only if you'd rather pull the trigger yourself.",
    meta: ["24/7 checks", "Hyperliquid + Solana", "Trade or alert"],
  },
];

/* ---------- Visual 1: thesis typing ---------- */
function ThesisVisual({ active }: { active: boolean }) {
  const reduce = useReducedMotion();
  const [idx, setIdx] = useState(0);
  const [len, setLen] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const text = thesisExamples[idx];
  useInterval(
    () => {
      if (dir === 1) {
        if (len < text.length) setLen((l) => l + 1);
        else setDir(-1);
      } else {
        if (len > 0) setLen((l) => Math.max(0, l - 3));
        else {
          setIdx((i) => (i + 1) % thesisExamples.length);
          setDir(1);
        }
      }
    },
    dir === 1 && len === text.length ? 2200 : dir === 1 ? 38 : 14,
    active && !reduce
  );
  const shown = reduce ? text : text.slice(0, len);
  const intents: Record<number, { k: string; v: string }[]> = {
    0: [
      { k: "Horizon", v: "Hours to days" },
      { k: "Markets", v: "$PUMP by mint" },
      { k: "Needs", v: "Price · sentiment · rug checks" },
    ],
    1: [
      { k: "Horizon", v: "3–6 months" },
      { k: "Markets", v: "Grains · Softs · BRL" },
      { k: "Needs", v: "ENSO · odds · posts" },
    ],
    2: [
      { k: "Horizon", v: "Event-driven" },
      { k: "Markets", v: "NVDA perp" },
      { k: "Needs", v: "1 account · wires" },
    ],
    3: [
      { k: "Horizon", v: "≤ 8 weeks" },
      { k: "Markets", v: "BTC · ETH · Gold" },
      { k: "Needs", v: "FOMC odds · 2Y" },
    ],
    4: [
      { k: "Horizon", v: "Days" },
      { k: "Markets", v: "SOL perp" },
      { k: "Needs", v: "Funding · OI" },
    ],
  };
  const done = reduce || (dir === -1 || len === text.length);
  return (
    <div className="flex h-full flex-col justify-center gap-5 p-6 sm:p-10">
      <div className="rounded-2xl border border-line bg-card p-4 shadow-card">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
          <span className="grid h-5 w-5 place-items-center rounded-md bg-[var(--signal-soft)] text-signal">
            <IconModel size={11} />
          </span>
          New thesis
        </div>
        <div className="mt-3 min-h-[64px] text-[20px] leading-snug tracking-[-0.02em] text-ink sm:text-[24px]">
          {shown}
          <span className="caret ml-0.5 inline-block h-[1em] w-[2px] translate-y-[3px] bg-signal" />
        </div>
        <div className="mt-3 flex items-center justify-between">
          <div className="flex gap-1.5">
            {thesisExamples.map((_, i) => (
              <span key={i} className={`h-1 rounded-full transition-all duration-500 ${i === idx ? "w-5 bg-ink" : "w-1.5 bg-line-2"}`} />
            ))}
          </div>
          <span className="grid h-8 w-8 place-items-center rounded-full bg-ink text-paper">
            <IconSend size={13} />
          </span>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {intents[idx].map((it, i) => (
          <motion.div
            key={`${idx}-${it.k}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: done ? 1 : 0.25, y: 0 }}
            transition={{ delay: done ? i * 0.08 : 0, duration: 0.4 }}
            className="rounded-xl border border-line bg-card/70 p-3"
          >
            <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint">{it.k}</div>
            <div className="mt-1 text-[12.5px] font-medium leading-snug text-ink sm:text-[13px]">{it.v}</div>
          </motion.div>
        ))}
      </div>
      <p className="font-mono text-[11px] text-faint">Parsed intent · the agent asks before it assumes.</p>
    </div>
  );
}

/* ---------- Visual 2: graph assembling ---------- */
function GraphVisual({ active }: { active: boolean }) {
  const spec = strategies.find((x) => x.id === "sub-penny-reload") ?? strategies[1];
  const { runtime } = useGraphSequence(spec, active, 250);
  return (
    <div className="flex h-full flex-col justify-center p-5 sm:p-8">
      <div className="mb-4 flex items-center justify-between">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">{spec.title}</span>
        <span className="font-mono text-[10.5px] text-faint">{spec.nodes.length} nodes · {spec.edges.length} edges</span>
      </div>
      <StrategyGraph spec={spec} runtime={runtime} preset="auto" wide="medium" stackBelow={520} interactive live ariaLabel={`${spec.title} strategy graph`} />
    </div>
  );
}

/* ---------- Visual 3: execution log ---------- */
const LOG = [
  { t: "09:14:02", tag: "check", text: "3 signals fresh · PUMP 0.00412 · sent +0.29", tone: "muted" },
  { t: "09:41:30", tag: "trigger", text: "≤ 0.004 ✓  sent 0.34 ✓  mentions +162% ✓", tone: "trigger" },
  { t: "09:41:30", tag: "rug", text: "pumpCm…H9Dfn · 6/6 rug checks passed", tone: "long" },
  { t: "09:41:31", tag: "order", text: "SWAP 0.5 SOL → PUMP · Jupiter · impact 0.04%", tone: "long" },
  { t: "09:41:32", tag: "fill", text: "Filled 0.00398 · TP +40% · SL −20% · in your wallet", tone: "ink" },
  { t: "10:11:32", tag: "check", text: "Position +3.1% · dev wallet idle · stops intact", tone: "muted" },
  { t: "14:52:07", tag: "exit", text: "TP hit · swapped back to SOL · +40.0%", tone: "long" },
];

function RunVisual({ active }: { active: boolean }) {
  const reduce = useReducedMotion();
  const [n, setN] = useState(reduce ? LOG.length : 0);
  useEffect(() => {
    if (active) setN(reduce ? LOG.length : 0);
  }, [active, reduce]);
  useInterval(() => setN((x) => (x >= LOG.length + 3 ? 0 : x + 1)), 900, active && !reduce);
  const shown = LOG.slice(0, Math.min(n, LOG.length));
  const curve = walk(301, 40, 0.5, 0.35);
  const tone = (t: string) =>
    ({ muted: "var(--muted)", trigger: "var(--trigger)", long: "var(--long)", short: "var(--short)", ink: "var(--ink)" })[t];
  return (
    <div className="flex h-full flex-col justify-center gap-4 p-5 sm:p-8">
      <div className="flex items-center justify-between rounded-2xl border border-line bg-card px-4 py-3 shadow-card">
        <div className="flex items-center gap-3">
          <span className="relative flex h-2.5 w-2.5">
            <span className="pulse-ring absolute inset-0 rounded-full bg-long" />
            <span className="relative h-2.5 w-2.5 rounded-full bg-long" />
          </span>
          <div>
            <div className="text-[13.5px] font-medium">Sub-Penny Reload · running</div>
            <div className="font-mono text-[10.5px] text-muted">checks every 30s · paper</div>
          </div>
        </div>
        <Sparkline data={curve.slice(0, 12 + Math.min(n, LOG.length) * 4)} width={120} height={32} color="var(--long)" dot />
      </div>
      <div className="relative min-h-[262px] overflow-hidden rounded-2xl border border-line bg-[color-mix(in_oklab,var(--ink)_96%,transparent)] p-4 font-mono text-[11.5px] leading-[1.9] text-[#e9e7e2] shadow-card dark:bg-card-2">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-[#8b8e96]">
          <span className="h-1.5 w-1.5 rounded-full bg-volt" /> execution log
        </div>
        <AnimatePresence initial={false}>
          {shown.map((l, i) => (
            <motion.div
              key={`${l.t}-${i}`}
              initial={{ opacity: 0, x: -8, filter: "blur(3px)" }}
              animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35 }}
              className="flex gap-3 whitespace-nowrap"
            >
              <span className="text-[#6e717a]">{l.t}</span>
              <span className="w-[52px] shrink-0 uppercase" style={{ color: l.tone === "ink" || l.tone === "muted" ? "#9a9da5" : tone(l.tone) }}>
                {l.tag}
              </span>
              <span className="truncate">{l.text}</span>
            </motion.div>
          ))}
        </AnimatePresence>
        <span className="caret mt-1 inline-block h-3 w-[7px] bg-volt" />
      </div>
    </div>
  );
}

const VISUALS = [ThesisVisual, GraphVisual, RunVisual];

function Panel({ active, idx }: { active: boolean; idx: number }) {
  const V = VISUALS[idx];
  return (
    <div className="dot-grid relative h-full overflow-hidden rounded-[24px] border border-line bg-paper-2/60 shadow-card">
      <V active={active} />
    </div>
  );
}

export function HowItWorks() {
  const track = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const { scrollYProgress } = useScroll({ target: track, offset: ["start 0.35", "end 0.65"] });
  useMotionValueEvent(scrollYProgress, "change", (v) => setStep(Math.min(2, Math.max(0, Math.floor(v * 3)))));
  const mobileRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const mIn = [useInView(mobileRefs[0]), useInView(mobileRefs[1]), useInView(mobileRefs[2])];

  return (
    <section id="how" className="relative py-24 md:py-36">
      <div className="mx-auto max-w-[1240px] px-5">
        <SectionHeading
          eyebrow="How it works"
          title={
            <>
              From a sentence to a <span className="serif-em">running</span> strategy.
            </>
          }
          sub="Three steps, and you stay in charge of every one. The agent does the research, the wiring and the watching."
        />

        {/* Desktop: sticky scroll story */}
        <div ref={track} className="relative mt-16 hidden lg:block" style={{ height: "210vh" }}>
          <div className="sticky top-[12vh] grid h-[76vh] max-h-[680px] grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-10">
            <div className="flex flex-col justify-center">
              {STEPS.map((s, i) => (
                <button
                  key={s.n}
                  onClick={() => {
                    const el = track.current!;
                    const top = el.getBoundingClientRect().top + window.scrollY;
                    window.scrollTo({ top: top + (el.offsetHeight - window.innerHeight * 0.3) * (i / 3 + 0.12) - window.innerHeight * 0.35, behavior: "smooth" });
                  }}
                  className="group relative block w-full border-t border-line py-6 text-left last:border-b"
                >
                  <motion.span
                    className="absolute left-0 top-[-1px] h-[2px] origin-left bg-ink"
                    animate={{ scaleX: step === i ? 1 : 0 }}
                    style={{ width: "100%" }}
                    transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                  />
                  <div className="flex items-baseline gap-5">
                    <span className={`font-mono text-[12px] transition-colors ${step === i ? "text-ink" : "text-faint"}`}>{s.n}</span>
                    <div>
                      <h3 className={`text-[26px] font-semibold tracking-[-0.03em] transition-colors duration-500 ${step === i ? "text-ink" : "text-faint"}`}>
                        {s.title}
                      </h3>
                      <motion.div
                        initial={false}
                        animate={{ height: step === i ? "auto" : 0, opacity: step === i ? 1 : 0 }}
                        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden"
                      >
                        <p className="mt-3 max-w-md text-[15.5px] leading-relaxed text-ink-2">{s.body}</p>
                        <div className="mt-4 flex flex-wrap gap-1.5">
                          {s.meta.map((m) => (
                            <span key={m} className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 font-mono text-[10.5px] text-ink-2">
                              <IconCheck size={10} className="text-long" /> {m}
                            </span>
                          ))}
                        </div>
                      </motion.div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <div className="relative">
              <AnimatePresence mode="wait">
                <motion.div
                  key={step}
                  className="absolute inset-0"
                  initial={{ opacity: 0, y: 24, scale: 0.98, filter: "blur(6px)" }}
                  animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                  exit={{ opacity: 0, y: -24, scale: 0.98, filter: "blur(6px)" }}
                  transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
                >
                  <Panel active idx={step} />
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* Mobile / tablet: stacked */}
        <div className="mt-12 space-y-14 lg:hidden">
          {STEPS.map((s, i) => (
            <div key={s.n} ref={mobileRefs[i]}>
              <div className="flex items-baseline gap-4">
                <span className="font-mono text-[12px] text-muted">{s.n}</span>
                <h3 className="text-[24px] font-semibold tracking-[-0.03em]">{s.title}</h3>
              </div>
              <p className="mt-3 text-[15.5px] leading-relaxed text-ink-2">{s.body}</p>
              <div className={`mt-6 ${i === 1 ? "" : "min-h-[360px]"}`}>
                <Panel active={mIn[i]} idx={i} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
