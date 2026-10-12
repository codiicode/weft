"use client";
import { useEffect, useRef } from "react";
import { animate } from "motion/react";
import { useReducedMotion } from "@/lib/hooks";

interface Props {
  value: number;
  from?: number;
  duration?: number;
  format?: (v: number) => string;
  className?: string;
}

/** Tweens a number into place without re-rendering React on every frame. */
export function CountUp({ value, from, duration = 1.2, format = (v) => v.toFixed(0), className }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(from ?? value);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce) {
      el.textContent = format(value);
      prev.current = value;
      return;
    }
    const ctrl = animate(prev.current, value, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => (el.textContent = format(v)),
    });
    prev.current = value;
    return () => ctrl.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration, reduce]);
  return (
    <span ref={ref} className={className}>
      {format(from ?? value)}
    </span>
  );
}
