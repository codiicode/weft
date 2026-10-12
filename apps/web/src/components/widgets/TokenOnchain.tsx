"use client";
import { useRef, useState } from "react";
import { motion } from "motion/react";
import { onchainToken, tokenProfiles } from "@/data/mock";
import { clamp, fmtNum, mulberry32 } from "@/lib/rng";
import { useInterval } from "@/lib/hooks";
import { IconChain, IconCheck, IconLock } from "@/components/graph/icons";
import { TokenAvatar } from "@/components/ui/TokenAvatar";
import { Flash, MicroLabel, WidgetCard, type WidgetProps } from "./WidgetCard";

const T = onchainToken;
const CHECKS = tokenProfiles[T.sym]?.checks ?? [];
const TOP10_MAX = 30; // rug-check threshold, % of supply
const FLOW_MAX = 7;

function Body({ live }: { live: boolean }) {
  const rand = useRef(mulberry32(5150));
  const [flows, setFlows] = useState<number[]>(T.flows);
  const [holders, setHolders] = useState(T.holders);
  useInterval(
    () => {
      const r = rand.current;
      const buy = r() < 0.6;
      const size = +(0.2 + r() ** 2 * 5.5).toFixed(2);
      setFlows((f) => [...f.slice(1), buy ? size : -size]);
      if (r() < 0.55) setHolders((h) => h + 1 + Math.floor(r() * 3));
    },
    1100,
    live
  );
  const buys = flows.filter((v) => v > 0).reduce((a, v) => a + v, 0);
  const sells = -flows.filter((v) => v < 0).reduce((a, v) => a + v, 0);
  const ratio = sells ? buys / sells : buys;
  const top10 = T.top10.reduce((a, v) => a + v, 0);
  const passed = CHECKS.filter((c) => c.ok).length;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)] lg:gap-0 lg:divide-x lg:divide-line">
      {/* identity + order flow */}
      <div className="min-w-0 lg:pr-6">
        <div className="flex items-center gap-3">
          <TokenAvatar sym={T.sym} size={36} />
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-semibold tracking-[-0.02em] text-ink">{T.sym}</div>
            <div className="truncate font-mono text-[10.5px] text-muted">
              mint <span className="text-ink-2">{T.mint}</span>
            </div>
          </div>
          <div className="text-right">
            <MicroLabel>Buy / sell</MicroLabel>
            <div className="mt-0.5 font-mono text-[18px] leading-none text-ink">
              <Flash value={Math.round(ratio * 100)}>
                <span className="tnum">{ratio.toFixed(2)}</span>
              </Flash>
            </div>
          </div>
        </div>
        <div className="relative mt-4 h-[78px]" aria-label="Recent swaps, buys above the line and sells below" role="img">
          <span className="absolute inset-x-0 top-1/2 h-px bg-line-2" />
          <div className="absolute inset-0 flex items-center gap-[3px]">
            {flows.map((v, i) => {
              const h = (clamp(Math.abs(v), 0.15, FLOW_MAX) / FLOW_MAX) * 50;
              return (
                <div key={i} className="relative h-full min-w-0 flex-1">
                  <motion.span
                    className="absolute inset-x-0 rounded-[2px]"
                    style={{ background: v > 0 ? "var(--long)" : "var(--short)", opacity: 0.35 + (i / flows.length) * 0.65, [v > 0 ? "bottom" : "top"]: "50%" }}
                    initial={false}
                    animate={{ height: `${h}%` }}
                    transition={{ type: "spring", stiffness: 260, damping: 26 }}
                  />
                </div>
              );
            })}
          </div>
        </div>
        <div className="mt-2 flex justify-between font-mono text-[10px] text-muted">
          <span className="text-long">▲ {buys.toFixed(1)} SOL bought</span>
          <span className="text-short">▼ {sells.toFixed(1)} SOL sold</span>
        </div>
      </div>

      {/* holders */}
      <div className="min-w-0 lg:px-6">
        <div className="flex items-baseline justify-between">
          <MicroLabel>Holders</MicroLabel>
          <span className="font-mono text-[10px] text-long">+{fmtNum(T.holders24h + holders - T.holders)} 24h</span>
        </div>
        <div className="mt-1 font-mono text-[20px] leading-none text-ink">
          <Flash value={holders}>
            <span className="tnum">{fmtNum(holders)}</span>
          </Flash>
        </div>
        <div className="mt-4 flex items-baseline justify-between">
          <MicroLabel>Top-10 wallets</MicroLabel>
          <span className="tnum font-mono text-[11px] text-ink">{top10.toFixed(1)}%</span>
        </div>
        <div className="relative mt-2">
          <div className="flex h-[10px] overflow-hidden rounded-full bg-paper-2">
            {T.top10.map((v, i) => (
              <motion.span
                key={i}
                className="h-full border-r border-card last:border-r-0"
                style={{ background: `color-mix(in oklab, var(--signal) ${90 - i * 6}%, var(--paper-2))` }}
                initial={{ width: 0 }}
                whileInView={{ width: `${v}%` }}
                viewport={{ once: true }}
                transition={{ duration: 0.8, delay: 0.2 + i * 0.05, ease: [0.22, 1, 0.36, 1] }}
              />
            ))}
          </div>
          <span className="absolute -top-1 h-[18px] w-[2px] -translate-x-1/2 rounded-full bg-short" style={{ left: `${TOP10_MAX}%` }} />
          <div className="relative mt-1.5 h-3 font-mono text-[9.5px] text-faint">
            <span className="absolute left-0">0%</span>
            <span className="absolute -translate-x-1/2 whitespace-nowrap text-short" style={{ left: `${TOP10_MAX}%` }}>
              limit {TOP10_MAX}%
            </span>
            <span className="absolute right-0">100%</span>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className="rounded-[10px] border border-line bg-card-2 px-3 py-2">
            <MicroLabel>LP locked</MicroLabel>
            <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[13px] text-ink">
              <IconLock size={11} className="text-long" /> {T.lpLocked}%
            </div>
          </div>
          <div className="rounded-[10px] border border-line bg-card-2 px-3 py-2">
            <MicroLabel>Dev wallet</MicroLabel>
            <div className="mt-0.5 font-mono text-[13px] text-ink">{T.devSold}% sold</div>
          </div>
        </div>
      </div>

      {/* rug checks */}
      <div className="min-w-0 lg:pl-6">
        <div className="flex items-baseline justify-between">
          <MicroLabel>Rug checks</MicroLabel>
          <span className="tnum font-mono text-[11px] text-long">
            {passed}/{CHECKS.length} pass
          </span>
        </div>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {CHECKS.map((c, i) => (
            <motion.li
              key={c.label}
              initial={{ opacity: 0, y: 6 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.25 + i * 0.07, duration: 0.4 }}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-2 py-1 font-mono text-[10px] text-ink-2"
            >
              <IconCheck size={10} strokeWidth={2.4} className="text-long" />
              {c.label.replace(" · 0.5 SOL", "")}
            </motion.li>
          ))}
        </ul>
        <p className="mt-4 text-[12.5px] leading-relaxed text-ink-2">
          Every swap is gated on these. Fail one and the agent doesn&apos;t buy, whatever the graph says.
        </p>
        <div className="mt-3 font-mono text-[10px] text-faint">Matched by mint, never by ticker.</div>
      </div>
    </div>
  );
}

export function TokenOnchainWidget({ className, index }: WidgetProps) {
  return (
    <WidgetCard icon={IconChain} label="Token on-chain" meta="Solana · by mint" tone="long" className={className} index={index}>
      {(live) => <Body live={live} />}
    </WidgetCard>
  );
}
