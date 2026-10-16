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
  const [geo, setGeo] = useState<{ W: number; H: number; x: number; y: number; l: number } | null>(null);
  useEffect(() => {
    const measure = () => {
      const a = sec.current?.getBoundingClientRect();
      const b = form.current?.getBoundingClientRect();
      if (a && b) setGeo({ W: a.width, H: a.height, x: b.right - a.left, y: b.top - a.top + b.height / 2, l: b.left - a.left });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (sec.current) ro.observe(sec.current);
    return () => ro.disconnect();
  }, []);
  const go = (t: string) => {
    window.location.href = `/new?thesis=${encodeURIComponent(t)}`;
  };
  return (
    <section ref={sec} className="relative overflow-hidden border-t border-line">
      {geo && geo.l > 60 && (
        <svg className="pointer-events-none absolute inset-0" width={geo.W} height={geo.H} aria-hidden>
          {[-0.3, -0.12, 0.08].flatMap((k, i) => {
            const sy = geo.y + k * geo.H;
            const right = `M${geo.W} ${sy} C${geo.x + (geo.W - geo.x) * 0.5} ${sy} ${geo.x + (geo.W - geo.x) * 0.25} ${geo.y} ${geo.x} ${geo.y}`;
            const left = `M0 ${geo.y - k * geo.H} C${geo.l * 0.5} ${geo.y - k * geo.H} ${geo.l * 0.75} ${geo.y} ${geo.l} ${geo.y}`;
            return [right, left].map((d, side) => (
              <motion.path
                key={`${k}-${side}`}
                d={d}
                fill="none"
                strokeWidth={2.2}
                strokeLinecap="round"
                style={{ stroke: "var(--signal)", opacity: [0.35, 0.6, 0.9][i] }}
                initial={{ pathLength: reduce ? 1 : 0 }}
                animate={{ pathLength: inView || reduce ? 1 : 0 }}
                transition={{ duration: 1.5, delay: 0.15 + i * 0.12 + side * 0.06, ease: [0.45, 0, 0.2, 1] }}
              />
            ));
          })}
        </svg>
      )}
      <div className="relative mx-auto max-w-[1200px] px-5 py-32 text-center sm:px-8 sm:py-44">
        <Reveal mask>
          <h2 className="display mx-auto text-[clamp(3rem,8vw,7rem)] leading-[0.98] tracking-[-0.03em] text-ink">What’s your thesis?</h2>
        </Reveal>
        <form
          ref={form}
          onSubmit={(e) => {
            e.preventDefault();
            if (v.trim()) go(v.trim());
          }}
          className="relative mx-auto mt-12 flex max-w-[40rem] items-center gap-2 rounded-[14px] border border-line-2 bg-card p-2 pl-5 text-left shadow-lift focus-within:border-ink/40"
        >
          <input
            value={v}
            onChange={(e) => setV(e.target.value)}
            placeholder={ph}
            aria-label="Your trade idea"
            className="h-11 min-w-0 flex-1 bg-transparent text-[17px] text-ink outline-none placeholder:text-faint"
          />
          <button type="submit" className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] bg-ink text-paper transition-transform hover:scale-[1.04] active:scale-95" aria-label="Draft strategy">
            <IconSend size={16} />
          </button>
        </form>
        <div className="mx-auto mt-5 flex max-w-[44rem] flex-wrap justify-center gap-x-5 gap-y-2 text-[14px]">
          {ideas.map((t) => (
            <button key={t} onClick={() => go(t)} className="text-muted underline decoration-line-2 underline-offset-4 transition-colors hover:text-ink hover:decoration-ink">
              {t}
            </button>
          ))}
        </div>
        <p className="mt-10 text-[14px] text-muted">Free to write and test. A small fee only when it trades.</p>
      </div>
    </section>
  );
}
