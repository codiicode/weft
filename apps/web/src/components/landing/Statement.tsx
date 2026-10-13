"use client";
import { useRef, useState } from "react";
import { useMotionValueEvent, useScroll } from "motion/react";
import { useReducedMotion } from "@/lib/hooks";

/**
 * One sentence that lights up word by word as you scroll past it.
 * Marked phrases take their meaning's colour once lit: what you think
 * (blue, the signal) and what Weft does (green, the trade).
 */
const TEXT: [string, "signal" | "long" | null][] = [
  ["You don’t need to watch charts all day.", null],
  ["Tell Weft", null],
  ["what you think will happen.", "signal"],
  ["It watches every market, every minute, and", null],
  ["trades the moment you’re right.", "long"],
];

const WORDS = TEXT.flatMap(([chunk, tone]) => chunk.split(" ").map((w) => ({ w, tone })));

export function Statement() {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const [lit, setLit] = useState(reduce ? WORDS.length : 0);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 0.75", "end 0.6"] });
  useMotionValueEvent(scrollYProgress, "change", (v) => setLit(Math.round(Math.max(0, Math.min(1, v)) * WORDS.length)));
  const n = reduce ? WORDS.length : lit;

  return (
    <section ref={ref} className="border-t border-line" aria-label="What Weft does">
      <div className="mx-auto max-w-[1200px] px-5 py-32 sm:px-8 sm:py-44">
        <p className="display max-w-[22ch] text-[clamp(2rem,4.8vw,4.2rem)] leading-[1.12] text-balance">
          {WORDS.map(({ w, tone }, i) => (
            <span
              key={i}
              className="transition-colors duration-300"
              style={{ color: i < n ? (tone ? `var(--${tone})` : "var(--ink)") : "var(--line-2)" }}
            >
              {w}{" "}
            </span>
          ))}
        </p>
      </div>
    </section>
  );
}
