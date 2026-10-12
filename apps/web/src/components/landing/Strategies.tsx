"use client";
import { useMemo, useState } from "react";
import { Section } from "./Section";
import { StrategyGraph } from "../graph/StrategyGraph";
import { finalRuntime } from "../graph/layout";
import type { GraphRuntime } from "../graph/types";
import { strategies, type Strategy } from "@/data/mock";
import { buttonClass } from "../ui/Button";

const picks = ["el-nino-harvest", "sub-penny-reload", "fed-pivot"];

function Card({ s }: { s: Strategy }) {
  const [hover, setHover] = useState(false);
  const fired = useMemo(() => finalRuntime(s), [s]);
  const armed = useMemo<GraphRuntime>(() => ({ visible: fired.visible, met: {}, active: {} }), [fired]);
  return (
    <a
      href={`/app/new?thesis=${encodeURIComponent(s.thesis)}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      className="group flex flex-col rounded-[14px] border border-line bg-card transition-colors hover:border-line-2"
    >
      <div className="p-5 pb-0 sm:p-6 sm:pb-0">
        <p className="text-[13px] text-muted">{s.category}</p>
        <h3 className="mt-1 text-[19px] font-semibold tracking-[-0.025em] text-ink">{s.title}</h3>
        <p className="mt-2 line-clamp-2 text-[14.5px] leading-[1.55] text-ink-2">“{s.thesis}”</p>
      </div>
      <div className="m-3 mt-5 flex-1 rounded-[10px] bg-paper-2/60 px-2 py-4">
        <StrategyGraph spec={s} runtime={hover ? fired : armed} preset="compact" live={hover} interactive={false} instant ariaLabel={`${s.title} strategy graph`} />
      </div>
      <div className="flex items-center justify-between border-t border-line px-5 py-3.5 text-[13.5px] sm:px-6">
        <span className="text-muted">{s.venues.join(" · ")}</span>
        <span className="font-medium text-ink transition-transform group-hover:translate-x-0.5">Use this →</span>
      </div>
    </a>
  );
}

export function Strategies() {
  const list = picks.map((id) => strategies.find((s) => s.id === id)!).filter(Boolean);
  return (
    <Section
      id="strategies"
      label="Strategies"
      title="Start from someone else’s strategy"
      lead="Every strategy is public. Read exactly what it does, then copy it and make it yours. Your wallet and sizes stay private."
    >
      <div className="grid gap-4 md:grid-cols-3">
        {list.map((s) => (
          <Card key={s.id} s={s} />
        ))}
      </div>
      <a href="/app/library" className={buttonClass("secondary", "md", "mt-8")}>
        Browse all strategies
      </a>
    </Section>
  );
}
