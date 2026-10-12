"use client";
import { useRef } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { HeroDemo } from "./HeroDemo";
import { ThreadField } from "../ui/ThreadField";
import { Button } from "../ui/Magnetic";
import { IconArrowRight } from "../graph/icons";
import { useReducedMotion } from "@/lib/hooks";


function Line({ children, delay }: { children: React.ReactNode; delay: number }) {
  return (
    <span className="block overflow-hidden pb-[0.08em]">
      <span className="rise" style={{ animationDelay: `${delay}s` }}>
        {children}
      </span>
    </span>
  );
}

export function Hero() {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const rotateX = useTransform(scrollYProgress, [0, 0.35], reduce ? [0, 0] : [11, 0]);
  const scale = useTransform(scrollYProgress, [0, 0.35], reduce ? [1, 1] : [0.94, 1]);
  const glowY = useTransform(scrollYProgress, [0, 1], [0, 160]);
  const copyY = useTransform(scrollYProgress, [0, 0.4], reduce ? [0, 0] : [0, -60]);
  const copyOpacity = useTransform(scrollYProgress, [0, 0.3], [1, 0.2]);

  return (
    <section ref={ref} id="top" className="grain relative overflow-hidden pb-20 pt-28 sm:pt-36 md:pb-28">
      <div className="absolute inset-0 [mask-image:linear-gradient(to_bottom,black,black_55%,transparent)]">
        <ThreadField className="absolute inset-0 h-full w-full" density={34} />
      </div>
      {/* soft glows */}
      <div className="pointer-events-none absolute left-1/2 top-[38%] h-[720px] w-[1100px] -translate-x-1/2">
        <motion.div style={{ y: glowY }} className="h-full w-full rounded-full opacity-60 blur-[120px] [background:radial-gradient(closest-side,var(--signal-soft),transparent),radial-gradient(closest-side_at_70%_60%,color-mix(in_oklab,var(--volt)_30%,transparent),transparent)]" />
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-paper to-transparent" />

      <motion.div style={{ y: copyY, opacity: copyOpacity }} className="relative mx-auto max-w-[1240px] px-5 text-center">
        <a
          href="#waitlist"
          className="enter group mx-auto inline-flex items-center gap-2 rounded-full border border-line bg-card/70 py-1 pl-1 pr-3 text-[12.5px] text-ink-2 shadow-card backdrop-blur transition-colors hover:text-ink"
        >
          <span className="rounded-full bg-ink px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-paper">Beta</span>
          Open, non-custodial, paper trading by default
          <IconArrowRight size={12} className="transition-transform group-hover:translate-x-0.5" />
        </a>

        <h1 className="mx-auto mt-7 max-w-[13ch] text-[clamp(3.1rem,9vw,7.9rem)] font-semibold leading-[0.9] tracking-[-0.058em] text-ink">
          <Line delay={0.08}>
            Trade the <span className="serif-em pr-[0.04em] tracking-[-0.02em]">thesis,</span>
          </Line>
          <Line delay={0.18}>
            not the <span className="text-muted">chart.</span>
          </Line>
        </h1>

        <p
          style={{ animationDelay: "0.32s" }}
          className="enter mx-auto mt-7 max-w-[34rem] text-[17px] leading-relaxed text-ink-2 text-pretty sm:text-[19px]"
        >
          Write what you believe in plain English. Weft researches it, weaves it into a strategy graph you can read, and trades it for you: perps, stocks, prediction markets and any Solana token, on Hyperliquid and Jupiter.{" "}
          <span className="text-ink">Your keys never leave your hands.</span>
        </p>

        <div
          style={{ animationDelay: "0.45s" }}
          className="enter mt-9 flex flex-wrap items-center justify-center gap-3"
        >
          <Button href="#waitlist" size="lg">
            Join the waitlist <IconArrowRight size={15} />
          </Button>
          <Button href="#gallery" size="lg" variant="ghost">
            Explore strategies
          </Button>
        </div>
      </motion.div>

      <div className="relative mx-auto mt-14 max-w-[1240px] px-3 sm:mt-20 sm:px-5 [perspective:1800px]">
        <div className="enter" style={{ animationDelay: "0.5s", animationDuration: "1.2s" }}>
          <motion.div style={{ rotateX, scale, transformOrigin: "50% 0%" }}>
            <HeroDemo />
          </motion.div>
        </div>
        <p className="mt-4 text-center font-mono text-[11px] text-faint">Demo with illustrative data. Hover any node to trace its path.</p>
      </div>
    </section>
  );
}
