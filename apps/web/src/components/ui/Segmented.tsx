"use client";
import { motion } from "motion/react";

/** A small pill switch (ranges, chart type). The selected pill slides between options. */
export function Segmented<T extends string>({ value, options, onChange, id }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; id: string }) {
  return (
    <div className="inline-flex rounded-[10px] bg-paper-2 p-0.5" role="tablist">
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={`relative h-7 min-w-[40px] rounded-[8px] px-2.5 text-[13px] transition-colors ${value === o.id ? "font-medium text-ink" : "text-muted hover:text-ink"}`}
        >
          {value === o.id && <motion.span layoutId={`seg-${id}`} className="absolute inset-0 rounded-[8px] bg-[var(--raised)] shadow-[0_1px_2px_rgba(0,0,0,0.08)]" transition={{ type: "spring", stiffness: 480, damping: 36 }} />}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
