"use client";
import { useRef } from "react";
import { useInView, useReducedMotion } from "@/lib/hooks";

/**
 * The permission model in one picture: Weft's key can send orders into
 * your account, but a withdrawal never gets past the barrier.
 */
export function SafetyDiagram() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const reduce = useReducedMotion();
  const play = inView && !reduce;
  return (
    <div ref={ref} className="relative">
      {/* phones: the same idea, stacked and readable */}
      <div className="space-y-2 sm:hidden" role="img" aria-label="Weft's key can place trades in your account; withdrawals are blocked">
        <div className="rounded-[12px] border border-line-2 bg-card px-4 py-3">
          <p className="text-[12px] text-muted">Trading-only key</p>
          <p className="text-[16px] font-semibold text-ink">Weft agent</p>
        </div>
        <div className="flex items-center gap-2 pl-4 text-[14px] font-medium text-long">
          <span className="h-5 w-px bg-long" /> Place a trade ↓
        </div>
        <div className="rounded-[12px] border border-line-2 bg-card px-4 py-3">
          <p className="text-[12px] text-muted">Your account</p>
          <p className="text-[16px] font-semibold text-ink">Your money stays here</p>
        </div>
        <div className="flex items-center gap-2 pl-4 text-[14px] font-medium text-short">
          <span className="h-5 w-px border-l border-dashed border-short" /> Withdraw · blocked
        </div>
      </div>
      <svg viewBox="0 0 520 250" className="hidden h-auto w-full sm:block" role="img" aria-label="Weft's key can place trades in your account; withdrawals are blocked">
        {/* nodes */}
        <g>
          <rect x="1" y="70" width="150" height="110" rx="12" style={{ fill: "var(--card)", stroke: "var(--line-2)" }} />
          <text x="20" y="102" fontSize="12" style={{ fill: "var(--muted)" }}>
            Trading-only key
          </text>
          <text x="20" y="126" fontSize="17" fontWeight="600" style={{ fill: "var(--ink)" }}>
            Weft agent
          </text>
          <text x="20" y="156" fontSize="12" style={{ fill: "var(--muted)" }}>
            can’t move money out
          </text>
        </g>
        <g>
          <rect x="369" y="70" width="150" height="110" rx="12" style={{ fill: "var(--card)", stroke: "var(--line-2)" }} />
          <text x="388" y="102" fontSize="12" style={{ fill: "var(--muted)" }}>
            Your account
          </text>
          <text x="388" y="126" fontSize="17" fontWeight="600" style={{ fill: "var(--ink)" }}>
            Your money
          </text>
          <text x="388" y="156" fontSize="12" className="tnum" style={{ fill: "var(--muted)" }}>
            stays here
          </text>
        </g>

        {/* trade: allowed */}
        <path id="sd-trade" d="M151 100 C 230 100, 290 100, 369 100" fill="none" style={{ stroke: "var(--long)" }} strokeWidth="2" />
        <text x="260" y="88" textAnchor="middle" fontSize="12.5" fontWeight="500" style={{ fill: "var(--long)" }}>
          Place a trade
        </text>
        {play &&
          [0, 1, 2].map((i) => (
            <circle key={i} r="4" style={{ fill: "var(--long)" }}>
              <animateMotion dur="2.4s" begin={`${i * 0.8}s`} repeatCount="indefinite" keyPoints="0;1" keyTimes="0;1" calcMode="linear">
                <mpath href="#sd-trade" />
              </animateMotion>
            </circle>
          ))}

        {/* withdraw: blocked */}
        <path d="M369 150 L 290 150" fill="none" style={{ stroke: "var(--short)" }} strokeWidth="2" strokeDasharray="5 5" />
        <path d="M230 150 L 151 150" fill="none" style={{ stroke: "var(--line-2)" }} strokeWidth="2" strokeDasharray="5 5" />
        <line x1="260" x2="260" y1="132" y2="168" style={{ stroke: "var(--short)" }} strokeWidth="3" strokeLinecap="round" />
        <text x="260" y="192" textAnchor="middle" fontSize="12.5" fontWeight="500" style={{ fill: "var(--short)" }}>
          Withdraw · blocked
        </text>
        {play && (
          <circle r="4" style={{ fill: "var(--short)" }}>
            <animate attributeName="cx" values="369;268;268;369" keyTimes="0;0.45;0.6;1" dur="3s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="1;1;0.2;0" keyTimes="0;0.45;0.7;1" dur="3s" repeatCount="indefinite" />
            <animate attributeName="cy" values="150;150;150;150" dur="3s" repeatCount="indefinite" />
          </circle>
        )}
        {!play && <circle cx="275" cy="150" r="4" style={{ fill: "var(--short)" }} />}
      </svg>
    </div>
  );
}
