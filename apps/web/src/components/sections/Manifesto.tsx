"use client";
import { useRef } from "react";
import { motion, useScroll, useTransform, type MotionValue } from "motion/react";
import { brand } from "@/config/brand";
import { Eyebrow, Reveal } from "../ui/Reveal";

type Tok = { w: string; cls?: string };

const tokens: Tok[] = [
  ...`${brand.competitor.name} raised ${brand.competitor.raised} from ${brand.competitor.investor} to build a`.split(" ").map((w) => ({ w })),
  { w: "closed", cls: "line-through decoration-[0.06em] decoration-short/70" },
  ...`AI trading app.`.split(" ").map((w) => ({ w })),
  { w: "We", cls: "" },
  { w: "built" },
  { w: "the" },
  { w: "open", cls: "serif-em" },
  { w: "one.", cls: "serif-em" },
  ...`Non-custodial. Every strategy public and forkable. And the token`.split(" ").map((w) => ({ w })),
  { w: "eats", cls: "highlight" },
  { w: "the", cls: "highlight" },
  { w: "fees.", cls: "highlight" },
];

function Word({ tok, i, n, p }: { tok: Tok; i: number; n: number; p: MotionValue<number> }) {
  const start = i / n;
  const opacity = useTransform(p, [start, start + 1.5 / n], [0.2, 1]);
  const y = useTransform(p, [start, start + 1.5 / n], [6, 0]);
  return (
    <motion.span style={{ opacity, y }} className={`mr-[0.24em] inline-block ${tok.cls ?? ""}`}>
      {tok.w}
    </motion.span>
  );
}

export function Manifesto() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 0.85", "end 0.5"] });
  return (
    <section className="relative py-28 md:py-44">
      <div className="mx-auto max-w-[1240px] px-5">
        <Reveal>
          <Eyebrow>Why {brand.name}</Eyebrow>
        </Reveal>
        <div ref={ref} className="mt-8 max-w-[22ch] text-[clamp(2rem,5.4vw,4.6rem)] font-semibold leading-[1.04] tracking-[-0.045em] text-ink sm:max-w-[24ch]">
          {tokens.map((t, i) => (
            <Word key={i} tok={t} i={i} n={tokens.length} p={scrollYProgress} />
          ))}
        </div>
        <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
          {[
            ["01", "Non-custodial", "Funds never leave your wallet. The agent's key can trade, never withdraw."],
            ["02", "Public & forkable", "Every strategy is a readable graph with an on-chain track record. Fork it in one click."],
            ["03", "Fees → buyback", `Builder fees buy back $${brand.ticker} on the open market, in public.`],
          ].map(([n, t, d], i) => (
            <Reveal key={n} delay={i * 0.08} className="bg-paper p-6 sm:p-7">
              <div className="font-mono text-[11px] text-faint">{n}</div>
              <div className="mt-6 text-[18px] font-semibold tracking-[-0.02em]">{t}</div>
              <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">{d}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
