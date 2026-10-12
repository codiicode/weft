"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Section } from "./Section";
import { products } from "@/data/mock";

const blurb: Record<string, string> = {
  perps: "Crypto perpetuals with leverage. Every order carries a stop.",
  stocks: "Shares, indices and commodities, as perps on Hyperliquid or tokenized on Solana.",
  predictions: "Buy the side of an outcome market your data says is mispriced.",
  tokens: "Any Solana token by contract address, memecoins included. Rug checks run before every swap.",
  options: "Spreads and bought calls or puts. You know the worst case before you trade.",
};

function Flow({ graph }: { graph: { signal: string; trigger: string; action: string } }) {
  const parts = [
    ["Watch", graph.signal, "var(--signal)"],
    ["When", graph.trigger, "var(--trigger)"],
    ["Do", graph.action, "var(--long)"],
  ] as const;
  return (
    <div className="space-y-2">
      {parts.map(([k, v, c], i) => (
        <div key={k} className="flex items-center gap-3">
          <span className="w-12 shrink-0 text-[12.5px] text-muted">{k}</span>
          <span className="flex-1 rounded-[8px] border border-line bg-card px-3 py-2 text-[13.5px] text-ink" style={{ boxShadow: `inset 2px 0 0 ${c}` }}>
            {v}
          </span>
          {i < 2 && <span className="sr-only">then</span>}
        </div>
      ))}
    </div>
  );
}

export function Markets() {
  const [sel, setSel] = useState(0);
  const p = products[sel]!;
  const m = p.markets[0]!;

  return (
    <Section
      id="markets"
      label="Markets"
      title="One idea. Five kinds of market."
      lead="The same strategy can watch a weather forecast and buy a wheat perp, or watch X and buy a memecoin. Weft picks the venue."
    >
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-14">
        <ul className="border-t border-line">
          {products.map((x, i) => (
            <li key={x.id} className="border-b border-line">
              <button
                onClick={() => setSel(i)}
                onMouseEnter={() => setSel(i)}
                aria-expanded={sel === i}
                className="group flex w-full items-baseline gap-4 py-5 text-left"
              >
                <span className={`text-[22px] font-semibold tracking-[-0.025em] transition-colors sm:text-[26px] ${sel === i ? "text-ink" : "text-faint group-hover:text-ink-2"}`}>
                  {x.id === "predictions" ? "Prediction markets" : x.name}
                </span>
                {x.status === "soon" && <span className="text-[13px] text-muted">Soon</span>}
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
