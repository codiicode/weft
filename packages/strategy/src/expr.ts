import { z } from "zod";

/**
 * Trigger conditions: a small, closed expression language. No user code runs.
 *
 * Operands are signal references (`"nino.value"`), literals, or arithmetic.
 * Conditions combine comparisons with and/or/not. Logic is three-valued:
 * missing or stale data is `null` (unknown), and unknown never fires a trigger.
 */

export const Ref = z
  .string()
  .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'refs look like "signal_id.field"');

export type Operand =
  | { ref: string }
  | { value: number }
  | { op: "add" | "sub" | "mul" | "div" | "min" | "max"; args: [Operand, Operand] }
  | { op: "abs"; arg: Operand };

export const Operand: z.ZodType<Operand> = z.lazy(() =>
  z.union([
    z.object({ ref: Ref }),
    z.object({ value: z.number() }),
    z.object({ op: z.enum(["add", "sub", "mul", "div", "min", "max"]), args: z.tuple([Operand, Operand]) }),
    z.object({ op: z.literal("abs"), arg: Operand }),
  ])
);

export type Comparator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";

export type Expr =
  | { op: "and" | "or"; args: Expr[] }
  | { op: "not"; arg: Expr }
  | { op: Comparator; left: Operand; right: Operand }
  | { op: "crosses_above" | "crosses_below"; left: Operand; right: Operand }
  | { op: "between"; value: Operand; min: Operand; max: Operand }
  | { op: "is"; ref: string; value: boolean };

export const Expr: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(["and", "or"]), args: z.array(Expr).min(1) }),
    z.object({ op: z.literal("not"), arg: Expr }),
    z.object({ op: z.enum(["gt", "gte", "lt", "lte", "eq", "neq"]), left: Operand, right: Operand }),
    z.object({ op: z.enum(["crosses_above", "crosses_below"]), left: Operand, right: Operand }),
    z.object({ op: z.literal("between"), value: Operand, min: Operand, max: Operand }),
    z.object({ op: z.literal("is"), ref: Ref, value: z.boolean() }),
  ])
);

/* ------------------------------------------------------------------ */
/* Walking                                                             */
/* ------------------------------------------------------------------ */

export function operandRefs(o: Operand, out: string[] = []): string[] {
  if ("ref" in o) out.push(o.ref);
  else if ("args" in o) o.args.forEach((a) => operandRefs(a, out));
  else if ("arg" in o) operandRefs(o.arg, out);
  return out;
}

/** Every ref used in an expression, with whether it is used as a boolean (`is`) or a number. */
export function exprRefs(e: Expr, out: { ref: string; as: "number" | "boolean" }[] = []) {
  switch (e.op) {
    case "and":
    case "or":
      e.args.forEach((a) => exprRefs(a, out));
      break;
    case "not":
      exprRefs(e.arg, out);
      break;
    case "is":
      out.push({ ref: e.ref, as: "boolean" });
      break;
    case "between":
      [e.value, e.min, e.max].forEach((o) => operandRefs(o).forEach((ref) => out.push({ ref, as: "number" })));
      break;
    default:
      [e.left, e.right].forEach((o) => operandRefs(o).forEach((ref) => out.push({ ref, as: "number" })));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

export type Tri = boolean | null;
export type Lookup = (ref: string) => number | boolean | null;

export interface ExprContext {
  lookup: Lookup;
  /** Previous left−right differences for crossing detection, keyed by expression path. */
  prev: Record<string, number>;
  /** Written during evaluation; becomes the next `prev`. */
  next: Record<string, number>;
  /** Refs that were unknown during this evaluation. */
  unknown: Set<string>;
}

export function evalOperand(o: Operand, ctx: ExprContext): number | null {
  if ("value" in o) return o.value;
  if ("ref" in o) {
    const v = ctx.lookup(o.ref);
    if (typeof v !== "number" || !Number.isFinite(v)) {
      ctx.unknown.add(o.ref);
      return null;
    }
    return v;
  }
  if (o.op === "abs") {
    const v = evalOperand(o.arg, ctx);
    return v == null ? null : Math.abs(v);
  }
  const a = evalOperand(o.args[0], ctx);
  const b = evalOperand(o.args[1], ctx);
  if (a == null || b == null) return null;
  switch (o.op) {
    case "add":
      return a + b;
    case "sub":
      return a - b;
    case "mul":
      return a * b;
    case "div":
      return b === 0 ? null : a / b;
    case "min":
      return Math.min(a, b);
    case "max":
      return Math.max(a, b);
  }
}

const EPS = 1e-12;

export function evalExpr(e: Expr, ctx: ExprContext, path = "$"): Tri {
  switch (e.op) {
    case "and": {
      // false dominates; otherwise unknown dominates
      let unknown = false;
      for (let i = 0; i < e.args.length; i++) {
        const v = evalExpr(e.args[i]!, ctx, `${path}.${i}`);
        if (v === false) return false;
        if (v === null) unknown = true;
      }
      return unknown ? null : true;
    }
    case "or": {
      let unknown = false;
      for (let i = 0; i < e.args.length; i++) {
        const v = evalExpr(e.args[i]!, ctx, `${path}.${i}`);
        if (v === true) return true;
        if (v === null) unknown = true;
      }
      return unknown ? null : false;
    }
    case "not": {
      const v = evalExpr(e.arg, ctx, `${path}.0`);
      return v == null ? null : !v;
    }
    case "is": {
      const v = ctx.lookup(e.ref);
      if (typeof v !== "boolean") {
        ctx.unknown.add(e.ref);
        return null;
      }
      return v === e.value;
    }
    case "between": {
      const v = evalOperand(e.value, ctx);
      const lo = evalOperand(e.min, ctx);
      const hi = evalOperand(e.max, ctx);
      if (v == null || lo == null || hi == null) return null;
      return v >= lo && v <= hi;
    }
    case "crosses_above":
    case "crosses_below": {
      const l = evalOperand(e.left, ctx);
      const r = evalOperand(e.right, ctx);
      if (l == null || r == null) return null;
      const diff = l - r;
      const prev = ctx.prev[path];
      ctx.next[path] = diff;
      if (prev === undefined) return false; // need a prior observation to call it a cross
      return e.op === "crosses_above" ? prev <= 0 && diff > 0 : prev >= 0 && diff < 0;
    }
    default: {
      const l = evalOperand(e.left, ctx);
      const r = evalOperand(e.right, ctx);
      if (l == null || r == null) return null;
      switch (e.op) {
        case "gt":
          return l > r;
        case "gte":
          return l >= r;
        case "lt":
          return l < r;
        case "lte":
          return l <= r;
        case "eq":
          return Math.abs(l - r) < EPS;
        case "neq":
          return Math.abs(l - r) >= EPS;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Describe (for graph labels, logs, approvals)                         */
/* ------------------------------------------------------------------ */

const SYM: Record<string, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=", neq: "≠", add: "+", sub: "−", mul: "×", div: "÷" };

export function describeOperand(o: Operand): string {
  if ("value" in o) return String(o.value);
  if ("ref" in o) return o.ref;
  if (o.op === "abs") return `|${describeOperand(o.arg)}|`;
  if (o.op === "min" || o.op === "max") return `${o.op}(${describeOperand(o.args[0])}, ${describeOperand(o.args[1])})`;
  return `(${describeOperand(o.args[0])} ${SYM[o.op]} ${describeOperand(o.args[1])})`;
}

export function describeExpr(e: Expr): string {
  switch (e.op) {
    case "and":
    case "or":
      return e.args.map((a) => (a.op === "and" || a.op === "or" ? `(${describeExpr(a)})` : describeExpr(a))).join(` ${e.op.toUpperCase()} `);
    case "not":
      return `NOT ${describeExpr(e.arg)}`;
    case "is":
      return e.value ? e.ref : `NOT ${e.ref}`;
    case "between":
      return `${describeOperand(e.min)} ≤ ${describeOperand(e.value)} ≤ ${describeOperand(e.max)}`;
    case "crosses_above":
      return `${describeOperand(e.left)} crosses above ${describeOperand(e.right)}`;
    case "crosses_below":
      return `${describeOperand(e.left)} crosses below ${describeOperand(e.right)}`;
    default:
      return `${describeOperand(e.left)} ${SYM[e.op]} ${describeOperand(e.right)}`;
  }
}

/** Top-level clauses of a condition, for multi-line display in a trigger node. */
export function clauses(e: Expr): { logic: "AND" | "OR" | "IF"; lines: string[] } {
  if (e.op === "and" || e.op === "or") return { logic: e.op === "and" ? "AND" : "OR", lines: e.args.map(describeExpr) };
  return { logic: "IF", lines: [describeExpr(e)] };
}
