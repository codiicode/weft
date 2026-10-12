"use client";
import { useMemo } from "react";
import type { Strategy } from "@weft/strategy";
import { StrategyGraph } from "../graph/StrategyGraph";
import { strategyToSpec, type LiveOverlay } from "@/lib/strategy-view";

/** The real strategy rendered with the landing page's graph component, optionally with live engine state. */
export function StrategyCanvas({
  strategy,
  live,
  preset = "auto",
  className = "",
  animate = true,
}: {
  strategy: Strategy;
  live?: LiveOverlay;
  preset?: "auto" | "compact";
  className?: string;
  animate?: boolean;
}) {
  const { spec, runtime } = useMemo(() => strategyToSpec(strategy, live), [strategy, live]);
  return (
    <div className={`dot-grid relative rounded-2xl border border-line bg-paper/60 px-3 py-6 sm:px-5 ${className}`}>
      {preset === "auto" && (
        <div className="pointer-events-none mb-3 hidden gap-6 px-1 font-mono text-[10px] uppercase tracking-[0.16em] text-faint sm:flex">
          <span className="flex items-center gap-1.5"><span className="h-1 w-1 rounded-full bg-signal" />Signals</span>
          <span className="flex items-center gap-1.5"><span className="h-1 w-1 rounded-full bg-trigger" />Triggers</span>
          <span className="flex items-center gap-1.5"><span className="h-1 w-1 rounded-full bg-long" />Actions</span>
        </div>
      )}
      <StrategyGraph
        spec={spec}
        runtime={runtime}
        preset={preset === "compact" ? "compact" : "auto"}
        wide="full"
        stackBelow={640}
        live
        interactive={preset !== "compact"}
        instant={!animate}
        ariaLabel={`${strategy.name} strategy graph`}
      />
    </div>
  );
}
