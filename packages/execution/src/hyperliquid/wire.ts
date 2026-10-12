import { keccak256, toBytes, type Hex } from "viem";
import { floatToWire } from "./signing.ts";

/**
 * Order / cancel action construction, ported from the Python SDK
 * (`order_request_to_order_wire`, `order_wires_to_order_action`, `Exchange.bulk_cancel*`).
 * Key order matters: it is part of the msgpack bytes that get signed.
 */

export type Tif = "Alo" | "Ioc" | "Gtc";
export type Tpsl = "tp" | "sl";
export type Grouping = "na" | "normalTpsl" | "positionTpsl";

export type OrderType =
  | { limit: { tif: Tif } }
  | { trigger: { triggerPx: number; isMarket: boolean; tpsl: Tpsl } };

export interface HlOrder {
  /** Venue asset id (see `assets.ts`). */
  asset: number;
  isBuy: boolean;
  limitPx: number;
  sz: number;
  reduceOnly: boolean;
  orderType: OrderType;
  /** 16-byte hex client order id. */
  cloid?: Hex;
}

export type OrderTypeWire =
  | { limit: { tif: Tif } }
  | { trigger: { isMarket: boolean; triggerPx: string; tpsl: Tpsl } };

export interface OrderWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: OrderTypeWire;
  c?: Hex;
}

export interface BuilderInfo {
  /** Builder address, lowercase. */
  b: string;
  /** Fee in tenths of a basis point (50 = 5 bps). */
  f: number;
}

export interface OrderAction {
  type: "order";
  orders: OrderWire[];
  grouping: Grouping;
  builder?: BuilderInfo;
}

export function orderTypeToWire(t: OrderType): OrderTypeWire {
  if ("limit" in t) return { limit: { tif: t.limit.tif } };
  if ("trigger" in t)
    return { trigger: { isMarket: t.trigger.isMarket, triggerPx: floatToWire(t.trigger.triggerPx), tpsl: t.trigger.tpsl } };
  throw new Error("invalid order type");
}

export function orderToWire(o: HlOrder): OrderWire {
  const w: OrderWire = {
    a: o.asset,
    b: o.isBuy,
    p: floatToWire(o.limitPx),
    s: floatToWire(o.sz),
    r: o.reduceOnly,
    t: orderTypeToWire(o.orderType),
  };
  if (o.cloid != null) w.c = assertCloid(o.cloid);
  return w;
}

export function orderAction(orders: OrderWire[], builder?: BuilderInfo | null, grouping: Grouping = "na"): OrderAction {
  const action: OrderAction = { type: "order", orders, grouping };
  if (builder) action.builder = { b: builder.b.toLowerCase(), f: builder.f };
  return action;
}

export interface CancelAction {
  type: "cancel";
  cancels: { a: number; o: number }[];
}

export interface CancelByCloidAction {
  type: "cancelByCloid";
  cancels: { asset: number; cloid: Hex }[];
}

export function cancelAction(cancels: { asset: number; oid: number }[]): CancelAction {
  return { type: "cancel", cancels: cancels.map((c) => ({ a: c.asset, o: c.oid })) };
}

export function cancelByCloidAction(cancels: { asset: number; cloid: Hex }[]): CancelByCloidAction {
  return { type: "cancelByCloid", cancels: cancels.map((c) => ({ asset: c.asset, cloid: assertCloid(c.cloid) })) };
}

export interface UpdateLeverageAction {
  type: "updateLeverage";
  asset: number;
  isCross: boolean;
  leverage: number;
}

export function updateLeverageAction(asset: number, leverage: number, isCross: boolean): UpdateLeverageAction {
  if (!Number.isInteger(leverage) || leverage < 1) throw new Error(`leverage must be a positive integer, got ${leverage}`);
  return { type: "updateLeverage", asset, isCross, leverage };
}

export function assertCloid(c: string): Hex {
  if (!/^0x[0-9a-fA-F]{32}$/.test(c)) throw new Error(`cloid must be a 16-byte hex string, got ${c}`);
  return c as Hex;
}

/**
 * Deterministic cloid from an idempotency key: first 16 bytes of keccak256(utf8(key)).
 * A retried request for the same intent carries the same cloid, so the executor can look
 * the order up (`orderStatus` by cloid) before resubmitting and never fill an intent twice.
 */
export function cloidFromKey(key: string): Hex {
  return keccak256(toBytes(key)).slice(0, 34) as Hex;
}
