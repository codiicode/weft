"use client";
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useInView, useReducedMotion } from "@/lib/hooks";
import { IconSend } from "../graph/icons";
import { Reveal } from "../ui/Reveal";

const ideas = ["Long BTC if ETF inflows stay positive for 3 days", "Fade SOL when funding gets crowded", "Buy YES on a Fed cut if odds dip below 60%"];

export function Closing() {
  const [v, setV] = useState("");
  // The placeholder types out example ideas while the field is empty.
  const [ph, setPh] = useState("Type a trade idea…");
  useEffect(() => {
    if (v || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const examples = ["Buy $WIF if it gets back above 2.40", "Short ETH if funding stays above 0.1% for a day", "Buy YES on a Fed cut if the odds dip below 60%", "Long gold when real yields fall for a week"];
    let i = 0;
    let n = 0;
    let dir = 1;
    const id = setInterval(() => {
      const text = examples[i]!;
      n += dir;
      if (n > text.length + 18) dir = -1;
      if (n <= 0 && dir === -1) {
        dir = 1;
        i = (i + 1) % examples.length;
      }
      setPh(text.slice(0, Math.max(0, Math.min(n, text.length))) || "Type a trade idea…");
    }, 55);
    return () => clearInterval(id);
  }, [v]);
  // Threads from the right edge meet at the send button: your thesis is where they tie together.
  const sec = useRef<HTMLElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const inView = useInView(sec, { once: true, rootMargin: "-20% 0px" });
  const reduce = useReducedMotion();
  const [geo, setGeo] = useState<{ W: number; H: number; x: number; y: number } | null>(null);
  useEffect(() => {
    const measure = () => {
      const a = sec.current?.getBoundingClientRect();
      const b = form.current?.getBoundingClientRect();
      if (a && b) setGeo({ W: a.width, H: a.height, x: b.right - a.left - 22, y: b.top - a.top + b.height / 2 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (sec.current) ro.observe(sec.current);
    return () => ro.disconnect();
  }, []);
  const go = (t: string) => {
    window.location.href = `/app/new?thesis=${encodeURIComponent(t)}`;
  };
  return (
    <section ref={sec} className="relative overflow-hidden border-t border-line">
      {geo && geo.W - geo.x > 160 && (
        <svg className="pointer-events-none absolute inset-0" width={geo.W} height={geo.H} aria-hidden>
          {[-0.4, -0.25, -0.11, 0, 0.1].map((k, i) => {
            const sy = geo.y + k * geo.H;
            const d = `M${geo.W} ${sy} C${geo.x + (geo.W - geo.x) * 0.45} ${sy} ${geo.x + (geo.W - geo.x) * 0.3} ${geo.y} ${geo.x + 22} ${geo.y}`;
            return (
              <motion.path
                key={k}
                d={d}
                fill="none"
                strokeWidth={2}
                strokeLinecap="round"
                style={{ stroke: "var(--signal)", opacity: [0.3, 0.5, 0.7, 0.95, 0.5][i] }}
                initial={{ pathLength: reduce ? 1 : 0 }}
                animate={{ pathLength: inView || reduce ? 1 : 0 }}
                transition={{ duration: 1.6, delay: 0.2 + i * 0.12, ease: [0.45, 0, 0.2, 1] }}
              />
            );
          })}
        </svg>
      )}
      <div className="relative mx-auto max-w-[1200px] px-5 py-28 sm:px-8 sm:py-36">
        <Reveal mask>
          <h2 className="display max-w-[14ch] text-[clamp(2.6rem,6vw,4.8rem)] leading-[1] text-ink">What’s your thesis?</h2>
        </Reveal>
        <form
          ref={form}
          onSubmit={(e) => {
            e.preventDefault();
            if (v.trim()) go(v.trim());
          }}
          className="relative mt-10 flex max-w-[44rem] items-center gap-2 rounded-[14px] border border-line-2 bg-card p-2 pl-5 shadow-lift focus-within:border-ink/40"
        >
          <input
            value={v}
            onChange={(e) => setV(e.target.value)}
            placeholder={ph}
            aria-label="Your trade idea"
            className="h-11 min-w-0 flex-1 bg-transparent text-[17px] text-ink outline-none placeholder:text-faint"
          />
          <button type="submit" className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] bg-ink text-paper transition-opacity disabled:opacity-30" disabled={!v.trim()} aria-label="Draft strategy">
            <IconSend size={16} />
          </button>
        </form>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[14px]">
          {ideas.map((t) => (
            <button key={t} onClick={() => go(t)} className="text-muted underline decoration-line-2 underline-offset-4 transition-colors hover:text-ink hover:decoration-ink">
              {t}
            </button>
          ))}
        </div>
        <p className="mt-10 text-[14px] text-muted">Free on paper. No wallet needed to start.</p>
      </div>
    </section>
  );
}
