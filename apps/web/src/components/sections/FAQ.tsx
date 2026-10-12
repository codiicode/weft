"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { faqs } from "@/data/mock";
import { SectionHeading, Reveal } from "../ui/Reveal";
import { IconPlus } from "../graph/icons";

export function FAQ() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section id="faq" className="relative py-24 md:py-36">
      <div className="mx-auto grid max-w-[1240px] gap-12 px-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <SectionHeading
            eyebrow="FAQ"
            title={
              <>
                Questions, <span className="serif-em">answered.</span>
              </>
            }
            sub="The short version: your wallet, your rules, a public graph, and an agent that can't take the money and run."
          />
        </div>
        <div className="border-t border-line">
          {faqs.map((f, i) => {
            const isOpen = open === i;
            return (
              <Reveal key={f.q} delay={i * 0.03} className="border-b border-line">
                <button
                  onClick={() => setOpen(isOpen ? null : i)}
                  aria-expanded={isOpen}
                  className="group flex w-full items-center gap-6 py-6 text-left"
                >
                  <span className="font-mono text-[11px] text-faint">{String(i + 1).padStart(2, "0")}</span>
                  <span className="flex-1 text-[18px] font-medium tracking-[-0.02em] text-ink sm:text-[20px]">{f.q}</span>
                  <motion.span
                    animate={{ rotate: isOpen ? 45 : 0 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border transition-colors ${isOpen ? "border-ink bg-ink text-paper" : "border-line text-ink-2 group-hover:border-ink"}`}
                  >
                    <IconPlus size={14} />
                  </motion.span>
                </button>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                      className="overflow-hidden"
                    >
                      <p className="max-w-2xl pb-7 pl-[42px] pr-12 text-[15.5px] leading-relaxed text-ink-2">{f.a}</p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
