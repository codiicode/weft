"use client";
import type { Strategy } from "@weft/strategy";
import { describeStrategy } from "@/lib/strategy-view";
import { AssetIcon } from "@/components/ui/AssetIcon";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";

const TONE = { long: "var(--long)", short: "var(--short)", exit: "var(--exit)", alert: "var(--signal)" } as const;

/** A strategy read aloud: what it watches and, rule by rule, when it acts. */
export function StrategyRules({ strategy, met }: { strategy: Strategy; met?: Record<string, boolean> }) {
  const { watchKinds, rules } = describeStrategy(strategy);
  // Some feeds (X, news, model forecasts) run on sample data until a provider is connected: say so.
  const health = useApi(() => api.health(), []);
  const simulated = (kind: string) => health.data?.signals?.[kind] === "simulated";
  return (
    <div className="divide-y divide-line rounded-[12px] border border-line bg-card">
      <div className="grid gap-2 px-5 py-4 sm:grid-cols-[88px_1fr]">
        <span className="text-[13px] text-muted">Watches</span>
        <span className="text-[14.5px] leading-relaxed text-ink">
          {watchKinds.map((w, i) => (
            <span key={w.label}>
              {i > 0 && ", "}
              {w.label}
              {simulated(w.kind) && (
                <span
                  className="ml-1.5 rounded-[5px] bg-paper-2 px-1.5 py-px align-[1px] text-[11.5px] text-muted"
                  title="This feed uses sample data for now. Paper runs are fine; live decisions should not rely on it yet."
                >
                  sample data
                </span>
              )}
            </span>
          ))}
        </span>
      </div>
      {rules.map((r, i) => (
        <div key={r.id} className="grid gap-2 px-5 py-4 sm:grid-cols-[88px_1fr]">
          <span className="flex items-center gap-2 text-[13px] text-muted">
            Rule {i + 1}
            {met && (
              <span
                className={`h-1.5 w-1.5 rounded-full ${met[r.id] ? "bg-long" : "bg-line-2"}`}
                title={met[r.id] ? "Conditions met right now" : "Waiting for conditions"}
              />
            )}
          </span>
          <div className="min-w-0 space-y-2.5">
            {r.when.length > 2 ? (
              <div className="text-[14.5px] leading-relaxed text-ink">
                <p className="text-muted">
                  When {r.match === "any" ? "any of these is" : "all of these are"} true{r.hold ? ` ${r.hold}` : ""}:
                </p>
                <ul className="mt-1 space-y-0.5">
                  {r.when.map((w, j) => (
                    <li key={j} className="flex gap-2">
                      <span className="text-faint">·</span>
                      {w}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-[14.5px] leading-relaxed text-ink">
                <span className="text-muted">When </span>
                {r.when.map((w, j) => (
                  <span key={j}>
                    {j > 0 && <span className="text-muted"> {r.match === "any" ? "or" : "and"} </span>}
                    <span>{w}</span>
                  </span>
                ))}
                {r.hold && <span className="text-muted"> {r.hold}</span>}
              </p>
            )}
            <ul className="space-y-1.5">
              {r.then.map((t) => (
                <li key={t.text} className="flex gap-2.5 text-[14.5px] leading-relaxed text-ink">
                  {t.icon ? (
                    <span className="relative mt-[2px] shrink-0">
                      <AssetIcon {...t.icon} size={20} />
                      <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-card" style={{ background: TONE[t.tone] }} />
                    </span>
                  ) : (
                    <span className="mt-[9px] h-[2px] w-3 shrink-0 rounded" style={{ background: TONE[t.tone] }} />
                  )}
                  <span>{t.text}</span>
                </li>
              ))}
              {r.then.length === 0 && <li className="text-[14px] text-muted">No action attached.</li>}
            </ul>
          </div>
        </div>
      ))}
    </div>
  );
}
