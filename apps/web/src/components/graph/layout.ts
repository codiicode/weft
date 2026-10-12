import type { GraphNode, GraphSpec, GraphRuntime, LayoutPreset, NodeBox } from "./types";

type Tier = 0 | 1 | 2;
const tierOf = (n: GraphNode): Tier =>
  n.kind === "signal" ? 0 : n.kind === "trigger" ? 1 : 2;

function nodeHeight(n: GraphNode, preset: LayoutPreset): number {
  if (preset === "compact") return 34;
  const stack = preset === "stack";
  switch (n.kind) {
    case "signal":
      return stack ? 92 : 94;
    case "trigger":
      return (stack ? 52 : 50) + n.conditions.length * (stack ? 22 : 22);
    case "action":
      return stack ? 118 : 112;
    case "exit":
      return stack ? 84 : 78;
  }
}

export interface Layout {
  W: number;
  H: number;
  boxes: Record<string, NodeBox>;
  orientation: "h" | "v";
}

const H_PRESETS = {
  full: { cols: [0, 392, 808], widths: [234, 252, 262], W: 1070, gap: 14, pad: 6 },
  medium: { cols: [0, 300, 604], widths: [222, 236, 246], W: 850, gap: 12, pad: 6 },
  compact: { cols: [0, 150, 300], widths: [118, 120, 124], W: 424, gap: 8, pad: 4 },
};

export function layoutGraph(spec: GraphSpec, preset: LayoutPreset): Layout {
  const tiers: GraphNode[][] = [[], [], []];
  spec.nodes.forEach((n) => tiers[tierOf(n)].push(n));
  const boxes: Record<string, NodeBox> = {};

  if (preset === "stack") {
    const W = 340;
    const colGap = 12;
    const rowGap = 12;
    const tierGap = 54;
    let y = 4;
    tiers.forEach((tier, ti) => {
      const perRow = ti === 1 ? (tier.length > 2 ? 2 : tier.length) : Math.min(2, tier.length);
      for (let i = 0; i < tier.length; i += perRow) {
        const row = tier.slice(i, i + perRow);
        const rowH = Math.max(...row.map((n) => nodeHeight(n, preset)));
        const w = (W - colGap * (perRow - 1)) / perRow;
        // center a short last row
        const offset = ((perRow - row.length) * (w + colGap)) / 2;
        row.forEach((n, j) => {
          const h = nodeHeight(n, preset);
          boxes[n.id] = { x: offset + j * (w + colGap), y: y + (rowH - h) / 2, w, h };
        });
        y += rowH + rowGap;
      }
      y += tierGap - rowGap;
    });
    return { W, H: y - tierGap + 8, boxes, orientation: "v" };
  }

  const P = H_PRESETS[preset];
  const colHeights = tiers.map(
    (t) => t.reduce((s, n) => s + nodeHeight(n, preset), 0) + Math.max(0, t.length - 1) * P.gap
  );
  const H = Math.max(...colHeights) + P.pad * 2;
  tiers.forEach((tier, ti) => {
    let y = (H - colHeights[ti]) / 2;
    tier.forEach((n) => {
      const h = nodeHeight(n, preset);
      boxes[n.id] = { x: P.cols[ti], y, w: P.widths[ti], h };
      y += h + P.gap;
    });
  });
  return { W: P.W, H, boxes, orientation: "h" };
}

export function edgePath(a: NodeBox, b: NodeBox, orientation: "h" | "v"): string {
  if (orientation === "h") {
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const k = Math.max(36, (x2 - x1) * 0.55);
    return `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`;
  }
  const x1 = a.x + a.w / 2;
  const y1 = a.y + a.h;
  const x2 = b.x + b.w / 2;
  const y2 = b.y;
  const k = Math.max(28, (y2 - y1) * 0.5);
  return `M${x1},${y1} C${x1},${y1 + k} ${x2},${y2 - k} ${x2},${y2}`;
}

export function endpoints(a: NodeBox, b: NodeBox, orientation: "h" | "v") {
  return orientation === "h"
    ? { x1: a.x + a.w, y1: a.y + a.h / 2, x2: b.x, y2: b.y + b.h / 2 }
    : { x1: a.x + a.w / 2, y1: a.y + a.h, x2: b.x + b.w / 2, y2: b.y };
}

/** Every node visible, triggers at their final met state, downstream actions active. */
export function finalRuntime(spec: GraphSpec): GraphRuntime {
  const visible: Record<string, boolean> = {};
  const met: Record<string, boolean> = {};
  const active: Record<string, boolean> = {};
  spec.nodes.forEach((n) => {
    visible[n.id] = true;
    if (n.kind === "trigger") met[n.id] = !!n.met;
  });
  spec.edges.forEach(([f, t]) => {
    if (met[f]) active[t] = true;
  });
  return { visible, met, active };
}

export function emptyRuntime(): GraphRuntime {
  return { visible: {}, met: {}, active: {} };
}

/** Upstream + downstream neighbourhood of a node, for hover highlighting. */
export function connectedSet(spec: GraphSpec, id: string): Set<string> {
  const set = new Set([id]);
  const walk = (cur: string, dir: 0 | 1) => {
    spec.edges.forEach((e) => {
      if (e[dir] === cur && !set.has(e[1 - dir])) {
        set.add(e[1 - dir]);
        walk(e[1 - dir], dir);
      }
    });
  };
  walk(id, 0);
  walk(id, 1);
  return set;
}
