"use client";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { Btn } from "@/components/app/AppShell";

type Card = { id: string; url: string; image: string; returnPct: number; practice: boolean };

const pct = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(Math.abs(v) >= 10 ? 1 : 2)}%`;

/**
 * "Share result": freezes the run's return (percent only, never amounts) into a card with its own
 * link. The link previews as the card on X and opens the same strategy for whoever clicks it.
 */
export function ShareResult({ id, name }: { id: string; name: string }) {
  const requireAuth = useRequireAuth();
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const start = async () => {
    if (!requireAuth()) return;
    setOpen(true);
    setCard(null);
    setError(null);
    setNote(null);
    setLoaded(false);
    try {
      setCard(await api.resultCard(id));
    } catch (e) {
      setError((e as { status?: number }).status === 403 ? "Only the owner of this run can share it." : (e as Error).message);
    }
  };
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);

  const text = card
    ? card.practice
      ? `My practice run of “${name}” on @weftfinance is ${card.returnPct >= 0 ? "up" : "down"} ${pct(card.returnPct).replace(/^[+−]/, "")}.`
      : `“${name}” on @weftfinance is ${card.returnPct >= 0 ? "up" : "down"} ${pct(card.returnPct).replace(/^[+−]/, "")} so far.`
    : "";
  const post = () => card && window.open(`https://x.com/intent/post?text=${encodeURIComponent(`${text}\n\n${card.url}`)}`, "_blank", "noopener");
  const copyLink = async () => {
    if (!card) return;
    await navigator.clipboard.writeText(card.url);
    setNote("Link copied.");
  };
  const copyImage = async () => {
    if (!card) return;
    try {
      const blob = await fetch(card.image).then((r) => r.blob());
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      setNote("Image copied. Paste it into your post.");
    } catch {
      setNote("Your browser didn’t allow copying the image: use Download instead.");
    }
  };

  return (
    <>
      <Btn variant="quiet" onClick={start}>
        Share result
      </Btn>
      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-4 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
          >
            <motion.div
              role="dialog"
              aria-label="Share this run’s result"
              className="w-full max-w-[640px] rounded-[16px] border border-line bg-card p-5 shadow-2xl"
              initial={{ y: 16, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 8, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-baseline justify-between gap-4">
                <div className="text-[16px] font-semibold tracking-[-0.015em] text-ink">Share the result</div>
                <button onClick={() => setOpen(false)} className="text-[13.5px] text-muted hover:text-ink">
                  Close
                </button>
              </div>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">
                The card shows the return in percent, never amounts. Whoever opens the link can run the same strategy.
              </p>
              <div className="relative mt-4 aspect-[1200/630] overflow-hidden rounded-[10px] border border-line bg-paper-2">
                {card && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={card.image} alt={`${name}: ${pct(card.returnPct)}`} className={`h-full w-full transition-opacity ${loaded ? "opacity-100" : "opacity-0"}`} onLoad={() => setLoaded(true)} />
                )}
                {!loaded && !error && <div className="absolute inset-0 animate-pulse bg-paper-2" />}
                {error && <div className="absolute inset-0 grid place-items-center px-6 text-center text-[14px] text-short">{error}</div>}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Btn onClick={post} disabled={!card}>
                  Post on X
                </Btn>
                <Btn variant="ghost" onClick={copyImage} disabled={!card}>
                  Copy image
                </Btn>
                <Btn variant="ghost" onClick={copyLink} disabled={!card}>
                  Copy link
                </Btn>
                {card && (
                  <a href={card.image} download={`weft-result-${card.id}.png`} className="ml-auto self-center text-[13.5px] text-muted underline decoration-line-2 underline-offset-4 hover:text-ink">
                    Download
                  </a>
                )}
              </div>
              {note && <p className="mt-3 text-[13px] text-muted">{note}</p>}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
