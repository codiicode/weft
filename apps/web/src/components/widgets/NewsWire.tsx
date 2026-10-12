"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { newsWire } from "@/data/mock";
import { useInterval } from "@/lib/hooks";
import { IconNews } from "@/components/graph/icons";
import { EASE, MicroLabel, WidgetCard, type WidgetProps } from "./WidgetCard";

/* Wire settings. */
const NEWS_VISIBLE = 4;
const NEWS_EVERY_MS = 2900;
const NEWS_ROUTE_THRESHOLD = 0.8;
const NEWS_SOURCES = "Wire · 6 desks";

type Story = (typeof newsWire)[number];
type Item = { uid: number; story: Story };

function Body({ live }: { live: boolean }) {
  const [state, setState] = useState(() => ({
    items: newsWire.slice(0, NEWS_VISIBLE).map((story, uid) => ({ uid, story })) as Item[],
    cursor: NEWS_VISIBLE,
    uid: NEWS_VISIBLE,
  }));
  useInterval(
    () =>
      setState((s) => {
        const story = newsWire[s.cursor % newsWire.length];
        return {
          items: [{ uid: s.uid, story: { ...story, ago: "now" } }, ...s.items].slice(0, NEWS_VISIBLE),
          cursor: s.cursor + 1,
          uid: s.uid + 1,
        };
      }),
    NEWS_EVERY_MS,
    live
  );

  return (
    <>
      <div className="flex items-center justify-between border-b border-line pb-2">
        <MicroLabel>Headline</MicroLabel>
        <MicroLabel>Relevance</MicroLabel>
      </div>
      <ol className="relative min-h-[300px] flex-1 overflow-hidden">
        <AnimatePresence initial={false} mode="popLayout">
          {state.items.map((it, idx) => {
            const routed = it.story.rel >= NEWS_ROUTE_THRESHOLD;
            return (
              <motion.li
                key={it.uid}
                layout
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, transition: { duration: 0.25 } }}
                transition={{ duration: 0.65, ease: EASE }}
                className="overflow-hidden border-b border-line last:border-b-0"
              >
                <div className="grid grid-cols-[minmax(0,1fr)_78px] gap-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-faint">
                      {idx === 0 && it.story.ago === "now" ? (
                        <span className="rounded-[4px] bg-volt px-1 py-px font-semibold text-[#0b0c0f]">New</span>
                      ) : null}
                      <span>{it.story.src}</span>
                      <span>·</span>
                      <span className="tnum">{it.story.ago}</span>
                      {routed && (
                        <span className="ml-1 inline-flex items-center gap-1 normal-case tracking-normal text-muted">
                          <span className="h-[4px] w-[4px] rounded-full bg-[var(--signal)]" />
                          routed
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[13.5px] font-medium leading-[1.35] tracking-[-0.01em] text-ink">{it.story.text}</p>
                  </div>
                  <div className="flex flex-col items-end justify-center gap-1.5">
                    <span className="tnum font-mono text-[12px] text-ink">{it.story.rel.toFixed(2)}</span>
                    <span className="relative h-[4px] w-full overflow-hidden rounded-full bg-[var(--paper-2)]">
                      <motion.span
                        className="absolute inset-y-0 left-0 rounded-full"
                        style={{ background: routed ? "var(--signal)" : "var(--faint)" }}
                        initial={{ width: 0 }}
                        animate={{ width: `${it.story.rel * 100}%` }}
                        transition={{ duration: 1, delay: 0.2, ease: EASE }}
                      />
                      <span
                        className="absolute inset-y-0 w-px bg-ink-2 opacity-60"
                        style={{ left: `${NEWS_ROUTE_THRESHOLD * 100}%` }}
                      />
                    </span>
                  </div>
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ol>
      <div className="mt-auto flex items-center gap-2 border-t border-line pt-3 font-mono text-[10px] text-muted">
        <span className="h-px w-3 bg-ink-2" />
        Relevance ≥ {NEWS_ROUTE_THRESHOLD.toFixed(2)} routes to your triggers
      </div>
    </>
  );
}

export function NewsWireWidget({ className, index }: WidgetProps) {
  return (
    <WidgetCard icon={IconNews} label="News wire" meta={NEWS_SOURCES} className={className} index={index}>
      {(live) => <Body live={live} />}
    </WidgetCard>
  );
}
