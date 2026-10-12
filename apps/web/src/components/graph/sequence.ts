"use client";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type { GraphRuntime, GraphSpec } from "./types";
import { emptyRuntime, finalRuntime } from "./layout";
import { useReducedMotion } from "@/lib/hooks";

export interface Step {
  at: number;
  run: () => void;
}
type SetRT = Dispatch<SetStateAction<GraphRuntime>>;

const patch = (set: SetRT, key: keyof GraphRuntime, id: string, v = true) =>
  set((rt) => ({ ...rt, [key]: { ...rt[key], [id]: v } }));

/** Nodes appear tier by tier: signals, then triggers, then actions. */
export function revealSteps(
  spec: GraphSpec,
  set: SetRT,
  t0 = 0,
  gap = { signal: 190, trigger: 230, action: 170, tier: 260 }
) {
  const steps: Step[] = [];
  let t = t0;
  (["signal", "trigger", "action"] as const).forEach((tier) => {
    const nodes = spec.nodes.filter((n) =>
      tier === "action" ? n.kind === "action" || n.kind === "exit" : n.kind === tier
    );
    nodes.forEach((n) => {
      steps.push({ at: t, run: () => patch(set, "visible", n.id) });
      t += gap[tier];
    });
    t += gap.tier;
  });
  return { steps, end: t };
}

/** Triggers flip to Met one at a time; downstream actions go live shortly after. */
export function fireSteps(spec: GraphSpec, set: SetRT, t0 = 0, gap = 950) {
  const steps: Step[] = [];
  let t = t0;
  spec.nodes.forEach((n) => {
    if (n.kind !== "trigger" || !n.met) return;
    steps.push({ at: t, run: () => patch(set, "met", n.id) });
    spec.edges
      .filter(([f]) => f === n.id)
      .forEach(([, to], i) => steps.push({ at: t + 380 + i * 220, run: () => patch(set, "active", to) }));
    t += gap;
  });
  return { steps, end: t };
}

export function useTimeline() {
  const timers = useRef<number[]>([]);
  const clear = useCallback(() => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  }, []);
  const run = useCallback(
    (steps: Step[]) => {
      clear();
      steps.forEach((s) => timers.current.push(window.setTimeout(s.run, s.at)));
    },
    [clear]
  );
  useEffect(() => clear, [clear]);
  return { run, clear };
}

/** Build-then-fire sequence for any strategy graph. */
export function useGraphSequence(spec: GraphSpec, playing: boolean, startDelay = 150) {
  const reduce = useReducedMotion();
  const [runtime, setRuntime] = useState<GraphRuntime>(emptyRuntime);
  const [runId, setRunId] = useState(0);
  const { run, clear } = useTimeline();

  useEffect(() => {
    if (!playing) return;
    if (reduce) {
      setRuntime(finalRuntime(spec));
      return;
    }
    setRuntime(emptyRuntime());
    const r = revealSteps(spec, setRuntime, startDelay);
    const f = fireSteps(spec, setRuntime, r.end + 500);
    run([...r.steps, ...f.steps]);
    return clear;
  }, [playing, spec, reduce, run, clear, runId, startDelay]);

  return { runtime, replay: () => setRunId((x) => x + 1) };
}
