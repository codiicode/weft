"use client";
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import type { GraphNode, GraphRuntime, GraphSpec, LayoutPreset } from "./types";
import { connectedSet, edgePath, endpoints, finalRuntime, layoutGraph } from "./layout";
import { nodeColor } from "./palette";
import { NodeContent } from "./Nodes";
import { useInView, useWidth, useReducedMotion } from "@/lib/hooks";

export interface StrategyGraphProps {
  spec: GraphSpec;
  runtime?: GraphRuntime;
  /** "auto" switches between the horizontal and stacked layouts by container width */
  preset?: LayoutPreset | "auto";
  /** horizontal preset used by "auto" above the stack breakpoint */
  wide?: "full" | "medium";
  stackBelow?: number;
  /** particles flow along edges */
  live?: boolean;
  /** hover a node to trace its path */
  interactive?: boolean;
  maxScale?: number;
  className?: string;
  /** skip entrance animations (thumbnails) */
  instant?: boolean;
  ariaLabel?: string;
  /** draw dashed placeholder slots for nodes that are not visible yet */
  ghost?: boolean;
}

const EASE = [0.22, 1, 0.36, 1] as const;

function StrategyGraphImpl({
  spec,
  runtime,
  preset = "auto",
  stackBelow = 640,
  wide = "full",
  live = true,
  interactive = true,
  maxScale = 1,
  className = "",
  instant = false,
  ariaLabel,
  ghost = false,
}: StrategyGraphProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const width = useWidth(wrap);
  const inView = useInView(wrap, { rootMargin: "60px" });
  const reduce = useReducedMotion();
  const uid = useId().replace(/[:«»]/g, "");
  const [hover, setHover] = useState<string | null>(null);

  const resolved: LayoutPreset = preset === "auto" ? (width && width < stackBelow ? "stack" : wide) : preset;
  const layout = useMemo(() => layoutGraph(spec, resolved), [spec, resolved]);
  const rt = useMemo(() => runtime ?? finalRuntime(spec), [runtime, spec]);
  const scale = width ? Math.min(maxScale, width / layout.W) : 1;
  const offsetX = width ? Math.max(0, (width - layout.W * scale) / 2) : 0;
  const highlight = useMemo(() => (hover && interactive ? connectedSet(spec, hover) : null), [hover, interactive, spec]);
  const byId = useMemo(() => Object.fromEntries(spec.nodes.map((n) => [n.id, n])) as Record<string, GraphNode>, [spec]);

  const stackLayout = useMemo(() => (preset === "auto" ? layoutGraph(spec, "stack") : null), [spec, preset]);
  const wideLayout = useMemo(() => (preset === "auto" ? layoutGraph(spec, wide) : null), [spec, preset, wide]);
  const flowing = live && !reduce && inView;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof svg.pauseAnimations !== "function") return;
    if (flowing) svg.unpauseAnimations();
    else svg.pauseAnimations();
  }, [flowing]);

  const edges = spec.edges.map(([f, t], i) => {
    const a = layout.boxes[f];
    const b = layout.boxes[t];
    const from = byId[f];
    const to = byId[t];
    const visible = !!(rt.visible[f] && rt.visible[t]);
    const hot =
      visible &&
      (to.kind === "trigger" ? !!rt.met[t] : from.kind === "trigger" ? !!rt.met[f] && !!rt.active[t] : false);
    const feeding = visible && from.kind === "signal" && !hot;
    const d = edgePath(a, b, layout.orientation);
    const p = endpoints(a, b, layout.orientation);
    const dim = highlight ? !(highlight.has(f) && highlight.has(t)) : false;
    return { key: `${f}-${t}`, i, d, p, visible, hot, feeding, dim, fromColor: nodeColor(from, !!rt.met[f]), toColor: nodeColor(to, !!rt.met[t]) };
  });

  return (
    <div className="w-full" style={{ containerType: "inline-size" }}>
    {!width && stackLayout && wideLayout && (
      <style>{`.sg-${uid}{aspect-ratio:${wideLayout.W}/${wideLayout.H}}@container (max-width:${stackBelow - 0.02}px){.sg-${uid}{aspect-ratio:auto;height:${Math.round(stackLayout.H * Math.min(maxScale, 1))}px}}`}</style>
    )}
    <div
      ref={wrap}
      className={`relative w-full select-none ${!width && stackLayout ? `sg-${uid}` : ""} ${className}`}
      style={width ? { height: layout.H * scale } : stackLayout ? undefined : { aspectRatio: `${layout.W} / ${layout.H}` }}
      role="img"
      aria-label={ariaLabel ?? "Strategy graph"}
    >
      {width > 0 && (
        <div
          className="absolute top-0 origin-top-left"
          style={{ left: offsetX, width: layout.W, height: layout.H, transform: `scale(${scale})` }}
          onMouseLeave={() => setHover(null)}
        >
          {/* Edges, beneath nodes */}
          <svg ref={svgRef} width={layout.W} height={layout.H} className="absolute inset-0 overflow-visible" aria-hidden>
            <defs>
              {edges.map((e) => (
                <linearGradient
                  key={e.key}
                  id={`eg-${uid}-${e.i}`}
                  gradientUnits="userSpaceOnUse"
                  x1={e.p.x1}
                  y1={e.p.y1}
                  x2={e.p.x2}
                  y2={e.p.y2}
                >
                  <stop offset="0" style={{ stopColor: e.fromColor }} />
                  <stop offset="1" style={{ stopColor: e.toColor }} />
                </linearGradient>
              ))}
            </defs>
            {edges.map((e) => (
              <g key={e.key} style={{ opacity: e.dim ? 0.12 : 1, transition: "opacity .35s var(--ease-out)" }}>
                <motion.path
                  d={e.d}
                  fill="none"
                  style={{ stroke: "var(--line-2)" }}
                  strokeWidth={resolved === "compact" ? 1.6 : 1.5}
                  strokeLinecap="round"
                  initial={instant ? false : { pathLength: 0, opacity: 0 }}
                  animate={e.visible ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
                  transition={{ duration: 0.75, ease: EASE }}
                />
                {e.hot && (
                  <motion.path
                    d={e.d}
                    fill="none"
                    stroke={`url(#eg-${uid}-${e.i})`}
                    strokeWidth={resolved === "compact" ? 2.2 : 2.2}
                    strokeLinecap="round"
                    initial={instant ? false : { pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 0.7, ease: EASE }}
                  />
                )}
                {(e.hot || e.feeding) && live && !reduce && (
                  <g>
                    {[0, 1].map((k) => (
                      <g key={k}>
                        <circle r={e.hot ? 5 : 3.6} style={{ fill: e.hot ? e.toColor : "var(--signal)" }} opacity={0.16}>
                          <animateMotion
                            dur={e.hot ? "1.9s" : "3.4s"}
                            begin={`-${(k * (e.hot ? 0.95 : 1.7) + e.i * 0.37).toFixed(2)}s`}
                            repeatCount="indefinite"
                            path={e.d}
                          />
                        </circle>
                        <circle r={e.hot ? 2.3 : 1.7} style={{ fill: e.hot ? e.toColor : "var(--signal)" }} opacity={e.hot ? 1 : 0.55}>
                          <animateMotion
                            dur={e.hot ? "1.9s" : "3.4s"}
                            begin={`-${(k * (e.hot ? 0.95 : 1.7) + e.i * 0.37).toFixed(2)}s`}
                            repeatCount="indefinite"
                            path={e.d}
                          />
                        </circle>
                      </g>
                    ))}
                  </g>
                )}
              </g>
            ))}
          </svg>

          {/* Blueprint slots */}
          {ghost &&
            spec.nodes.map((n, i) => {
              const b = layout.boxes[n.id];
              return (
                <motion.div
                  key={`g-${n.id}`}
                  className="pointer-events-none absolute rounded-[10px] border border-dashed border-line-2"
                  style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: rt.visible[n.id] ? 0 : reduce ? 0.8 : [0.35, 0.9, 0.35] }}
                  transition={rt.visible[n.id] ? { duration: 0.3 } : { duration: 2.2, repeat: Infinity, delay: i * 0.12 }}
                />
              );
            })}

          {/* Nodes */}
          {spec.nodes.map((n) => {
            const box = layout.boxes[n.id];
            const visible = !!rt.visible[n.id];
            const met = !!rt.met[n.id];
            const active = !!rt.active[n.id];
            const dim = highlight ? !highlight.has(n.id) : false;
            const lit = (n.kind === "trigger" && met) || ((n.kind === "action" || n.kind === "exit") && active);
            const armed = (n.kind === "action" || n.kind === "exit") && !active;
            const color = nodeColor(n, met);
            return (
              <motion.div
                key={n.id}
                className="absolute"
                style={{ left: box.x, top: box.y, width: box.w, height: box.h, zIndex: hover === n.id ? 3 : 1 }}
                initial={instant ? false : { opacity: 0, y: 6, scale: 0.98 }}
                animate={
                  visible
                    ? { opacity: dim ? 0.32 : 1, y: 0, scale: 1 }
                    : { opacity: 0, y: 6, scale: 0.98 }
                }
                transition={{ duration: 0.55, ease: EASE }}
                onMouseEnter={interactive ? () => setHover(n.id) : undefined}
              >
                <motion.div
                  className={`relative h-full overflow-hidden border bg-card transition-[border-color,box-shadow] duration-500 ${
                    resolved === "compact" ? "rounded-[8px]" : "rounded-[10px]"
                  } ${interactive ? "cursor-default" : ""}`}
                  style={{
                    borderColor: lit ? `color-mix(in oklab, ${color} 55%, transparent)` : "var(--line)",
                    boxShadow: lit
                      ? `0 0 0 3px color-mix(in oklab, ${color} 10%, transparent)`
                      : "var(--shadow-card)",
                  }}
                  whileHover={interactive ? { y: -2, transition: { type: "spring", stiffness: 400, damping: 26 } } : undefined}
                >
                  <div className={armed && resolved !== "compact" ? "h-full opacity-[0.82] transition-opacity duration-500" : "h-full transition-opacity duration-500"}>
                    <NodeContent node={n} preset={resolved} met={met} active={active} width={box.w} />
                  </div>
                  {/* activation flash */}
                  {lit && !instant && !reduce && (
                    <motion.span
                      className="pointer-events-none absolute inset-0"
                      style={{ background: `radial-gradient(120% 90% at 0% 50%, color-mix(in oklab, ${color} 14%, transparent), transparent 70%)` }}
                      initial={{ opacity: 1 }}
                      animate={{ opacity: 0 }}
                      transition={{ duration: 1.4, ease: "easeOut" }}
                    />
                  )}
                </motion.div>
              </motion.div>
            );
          })}

          {/* Ports, above nodes */}
          <svg width={layout.W} height={layout.H} className="pointer-events-none absolute inset-0 overflow-visible" aria-hidden>
            {edges.map((e) =>
              e.visible ? (
                <g key={e.key} style={{ opacity: e.dim ? 0.15 : 1, transition: "opacity .35s" }}>
                  <circle cx={e.p.x1} cy={e.p.y1} r={resolved === "compact" ? 2.6 : 3.4} strokeWidth={1.4} style={{ fill: "var(--card)", stroke: e.hot ? e.fromColor : "var(--line-2)", transition: "stroke .5s" }} />
                  <circle cx={e.p.x2} cy={e.p.y2} r={resolved === "compact" ? 2.6 : 3.4} strokeWidth={1.4} style={{ fill: "var(--card)", stroke: e.hot ? e.toColor : "var(--line-2)", transition: "stroke .5s" }} />
                </g>
              ) : null
            )}
          </svg>
        </div>
      )}
    </div>
    </div>
  );
}

export const StrategyGraph = memo(StrategyGraphImpl);
