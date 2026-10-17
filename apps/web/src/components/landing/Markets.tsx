"use client";
import { useEffect, useRef, useState } from "react";
import { useInView, useReducedMotion } from "@/lib/hooks";
import { AssetStack } from "../ui/AssetIcon";
import { AnimatePresence, motion } from "motion/react";
import { Section } from "./Section";
import { products } from "@/data/mock";

const LOGOS: Record<string, string[]> = {
  perps: ["BTC", "ETH", "HYPE"],
  stocks: ["NVDA", "TSLA", "GOLD"],
  predictions: ["OUTCOME"],
  tokens: ["PUMP", "WIF", "JUP"],
  options: ["ETH", "BTC"],
};

const blurb: Record<string, string> = {
  perps: "Crypto perpetuals on Hyperliquid, up to each market’s own max leverage. Your stop is placed on Hyperliquid too.",
  stocks: "Stocks, indices and gold as perps on Hyperliquid, or tokenized shares on Solana.",
  predictions: "Fed decisions, crypto prices and sports on Hyperliquid. Buy the side you think is priced wrong, or use Polymarket’s odds as a signal.",
  tokens: "Any Solana token by contract address, from majors to brand-new launches. Bought and sold through Jupiter, straight from your own wallet.",
  options: "Spreads and bought calls or puts, so you know the most you can lose before you trade.",
};

function Flow({ graph }: { graph: { signal: string; trigger: string; action: string } }) {
  const parts = [
    ["Watch", graph.signal, "var(--signal)"],
    ["When", graph.trigger, "var(--trigger)"],
    ["Do", graph.action, "var(--long)"],
  ] as const;
  return (
    <dl className="space-y-3.5">
      {parts.map(([k, v, c]) => (
        <div key={k} className="flex items-baseline gap-3 text-[15px]">
          <dt className="flex w-16 shrink-0 items-center gap-1.5 text-[13px] text-muted">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
            {k}
          </dt>
          <span className="mb-1 min-w-4 flex-1 border-b border-dotted border-line-2" aria-hidden />
          <dd className="max-w-[70%] text-right text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Markets() {
  const [sel, setSel] = useState(0);
  const [paused, setPaused] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const inView = useInView(listRef);
  const reduce = useReducedMotion();
  const auto = inView && !paused && !reduce;
  // Step through the markets on its own; hovering or clicking takes over.
  useEffect(() => {
    if (!auto) return;
    const t = setTimeout(() => setSel((i) => (i + 1) % products.length), 4500);
    return () => clearTimeout(t);
  }, [auto, sel]);
  const p = products[sel]!;
  const m = p.markets[0]!;

  return (
    <Section
      id="markets"
      layout="stack"
      label="Markets"
      title="What it can trade"
      lead="You name the market. Weft knows where it trades and sends the order there."
    >
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-14">
        <ul ref={listRef} className="border-t border-line" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
          {products.map((x, i) => (
            <li key={x.id} className="relative border-b border-line">
              {sel === i && auto && (
                <motion.span
                  key={`bar-${sel}`}
                  aria-hidden
                  className="absolute -bottom-px left-0 h-px bg-ink"
                  initial={{ width: "0%" }}
                  animate={{ width: "100%" }}
                  transition={{ duration: 4.5, ease: "linear" }}
                />
              )}
              <button
                onClick={() => (setSel(i), setPaused(true))}
                onMouseEnter={() => setSel(i)}
                aria-expanded={sel === i}
                className="group flex w-full items-center gap-4 py-5 text-left"
              >
                <span className={`transition-[opacity,filter] duration-300 ${sel === i ? "" : "opacity-50 grayscale"}`}>
                  <AssetStack items={(LOGOS[x.id] ?? []).map((symbol) => ({ symbol }))} size={26} max={3} />
                </span>
                <span className={`text-[22px] font-semibold tracking-[-0.025em] transition-colors sm:text-[26px] ${sel === i ? "text-ink" : "text-faint group-hover:text-ink-2"}`}>
                  {x.id === "predictions" ? "Prediction markets" : x.name}
                </span>
                {x.status === "soon" && <span className="text-[13px] text-muted">Coming soon</span>}
                <span className="ml-auto hidden text-[13px] text-muted sm:inline">{x.venues.slice(0, 2).join(", ")}</span>
              </button>
              <AnimatePresence initial={false}>
                {sel === i && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                    className="overflow-hidden"
                  >
                    <p className="max-w-[30rem] pb-5 text-[15px] leading-[1.6] text-ink-2">{blurb[x.id]}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          ))}
        </ul>

        <div className="lg:sticky lg:top-28 lg:self-start">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={p.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
              className="rounded-[14px] border border-line bg-paper-2/60 p-6 sm:p-8"
            >
              <p className="text-[13px] text-muted">Example</p>
              <p className="display mt-2 text-[24px] leading-[1.3] text-ink sm:text-[26px]">“{m.thesis}”</p>
              <div className="mt-7">
                <Flow graph={m.graph} />
              </div>
              <p className="mt-6 text-[13px] text-muted">Runs on {m.venue}</p>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </Section>
  );
}
