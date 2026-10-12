"use client";
import { useRef, useState, type ReactNode, type SVGProps } from "react";
import { motion } from "motion/react";
import { useInView, useReducedMotion } from "@/lib/hooks";

export const EASE = [0.22, 1, 0.36, 1] as const;

type IconComp = (p: SVGProps<SVGSVGElement> & { size?: number }) => React.JSX.Element;

const TONES = {
  signal: { bg: "var(--signal-soft)", fg: "var(--signal)" },
  trigger: { bg: "var(--trigger-soft)", fg: "var(--trigger)" },
  long: { bg: "var(--long-soft)", fg: "var(--long)" },
  ink: { bg: "var(--paper-2)", fg: "var(--ink-2)" },
} as const;

export type Tone = keyof typeof TONES;

export interface WidgetProps {
  className?: string;
  index?: number;
}

/**
 * Bento card shell. Owns the in-view + reduced-motion gate and hands a single
 * `live` boolean to its body, so nothing ticks offscreen.
 */
export function WidgetCard({
  icon: Icon,
  label,
  meta,
  tone = "signal",
  index = 0,
  className = "",
  children,
}: {
  icon: IconComp;
  label: string;
  meta?: ReactNode;
  tone?: Tone;
  index?: number;
  className?: string;
  children: (live: boolean) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { rootMargin: "60px" });
  const reduce = useReducedMotion();
  const live = inView && !reduce;
  const t = TONES[tone];
  return (
    <motion.div
      ref={ref}
      className={`min-w-0 ${className}`}
      initial={reduce ? false : { opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.85, delay: (index % 3) * 0.08, ease: EASE }}
    >
      <motion.article
        whileHover={reduce ? undefined : { y: -3 }}
        transition={{ type: "spring", stiffness: 380, damping: 30 }}
        className="relative flex h-full min-w-0 flex-col overflow-hidden rounded-[16px] border border-line bg-card p-5 shadow-card transition-shadow duration-500 hover:shadow-lift"
      >
        <header className="flex h-[22px] min-w-0 items-center gap-2.5">
          <span
            className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[7px]"
            style={{ background: t.bg, color: t.fg }}
          >
            <Icon size={13} />
          </span>
          <span className="shrink-0 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-ink-2">
            {label}
          </span>
          {meta && (
            <span className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
              <span className="mr-2 text-line-2">/</span>
              {meta}
            </span>
          )}
          <LiveDot live={live} />
        </header>
        <div className="mt-4 flex min-w-0 flex-1 flex-col">{children(live)}</div>
      </motion.article>
    </motion.div>
  );
}

export function LiveDot({ live, label = "Live" }: { live: boolean; label?: string }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted">
      <span className="relative flex h-[6px] w-[6px]">
        {live && <span className="pulse-ring absolute inset-0 rounded-full bg-volt-deep dark:bg-volt" />}
        <span className="relative h-[6px] w-[6px] rounded-full bg-volt-deep dark:bg-volt" />
      </span>
      {label}
    </span>
  );
}

/** Mono uppercase micro-label. */
export function MicroLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`font-mono text-[9.5px] font-medium uppercase tracking-[0.14em] text-faint ${className}`}>
      {children}
    </span>
  );
}

/** Signed delta, the only text allowed to wear series colours. */
export function Delta({ value, children, className = "" }: { value: number; children: ReactNode; className?: string }) {
  return (
    <span
      className={`tnum font-mono ${className}`}
      style={{ color: value > 0 ? "var(--long)" : value < 0 ? "var(--short)" : "var(--muted)" }}
    >
      {children}
    </span>
  );
}

/** Briefly washes the background green/red whenever `value` changes. */
export function Flash({ value, children, className = "" }: { value: number; children: ReactNode; className?: string }) {
  const [prev, setPrev] = useState(value);
  const [flash, setFlash] = useState({ n: 0, dir: 0 });
  if (value !== prev) {
    setPrev(value);
    setFlash((f) => ({ n: f.n + 1, dir: value > prev ? 1 : -1 }));
  }
  return (
    <span className={`relative -mx-1 inline-block rounded-[5px] px-1 ${className}`}>
      {flash.n > 0 && (
        <motion.span
          key={flash.n}
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[5px]"
          style={{
            background:
              flash.dir > 0
                ? "color-mix(in oklab, var(--long) 24%, transparent)"
                : "color-mix(in oklab, var(--short) 24%, transparent)",
          }}
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 1.1, ease: "easeOut" }}
        />
      )}
      <span className="relative">{children}</span>
    </span>
  );
}

/** Catmull-Rom → cubic Bézier through points. Command structure is stable for a fixed point count (morphable). */
export function smoothPath(pts: { x: number; y: number }[], tension = 0.18) {
  if (pts.length < 2) return "";
  let d = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) * tension;
    const c1y = p1.y + (p2.y - p0.y) * tension;
    const c2x = p2.x - (p3.x - p1.x) * tension;
    const c2y = p2.y - (p3.y - p1.y) * tension;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  return d;
}

/** Map a series into chart-space points for a fixed y-domain. */
export function toPoints(data: number[], w: number, h: number, min: number, max: number, x0 = 0) {
  const span = max - min || 1;
  const step = (w - x0) / Math.max(1, data.length - 1);
  return data.map((v, i) => ({ x: x0 + i * step, y: (1 - (v - min) / span) * h }));
}
