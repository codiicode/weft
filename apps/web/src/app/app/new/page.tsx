"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import type { Strategy } from "@weft/strategy";
import { api, ApiError, type GenerateProgress, type GenerateResult } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { PageHeader, Card, Btn, Pill } from "@/components/app/AppShell";
import { StrategyCanvas } from "@/components/app/StrategyCanvas";
import { DeployPanel } from "@/components/app/DeployPanel";
import { BacktestPanel } from "@/components/app/BacktestPanel";
import { IconModel, IconSend, IconCheck } from "@/components/graph/icons";

const SUGGESTIONS = [
  "Buy $BONK when it dips 10% and sentiment turns bullish. 0.5 SOL, tight stop.",
  "El Niño is coming — what's the trade?",
  "The Fed cuts in December and nobody's positioned for it.",
  "NVDA rips into earnings, flat before the print.",
  "SOL longs are way too crowded. Fade them.",
  "ETH call spread if it breaks out this week.",
];

function Builder() {
  const params = useSearchParams();
  const [thesis, setThesis] = useState(params.get("thesis") ?? "");
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [steps, setSteps] = useState<GenerateProgress[]>([]);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"graph" | "json">("graph");
  const [json, setJson] = useState("");
  const [jsonMsg, setJsonMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const strategy: Strategy | null = result?.strategy ?? null;

  const requireAuth = useRequireAuth();
  const generate = async (t = thesis) => {
    if (t.trim().length < 3) return;
    if (!requireAuth()) return;
    abort.current?.abort();
    abort.current = new AbortController();
    setStatus("running");
    setSteps([]);
    setResult(null);
    setError(null);
    setSaved(null);
    try {
      const r = await api.generateStream(t.trim(), (p) => setSteps((s) => [...s, p]), abort.current.signal);
      setResult(r);
      setJson(JSON.stringify(r.strategy, null, 2));
      setStatus("done");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message);
      setStatus("error");
    }
  };

  useEffect(() => {
    if (params.get("thesis") && params.get("go") === "1") generate(params.get("thesis")!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyJson = async () => {
    try {
      const parsed = JSON.parse(json);
      const v = await api.validate(parsed);
      setResult((r) => (r ? { ...r, strategy: v.strategy, warnings: v.warnings, graph: v.graph } : r));
      setJsonMsg({ ok: true, text: `Valid. ${v.warnings.length} warning(s).` });
      setTab("graph");
    } catch (e) {
      setJsonMsg({ ok: false, text: e instanceof ApiError && e.issues?.length ? e.issues.map((i) => `${i.path}: ${i.message}`).join("\n") : (e as Error).message });
    }
  };

  const save = async () => {
    if (!strategy || !requireAuth()) return;
    const entry = await api.saveStrategy(strategy);
    setSaved(entry.id);
  };

  return (
    <>
      <PageHeader eyebrow="New strategy" title={<>Write the <span className="serif-em">thesis.</span></>} sub="Plain language. The agent researches the markets, builds a graph you can read, and you decide whether it runs." />
      <div className="space-y-6 px-5 py-6 lg:px-10">
        {/* Prompt */}
        <Card className="p-3 sm:p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              generate();
            }}
            className="flex items-start gap-3"
          >
            <span className="mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--signal-soft)] text-signal">
              <IconModel size={16} />
            </span>
            <textarea
              value={thesis}
              onChange={(e) => setThesis(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generate();
              }}
              rows={2}
              placeholder="e.g. Buy $WIF when it reclaims 2.40 and X turns bullish, 1 SOL, stop at −15%"
              className="min-h-[56px] flex-1 resize-none bg-transparent py-1.5 text-[17px] leading-relaxed tracking-[-0.01em] text-ink outline-none placeholder:text-faint"
              aria-label="Your market thesis"
            />
            <button
              type="submit"
              disabled={status === "running" || thesis.trim().length < 3}
              className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink text-paper transition-opacity disabled:opacity-30"
              aria-label="Generate strategy"
            >
              {status === "running" ? <span className="spin-slow block h-4 w-4 rounded-full border-2 border-paper/30 border-t-paper" /> : <IconSend size={15} />}
            </button>
          </form>
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => {
                  setThesis(s);
                  generate(s);
                }}
                className="rounded-full border border-line px-3 py-1 text-[12.5px] text-ink-2 transition-colors hover:border-ink hover:text-ink"
              >
                {s.length > 48 ? `${s.slice(0, 46)}…` : s}
              </button>
            ))}
          </div>
        </Card>

        {/* Progress */}
        <AnimatePresence>
          {(status === "running" || (status !== "idle" && steps.length > 0)) && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex flex-wrap items-center gap-1.5">
              <span className={`mr-1 font-mono text-[10.5px] uppercase tracking-[0.12em] ${status === "running" ? "shimmer-text" : "text-muted"}`}>
                {status === "running" ? "Researching" : "Research"}
              </span>
              {steps.map((s, i) => (
                <motion.span
                  key={i}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1 text-[12px] text-ink-2"
                >
                  {i === steps.length - 1 && status === "running" ? (
                    <span className="spin-slow block h-3 w-3 rounded-full border-[1.5px] border-line-2 border-t-ink-2" />
                  ) : (
                    <IconCheck size={11} className={s.type === "invalid" ? "text-trigger" : "text-long"} />
                  )}
                  {s.message}
                </motion.span>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {error && (
          <Card className="border-[color-mix(in_oklab,var(--short)_40%,transparent)] p-4 text-[14px] text-short">
            {error}. Is the API running? <span className="font-mono">npm run dev -w @weft/api</span>
          </Card>
        )}

        {status === "idle" && (
          <div className="dot-grid grid place-items-center rounded-[20px] border border-dashed border-line-2 px-6 py-20 text-center">
            <div className="max-w-md">
              <div className="text-[17px] font-semibold tracking-[-0.02em]">Your strategy graph appears here</div>
              <p className="mt-1.5 text-[14px] text-ink-2">
                Perps, stocks, predictions, Solana tokens and options. Tokens are resolved to their mint address, and vague words like “bullish” become measurable conditions.
              </p>
            </div>
          </div>
        )}

        {status === "running" && !result && (
          <div className="dot-grid grid h-[360px] place-items-center rounded-[20px] border border-line bg-paper/50">
            <div className="flex items-center gap-2">
              {["var(--signal)", "var(--trigger)", "var(--long)"].map((c, i) => (
                <motion.span key={c} className="h-2.5 w-2.5 rounded-full" style={{ background: c }} animate={{ y: [0, -8, 0], opacity: [0.4, 1, 0.4] }} transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }} />
              ))}
            </div>
          </div>
        )}

        {/* Result */}
        {result && strategy && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[24px] font-semibold tracking-[-0.03em]">{strategy.name}</h2>
                <Pill tone={result.source === "claude" ? "signal" : "neutral"}>{result.source === "claude" ? "Built by Claude" : "Template"}</Pill>
                {strategy.tags.map((t) => (
                  <Pill key={t}>{t}</Pill>
                ))}
                <div className="ml-auto flex rounded-full border border-line p-0.5">
                  {(["graph", "json"] as const).map((t) => (
                    <button key={t} onClick={() => setTab(t)} className={`rounded-full px-3 py-1 font-mono text-[11px] uppercase tracking-[0.1em] ${tab === t ? "bg-ink text-paper" : "text-ink-2"}`}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              {result.rationale && <p className="max-w-3xl text-[15px] leading-relaxed text-ink-2">{result.rationale}</p>}

              {tab === "graph" ? (
                <StrategyCanvas strategy={strategy} />
              ) : (
                <div>
                  <textarea
                    value={json}
                    onChange={(e) => setJson(e.target.value)}
                    spellCheck={false}
                    className="h-[520px] w-full rounded-2xl border border-line bg-card p-4 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-ink"
                    aria-label="Strategy JSON"
                  />
                  <div className="mt-2 flex items-start gap-3">
                    <Btn onClick={applyJson} variant="ghost">Validate & apply</Btn>
                    {jsonMsg && <pre className={`whitespace-pre-wrap font-mono text-[12px] ${jsonMsg.ok ? "text-long" : "text-short"}`}>{jsonMsg.text}</pre>}
                  </div>
                </div>
              )}

              {(result.warnings.length > 0 || result.notes.length > 0) && (
                <Card className="p-4">
                  <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">Notes</div>
                  <ul className="mt-2 space-y-1.5 text-[13px] text-ink-2">
                    {result.notes.map((n) => (
                      <li key={n}>• {n}</li>
                    ))}
                    {result.warnings.map((w) => (
                      <li key={w.path + w.message}>
                        <span className="text-trigger">⚠</span> <span className="font-mono text-[11.5px] text-faint">{w.path}</span> {w.message}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              <BacktestPanel strategy={strategy} />
            </div>

            <div className="space-y-4">
              <DeployPanel strategy={strategy} />
              <Card className="p-5">
                <div className="text-[15px] font-semibold tracking-[-0.02em]">Publish to the library</div>
                <p className="mt-1.5 text-[13px] text-ink-2">Public and forkable. Your wallet and sizes stay private.</p>
                {saved ? (
                  <Link href={`/app/strategy?id=${encodeURIComponent(saved)}`} className="mt-3 inline-flex items-center gap-1.5 text-[14px] font-medium text-long">
                    <IconCheck size={14} /> Saved: view it →
                  </Link>
                ) : (
                  <Btn onClick={save} variant="ghost" className="mt-3 w-full">Save strategy</Btn>
                )}
              </Card>
              <Card className="p-5">
                <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">Risk policy</div>
                <dl className="mt-3 grid grid-cols-2 gap-y-2 font-mono text-[12px]">
                  <dt className="text-faint">Max position</dt><dd className="text-right">{strategy.risk.maxPositionPct}%</dd>
                  <dt className="text-faint">Max exposure</dt><dd className="text-right">{strategy.risk.maxTotalExposurePct}%</dd>
                  <dt className="text-faint">Max leverage</dt><dd className="text-right">{strategy.risk.maxLeverage}×</dd>
                  <dt className="text-faint">Daily loss stop</dt><dd className="text-right">{strategy.risk.maxDailyLossPct}%</dd>
                  <dt className="text-faint">Stops required</dt><dd className="text-right">{strategy.risk.requireStopLoss ? "yes" : "no"}</dd>
                  <dt className="text-faint">Token min liq.</dt><dd className="text-right">${strategy.risk.token.minLiquidityUsd.toLocaleString()}</dd>
                </dl>
              </Card>
            </div>
          </motion.div>
        )}
      </div>
    </>
  );
}

export default function NewStrategyPage() {
  return (
    <Suspense>
      <Builder />
    </Suspense>
  );
}
