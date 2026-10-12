"use client";
import { useRef, type ReactNode } from "react";
import { motion, useMotionValue, useSpring } from "motion/react";
import { useReducedMotion } from "@/lib/hooks";

/** Wraps a child so it leans toward the cursor. */
export function Magnetic({ children, strength = 0.28, className = "" }: { children: ReactNode; strength?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 260, damping: 18, mass: 0.4 });
  const sy = useSpring(y, { stiffness: 260, damping: 18, mass: 0.4 });
  return (
    <motion.span
      ref={ref}
      className={`inline-flex ${className}`}
      style={{ x: sx, y: sy }}
      onPointerMove={(e) => {
        if (reduce || e.pointerType !== "mouse") return;
        const r = ref.current!.getBoundingClientRect();
        x.set((e.clientX - (r.left + r.width / 2)) * strength);
        y.set((e.clientY - (r.top + r.height / 2)) * strength);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
    >
      {children}
    </motion.span>
  );
}

type BtnProps = {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  variant?: "ink" | "ghost" | "volt";
  size?: "md" | "lg";
  className?: string;
  type?: "button" | "submit";
};

export function Button({ children, href, onClick, variant = "ink", size = "md", className = "", type = "button" }: BtnProps) {
  const base =
    "group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-full font-medium tracking-[-0.01em] transition-[background-color,box-shadow,color] duration-300 select-none";
  const sizes = { md: "h-10 px-4 text-[14px]", lg: "h-12 px-6 text-[15px]" }[size];
  const variants = {
    ink: "bg-ink text-paper shadow-[0_1px_0_rgba(255,255,255,.15)_inset,0_8px_24px_-8px_rgba(11,12,15,.5)] hover:shadow-[0_1px_0_rgba(255,255,255,.15)_inset,0_14px_30px_-8px_rgba(11,12,15,.55)]",
    ghost: "border border-line-2 bg-card/60 text-ink backdrop-blur hover:bg-card",
    volt: "bg-volt text-[#0b0c0f] shadow-[0_0_0_1px_rgba(0,0,0,.06)_inset,0_10px_30px_-10px_rgba(205,255,63,.7)] hover:shadow-[0_0_0_1px_rgba(0,0,0,.06)_inset,0_14px_40px_-8px_rgba(205,255,63,.85)]",
  }[variant];
  const inner = (
    <>
      <span className="relative z-10 inline-flex items-center gap-2">{children}</span>
      {variant !== "ghost" && (
        <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-full" />
      )}
    </>
  );
  const cls = `${base} ${sizes} ${variants} ${className}`;
  return (
    <Magnetic>
      {href ? (
        <a href={href} className={cls} onClick={onClick}>
          {inner}
        </a>
      ) : (
        <button type={type} className={cls} onClick={onClick}>
          {inner}
        </button>
      )}
    </Magnetic>
  );
}
