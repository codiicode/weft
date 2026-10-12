"use client";
import { useState } from "react";
import { AnimatePresence, motion, useMotionValueEvent, useScroll } from "motion/react";
import { Logo } from "../ui/Logo";
import { Button } from "../ui/Magnetic";
import { ThemeToggle } from "../ui/ThemeToggle";
import { IconArrowRight } from "../graph/icons";

const links = [
  ["Products", "#products"],
  ["How it works", "#how"],
  ["Strategies", "#gallery"],
  ["Safety", "#safety"],
  ["Leaderboard", "#leaderboard"],
  ["Token", "#token"],
];

export function Nav() {
  const { scrollY, scrollYProgress } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [night, setNight] = useState(false);
  useMotionValueEvent(scrollY, "change", (v) => {
    setScrolled(v > 24);
    const el = document.elementFromPoint(window.innerWidth / 2, 92);
    setNight(!!el?.closest(".night"));
  });

  return (
    <header className={`fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-4 ${night ? "night !bg-transparent" : ""}`}>
      <div
        className={`relative mx-auto flex h-14 max-w-[1240px] items-center gap-6 rounded-full pl-4 pr-2 transition-all duration-500 ${
          scrolled ? "border border-line bg-card/75 shadow-card backdrop-blur-xl" : "border border-transparent"
        }`}
      >
        <a href="#top" aria-label="Weft home" className="shrink-0">
          <Logo />
        </a>
        <nav className="hidden items-center gap-1 lg:flex">
          {links.map(([l, h]) => (
            <a key={h} href={h} className="rounded-full px-3 py-1.5 text-[13.5px] text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink">
              {l}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <span className="hidden sm:inline-flex">
            <Button href="#waitlist" size="md">
              Join waitlist <IconArrowRight size={14} />
            </Button>
          </span>
          <button
            className="grid h-9 w-9 place-items-center rounded-full border border-line lg:hidden"
            onClick={() => setOpen((o) => !o)}
            aria-label="Menu"
            aria-expanded={open}
          >
            <span className="relative block h-3 w-4">
              <span className={`absolute left-0 h-[1.5px] w-4 bg-ink transition-all ${open ? "top-1.5 rotate-45" : "top-0"}`} />
              <span className={`absolute left-0 h-[1.5px] w-4 bg-ink transition-all ${open ? "top-1.5 -rotate-45" : "top-3"}`} />
            </span>
          </button>
        </div>
        {scrolled && (
          <motion.span
            className="absolute bottom-[-1px] left-6 right-6 h-[1.5px] origin-left rounded-full bg-gradient-to-r from-signal via-trigger to-long opacity-70"
            style={{ scaleX: scrollYProgress }}
          />
        )}
      </div>
      <AnimatePresence>
        {open && (
          <motion.nav
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            className="mx-auto mt-2 max-w-[1240px] rounded-3xl border border-line bg-card/95 p-2 shadow-lift backdrop-blur-xl lg:hidden"
          >
            {links.map(([l, h]) => (
              <a key={h} href={h} onClick={() => setOpen(false)} className="block rounded-2xl px-4 py-3 text-[16px] text-ink hover:bg-paper-2">
                {l}
              </a>
            ))}
            <a href="#waitlist" onClick={() => setOpen(false)} className="mt-1 block rounded-2xl bg-ink px-4 py-3 text-[16px] font-medium text-paper">
              Join the waitlist →
            </a>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  );
}
