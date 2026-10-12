"use client";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/** Motion respects the OS reduced-motion setting for every transform animation. */
export function Providers({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
