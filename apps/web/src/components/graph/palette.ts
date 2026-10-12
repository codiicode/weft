import type { GraphNode, Side } from "./types";

export const sideColor = (side: Side) =>
  side === "long" || side === "buy" ? "var(--long)" : "var(--short)";
export const sideSoft = (side: Side) =>
  side === "long" || side === "buy" ? "var(--long-soft)" : "var(--short-soft)";

export function nodeColor(n: GraphNode, met = false): string {
  switch (n.kind) {
    case "signal":
      return "var(--signal)";
    case "trigger":
      return met ? "var(--met)" : "var(--trigger)";
    case "action":
      return sideColor(n.side);
    case "exit":
      return "var(--exit)";
  }
}
export function nodeSoft(n: GraphNode, met = false): string {
  switch (n.kind) {
    case "signal":
      return "var(--signal-soft)";
    case "trigger":
      return met ? "var(--long-soft)" : "var(--trigger-soft)";
    case "action":
      return sideSoft(n.side);
    case "exit":
      return "var(--exit-soft)";
  }
}
export const sideLabel = (s: Side) => ({ long: "Long", short: "Short", buy: "Buy", sell: "Sell" })[s];
