"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Section } from "./Section";
import { brand, $T } from "@/config/brand";

const faqs = [
  {
    q: "Do I need to know how to trade?",
    a: "You need an opinion, not a trading background. Weft turns it into concrete rules and shows you each one in plain English before anything runs. Test it on recent market data first, then start it with whatever amount you like.",
  },
  {
    q: "Does Weft hold my money?",
    a: "No. Your money stays in your own Hyperliquid account and your own Solana wallet. Weft gets a key that can place trades, but it can’t withdraw or send money anywhere. You can move your money out whenever you want.",
  },
  {
    q: "What can it watch?",
    a: "Prices, funding and open interest (on Hyperliquid, Binance and Bybit), order books, prediction-market odds from Hyperliquid and Polymarket, and on-chain data for Solana tokens: holders, buys and sells, liquidity and dev wallets. It can copy every trade a Solana wallet or a Hyperliquid trader makes, track how much a coin is talked about on X, and act when an account you pick posts something specific. Also crypto and market headlines, interest rates, stock indices, oil, the dollar, inflation and jobs data, earnings and Fed dates, weather forecasts, sports standings (NBA, NFL, MLB, NHL and the big soccer leagues), and crypto-wide numbers like the Fear & Greed Index, Bitcoin dominance, stablecoin supply, DeFi TVL and protocol fees.",
  },
  {
    q: "Can I copy other traders?",
    a: "Yes. Give Weft a Solana wallet or a Hyperliquid account and it copies every new trade they make with your own amount, then closes when they close. You can limit it to certain coins, cap how many copies are open, or only copy while a condition holds, like “only while Fear & Greed is above 50”. Whatever they held before you started is left alone.",
  },
  {
    q: "What does it cost?",
    a: `Writing and testing strategies is free. When a strategy trades, you pay ${(brand.builderFeeBps / 100).toFixed(2)}% on Hyperliquid and ${+(brand.swapFeeBps / 100).toFixed(2)}% on Solana swaps. Half of every fee buys back ${$T}. Once ${$T} is live, holders pay half.`,
  },
  {
    q: "Is it safe to trade new tokens with it?",
    a: "Safer than doing it by hand, but never safe. Weft finds a token by its contract address, not its ticker, and checks every buy for the usual rug signs: whether the dev can still mint or freeze, how much the top wallets hold, how deep the liquidity is and whether the dev has sold. If a check fails, you get a warning. Add “only if it’s safe” and a failed check stops the buy instead. New tokens can still go to zero.",
  },
  {
    q: "Can it just alert me instead?",
    a: "Yes. Any strategy can run as alerts only. Weft messages you on Telegram when it would have traded, and no money moves.",
  },
  {
    q: "What if Weft goes down?",
    a: "Stops on Hyperliquid stay in place, because they sit on Hyperliquid itself. New trades wait until Weft is back. Stops on Solana tokens are watched by Weft, so those wait too.",
  },
  {
    q: "Is this financial advice?",
    a: "No. Weft runs the rules you write and approve. Trading is risky, and leverage makes losses bigger.",
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
