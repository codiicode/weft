"use client";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { $T, brand } from "@/config/brand";
import { buybackLedger, tokenStats } from "@/data/mock";
import { fmtNum, fmtUsd, mulberry32, walk } from "@/lib/rng";
import { useInView, useInterval, useReducedMotion } from "@/lib/hooks";
import { SectionHeading, Reveal } from "../ui/Reveal";
import { CountUp } from "../ui/CountUp";
import { Sparkline } from "../ui/Sparkline";
import { LogoMark } from "../ui/Logo";
import { IconCheck, IconCopy, IconEye, IconLock, IconPrice, IconReplay } from "../graph/icons";

const EASE = [0.22, 1, 0.36, 1] as const;
const FEE_PCT = brand.builderFeeBps / 100; // 5 bps -> 0.05
const SWAP_FEE_PCT = brand.swapFeeBps / 100;
/** "0.05%" when both fees match, "0.05–0.10%" otherwise. */
const FEE_LABEL =
  FEE_PCT === SWAP_FEE_PCT
    ? `${FEE_PCT.toFixed(2)}%`
    : `${Math.min(FEE_PCT, SWAP_FEE_PCT).toFixed(2)}–${Math.max(FEE_PCT, SWAP_FEE_PCT).toFixed(2)}%`;
const TOKEN_PRICE = tokenStats.boughtBackUsd / tokenStats.boughtBackTokens;
const LEDGER_MAX = 7;
const VAULT_BALANCE = 1_912;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const compactUsd = (v: number) =>
  v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : fmtUsd(v);
const compactNum = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : fmtNum(v));

/* ------------------------------------------------------------------ */
/* Flow diagram                                                        */
/* ------------------------------------------------------------------ */

type FlowNode = { key: string; step: string; title: string; value: string; sub: string; icon: "trades" | "fee" | "vault" | "swap" | "token" };

const FLOW: FlowNode[] = [
  { key: "trades", step: "01", title: "Every trade", value: compactUsd(tokenStats.volume24h), sub: "Hyperliquid · Jupiter", icon: "trades" },
  { key: "fee", step: "02", title: "Trade fees", value: FEE_LABEL, sub: "HL builder · Jup swap", icon: "fee" },
  { key: "vault", step: "03", title: "Fee vault", value: compactUsd(tokenStats.fees24h), sub: "Public · last 24h", icon: "vault" },
  { key: "swap", step: "04", title: "Buyback", value: "Jupiter", sub: `USDC → ${$T}`, icon: "swap" },
  { key: "token", step: "05", title: $T, value: compactNum(tokenStats.boughtBackTokens), sub: "Bought back", icon: "token" },
];

const LINKS = ["per fill", "on-chain", "every 6m", "market buy"];

const FLOW_DUR = 2; // seconds per segment
const PARTICLES = 2;

function NodeIcon({ kind, x, y, size = 16 }: { kind: FlowNode["icon"]; x: number; y: number; size?: number }) {
  const p = { x, y, size };
  if (kind === "trades") return <IconPrice {...p} />;
  if (kind === "fee")
    return (
      <svg x={x} y={y} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
        <path d="M12.5 3.5 3.5 12.5" />
        <circle cx="4.6" cy="4.6" r="1.7" />
        <circle cx="11.4" cy="11.4" r="1.7" />
      </svg>
    );
  if (kind === "vault") return <IconLock {...p} />;
  if (kind === "swap") return <IconReplay {...p} />;
  return null;
}

type Geo = {
  W: number;
  H: number;
  nodes: { x: number; y: number; w: number; h: number }[];
  paths: string[];
  labels: { x: number; y: number; anchor: "middle" | "start" | "end" }[];
  vertical: boolean;
};

function geometry(vertical: boolean): Geo {
  if (!vertical) {
    const W = 1160;
    const w = 168;
    const h = 136;
    const gap = (W - FLOW.length * w) / (FLOW.length - 1);
    const y = 38;
    const nodes = FLOW.map((_, i) => ({ x: i * (w + gap), y, w, h }));
    const paths = nodes.slice(0, -1).map((a, i) => {
      const b = nodes[i + 1];
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      const y2 = b.y + b.h / 2;
      const bend = i % 2 === 0 ? -34 : 34; // the thread goes over, then under
      const mx = (x1 + x2) / 2;
      return `M${x1},${y1} C${x1 + 18},${y1} ${mx - 20},${y1 + bend} ${mx},${y1 + bend} S${x2 - 18},${y2} ${x2},${y2}`;
    });
    const labels = nodes.slice(0, -1).map((a, i) => {
      const mx = (a.x + a.w + nodes[i + 1].x) / 2;
      const yc = a.y + a.h / 2;
      return { x: mx, y: i % 2 === 0 ? yc + 26 : yc - 18, anchor: "middle" as const };
    });
    return { W, H: y * 2 + h, nodes, paths, labels, vertical };
  }
  const W = 340;
  const w = 300;
  const h = 78;
  const gap = 46;
  const x = (W - w) / 2;
  const nodes = FLOW.map((_, i) => ({ x, y: 8 + i * (h + gap), w, h }));
  const paths = nodes.slice(0, -1).map((a, i) => {
    const b = nodes[i + 1];
    const cx = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const y2 = b.y;
    const bend = i % 2 === 0 ? -46 : 46;
    const my = (y1 + y2) / 2;
    return `M${cx},${y1} C${cx},${y1 + 10} ${cx + bend},${my - 14} ${cx + bend},${my} S${cx},${y2 - 10} ${cx},${y2}`;
  });
  const labels = nodes.slice(0, -1).map((a, i) => {
    const cx = a.x + a.w / 2;
    const my = (a.y + a.h + nodes[i + 1].y) / 2 + 3.5;
    return i % 2 === 0 ? { x: cx + 14, y: my, anchor: "start" as const } : { x: cx - 14, y: my, anchor: "end" as const };
  });
  return { W, H: nodes[nodes.length - 1].y + h + 8, nodes, paths, labels, vertical };
}

const FlowSvg = memo(function FlowSvg({ vertical, playing, reduce, className }: { vertical: boolean; playing: boolean; reduce: boolean; className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const g = useMemo(() => geometry(vertical), [vertical]);
  const id = vertical ? "flv" : "flh";

  useEffect(() => {
    const svg = ref.current;
    if (!svg || typeof svg.pauseAnimations !== "function") return;
    if (playing && !reduce) svg.unpauseAnimations();
    else svg.pauseAnimations();
  }, [playing, reduce]);

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${g.W} ${g.H}`}
      className={className}
      overflow="visible"
      role="img"
      aria-label={`Fee flow: trades pay a ${FEE_LABEL} fee (Hyperliquid builder fees and Jupiter swap fees) into a public vault, which buys back ${$T} on Jupiter`}
    >
      <defs>
        <radialGradient id={`${id}-dot`}>
          <stop offset="0" style={{ stopColor: "var(--volt)" }} stopOpacity="0.9" />
          <stop offset="0.35" style={{ stopColor: "var(--volt)" }} stopOpacity="0.35" />
          <stop offset="1" style={{ stopColor: "var(--volt)" }} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-glow`}>
          <stop offset="0" style={{ stopColor: "var(--volt)" }} stopOpacity="0.4" />
          <stop offset="0.6" style={{ stopColor: "var(--volt)" }} stopOpacity="0.08" />
          <stop offset="1" style={{ stopColor: "var(--volt)" }} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-node`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--card-2)" }} />
          <stop offset="1" style={{ stopColor: "var(--card)" }} />
        </linearGradient>
        <linearGradient id={`${id}-tok`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "color-mix(in oklab, var(--volt) 20%, var(--card))" }} />
          <stop offset="1" style={{ stopColor: "color-mix(in oklab, var(--volt) 6%, var(--card))" }} />
        </linearGradient>
        {g.paths.map((d, i) => (
          <path key={i} id={`${id}-p${i}`} d={d} />
        ))}
      </defs>

      {/* glow behind the token node */}
      {(() => {
        const t = g.nodes[g.nodes.length - 1];
        const r = vertical ? 170 : 190;
        return (
          <circle cx={t.x + t.w / 2} cy={t.y + t.h / 2} r={r} fill={`url(#${id}-glow)`}>
            {!reduce && (
              <animate attributeName="opacity" values="0.75;1;0.75" dur={`${FLOW_DUR / PARTICLES}s`} repeatCount="indefinite" />
            )}
          </circle>
        );
      })()}

      {/* threads */}
      {g.paths.map((d, i) => (
        <g key={i}>
          <path d={d} fill="none" style={{ stroke: "var(--line-2)" }} strokeWidth={vertical ? 1.5 : 1.6} />
          <path
            d={d}
            fill="none"
            style={{ stroke: "var(--volt)" }}
            strokeOpacity={0.55}
            strokeWidth={1.4}
            strokeLinecap="round"
            className={reduce ? undefined : "edge-flow"}
            strokeDasharray={reduce ? "2 10" : undefined}
          />
        </g>
      ))}

      {/* link labels */}
      {g.labels.map((l, i) => (
        <text key={i} x={l.x} y={l.y} textAnchor={l.anchor} className="font-mono" fontSize={10} letterSpacing="0.06em" style={{ fill: "var(--faint)" }}>
          {LINKS[i]}
        </text>
      ))}

      {/* particles */}
      {!reduce &&
        g.paths.map((_, i) =>
          Array.from({ length: PARTICLES }, (_, k) => {
            const begin = `-${((k * FLOW_DUR) / PARTICLES).toFixed(2)}s`;
            return (
              <g key={`${i}-${k}`}>
                <circle r={9} fill={`url(#${id}-dot)`}>
                  <animateMotion dur={`${FLOW_DUR}s`} begin={begin} repeatCount="indefinite" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines="0.45 0 0.25 1">
                    <mpath href={`#${id}-p${i}`} />
                  </animateMotion>
                </circle>
                <circle r={2.4} style={{ fill: "var(--volt)" }}>
                  <animateMotion dur={`${FLOW_DUR}s`} begin={begin} repeatCount="indefinite" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines="0.45 0 0.25 1">
                    <mpath href={`#${id}-p${i}`} />
                  </animateMotion>
                </circle>
              </g>
            );
          })
        )}

      {/* nodes */}
      {FLOW.map((n, i) => {
        const b = g.nodes[i];
        const isTok = n.key === "token";
        const r = vertical ? 16 : 18;
        return (
          <g key={n.key} transform={`translate(${b.x} ${b.y})`}>
            {/* arrival ring */}
            {!reduce && i > 0 && (
              <rect x={-3} y={-3} width={b.w + 6} height={b.h + 6} rx={r + 3} fill="none" style={{ stroke: "var(--volt)" }} strokeWidth={1.2} opacity={0}>
                <animate
                  attributeName="opacity"
                  values={isTok ? "0.85;0.1;0" : "0.4;0;0"}
                  keyTimes="0;0.4;1"
                  dur={`${FLOW_DUR / PARTICLES}s`}
                  repeatCount="indefinite"
                />
              </rect>
            )}
            <rect
              width={b.w}
              height={b.h}
              rx={r}
              fill={isTok ? `url(#${id}-tok)` : `url(#${id}-node)`}
              style={{ stroke: isTok ? "color-mix(in oklab, var(--volt) 60%, transparent)" : "var(--line-2)" }}
              strokeWidth={1}
            />
            {/* top highlight */}
            <path d={`M${r},0.5 H${b.w - r}`} stroke="rgba(255,255,255,0.09)" strokeWidth={1} />

            {vertical ? (
              <>
                <rect x={14} y={b.h / 2 - 17} width={34} height={34} rx={10} style={{ fill: isTok ? "transparent" : "var(--paper-2)", stroke: isTok ? "none" : "var(--line)" }} />
                {isTok ? (
                  <foreignObject x={14} y={b.h / 2 - 17} width={34} height={34}>
                    <LogoMark size={34} />
                  </foreignObject>
                ) : (
                  <g style={{ color: "var(--volt)" }}>
                    <NodeIcon kind={n.icon} x={23} y={b.h / 2 - 8} size={16} />
                  </g>
                )}
                <text x={62} y={b.h / 2 - 6} className="font-mono" fontSize={10} letterSpacing="0.12em" style={{ fill: "var(--faint)" }}>
                  {n.step} · {n.sub.toUpperCase()}
                </text>
                <text x={62} y={b.h / 2 + 15} fontSize={16} fontWeight={600} letterSpacing="-0.02em" style={{ fill: "var(--ink)" }}>
                  {n.title}
                </text>
                <text
                  x={b.w - 16}
                  y={b.h / 2 + 15}
                  textAnchor="end"
                  className="font-mono tnum"
                  fontSize={17}
                  fontWeight={600}
                  letterSpacing="-0.03em"
                  style={{ fill: isTok ? "var(--volt)" : "var(--ink)" }}
                >
                  {n.value}
                </text>
              </>
            ) : (
              <>
                <text x={18} y={30} className="font-mono" fontSize={10.5} letterSpacing="0.14em" style={{ fill: "var(--faint)" }}>
                  {n.step}
                </text>
                {isTok ? (
                  <foreignObject x={b.w - 46} y={14} width={28} height={28}>
                    <LogoMark size={28} />
                  </foreignObject>
                ) : (
                  <g>
                    <rect x={b.w - 46} y={14} width={28} height={28} rx={8} style={{ fill: "var(--paper-2)", stroke: "var(--line)" }} />
                    <g style={{ color: "var(--volt)" }}>
                      <NodeIcon kind={n.icon} x={b.w - 39} y={21} size={14} />
                    </g>
                  </g>
                )}
                <text x={18} y={68} fontSize={15} fontWeight={600} letterSpacing="-0.02em" style={{ fill: "var(--ink)" }}>
                  {n.title}
                </text>
                <text
                  x={18}
                  y={98}
                  className="font-mono tnum"
                  fontSize={22}
                  fontWeight={600}
                  letterSpacing="-0.04em"
                  style={{ fill: isTok ? "var(--volt)" : "var(--ink)" }}
                >
                  {n.value}
                </text>
                <text x={18} y={120} className="font-mono" fontSize={10.5} style={{ fill: "var(--muted)" }}>
                  {n.sub}
                </text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
});

function FlowDiagram({ playing, reduce }: { playing: boolean; reduce: boolean }) {
  return (
    <div className="relative overflow-hidden rounded-[24px] border border-line bg-[color-mix(in_oklab,var(--card)_55%,transparent)] shadow-[0_1px_0_rgba(255,255,255,.05)_inset]">
      <div className="pointer-events-none absolute inset-0 dot-grid opacity-60 [mask-image:radial-gradient(80%_70%_at_50%_50%,black,transparent)]" />
      <div className="relative flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5 font-mono text-[11px] text-muted">
        <span className="inline-flex items-center gap-2">
          <span className="relative h-1.5 w-1.5 rounded-full bg-volt">
            <span className="pulse-ring absolute inset-0 rounded-full bg-volt" />
          </span>
          Fee flow · on-chain
        </span>
        <span className="hidden items-center gap-1.5 sm:inline-flex">
          <IconEye size={13} /> Every step is a public transaction
        </span>
      </div>
      <div className="relative px-4 py-8 sm:px-8 md:py-12">
        <FlowSvg vertical={false} playing={playing} reduce={reduce} className="hidden h-auto w-full lg:block" />
        <FlowSvg vertical playing={playing} reduce={reduce} className="mx-auto block h-auto w-full max-w-[420px] lg:hidden" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Odometer                                                            */
/* ------------------------------------------------------------------ */

const STRIP = Array.from({ length: 20 }, (_, i) => i % 10);

function Digit({ d }: { d: number }) {
  const strip = useRef<HTMLSpanElement>(null);
  const [initial] = useState(d);
  const prev = useRef(d);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    const el = strip.current;
    const p = prev.current;
    prev.current = d;
    if (!el || d === p) return;
    cleanup.current?.();
    el.style.transition = "transform 0.75s cubic-bezier(0.22, 1, 0.36, 1)";
    if (d > p) {
      el.style.transform = `translateY(-${d}em)`;
      return;
    }
    // wrap forward (9 -> 0) through the second half of the strip, then snap back
    el.style.transform = `translateY(-${d + 10}em)`;
    const onEnd = () => {
      el.style.transition = "none";
      el.style.transform = `translateY(-${d}em)`;
      cleanup.current = null;
    };
    el.addEventListener("transitionend", onEnd, { once: true });
    cleanup.current = () => {
      el.removeEventListener("transitionend", onEnd);
      onEnd();
    };
  }, [d]);

  return (
    <span className="relative inline-block h-[1em] w-[0.6em] overflow-hidden align-top">
      <span ref={strip} className="absolute inset-x-0 top-0 flex flex-col will-change-transform" style={{ transform: `translateY(-${initial}em)` }}>
        {STRIP.map((n, i) => (
          <span key={i} className="block h-[1em] text-center leading-[1em]">
            {n}
          </span>
        ))}
      </span>
    </span>
  );
}

function Odometer({ value, className = "" }: { value: number; className?: string }) {
  const chars = fmtNum(Math.floor(value)).split("");
  // key digits by their position from the right so they stay stable as the number grows
  return (
    <span className={`inline-flex font-mono leading-none tnum ${className}`} aria-label={fmtNum(Math.floor(value))}>
      {chars.map((c, i) => {
        const pos = chars.length - i;
        return /\d/.test(c) ? (
          <Digit key={`d${pos}`} d={+c} />
        ) : (
          <span key={`s${pos}`} className="relative inline-block h-[1em] w-[0.3em] text-faint" aria-hidden>
            <span className="absolute bottom-[0.02em] left-1/2 -translate-x-1/2 text-[0.55em] leading-none">{c}</span>
          </span>
        );
      })}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

type LedgerRow = { id: string; t: string; tokens: number; usd: number; tx: string; fresh?: boolean };

const addMinutes = (t: string, m: number) => {
  const [h, mm] = t.split(":").map(Number);
  const total = (h * 60 + mm + m) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

function makeRow(rand: () => number, t: string): LedgerRow {
  const tokens = Math.round(35_000 + rand() * 11_000);
  const px = TOKEN_PRICE * (0.985 + rand() * 0.03);
  const h = (n: number) => Array.from({ length: n }, () => B58[Math.floor(rand() * B58.length)]).join("");
  const tx = `${h(4)}…${h(4)}`;
  return { id: tx, t, tokens, usd: tokens * px, tx, fresh: true };
}

function Ledger({ active }: { active: boolean }) {
  const reduce = useReducedMotion();
  const rand = useRef(mulberry32(9071));
  const [rows, setRows] = useState<LedgerRow[]>(() => buybackLedger.map((r) => ({ ...r, id: r.tx })));

  useInterval(
    () =>
      setRows((prev) => {
        const next = makeRow(rand.current, addMinutes(prev[0].t, 6));
        return [next, ...prev.map((r) => (r.fresh ? { ...r, fresh: false } : r))].slice(0, LEDGER_MAX);
      }),
    4600,
    active && !reduce
  );

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[20px] border border-line bg-card shadow-card">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <div className="text-[15px] font-semibold tracking-[-0.02em] text-ink">Buyback ledger</div>
          <div className="mt-0.5 font-mono text-[11px] text-muted">Jupiter swaps from the fee vault</div>
        </div>
        <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full bg-[color-mix(in_oklab,var(--volt)_12%,transparent)] px-2 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-volt">
          <span className="relative h-[5px] w-[5px] rounded-full bg-volt">
            <span className="pulse-ring absolute inset-0 rounded-full bg-volt" />
          </span>
          Live
        </span>
      </div>
      <div className="grid grid-cols-[52px_minmax(0,1fr)_minmax(0,0.8fr)_82px] gap-3 border-b border-line bg-card-2 px-5 py-2 font-mono text-[9.5px] font-medium uppercase tracking-[0.12em] text-faint">
        <span>UTC</span>
        <span className="text-right">{$T}</span>
        <span className="text-right">USD</span>
        <span className="text-right">Tx</span>
      </div>
      <ul className="relative flex-1">
        <AnimatePresence initial={false} mode="popLayout">
          {rows.map((r) => (
            <motion.li
              key={r.id}
              layout={reduce ? false : "position"}
              initial={{ opacity: 0, y: -18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.25 } }}
              transition={{ duration: 0.6, ease: EASE }}
              className="relative grid grid-cols-[52px_minmax(0,1fr)_minmax(0,0.8fr)_82px] items-center gap-3 border-b border-line px-5 py-3 font-mono text-[12.5px] tnum last:border-b-0"
            >
              {r.fresh && (
                <motion.span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 bg-[color-mix(in_oklab,var(--volt)_10%,transparent)]"
                  initial={{ opacity: 1 }}
                  animate={{ opacity: 0 }}
                  transition={{ duration: 2.2, delay: 0.4, ease: "easeOut" }}
                />
              )}
              <span className="relative text-muted">{r.t}</span>
              <span className="relative truncate text-right text-ink">
                <span className="text-volt">+</span>
                {fmtNum(r.tokens)}
              </span>
              <span className="relative truncate text-right text-ink-2">{fmtUsd(r.usd, 0)}</span>
              <span className="relative truncate text-right text-[11.5px] text-muted underline decoration-line-2 underline-offset-[3px]">{r.tx}</span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-card-2 px-5 py-3 font-mono text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <IconLock size={12} /> Vault <span className="text-ink-2 tnum">{fmtUsd(VAULT_BALANCE)}</span>
        </span>
        <span className="tnum">Next buyback ≈ 6m</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Stat tile + contract                                                */
/* ------------------------------------------------------------------ */

function Tile({ label, value, foot, children }: { label: string; value: ReactNode; foot?: ReactNode; children?: ReactNode }) {
  return (
    <div className="relative flex min-h-[132px] flex-col justify-between overflow-hidden bg-card px-5 py-4">
      <div className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-faint">{label}</div>
      <div className="mt-3">
        <div className="font-mono text-[clamp(1.35rem,2.4vw,1.7rem)] font-semibold leading-none tracking-[-0.04em] text-ink tnum">{value}</div>
        {foot && <div className="mt-2 font-mono text-[11px] text-muted">{foot}</div>}
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Launch card: bonding curve                                          */
/* ------------------------------------------------------------------ */

function LaunchCard() {
  const reduce = !!useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const inView = useInView(svgRef, { rootMargin: "60px" });
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof svg.pauseAnimations !== "function") return;
    if (inView && !reduce) svg.unpauseAnimations();
    else svg.pauseAnimations();
  }, [inView, reduce]);
  const W = 300;
  const H = 110;
  // y = x^2 style curve, from launch to graduation
  const pts = Array.from({ length: 31 }, (_, i) => {
    const t = i / 30;
    return [t * W, H - 8 - (H - 22) * t * t] as const;
  });
  const d = `M${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L")}`;
  return (
    <div className="flex h-full flex-col rounded-[20px] border border-line bg-card p-5 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <div className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Launch · {brand.chain}</div>
        <span className="rounded-full border border-line-2 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-2">{brand.launchpad}</span>
      </div>
      <div className="mt-2 text-[17px] font-semibold tracking-[-0.02em] text-ink">
        Launches on a {brand.launchpad} {brand.launchCurve}
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
        Price rises along the curve as people buy, then the pool graduates to open liquidity. From there, trading fees fund buybacks.
      </p>
      <div className="relative mt-auto pt-4">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="h-auto w-full overflow-visible" aria-hidden>
          <line x1={0} x2={W} y1={H - 8} y2={H - 8} style={{ stroke: "var(--line-2)" }} />
          <line x1={W} x2={W} y1={8} y2={H - 8} style={{ stroke: "var(--line-2)" }} strokeDasharray="3 4" />
          <path d={`${d} L${W},${H - 8} L0,${H - 8} Z`} style={{ fill: "color-mix(in oklab, var(--volt) 10%, transparent)" }} />
          <motion.path
            d={d}
            fill="none"
            style={{ stroke: "var(--volt)" }}
            strokeWidth={2}
            strokeLinecap="round"
            initial={reduce ? false : { pathLength: 0 }}
            whileInView={{ pathLength: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 1.6, ease: EASE }}
          />
          {!reduce && (
            <circle r={4} style={{ fill: "var(--volt)" }}>
              <animateMotion dur="5s" repeatCount="indefinite" path={d} keyPoints="0;1" keyTimes="0;1" calcMode="linear" />
            </circle>
          )}
          <text x={4} y={H - 14} className="fill-[var(--faint)] font-mono text-[9px] uppercase tracking-[0.1em]">launch</text>
          <text x={W - 4} y={18} textAnchor="end" className="fill-[var(--volt)] font-mono text-[9px] uppercase tracking-[0.1em]">graduates</text>
        </svg>
      </div>
    </div>
  );
}

function ContractRow() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(brand.contractAddress);
    } catch {
      /* clipboard unavailable */
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="rounded-[20px] border border-line bg-card p-2 shadow-card">
      <div className="flex flex-col gap-3 rounded-[14px] border border-line bg-paper-2 p-3 pl-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <LogoMark size={30} className="shrink-0" />
          <div className="min-w-0">
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Contract ({brand.chain})</div>
            <div className="mt-1 break-all font-mono text-[13.5px] text-ink sm:truncate">{brand.contractAddress}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={copy}
          aria-live="polite"
          className={`inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-4 text-[13px] font-medium transition-colors duration-300 ${
            copied ? "bg-[color-mix(in_oklab,var(--volt)_14%,transparent)] text-volt" : "border border-line-2 bg-card text-ink hover:bg-card-2"
          }`}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={copied ? "y" : "n"}
              className="inline-flex items-center gap-1.5"
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -10, opacity: 0 }}
              transition={{ duration: 0.25, ease: EASE }}
            >
              {copied ? <IconCheck size={13} strokeWidth={2} /> : <IconCopy size={13} />}
              {copied ? "Copied" : "Copy address"}
            </motion.span>
          </AnimatePresence>
        </button>
      </div>
      <p className="px-3 pb-1 pt-2.5 font-mono text-[11px] text-muted">Placeholder. The real address will be published here at launch.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section                                                             */
/* ------------------------------------------------------------------ */

export function Token() {
  const reduce = !!useReducedMotion();
  const root = useRef<HTMLElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);
  const flowInView = useInView(flowRef, { rootMargin: "80px" });
  const statsInView = useInView(statsRef, { rootMargin: "80px" });

  const [elapsed, setElapsed] = useState(0);
  useInterval(() => setElapsed((e) => e + 1), 1000, statsInView && !reduce);

  const tokens = tokenStats.boughtBackTokens + elapsed * tokenStats.tokensPerSec;
  const usd = tokenStats.boughtBackUsd + elapsed * tokenStats.usdPerSec;
  const feesSpark = useMemo(() => walk(733, 28, 0.5, 0.6), []);
  const bbSpark = useMemo(() => walk(734, 28, 0.35, 0.5), []);

  return (
    <section ref={root} id="token" className="night grain relative overflow-hidden py-24 md:py-36">
      {/* atmosphere */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,var(--volt)_35%,transparent),transparent)]" />
      <div className="pointer-events-none absolute left-1/2 top-[22%] h-[620px] w-[1100px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--volt)_9%,transparent),transparent)] blur-[40px]" />
      <div className="pointer-events-none absolute inset-0 dot-grid opacity-40 [mask-image:linear-gradient(to_bottom,black,transparent_45%)]" />

      <div className="relative mx-auto max-w-[1240px] px-5">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <SectionHeading
            eyebrow={`The ${$T} token`}
            title={
              <>
                The token <span className="serif-em text-volt">eats</span> the fees.
              </>
            }
            sub={
              <>
                {$T} launches on {brand.chain} through a {brand.launchpad} {brand.launchCurve}. After that, every executed trade pays a small fee: a {brand.builderFeeBps} bps builder fee on Hyperliquid and a {brand.swapFeeBps} bps platform fee on Jupiter swaps. Fees land in a public vault and buy back {$T}, on-chain, where anyone can watch it happen.
              </>
            }
          />
          <Reveal delay={0.15} className="shrink-0">
            <div className="inline-flex items-center gap-3 rounded-full border border-line-2 bg-card/60 py-1.5 pl-1.5 pr-4 backdrop-blur">
              <span className="grid h-8 min-w-8 place-items-center rounded-full bg-volt px-2 font-mono text-[12px] font-semibold text-[#0b0c0f] tnum">
                {FEE_LABEL}
              </span>
              <span className="font-mono text-[11.5px] text-ink-2">trade fees → 100% buyback</span>
            </div>
          </Reveal>
        </div>

        <Reveal delay={0.1} className="mt-12 md:mt-16">
          <div ref={flowRef}>
            <FlowDiagram playing={flowInView} reduce={reduce} />
          </div>
        </Reveal>

        <div ref={statsRef} className="mt-6 grid gap-6 lg:grid-cols-12">
          <Reveal className="lg:col-span-7">
            <div className="overflow-hidden rounded-[20px] border border-line bg-line shadow-card">
              {/* counter */}
              <div className="relative overflow-hidden bg-card px-5 pb-7 pt-6 sm:px-7">
                <div className="pointer-events-none absolute -right-20 -top-24 h-[280px] w-[380px] rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--volt)_14%,transparent),transparent)]" />
                <div className="relative flex items-center justify-between gap-3">
                  <div className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted">Bought back so far</div>
                  <span className="font-mono text-[11px] text-faint tnum">+{tokenStats.tokensPerSec}/s</span>
                </div>
                <div className="relative mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-2">
                  <Odometer
                    value={tokens}
                    className="text-[clamp(2.4rem,7.4vw,4.9rem)] font-semibold tracking-[-0.05em] text-ink"
                  />
                  <span className="font-mono text-[clamp(1rem,2vw,1.35rem)] font-semibold tracking-[-0.03em] text-volt">{$T}</span>
                </div>
                <div className="relative mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[13px] text-ink-2">
                  <span className="text-muted">≈</span>
                  <CountUp value={usd} duration={0.9} format={(v) => fmtUsd(v, 2)} className="tnum text-ink" />
                  <span className="text-faint">spent on buybacks</span>
                </div>
              </div>
              {/* tiles */}
              <div className="mt-px grid grid-cols-2 gap-px">
                <Tile label="Fees · 24h" value={fmtUsd(tokenStats.fees24h)} foot={`${FEE_LABEL} of volume`}>
                  <Sparkline data={feesSpark} width={72} height={22} color="var(--volt)" className="absolute right-4 top-4 hidden opacity-80 sm:block" />
                </Tile>
                <Tile label="Volume · 24h" value={compactUsd(tokenStats.volume24h)} foot="Hyperliquid + Jupiter" />
                <Tile label="Buybacks · 7d" value={fmtUsd(tokenStats.buybacks7d)} foot={`≈ ${compactNum(tokenStats.buybacks7d / TOKEN_PRICE)} ${$T}`}>
                  <Sparkline data={bbSpark} width={72} height={22} color="var(--volt)" className="absolute right-4 top-4 hidden opacity-80 sm:block" />
                </Tile>
                <Tile
                  label="Supply bought back"
                  value={`${tokenStats.supplyPct.toFixed(2)}%`}
                  foot={
                    <span className="mt-1 block">
                      <span className="relative block h-[5px] overflow-hidden rounded-full bg-paper-2">
                        <motion.span
                          className="absolute inset-y-0 left-0 rounded-full bg-volt shadow-[0_0_10px_var(--volt)]"
                          initial={{ width: 0 }}
                          whileInView={{ width: `${Math.max(3, tokenStats.supplyPct * 4)}%` }}
                          viewport={{ once: true }}
                          transition={{ duration: 1.4, ease: EASE, delay: 0.3 }}
                        />
                      </span>
                      <span className="mt-1.5 flex justify-between text-[10px] text-faint">
                        <span>0%</span>
                        <span>25% of supply</span>
                      </span>
                    </span>
                  }
                />
              </div>
            </div>
          </Reveal>
          <Reveal delay={0.08} className="lg:col-span-5">
            <Ledger active={statsInView} />
          </Reveal>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-12">
          <Reveal className="lg:col-span-5">
            <LaunchCard />
          </Reveal>
          <Reveal delay={0.08} className="flex flex-col lg:col-span-7">
            <ContractRow />
            <div className="mt-4 grid flex-1 grid-cols-2 gap-px overflow-hidden rounded-[20px] border border-line bg-line shadow-card">
              {[
                ["Hyperliquid", `${brand.builderFeeBps} bps builder fee`, "perps · HIP-3 stocks · HIP-4"],
                ["Jupiter", `${brand.swapFeeBps} bps platform fee`, "Solana tokens · xStocks"],
              ].map(([venue, fee, scope]) => (
                <div key={venue} className="flex flex-col justify-between bg-card px-5 py-4">
                  <div className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Fees from {venue}</div>
                  <div className="mt-3 font-mono text-[16px] font-semibold sm:text-[clamp(1.1rem,2vw,1.45rem)] tracking-[-0.03em] text-ink">{fee}</div>
                  <div className="mt-1 font-mono text-[11px] text-muted">{scope}</div>
                </div>
              ))}
            </div>
          </Reveal>
        </div>

        <p className="mt-6 text-center font-mono text-[11px] text-faint">
          All figures shown are demo data for illustration. Live numbers will be read from the chain at launch.
        </p>
      </div>
    </section>
  );
}
