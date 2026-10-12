"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tiny data hook: fetch on mount, optional polling (paused while the tab is
 * hidden), manual refresh, and stale-while-revalidate (keeps the last data on
 * errors so the UI doesn't flash empty).
 */
export function useApi<T>(fetcher: (() => Promise<T>) | null, deps: unknown[] = [], opts: { pollMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;

  const run = useCallback(async () => {
    if (!fetchRef.current) return;
    try {
      const d = await fetchRef.current();
      setData(d);
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    run();
    if (!opts.pollMs) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") run();
    }, opts.pollMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, opts.pollMs]);

  return { data, error, loading, refresh: run, setData };
}

export const fmtUsd = (v: number | null | undefined, digits?: number) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const d = digits ?? (Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 1 ? 2 : Math.abs(v) >= 0.01 ? 4 : 8);
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
};
export const fmtCompact = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : `$${Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v)}`;
export const fmtPct = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}%`;
export const fmtPrice = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (a >= 1) return v.toFixed(a >= 100 ? 2 : 3);
  if (a === 0) return "0";
  return v.toPrecision(4);
};
export const ago = (ts: number | null | undefined) => {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
