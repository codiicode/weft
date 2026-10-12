"use client";
import { useEffect, useState } from "react";
import { Logo } from "../ui/Logo";
import { ThemeToggle } from "../ui/ThemeToggle";
import { Button } from "../ui/Button";

const links = [
  ["How it works", "#how"],
  ["Markets", "#markets"],
  ["Safety", "#safety"],
  ["Strategies", "#strategies"],
  ["Token", "#token"],
];

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-[background-color,border-color] duration-200 ${
        scrolled || open ? "border-b border-line bg-paper/90 backdrop-blur-md" : "border-b border-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-8 px-5 sm:px-8">
        <a href="#top" aria-label="Weft home">
          <Logo />
        </a>
        <nav className="hidden items-center gap-7 md:flex">
          {links.map(([l, h]) => (
            <a key={h} href={h} className="text-[14px] text-ink-2 transition-colors hover:text-ink">
              {l}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <Button href="/app" size="sm" className="hidden sm:inline-flex">
            Open app
          </Button>
          <button
            className="grid h-9 w-9 place-items-center rounded-[10px] text-ink md:hidden"
            onClick={() => setOpen((o) => !o)}
            aria-label="Menu"
            aria-expanded={open}
          >
            <span className="relative block h-3 w-4">
              <span className={`absolute left-0 h-[1.5px] w-4 bg-current transition-all ${open ? "top-1.5 rotate-45" : "top-0.5"}`} />
              <span className={`absolute left-0 h-[1.5px] w-4 bg-current transition-all ${open ? "top-1.5 -rotate-45" : "top-2.5"}`} />
            </span>
          </button>
        </div>
      </div>
      {open && (
        <nav className="border-t border-line px-5 pb-5 pt-2 md:hidden">
          {links.map(([l, h]) => (
            <a key={h} href={h} onClick={() => setOpen(false)} className="block border-b border-line py-3.5 text-[16px] text-ink">
              {l}
            </a>
          ))}
          <Button href="/app" size="lg" className="mt-4 w-full">
            Open app
          </Button>
        </nav>
      )}
    </header>
  );
}
