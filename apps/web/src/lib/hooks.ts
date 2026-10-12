"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useReducedMotion as useMotionReduced } from "motion/react";
import { mulberry32 } from "./rng";

/**
 * Reduced-motion preference that matches the server render on first paint
 * (false), then reflects the user's setting once mounted. Avoids hydration
 * mismatches for components that branch on it.
 */
export function useReducedMotion() {
  const pref = useMotionReduced();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? !!pref : false;
}

/** True while the element is (nearly) on screen. */
export function useInView<T extends Element>(
  ref: RefObject<T | null>,
  { rootMargin = "120px", once = false }: { rootMargin?: string; once?: boolean } = {}
) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        setInView(e.isIntersecting);
        if (e.isIntersecting && once) io.disconnect();
      },
      { rootMargin }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin, once]);
  return inView;
}

/** Element width via ResizeObserver. */
export function useWidth<T extends Element>(ref: RefObject<T | null>) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    setW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** setInterval that only runs while `active`. */
export function useInterval(fn: () => void, ms: number | null, active = true) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (ms == null || !active) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms, active]);
}

/**
 * A live-ticking random-walk series. Pauses when `active` is false and
 * freezes under reduced motion.
 */
export function useLiveSeries(
  seed: number,
  { length = 40, start = 100, vol = 0.004, drift = 0, ms = 1200, active = true } = {}
) {
  const reduce = useReducedMotion();
  const rand = useRef(mulberry32(seed));
  const [series, setSeries] = useState<number[]>(() => {
    const r = mulberry32(seed * 7 + 3);
    const out = [start];
    for (let i = 1; i < length; i++) out.push(out[i - 1] * (1 + drift + (r() - 0.5) * 2 * vol));
    return out;
  });
  useInterval(
    () =>
      setSeries((s) => {
        const last = s[s.length - 1];
        const next = last * (1 + drift + (rand.current() - 0.5) * 2 * vol);
        return [...s.slice(1), next];
      }),
    ms,
    active && !reduce
  );
  return series;
}

export function useMediaQuery(q: string) {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(q);
    setM(mq.matches);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}
