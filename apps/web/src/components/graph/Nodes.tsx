"use client";
import { AnimatePresence, motion } from "motion/react";
import type { ActionNode, ExitNode, GraphNode, LayoutPreset, SignalNode, TriggerNode } from "./types";
import { IconCheck, IconExit, IconTrigger, actionIcon, signalIcon } from "./icons";
import { nodeColor, nodeSoft, sideColor, sideLabel, sideSoft } from "./palette";
import { Sparkline } from "../ui/Sparkline";
import { CountUp } from "../ui/CountUp";
import { fmtPct } from "@/lib/rng";

export interface NodeViewProps {
  node: GraphNode;
  width: number;
  preset: LayoutPreset;
  met: boolean;
  active: boolean;
}

const KIND_LABEL = { signal: "Signal", trigger: "Trigger", action: "Action", exit: "Exit" } as const;

function Chip({ node, met, size = 22 }: { node: GraphNode; met: boolean; size?: number }) {
  const Icon =
    node.kind === "signal"
      ? signalIcon[node.type]
      : node.kind === "trigger"
        ? IconTrigger
        : node.kind === "action"
          ? actionIcon(node.side)
          : IconExit;
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[7px] transition-colors duration-500"
      style={{ width: size, height: size, background: nodeSoft(node, met), color: nodeColor(node, met) }}
    >
      <Icon size={Math.round(size * 0.6)} />
    </span>
  );
}

function Header({ node, met, right }: { node: GraphNode; met: boolean; right?: React.ReactNode }) {
  return (
    <div className="flex h-[22px] items-center gap-2">
      <Chip node={node} met={met} />
      <span className="text-[11px] font-medium text-muted">
        {KIND_LABEL[node.kind]}
      </span>
      <span className="ml-auto flex min-w-0 items-center">{right}</span>
    </div>
  );
}

function StatusPill({ met }: { met: boolean }) {
  return (
    <motion.span
      layout
      className="relative inline-flex h-[20px] items-center gap-1 overflow-hidden whitespace-nowrap rounded-[6px] px-1.5 text-[10.5px] font-medium"
      style={{
        background: met ? "var(--long-soft)" : "var(--paper-2)",
        color: met ? "var(--met)" : "var(--muted)",
      }}
      transition={{ type: "spring", stiffness: 500, damping: 34 }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {met ? (
          <motion.span
            key="met"
            className="flex items-center gap-1"
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -12, opacity: 0 }}
          >
            <IconCheck size={10} strokeWidth={2.2} /> Met
          </motion.span>
        ) : (
          <motion.span
            key="not"
            className="flex items-center gap-1"
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -12, opacity: 0 }}
          >
            <span className="h-[6px] w-[6px] rounded-full border border-current" /> Waiting
          </motion.span>
        )}
      </AnimatePresence>
    </motion.span>
  );
}

function SignalBody({ node, preset }: { node: SignalNode; preset: LayoutPreset }) {
  const narrow = preset === "stack";
  return (
    <>
      <Header
        node={node}
        met={false}
        right={<span className="truncate text-[10.5px] text-faint">{node.source}</span>}
      />
      <div className="mt-[7px] truncate text-[13px] font-semibold leading-[17px] tracking-[-0.01em] text-ink">
        {node.title}
      </div>
      <div className="mt-[5px] flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="tnum truncate text-[12px] leading-[15px] text-ink-2">{node.value}</div>
          {node.delta && (
            <div
              className="tnum truncate text-[10.5px] leading-[13px]"
              style={{ color: node.deltaDir === "down" ? "var(--short)" : "var(--long)" }}
            >
              {node.delta}
            </div>
          )}
        </div>
        {node.spark && (
          <Sparkline data={node.spark} width={narrow ? 40 : 62} height={24} color="var(--signal)" strokeWidth={1.4} />
        )}
      </div>
    </>
  );
}

function TriggerBody({ node, met }: { node: TriggerNode; met: boolean }) {
  return (
    <>
      <Header node={node} met={met} right={<StatusPill met={met} />} />
      <div className="mt-[6px] space-y-[2px]">
        {node.conditions.map((c, i) => (
          <div key={i} className="flex h-[20px] items-center gap-1.5">
            {i > 0 ? (
              <span
                className="shrink-0 rounded-[4px] px-1 text-[9px] font-semibold leading-[14px] tracking-wide transition-colors duration-500"
                style={{ background: nodeSoft(node, met), color: nodeColor(node, met) }}
              >
                {node.logic}
              </span>
            ) : (
              <span className="shrink-0 text-[9px] font-semibold tracking-wide text-faint">IF</span>
            )}
            <span className="tnum truncate text-[11.5px] text-ink-2">{c}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function ActionBody({ node, active, preset, width }: { node: ActionNode; active: boolean; preset: LayoutPreset; width: number }) {
  const color = sideColor(node.side);
  const params = [
    ["Size", node.alloc],
    node.tp ? ["Target", node.tp] : null,
    node.sl ? ["Stop", node.sl] : null,
  ].filter(Boolean) as [string, string][];
  return (
    <>
      <Header
        node={node}
        met={false}
        right={<span className="truncate text-[10.5px] text-faint">{node.venue}</span>}
      />
      <div className="mt-[7px] flex h-[20px] items-center gap-1.5">
        <span
          className="rounded-[5px] px-1.5 text-[10.5px] font-semibold leading-[18px]"
          style={{ background: sideSoft(node.side), color }}
        >
          {sideLabel(node.side)}
        </span>
        <span className="truncate text-[13px] font-semibold tracking-[-0.01em] text-ink">{node.asset}</span>
        {node.lev && <span className="tnum text-[11px] text-muted">{node.lev}</span>}
        <span className="ml-auto shrink-0">
          {active && node.pnl != null ? (
            <motion.span
              initial={{ opacity: 0, x: 6 }}
              animate={{ opacity: 1, x: 0 }}
              className="tnum text-[11.5px] font-medium"
              style={{ color: node.pnl >= 0 ? "var(--long)" : "var(--short)" }}
            >
              <CountUp value={node.pnl} from={0} format={(v) => fmtPct(v, 1)} duration={1.6} />
            </motion.span>
          ) : null}
        </span>
      </div>
      <div className="mt-[7px] flex flex-wrap gap-1">
        {params.slice(0, preset === "stack" ? 2 : 3).map(([k, v]) => (
          <span
            key={k}
            className="tnum rounded-[5px] border border-line px-1.5 text-[10.5px] leading-[16px] text-ink-2"
          >
            <span className="text-faint">{k} </span>
            {v}
          </span>
        ))}
      </div>
      {node.spark && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[26px] overflow-hidden rounded-b-[10px]">
          {active ? (
            <Sparkline
              data={node.spark}
              width={width}
              height={26}
              color={color}
              strokeWidth={1.4}
              draw
              pad={0}
              className="h-full w-full"
            />
          ) : null}
        </div>
      )}
    </>
  );
}

function ExitBody({ node, active }: { node: ExitNode; active: boolean }) {
  return (
    <>
      <Header
        node={node}
        met={false}
        right={
          <span
            className="rounded-[6px] px-1.5 text-[10.5px] font-medium leading-[20px]"
            style={{
              background: active ? "var(--short-soft)" : "var(--paper-2)",
              color: active ? "var(--short)" : "var(--muted)",
            }}
          >
            {active ? "Triggered" : "Watching"}
          </span>
        }
      />
      <div className="mt-[7px] truncate text-[13px] font-semibold tracking-[-0.01em] text-ink">{node.title}</div>
      <div className="mt-[3px] truncate text-[11.5px] text-muted">{node.detail}</div>
    </>
  );
}

export function compactLabel(n: GraphNode): string {
  switch (n.kind) {
    case "signal":
      return n.title;
    case "trigger":
      return n.conditions[0];
    case "action":
      return `${sideLabel(n.side)} ${n.asset}`;
    case "exit":
      return n.title;
  }
}

export function NodeContent({ node, preset, met, active, width }: NodeViewProps) {
  if (preset === "compact") {
    const on = node.kind === "trigger" ? met : node.kind === "action" || node.kind === "exit" ? active : true;
    return (
      <div className="flex h-full items-center gap-2 px-2">
        <Chip node={node} met={met} size={20} />
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-2">{compactLabel(node)}</span>
        {node.kind !== "signal" && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-500"
            style={{ background: on ? (node.kind === "trigger" ? "var(--met)" : nodeColor(node)) : "var(--line-2)" }}
          />
        )}
      </div>
    );
  }
  return (
    <div className="relative h-full px-[11px] py-[10px]">
      {node.kind === "signal" && <SignalBody node={node} preset={preset} />}
      {node.kind === "trigger" && <TriggerBody node={node} met={met} />}
      {node.kind === "action" && <ActionBody node={node} active={active} preset={preset} width={width} />}
      {node.kind === "exit" && <ExitBody node={node} active={active} />}
    </div>
  );
}
