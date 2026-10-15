"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { Card } from "./AppShell";
import { IconCheck } from "@/components/graph/icons";

/** "Sell" on one position: pick how much, confirm, done. */
export function SellButton({ deploymentId, positionId, label, onDone }: { deploymentId: string; positionId: string; label: string; onDone: () => void }) {
  const requireAuth = useRequireAuth();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    // Fixed to the viewport so the table's scroll box can't clip it; closes on scroll or outside click.
    const r = btn.current!.getBoundingClientRect();
    setAt({ top: r.bottom + 6, right: window.innerWidth - r.right });
    const close = () => (setOpen(false), setPick(null));
    const off = (e: MouseEvent) => !box.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && close();
    window.addEventListener("mousedown", off);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", off);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  const sell = async () => {
    if (pick == null || !requireAuth()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.sellPosition(deploymentId, positionId, pick);
      if (!r.ok) throw new Error("The sell didn’t fill. Try again in a moment.");
      setOpen(false);
      setPick(null);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="inline-block text-left">
      <button
        ref={btn}
        onClick={() => setOpen((o) => !o)}
        className="h-7 rounded-[8px] border border-line-2 px-2.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:border-ink/30 hover:text-ink"
      >
        Sell
      </button>
      {open && at && (
        <div ref={box} style={{ top: at.top, right: at.right }} className="fixed z-50 w-[220px] rounded-[12px] border border-line bg-card p-3 shadow-window">
          <div className="text-[12.5px] text-muted">How much {label}?</div>
          <div className="mt-2 grid grid-cols-3 gap-1">
            {[
              [0.25, "25%"],
              [0.5, "Half"],
              [1, "All"],
            ].map(([f, l]) => (
              <button
                key={l as string}
                onClick={() => setPick(f as number)}
                className={`h-8 rounded-[8px] text-[13px] transition-colors ${pick === f ? "bg-ink font-medium text-paper" : "bg-paper-2 text-ink-2 hover:text-ink"}`}
              >
                {l}
              </button>
            ))}
          </div>
          {error && <p className="mt-2 text-[12px] text-short">{error}</p>}
          <button
            onClick={sell}
            disabled={pick == null || busy}
            className="mt-3 h-8 w-full rounded-[8px] bg-ink text-[13px] font-medium text-paper transition-opacity disabled:opacity-40"
          >
            {busy ? "Selling…" : pick == null ? "Pick an amount" : `Sell ${pick >= 1 ? "all" : `${Math.round(pick * 100)}%`} at market`}
          </button>
        </div>
      )}
    </div>
  );
}

const SUGGESTIONS = ["Sell half", "Sell everything", "Stop at 15%", "Take profit at 30%", "Remove the stop"];

/** Tell a running strategy what to do; review the plan, then confirm. */
export function InstructRun({ deploymentId, onDone }: { deploymentId: string; onDone: () => void }) {
  const requireAuth = useRequireAuth();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"plan" | "apply" | null>(null);
  const [plan, setPlan] = useState<{ planId: string; steps: { kind: string; label: string }[] } | null>(null);
  const [done, setDone] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = async (t = text) => {
    if (!t.trim() || !requireAuth()) return;
    setText(t);
    setBusy("plan");
    setError(null);
    setDone(null);
    setPlan(null);
    try {
      setPlan(await api.instruct(deploymentId, t.trim()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const apply = async () => {
    if (!plan) return;
    setBusy("apply");
    setError(null);
    try {
      const r = await api.applyPlan(deploymentId, plan.planId);
      setDone(r.done);
      setPlan(null);
      setText("");
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="p-5">
      <div className="text-[15px] font-semibold tracking-[-0.015em] text-ink">Tell it what to do</div>
      <p className="mt-0.5 text-[13px] text-muted">Sell some, set a stop or a target, or change a rule. You’ll see exactly what happens before anything does.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
        className="mt-3 flex gap-2"
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. sell half and set a stop at 15%"
          className="h-10 min-w-0 flex-1 rounded-[10px] border border-line-2 bg-card px-3 text-[14px] text-ink outline-none placeholder:text-faint focus:border-ink/40"
          aria-label="Instruction for this run"
        />
        <button type="submit" disabled={!text.trim() || busy != null} className="h-10 shrink-0 rounded-[10px] bg-ink px-4 text-[14px] font-medium text-paper transition-opacity disabled:opacity-40">
          {busy === "plan" ? "Reading…" : "Review"}
        </button>
      </form>
      {!plan && !done && (
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px]">
          {SUGGESTIONS.map((sug) => (
            <button key={sug} onClick={() => void ask(sug)} className="text-muted underline decoration-line-2 underline-offset-4 hover:text-ink hover:decoration-ink">
              {sug}
            </button>
          ))}
        </div>
      )}
      {error && <p className="mt-3 rounded-[10px] bg-[var(--short-soft)] px-3 py-2.5 text-[13px] text-short">{error}</p>}
      {plan && (
        <div className="mt-4 rounded-[10px] border border-line bg-paper-2/60 p-4">
          <div className="text-[12.5px] font-medium text-muted">This will</div>
          <ol className="mt-2 space-y-1.5 text-[14px] text-ink">
            {plan.steps.map((s, i) => (
              <li key={i} className="flex gap-2.5">
                <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${s.kind === "sell" ? "bg-short" : "bg-signal"}`} />
                <span>{s.label}</span>
              </li>
            ))}
          </ol>
          <div className="mt-4 flex gap-2">
            <button onClick={apply} disabled={busy != null} className="h-9 rounded-[10px] bg-ink px-4 text-[14px] font-medium text-paper disabled:opacity-40">
              {busy === "apply" ? "Doing it…" : plan.steps.some((s) => s.kind === "sell") ? "Confirm and sell" : "Confirm"}
            </button>
            <button onClick={() => setPlan(null)} disabled={busy != null} className="h-9 rounded-[10px] px-3 text-[14px] text-muted hover:text-ink">
              Cancel
            </button>
          </div>
        </div>
      )}
      {done && (
        <ul className="mt-4 space-y-1.5 text-[13.5px] text-ink-2">
          {done.map((d, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[var(--long-soft)] text-long">
                <IconCheck size={9} strokeWidth={2.6} />
              </span>
              {d}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
