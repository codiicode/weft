"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import type { EngineEvent } from "@weft/engine";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const TONE: Record<string, [string, string]> = {
  fill: ["Trade", "var(--long)"],
  rejected: ["Blocked", "var(--short)"],
  notify: ["Alert", "var(--signal)"],
  status: ["Update", "var(--muted)"],
  error: ["Problem", "var(--short)"],
  warning: ["Account mismatch", "var(--trigger)"],
};

/** Small notices for what your runs do while you're elsewhere in the app. */
export function Toasts() {
  const auth = useAuth();
  const [items, setItems] = useState<EngineEvent[]>([]);
  const on = auth.enabled && auth.authenticated;

  useEffect(() => {
    if (!on) return;
    const unsub = api.subscribeMine((e) => {
      // Funding notes and routine status changes are for the run page, not a popup.
      if (e.type === "notify" && /^Funding /.test(e.message)) return;
      if (e.type === "status" && !/killed|stopped|LIVE/i.test(e.message)) return;
      if (e.type === "warning" && !(e.data as { reconcile?: unknown } | undefined)?.reconcile) return;
      setItems((xs) => [e, ...xs].slice(0, 3));
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== e.id)), 7000);
    });
    return unsub;
  }, [on]);

  return (
    <div className="pointer-events-none fixed bottom-20 right-4 z-[55] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2 lg:bottom-5" aria-live="polite">
      <AnimatePresence initial={false}>
        {items.map((e) => {
          const [label, color] = TONE[e.type] ?? ["Update", "var(--muted)"];
          return (
            <motion.div
              key={e.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: 16 }}
              transition={{ duration: 0.18 }}
              className="pointer-events-auto rounded-[12px] border border-line bg-card px-4 py-3 shadow-lift"
            >
              <div className="flex items-center gap-2 text-[12.5px]">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                <span className="font-medium text-ink-2">{label}</span>
                <Link href={`/run?id=${encodeURIComponent(e.deploymentId)}`} className="ml-auto text-muted hover:text-ink">
                  Open →
                </Link>
              </div>
              <p className="mt-1 line-clamp-3 text-[13.5px] leading-snug text-ink">{e.message}</p>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
