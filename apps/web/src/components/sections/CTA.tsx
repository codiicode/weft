"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { brand } from "@/config/brand";
import { ThreadField } from "../ui/ThreadField";
import { Magnetic } from "../ui/Magnetic";
import { IconArrowRight, IconCheck } from "../graph/icons";

export function CTA() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "error" | "done">("idle");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Frontend-only: wire this to your waitlist provider later.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setState("error");
    setState("done");
  };
  return (
    <section id="waitlist" className="relative px-3 py-10 sm:px-5 md:py-16">
      <div className="night grain relative mx-auto max-w-[1240px] overflow-hidden rounded-[32px] px-6 py-20 text-center sm:px-10 md:py-32">
        <div className="absolute inset-0 opacity-90">
          <ThreadField className="absolute inset-0 h-full w-full" density={30} accentEvery={5} />
        </div>
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-[420px] w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(205,255,63,.14),transparent)] blur-2xl" />
        <div className="relative">
          <div className="mx-auto inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
            <span className="h-[5px] w-[5px] rounded-full bg-volt" /> Private beta · rolling invites
          </div>
          <h2 className="mx-auto mt-6 max-w-[15ch] text-[clamp(2.6rem,7vw,6rem)] font-semibold leading-[0.95] tracking-[-0.055em] text-ink">
            Your thesis deserves a <span className="serif-em text-volt">trade.</span>
          </h2>
          <p className="mx-auto mt-6 max-w-md text-[17px] leading-relaxed text-ink-2">
            Join the waitlist. Early users get paper trading on day one and first access to live mode.
          </p>
          <AnimatePresence mode="wait">
            {state === "done" ? (
              <motion.div
                key="done"
                initial={{ opacity: 0, y: 10, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                className="mx-auto mt-10 inline-flex items-center gap-3 rounded-full border border-line-2 bg-card/70 py-2 pl-2 pr-5 backdrop-blur"
              >
                <span className="grid h-9 w-9 place-items-center rounded-full bg-volt text-[#0b0c0f]">
                  <IconCheck size={16} strokeWidth={2.4} />
                </span>
                <span className="text-left text-[14px] text-ink">
                  You&apos;re on the list. <span className="font-mono text-muted">#4,812 in line</span>
                </span>
              </motion.div>
            ) : (
              <motion.form
                key="form"
                onSubmit={submit}
                exit={{ opacity: 0, y: -8 }}
                className="mx-auto mt-10 flex max-w-md flex-col gap-2 sm:flex-row sm:rounded-full sm:border sm:border-line-2 sm:bg-card/70 sm:p-1.5 sm:backdrop-blur"
                noValidate
              >
                <label htmlFor="email" className="sr-only">Email</label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@domain.com"
                  value={email}
                  onChange={(e) => (setEmail(e.target.value), state === "error" && setState("idle"))}
                  className={`h-12 flex-1 rounded-full border bg-card/70 px-5 text-[15px] text-ink outline-none placeholder:text-faint focus:border-volt sm:h-11 sm:border-0 sm:bg-transparent ${state === "error" ? "border-short" : "border-line-2"}`}
                  aria-invalid={state === "error"}
                />
                <Magnetic className="justify-center">
                  <button type="submit" className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-volt px-6 text-[15px] font-medium text-[#0b0c0f] shadow-[0_10px_30px_-10px_rgba(205,255,63,.7)] sm:h-11 sm:w-auto">
                    Join waitlist <IconArrowRight size={15} />
                  </button>
                </Magnetic>
              </motion.form>
            )}
          </AnimatePresence>
          <div className="mt-3 h-5 font-mono text-[11px] text-short">{state === "error" ? "That email doesn't look right." : ""}</div>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-[11px] text-muted">
            <span>Non-custodial</span>
            <span className="h-1 w-1 rounded-full bg-faint" />
            <span>Paper by default</span>
            <span className="h-1 w-1 rounded-full bg-faint" />
            <span>${brand.ticker} on {brand.chain}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
