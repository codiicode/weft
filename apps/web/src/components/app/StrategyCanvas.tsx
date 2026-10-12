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
    <div className={`relative rounded-[12px] border border-line bg-paper-2/40 px-3 py-5 sm:px-5 ${className}`}>
      {preset === "auto" && (
        <div className="pointer-events-none mb-4 hidden gap-5 px-1 text-[12.5px] text-muted sm:flex">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-[3px] bg-signal" />Watches</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-[3px] bg-trigger" />When</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-[3px] bg-long" />Does</span>
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
