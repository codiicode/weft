import type { GraphView, Issue, Instrument, Strategy } from "@weft/strategy";
import type { DeploymentRecord, DeploymentSnapshot, EngineEvent, Fill } from "@weft/engine";
import type { MarketListing, Product, Quote } from "@weft/venues";

/**
 * Typed client for the Weft API (apps/api). Base URL from
 * NEXT_PUBLIC_API_URL, defaulting to the local dev server.
 */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public issues?: Issue[]
  ) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...(init?.json !== undefined ? { "content-type": "application/json" } : {}), ...init?.headers },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.error ?? `HTTP ${res.status}`, res.status, data?.issues ?? data?.errors);
  return data as T;
}

export interface LibraryEntry {
  id: string;
  strategy: Strategy;
  author: string;
  forkedFrom: string | null;
  forks: number;
  createdAt: number;
  updatedAt: number;
  graph?: GraphView;
}

export interface GenerateResult {
  strategy: Strategy;
  warnings: Issue[];
  rationale: string;
  source: "claude" | "template";
  notes: string[];
  graph: GraphView;
}

export interface GenerateProgress {
  type: "search" | "submit" | "invalid" | "thinking" | "fallback";
  message: string;
}

export type Snapshot = DeploymentSnapshot & { graph?: GraphView; builderFeesUsd?: number };

export interface LeaderRow {
  deploymentId: string;
  strategyId: string;
  name: string;
  tags: string[];
  status: string;
  mode: string;
  returnPct: number;
  equityUsd: number;
  openPositions: number;
  equityCurve: [number, number][];
  since: number;
}

export interface Stats {
  deployments: number;
  running: number;
  strategies: number;
  fills: number;
  volumeUsd: number;
  feesUsd: number;
  builderFeesUsd: number;
}

export const api = {
  health: () => req<{ ok: boolean; ts: number; signals: Record<string, "live" | "simulated"> }>("/health"),

  markets: (product: Product, opts: { search?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.search) q.set("search", opts.search);
    if (opts.limit) q.set("limit", String(opts.limit));
    return req<{ product: Product; rows: MarketListing[] }>(`/markets/${product}?${q}`);
  },
  quote: (instrument: Instrument, opts: { side?: "buy" | "sell"; sizeUsd?: number } = {}) =>
    req<Quote>("/quote", { method: "POST", json: { instrument, ...opts } }),

  strategies: () => req<{ strategies: LibraryEntry[] }>("/strategies"),
  strategy: (id: string) => req<LibraryEntry>(`/strategies/${encodeURIComponent(id)}`),
  examples: () => req<{ strategies: Strategy[] }>("/strategies/examples"),
  validate: (strategy: unknown) =>
    req<{ ok: true; strategy: Strategy; warnings: Issue[]; graph: GraphView }>("/strategies/validate", { method: "POST", json: { strategy } }),
  saveStrategy: (strategy: Strategy, author = "@you") => req<LibraryEntry>("/strategies", { method: "POST", json: { strategy, author } }),
  updateStrategy: (id: string, strategy: Strategy) => req<LibraryEntry>(`/strategies/${encodeURIComponent(id)}`, { method: "PUT", json: { strategy } }),
  fork: (id: string, author = "@you") => req<LibraryEntry>(`/strategies/${encodeURIComponent(id)}/fork`, { method: "POST", json: { author } }),
  deleteStrategy: (id: string) => req<{ ok: true }>(`/strategies/${encodeURIComponent(id)}`, { method: "DELETE" }),

  generate: (thesis: string) => req<GenerateResult>("/ai/generate", { method: "POST", json: { thesis } }),

  /** Streams progress events while the strategy is generated. */
  async generateStream(thesis: string, onProgress: (p: GenerateProgress) => void, signal?: AbortSignal): Promise<GenerateResult> {
    const res = await fetch(`${API_URL}/ai/generate/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ thesis }),
      signal,
    });
    if (!res.ok || !res.body) throw new ApiError(`HTTP ${res.status}`, res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const event = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = chunk
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("\n");
        if (!data) continue;
        const payload = JSON.parse(data);
        if (event === "progress") onProgress(payload);
        else if (event === "result") return payload as GenerateResult;
        else if (event === "error") throw new ApiError(payload.error, 422);
      }
    }
    throw new ApiError("stream ended without a result", 500);
  },

  deployments: () => req<{ deployments: Snapshot[] }>("/deployments"),
  deploy: (body: { strategy?: Strategy; strategyId?: string; allocationUsd: number; intervalSec?: number }) =>
    req<DeploymentRecord>("/deployments", { method: "POST", json: body }),
  deployment: (id: string) => req<Snapshot>(`/deployments/${encodeURIComponent(id)}`),
  events: (id: string, since?: number) => req<{ events: EngineEvent[] }>(`/deployments/${encodeURIComponent(id)}/events${since ? `?since=${since}` : ""}`),
  fills: (id: string) => req<{ fills: Fill[] }>(`/deployments/${encodeURIComponent(id)}/fills`),
  control: (id: string, action: "pause" | "resume" | "stop" | "kill" | "tick") =>
    req<Snapshot>(`/deployments/${encodeURIComponent(id)}/${action}`, { method: "POST" }),

  leaderboard: () => req<{ rows: LeaderRow[] }>("/leaderboard"),
  stats: () => req<Stats>("/stats"),

  /** Subscribe to live engine events (SSE). Returns an unsubscribe function. */
  subscribe(onEvent: (e: EngineEvent) => void, deploymentId?: string): () => void {
    const es = new EventSource(`${API_URL}/events/stream${deploymentId ? `?deploymentId=${encodeURIComponent(deploymentId)}` : ""}`);
    const handler = (m: MessageEvent) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {}
    };
    for (const t of ["status", "tick", "trigger_met", "trigger_fired", "intent", "rejected", "fill", "notify", "warning", "error"])
      es.addEventListener(t, handler as EventListener);
    return () => es.close();
  },
};
