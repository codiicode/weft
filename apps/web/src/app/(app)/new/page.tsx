"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { motion } from "motion/react";
import Link from "next/link";
import type { Strategy } from "@weft/strategy";
import { api, ApiError, type GenerateProgress, type GenerateResult } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { PageHeader, Card, Btn } from "@/components/app/AppShell";
import { StrategyRules } from "@/components/app/StrategyRules";
import { StrategyCanvas } from "@/components/app/StrategyCanvas";
import { DeployPanel } from "@/components/app/DeployPanel";
import { IconSend, IconCheck } from "@/components/graph/icons";

const SUGGESTIONS = [
  "Buy 0.5 SOL of $JUP now.",
  "Open a 20x ETH long with $50 if ETH breaks $2,600 and funding stays under 0.01% an hour. 20% stop.",
  "If @elonmusk posts about Dogecoin and DOGE mentions on X double in an hour, long DOGE 5x with $100. 25% stop.",
  "If the Fear & Greed index reaches 20, open a 20x long on ETH and a 20x long on BTC with $100 on each.",
  "Long natural gas 2x with $100 if Chicago is forecast to be 5°C colder next week than this week.",
  "Long BTC 2x with $100 if Polymarket’s odds of a Fed cut pass 60%.",
  "If the Spurs win at least 10 of their first 15 games and their title odds pass 25%, put $1,000 on them winning the NBA title. Sell if the odds drop below 15%.",
];

/** "Half the size" as an instruction the offline editor also understands. */
function halfSize(s: Strategy): string {
  const a = s.actions.find((x) => x.type === "open");
  if (!a || a.type !== "open") return "half the size";
  const v = +(a.size.value / 2).toPrecision(3);
  if (a.size.unit === "native" && a.instrument.kind === "token") return `use ${v} ${a.instrument.quote}`;
  if (a.size.unit === "usd") return `use $${v}`;
  return `use ${v}% of the account`;
}

function Builder() {
  const params = useSearchParams();
  const [thesis, setThesis] = useState(params.get("thesis") ?? "");
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [steps, setSteps] = useState<GenerateProgress[]>([]);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"rules" | "graph" | "json">("rules");
  const [json, setJson] = useState("");
  const [jsonMsg, setJsonMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [history, setHistory] = useState<GenerateResult[]>([]);
  const [editing, setEditing] = useState(() => !!params.get("from"));
  const [change, setChange] = useState("");
  const [changing, setChanging] = useState(false);
  const [changeNote, setChangeNote] = useState<string | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);

  const strategy: Strategy | null = result?.strategy ?? null;

  const requireAuth = useRequireAuth();
  const generate = async (t = thesis) => {
    if (t.trim().length < 3) return;
    abort.current?.abort();
    abort.current = new AbortController();
    setStatus("running");
    setSteps([]);
    setResult(null);
    setError(null);
    setSaved(null);
    setHistory([]);
    setChangeNote(null);
    setChangeError(null);
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
    const from = params.get("from");
    if (from) {
      (from.startsWith("run:")
        ? api.deployment(from.slice(4)).then((r) => r.deployment.strategy)
        : from.startsWith("shared:")
          ? api.leaderboard().then((d) => {
              const s = d.rows.find((r) => r.deploymentId === from.slice(7))?.strategy;
              if (!s) throw new Error("That strategy is no longer shared.");
              return s;
            })
          : api.strategy(from).then((e) => e.strategy))
        .then((st) => {
          setThesis(st.thesis);
          setResult({ strategy: st, warnings: [], rationale: "", source: "template", notes: [], graph: undefined as never });
          setJson(JSON.stringify(st, null, 2));
          setStatus("done");
        })
        .catch((e) => setError((e as Error).message));
      return;
    }
    if (params.get("thesis") && params.get("go") === "1") generate(params.get("thesis")!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyJson = async () => {
    try {
      const parsed = JSON.parse(json);
      const v = await api.validate(parsed);
      setResult((r) => (r ? { ...r, strategy: v.strategy, warnings: v.warnings, graph: v.graph } : r));
      setJsonMsg({ ok: true, text: `Valid. ${v.warnings.length} warning(s).` });
      setTab("rules");
    } catch (e) {
      setJsonMsg({ ok: false, text: e instanceof ApiError && e.issues?.length ? e.issues.map((i) => `${i.path}: ${i.message}`).join("\n") : (e as Error).message });
    }
  };

  const applyChange = async (text = change) => {
    if (!result || text.trim().length < 2) return;
    setChanging(true);
    setChangeError(null);
    try {
      const r = await api.refineStream(result.strategy, text.trim(), () => {});
      setHistory((h) => [...h, result]);
      setResult({ ...r, rationale: result.rationale });
      setJson(JSON.stringify(r.strategy, null, 2));
      setChangeNote(r.rationale || "Updated.");
      setChange("");
      setSaved(null);
    } catch (e) {
      setChangeError((e as Error).message);
    } finally {
      setChanging(false);
    }
  };
  const undo = () => {
    const prev = history.at(-1);
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setResult(prev);
    setJson(JSON.stringify(prev.strategy, null, 2));
    setChangeNote(null);
    setSaved(null);
  };

  const save = async () => {
    if (!strategy || !requireAuth()) return;
    const entry = await api.saveStrategy(strategy);
    setSaved(entry.id);
  };

  const running = status === "running";
  return (
    <>
      <PageHeader title={editing ? "Edit strategy" : "New strategy"} sub="Describe a trade in your own words. Weft drafts the rules, and nothing runs until you say so." />
      <div className="space-y-8 px-5 pb-16 pt-6 lg:px-10">
        {result && status === "done" ? (
          <div className="flex max-w-[860px] items-start justify-between gap-4 rounded-[14px] border border-line bg-card px-4 py-3.5">
            <div className="min-w-0">
              <p className="text-[12.5px] text-muted">Your idea</p>
              <p className="mt-0.5 text-[15.5px] leading-relaxed text-ink">{thesis || result.strategy.thesis}</p>
            </div>
            <Btn
              variant="quiet"
              onClick={() => {
                setResult(null);
                setStatus("idle");
                setHistory([]);
                setChangeNote(null);
                setThesis("");
                setEditing(false);
                window.history.replaceState(null, "", "/new");
              }}
            >
              Start over
            </Btn>
          </div>
        ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            generate();
          }}
          className="max-w-[860px] rounded-[14px] border border-line-2 bg-card focus-within:border-ink/40"
        >
          <textarea
            value={thesis}
            onChange={(e) => setThesis(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generate();
            }}
            rows={3}
            placeholder="e.g. Buy $WIF with 1 SOL if it drops 15% in a day. Stop out at −15%."
            className="block min-h-[96px] w-full resize-none bg-transparent px-4 pt-4 text-[17px] leading-relaxed text-ink outline-none placeholder:text-faint"
            aria-label="Your trade idea"
          />
          <div className="flex items-center justify-between gap-3 px-3 pb-3">
            <span className="hidden pl-1 text-[12.5px] text-faint sm:inline">⌘ + Enter</span>
            <Btn type="submit" disabled={running || thesis.trim().length < 3} className="ml-auto">
              {running ? (
                <>
                  <span className="spin-slow block h-3.5 w-3.5 rounded-full border-2 border-paper/30 border-t-paper" /> Drafting…
                </>
              ) : (
                <>
                  Draft strategy <IconSend size={14} />
                </>
              )}
            </Btn>
          </div>
        </form>
        )}

        {status === "idle" && (
          <div className="max-w-[860px]">
            <p className="text-[13px] text-muted">Or try one of these</p>
            <ul className="mt-2 divide-y divide-line border-y border-line">
              {SUGGESTIONS.map((s) => (
                <li key={s}>
                  <button
                    onClick={() => {
                      setThesis(s);
                      generate(s);
                    }}
                    className="flex w-full items-center justify-between gap-4 py-3 text-left text-[14.5px] text-ink-2 transition-colors hover:text-ink"
                  >
                    {s}
                    <span className="text-faint">→</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(running || (status !== "idle" && steps.length > 0 && !result)) && (
          <ol className="max-w-[860px] space-y-2">
            {steps.map((s, i) => (
              <motion.li key={i} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2.5 text-[14px] text-ink-2">
                {i === steps.length - 1 && running ? (
                  <span className="spin-slow block h-3.5 w-3.5 rounded-full border-[1.5px] border-line-2 border-t-ink-2" />
                ) : (
                  <IconCheck size={14} strokeWidth={2.2} className={s.type === "invalid" ? "text-trigger" : "text-long"} />
                )}
                {s.message}
              </motion.li>
            ))}
            {running && steps.length === 0 && <li className="shimmer-text text-[14px]">Reading your idea…</li>}
          </ol>
        )}

        {error &&
          (/sign in/i.test(error) ? (
            // A visitor used up today's free drafts: signing in is the way on, not an error.
            <div className="flex max-w-[860px] flex-wrap items-center justify-between gap-3 rounded-[12px] border border-line bg-card px-4 py-3 text-[14px] text-ink-2">
              <span>{error}</span>
              <Btn onClick={() => requireAuth()}>Sign in</Btn>
            </div>
          ) : (
            <div className="max-w-[860px] rounded-[12px] bg-[var(--short-soft)] px-4 py-3 text-[14px] text-short">
              Couldn’t draft that: {error}
            </div>
          ))}

        {result && strategy && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-5">
              <div>
                <p className="text-[13px] text-muted">{editing && !history.length && !result.rationale ? "Editing a copy" : result.source === "claude" ? "Drafted by Claude" : "Drafted from a template"}</p>
                <h2 className="mt-1 text-[24px] font-semibold tracking-[-0.025em] text-ink">{strategy.name}</h2>
                {result.rationale && <p className="mt-2 max-w-3xl text-[15px] leading-relaxed text-ink-2">{result.rationale}</p>}
              </div>

              <div role="tablist" aria-label="View" className="flex gap-5 border-b border-line text-[14px]">
                {(
                  [
                    ["rules", "Rules"],
                    ["graph", "Diagram"],
                  ] as const
                ).map(([t, l]) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => setTab(t)}
                    className={`-mb-px border-b-2 pb-2.5 transition-colors ${tab === t ? "border-ink font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}
                  >
                    {l}
                  </button>
                ))}
                <button
                  onClick={() => setTab(tab === "json" ? "rules" : "json")}
                  className={`-mb-px ml-auto border-b-2 pb-2.5 text-[13px] transition-colors ${tab === "json" ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"}`}
                >
                  {tab === "json" ? "Close JSON" : "View JSON"}
                </button>
              </div>

              {tab === "rules" ? (
                <StrategyRules strategy={strategy} />
              ) : tab === "graph" ? (
                <StrategyCanvas strategy={strategy} />
              ) : (
                <div>
                  <textarea
                    value={json}
                    onChange={(e) => setJson(e.target.value)}
                    spellCheck={false}
                    className="h-[520px] w-full rounded-[12px] border border-line bg-card p-4 font-mono text-[12.5px] leading-relaxed text-ink outline-none focus:border-ink/40"
                    aria-label="Strategy JSON"
                  />
                  <div className="mt-3 flex items-start gap-3">
                    <Btn onClick={applyJson} variant="ghost">
                      Check and apply
                    </Btn>
                    {jsonMsg && <pre className={`whitespace-pre-wrap pt-2 font-mono text-[12px] ${jsonMsg.ok ? "text-long" : "text-short"}`}>{jsonMsg.text}</pre>}
                  </div>
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  applyChange();
                }}
                className="rounded-[12px] border border-line bg-card p-4"
              >
                <label htmlFor="change" className="text-[14px] font-medium text-ink">
                  Change something
                </label>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    id="change"
                    value={change}
                    onChange={(e) => setChange(e.target.value)}
                    disabled={changing}
                    placeholder="e.g. tighter stop, or exit if BTC drops 5%"
                    className="h-10 min-w-0 flex-1 rounded-[10px] border border-line-2 bg-card px-3 text-[14.5px] text-ink outline-none placeholder:text-faint focus:border-ink/40 disabled:opacity-60"
                  />
                  <Btn type="submit" disabled={changing || change.trim().length < 2} className="h-10">
                    {changing ? "Updating…" : "Update"}
                  </Btn>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
                  {["Tighter stop", "Take profit at 20%", "Half the size"].map((q) => (
                    <button
                      key={q}
                      type="button"
                      disabled={changing}
                      onClick={() => applyChange(q === "Half the size" ? halfSize(result.strategy) : q.toLowerCase())}
                      className="text-muted underline decoration-line-2 underline-offset-4 hover:text-ink hover:decoration-ink"
                    >
                      {q}
                    </button>
                  ))}
                  {history.length > 0 && (
                    <button type="button" onClick={undo} disabled={changing} className="ml-auto text-ink-2 hover:text-ink">
                      Undo
                    </button>
                  )}
                </div>
                {changeNote && !changeError && <p className="mt-3 text-[13.5px] text-long">{changeNote}</p>}
                {changeError && <p className="mt-3 text-[13.5px] text-short">{changeError}</p>}
              </form>

            </div>

            <div className="space-y-4">
              <DeployPanel strategy={strategy} initialMode={params.get("mode") === "live" ? "live" : params.get("mode") === "practice" ? "practice" : undefined} />
              <Card className="p-5">
                <div className="text-[15px] font-semibold tracking-[-0.015em] text-ink">Share it</div>
                <p className="mt-1 text-[13.5px] leading-relaxed text-muted">Others can read and copy the rules. Your wallet and amounts stay private.</p>
                {saved ? (
                  <div className="mt-3 space-y-2">
                    <Link href={`/strategy?id=${encodeURIComponent(saved)}`} className="inline-flex items-center gap-1.5 text-[14px] font-medium text-long">
                      <IconCheck size={14} /> Published. View it →
                    </Link>
                    <Btn
                      variant="ghost"
                      className="w-full"
                      href={`https://x.com/intent/post?text=${encodeURIComponent(`${strategy.name}, a strategy on Weft`)}&url=${encodeURIComponent(`https://weft.fi/s/${saved}`)}&via=weftfinance`}
                    >
                      Post it on X
                    </Btn>
                  </div>
                ) : (
                  <Btn onClick={save} variant="ghost" className="mt-3 w-full">
                    Publish
                  </Btn>
                )}
              </Card>
              <Card className="p-5">
                <div className="text-[15px] font-semibold tracking-[-0.015em] text-ink">Limits</div>
                <dl className="mt-3 space-y-2 text-[13.5px]">
                  {limitRows(strategy).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-4">
                      <dt className="text-muted">{k}</dt>
                      <dd className="tnum text-ink">{v}</dd>
                    </div>
                  ))}
                </dl>
              </Card>
            </div>
          </motion.div>
        )}
      </div>
    </>
  );
}

/** Only the limits that actually apply to this strategy. */
function limitRows(s: Strategy): [string, string][] {
  const opens = s.actions.filter((a) => a.type === "open");
  const scaled = opens.some((a) => a.type === "open" && a.size.unit === "pct_equity");
  const rows: [string, string][] = [];
  // Percentage caps only bind sizes that scale with the budget; a stated amount is used as given.
  if (scaled) {
    rows.push(["Largest single position", `${s.risk.maxPositionPct}%`], ["Most in the market at once", `${s.risk.maxTotalExposurePct}%`]);
  }
  if (opens.some((a) => a.type === "open" && a.instrument.kind === "perp")) rows.push(["Max leverage", `${s.risk.maxLeverage}×`]);
  if (opens.some((a) => a.type === "open" && a.instrument.kind === "outcome")) rows.push(["Must be able to sell back within", `${s.risk.maxExitLossPct ?? 10}%`]);
  rows.push(["Stop for the day after losing", `${s.risk.maxDailyLossPct}%`]);
  if (s.risk.requireStopLoss) rows.push(["Stop required on every trade", "Yes"]);
  return rows;
}

export default function NewStrategyPage() {
  return (
    <Suspense>
      <Builder />
    </Suspense>
  );
}
