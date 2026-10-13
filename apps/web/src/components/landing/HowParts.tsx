"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useInView, useReducedMotion } from "@/lib/hooks";

/** Types its text once it scrolls into view, with a caret while typing. */
export function TypedQuote({ text, className = "" }: { text: string; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const inView = useInView(ref, { once: true, rootMargin: "-10% 0px" });
  const reduce = useReducedMotion();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (reduce) return setN(text.length);
    if (!inView) return;
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setN(i);
      if (i >= text.length) clearInterval(id);
    }, 34);
    return () => clearInterval(id);
  }, [inView, reduce, text]);
  const done = n >= text.length;
  return (
    <p ref={ref} className={className} aria-label={text}>
      <span aria-hidden>
        {text.slice(0, n)}
        {!done && <span className="caret ml-[1px] inline-block h-[0.95em] w-[1.5px] translate-y-[2px] bg-ink" />}
        <span className="invisible">{text.slice(n)}</span>
      </span>
    </p>
  );
}

/** Renders children only once in view (so their own entrance animation plays then). */
export function OnView({ children, height, delay = 0 }: { children: ReactNode; height: number; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, rootMargin: "-10% 0px" });
  const reduce = useReducedMotion();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!inView) return;
    if (reduce || !delay) return setShow(true);
    const t = setTimeout(() => setShow(true), delay);
    return () => clearTimeout(t);
  }, [inView, reduce, delay]);
  return (
    <div ref={ref} style={{ minHeight: height }}>
      {show ? children : null}
    </div>
  );
}
