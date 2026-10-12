"use client";
import { motion, type HTMLMotionProps } from "motion/react";
import type { ReactNode } from "react";

/** Fade/rise into view once. */
export function Reveal({
  children,
  delay = 0,
  y = 18,
  className = "",
  as = "div",
  ...rest
}: { children: ReactNode; delay?: number; y?: number; className?: string; as?: "div" | "li" | "section" } & HTMLMotionProps<"div">) {
  const M = motion[as] as typeof motion.div;
  return (
    <M
      className={className}
      initial={{ opacity: 0, y, filter: "blur(4px)" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.8, delay, ease: [0.22, 1, 0.36, 1] }}
      {...rest}
    >
      {children}
    </M>
  );
}

export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`inline-flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-muted ${className}`}>
      <span className="h-[5px] w-[5px] rounded-full bg-volt shadow-[0_0_0_3px_color-mix(in_oklab,var(--volt)_30%,transparent)]" />
      {children}
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  sub,
  align = "left",
  className = "",
}: {
  eyebrow: string;
  title: ReactNode;
  sub?: ReactNode;
  align?: "left" | "center";
  className?: string;
}) {
  return (
    <div className={`${align === "center" ? "mx-auto text-center" : ""} max-w-3xl ${className}`}>
      <Reveal>
        <Eyebrow>{eyebrow}</Eyebrow>
      </Reveal>
      <Reveal delay={0.05}>
        <h2 className="mt-4 text-[clamp(2rem,4.6vw,3.6rem)] font-semibold leading-[1.02] tracking-[-0.045em] text-balance">
          {title}
        </h2>
      </Reveal>
      {sub && (
        <Reveal delay={0.1}>
          <p className={`mt-5 max-w-xl text-[17px] leading-relaxed text-ink-2 text-pretty ${align === "center" ? "mx-auto" : ""}`}>{sub}</p>
        </Reveal>
      )}
    </div>
  );
}
