"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Reveals its children once when scrolled into view: a masked rise for headings, a soft fade for the rest. */
export function Reveal({ children, mask = false, delay = 0, className = "" }: { children: ReactNode; mask?: boolean; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") return setOn(true);
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setOn(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={`${mask ? "reveal-mask" : "reveal-fade"} ${on ? "is-in" : ""} ${className}`} style={{ ["--d" as string]: `${delay}ms` }}>
      {mask ? <div>{children}</div> : children}
    </div>
  );
}
