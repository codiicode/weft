"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Section } from "./Section";
import { brand, $T } from "@/config/brand";

const faqs = [
  {
    q: "Do I need to know how to trade?",
    a: "You need an opinion, not a trading background. Weft turns it into concrete rules and shows you each one in plain English before anything runs. Test it on real history first, then start it with an amount you choose.",
  },
  {
    q: "Does Weft hold my money?",
    a: "No. Funds stay in your own Hyperliquid account. Weft gets a key that can trade but can’t withdraw or transfer, and you can revoke it from Hyperliquid at any time. Live trading on Solana works the same way and comes next.",
  },
  {
    q: "What does it cost?",
    a: `Writing and testing strategies is free. Trades pay a fee (${(brand.builderFeeBps / 100).toFixed(2)}% on Hyperliquid, ${(brand.swapFeeBps / 100).toFixed(1)}% on Solana swaps). Half of it buys back ${$T} on the open market, and holding ${$T} halves what you pay.`,
  },
  {
    q: "Is it safe to trade memecoins with it?",
    a: "Safer than by hand, never safe. Tokens are matched by contract address, not ticker, and every buy is checked for the usual rug signs: mint authority, holder concentration, liquidity, dev selling. You see a heads-up when one fails; say “only if it’s safe” and the checks block the buy instead. Memecoins can still go to zero.",
  },
  {
    q: "Can it just alert me instead?",
    a: "Yes. Any strategy can run as alerts only and message you on Telegram when it would have traded.",
  },
  {
    q: "Is this financial advice?",
    a: "No. Weft runs the strategy you approve. Trading is risky and leverage magnifies losses.",
  },
];

export function FAQ() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <Section id="faq" title="Questions" layout="aside" lead={
        <>
          Anything else? Ask us on{" "}
          <a href={brand.socials.x} className="text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">
            X
          </a>{" "}
          or{" "}
          <a href={brand.socials.telegram} className="text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">
            Telegram
          </a>
          .
        </>
      }
    >
      <ul className="border-t border-line">
        {faqs.map((f, i) => {
          const isOpen = open === i;
          return (
            <li key={f.q} className="border-b border-line">
              <button onClick={() => setOpen(isOpen ? null : i)} aria-expanded={isOpen} className="flex w-full items-center gap-6 py-5 text-left">
                <span className="text-[17px] font-medium tracking-[-0.015em] text-ink sm:text-[18px]">{f.q}</span>
                <span className="relative ml-auto h-3 w-3 shrink-0 text-muted" aria-hidden>
                  <span className="absolute left-0 top-1/2 h-[1.5px] w-3 -translate-y-1/2 bg-current" />
                  <span className={`absolute left-1/2 top-0 h-3 w-[1.5px] -translate-x-1/2 bg-current transition-transform duration-200 ${isOpen ? "scale-y-0" : ""}`} />
                </span>
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                    className="overflow-hidden"
                  >
                    <p className="max-w-[40rem] pb-6 text-[15.5px] leading-[1.65] text-ink-2">{f.a}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
