"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { api, type LibraryEntry } from "@/lib/api";

type Item = { id: string; label: string; hint?: string; group: string; run: () => void };

const PAGES: [string, string][] = [
  ["Home", "/home"],
  ["New strategy", "/new"],
  ["Portfolio", "/portfolio"],
  ["Strategies", "/strategies"],
  ["Markets", "/markets"],
  ["Leaderboard", "/leaderboard"],
  ["Trading accounts", "/accounts"],
  ["Settings", "/settings"],
];

/** ⌘K: jump anywhere, open a strategy, or start drafting from whatever you typed. */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [lib, setLib] = useState<LibraryEntry[] | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("weft:palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("weft:palette", onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    setTimeout(() => input.current?.focus(), 10);
    if (!lib) api.strategies().then((r) => setLib(r.strategies)).catch(() => setLib([]));
  }, [open, lib]);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const items = useMemo<Item[]>(() => {
    const t = q.trim().toLowerCase();
    const out: Item[] = [];
    const draft: Item | null =
      t.length > 2 ? { id: "draft", group: "Draft", label: `Draft a strategy: “${q.trim()}”`, run: () => go(`/new?go=1&thesis=${encodeURIComponent(q.trim())}`) } : null;
    const sentence = t.split(/\s+/).length >= 4;
    if (draft && sentence) out.push(draft);
    for (const [label, href] of PAGES) if (!t || label.toLowerCase().includes(t)) out.push({ id: href, group: "Go to", label, run: () => go(href) });
    for (const e of lib ?? [])
      if (!t || `${e.strategy.name} ${e.strategy.thesis}`.toLowerCase().includes(t))
        out.push({ id: `s:${e.id}`, group: "Strategies", label: e.strategy.name, hint: e.strategy.thesis, run: () => go(`/strategy?id=${encodeURIComponent(e.id)}`) });
    if (draft && !sentence) out.push(draft);
    return out.slice(0, 12);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, lib]);

  useEffect(() => setSel(0), [q]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-start justify-center bg-black/25 px-4 pt-[14vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <motion.div
            role="dialog"
            aria-label="Command menu"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            className="w-full max-w-[560px] overflow-hidden rounded-[14px] border border-line bg-card shadow-lift"
          >
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                else if (e.key === "ArrowDown") (e.preventDefault(), setSel((i) => Math.min(items.length - 1, i + 1)));
                else if (e.key === "ArrowUp") (e.preventDefault(), setSel((i) => Math.max(0, i - 1)));
                else if (e.key === "Enter") items[sel]?.run();
              }}
              placeholder="Search, or type a trade idea…"
              aria-label="Search"
              className="h-14 w-full border-b border-line bg-transparent px-5 text-[16px] text-ink outline-none placeholder:text-faint"
            />
            <ul className="max-h-[50vh] overflow-y-auto p-1.5" role="listbox">
              {items.map((it, i) => (
                <li key={it.id}>
                  {(i === 0 || items[i - 1]!.group !== it.group) && <p className="px-3 pb-1 pt-2.5 text-[12px] text-faint">{it.group}</p>}
                  <button
                    role="option"
                    aria-selected={i === sel}
                    onMouseEnter={() => setSel(i)}
                    onClick={it.run}
                    className={`flex w-full items-baseline gap-3 rounded-[8px] px-3 py-2 text-left text-[14px] ${i === sel ? "bg-paper-2 text-ink" : "text-ink-2"}`}
                  >
                    <span className="shrink-0">{it.label}</span>
                    {it.hint && <span className="truncate text-[13px] text-muted">{it.hint}</span>}
                  </button>
                </li>
              ))}
              {items.length === 0 && <li className="px-3 py-6 text-center text-[14px] text-muted">Nothing found</li>}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
