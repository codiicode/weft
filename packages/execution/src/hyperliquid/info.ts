import type { MarketKind } from "./ticks.ts";

export const HL_MAINNET_URL = "https://api.hyperliquid.xyz";
export const HL_TESTNET_URL = "https://api.hyperliquid-testnet.xyz";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export async function postJson<T>(fetchFn: FetchLike, url: string, body: unknown, timeoutMs = 10_000): Promise<T> {
  const res = await Promise.race([
    fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`POST ${url} timed out after ${timeoutMs} ms`)), timeoutMs).unref?.()),
  ]);
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`POST ${url} → non-JSON response: ${text.slice(0, 300)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Info endpoint (read-only)                                            */
/* ------------------------------------------------------------------ */

export interface PerpAssetInfo {
  name: string;
  szDecimals: number;
  maxLeverage?: number;
  onlyIsolated?: boolean;
  isDelisted?: boolean;
  marginMode?: string;
}
export interface PerpMeta {
  universe: PerpAssetInfo[];
}
export interface SpotMeta {
  universe: { tokens: [number, number]; name: string; index: number; isCanonical?: boolean }[];
  tokens: { name: string; szDecimals: number; weiDecimals?: number; index: number; tokenId?: string }[];
}
export type PerpDexs = ({ name: string; fullName?: string; deployer?: string } | null)[];
export interface OutcomeMeta {
  outcomes: { outcome: number; name: string; description?: string; sideSpecs: { name: string }[]; quoteToken?: string }[];
}
export interface ClearinghouseState {
  assetPositions: { position: { coin: string; szi: string; entryPx?: string | null; leverage?: { type: string; value: number } } }[];
  marginSummary?: { accountValue: string };
  withdrawable?: string;
}

export interface SpotClearinghouseState {
  balances: { coin: string; token: number; total: string; hold: string }[];
}

/** The subset of /info Weft needs. An interface so tests can use fixtures. */
export interface HlInfo {
  meta(dex?: string): Promise<PerpMeta>;
  spotMeta(): Promise<SpotMeta>;
  perpDexs(): Promise<PerpDexs>;
  allMids(dex?: string): Promise<Record<string, string>>;
  outcomeMeta?(): Promise<OutcomeMeta>;
  clearinghouseState?(user: string, dex?: string): Promise<ClearinghouseState>;
  spotClearinghouseState?(user: string): Promise<SpotClearinghouseState>;
  orderStatus?(user: string, oidOrCloid: number | string): Promise<unknown>;
  maxBuilderFee?(user: string, builder: string): Promise<number>;
}

export class HttpHlInfo implements HlInfo {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  constructor(baseUrl: string = HL_MAINNET_URL, fetchFn: FetchLike = globalThis.fetch as unknown as FetchLike) {
    this.baseUrl = baseUrl;
    this.fetchFn = fetchFn;
  }
  private post<T>(body: unknown) {
    return postJson<T>(this.fetchFn, `${this.baseUrl}/info`, body);
  }
  meta(dex = "") {
    return this.post<PerpMeta>({ type: "meta", dex });
  }
  spotMeta() {
    return this.post<SpotMeta>({ type: "spotMeta" });
  }
  perpDexs() {
    return this.post<PerpDexs>({ type: "perpDexs" });
  }
  allMids(dex = "") {
    return this.post<Record<string, string>>(dex ? { type: "allMids", dex } : { type: "allMids" });
  }
  outcomeMeta() {
    return this.post<OutcomeMeta>({ type: "outcomeMeta" });
  }
  clearinghouseState(user: string, dex = "") {
    return this.post<ClearinghouseState>({ type: "clearinghouseState", user, dex });
  }
  spotClearinghouseState(user: string) {
    return this.post<SpotClearinghouseState>({ type: "spotClearinghouseState", user });
  }
  orderStatus(user: string, oid: number | string) {
    return this.post<unknown>({ type: "orderStatus", user, oid });
  }
  maxBuilderFee(user: string, builder: string) {
    return this.post<number>({ type: "maxBuilderFee", user, builder });
  }
}

/* ------------------------------------------------------------------ */
/* Asset resolution                                                     */
/* ------------------------------------------------------------------ */

export interface ResolvedAsset {
  /** Venue asset id used in order wires. */
  asset: number;
  /** Key in `allMids` (and the coin name in user state): "BTC", "xyz:NVDA", "@107", "#100", … */
  coin: string;
  /** `""` for core perps; the HIP-3 dex name for builder-deployed perps. */
  dex: string;
  szDecimals: number;
  /** Tick rules: perps use 6 max decimals, spot (and outcomes) 8. */
  tickKind: MarketKind;
  market: "perp" | "spot" | "outcome";
  maxLeverage?: number;
  onlyIsolated?: boolean;
}

export const SPOT_ASSET_OFFSET = 10_000;
export const BUILDER_PERP_OFFSET = 100_000;
export const BUILDER_PERP_DEX_STRIDE = 10_000;
export const OUTCOME_ASSET_OFFSET = 100_000_000;

/** Docs "Asset IDs": builder-deployed perps → 100000 + perp_dex_index × 10000 + index_in_meta. */
export function builderPerpAssetId(perpDexIndex: number, indexInMeta: number): number {
  if (perpDexIndex < 1) throw new Error("perp dex index 0 is the core dex; use the plain meta index");
  return BUILDER_PERP_OFFSET + perpDexIndex * BUILDER_PERP_DEX_STRIDE + indexInMeta;
}

/** Docs "Asset IDs" → Outcomes: asset = 100_000_000 + 10 × outcome + side (side ∈ {0, 1}). */
export function outcomeAssetId(outcome: number, side: 0 | 1): number {
  if (!Number.isInteger(outcome) || outcome < 0) throw new Error(`invalid outcome id ${outcome}`);
  return OUTCOME_ASSET_OFFSET + 10 * outcome + side;
}

/**
 * Maps symbols to venue asset ids exactly like the SDK's `Info.__init__` / `name_to_asset`:
 *  - core perps: index in `meta.universe`;
 *  - spot: 10000 + `spotMeta.universe[i].index`, addressable by "BASE/QUOTE" or the pair name ("@107");
 *  - builder perps: `perpDexs()[1:]` enumerated as i → 110000 + i × 10000, i.e. 100000 + dexIndex × 10000.
 * Metadata is cached; call `refresh()` after listings change.
 */
export class AssetResolver {
  private perpCache = new Map<string, Promise<PerpMeta>>();
  private spotCache: Promise<SpotMeta> | null = null;
  private dexCache: Promise<PerpDexs> | null = null;
  private outcomeCache: Promise<OutcomeMeta> | null = null;

  private readonly info: HlInfo;
  private readonly opts: { outcomeSzDecimals?: number };
  constructor(info: HlInfo, opts: { outcomeSzDecimals?: number } = {}) {
    this.info = info;
    this.opts = opts;
  }

  refresh(): void {
    this.perpCache.clear();
    this.spotCache = this.dexCache = this.outcomeCache = null;
  }

  private perpMeta(dex: string) {
    let p = this.perpCache.get(dex);
    if (!p) {
      p = this.info.meta(dex);
      p.catch(() => this.perpCache.delete(dex));
      this.perpCache.set(dex, p);
    }
    return p;
  }

  async perp(symbol: string, dex?: string): Promise<ResolvedAsset> {
    const d = dex ?? (symbol.includes(":") ? symbol.split(":")[0]! : "");
    const bare = symbol.includes(":") ? symbol.split(":").slice(1).join(":") : symbol;
    const name = d ? `${d}:${bare}` : bare;
    let offset = 0;
    if (d) {
      this.dexCache ??= this.info.perpDexs();
      const dexs = await this.dexCache;
      const idx = dexs.findIndex((x) => x?.name === d);
      if (idx < 1) throw new Error(`unknown HIP-3 perp dex "${d}"`);
      offset = builderPerpAssetId(idx, 0);
    }
    const meta = await this.perpMeta(d);
    const i = meta.universe.findIndex((u) => u.name === name);
    if (i < 0) throw new Error(`unknown perp ${name}${d ? ` on dex ${d}` : ""}`);
    const u = meta.universe[i]!;
    if (u.isDelisted) throw new Error(`perp ${name} is delisted`);
    return {
      asset: offset + i,
      coin: name,
      dex: d,
      szDecimals: u.szDecimals,
      tickKind: "perp",
      market: "perp",
      maxLeverage: u.maxLeverage,
      onlyIsolated: u.onlyIsolated === true || u.marginMode === "noCross" || u.marginMode === "strictIsolated",
    };
  }

  async spot(symbol: string): Promise<ResolvedAsset> {
    this.spotCache ??= this.info.spotMeta();
    const meta = await this.spotCache;
    const tokens = new Map(meta.tokens.map((t) => [t.index, t]));
    // Like the SDK: the pair name always wins; "BASE/QUOTE" maps to the first pair with those tokens.
    let hit = meta.universe.find((u) => u.name === symbol);
    if (!hit) {
      const [b, q] = symbol.split("/");
      hit = meta.universe.find((u) => tokens.get(u.tokens[0])?.name === b && tokens.get(u.tokens[1])?.name === (q ?? "USDC"));
    }
    if (!hit) throw new Error(`unknown spot pair ${symbol}`);
    const base = tokens.get(hit.tokens[0]);
    if (!base) throw new Error(`spot pair ${symbol}: base token ${hit.tokens[0]} missing from spotMeta`);
    return {
      asset: SPOT_ASSET_OFFSET + hit.index,
      coin: hit.name,
      dex: "",
      szDecimals: base.szDecimals,
      tickKind: "spot",
      market: "spot",
    };
  }

  /**
   * HIP-4 outcome side. `market` is the numeric outcome id from `outcomeMeta`; `outcome` is the
   * side name ("Yes"/"No", matched against `sideSpecs`, case-insensitive) or "0"/"1".
   * EXPERIMENTAL: asset ids follow the docs; outcome lot size (szDecimals) is not published in
   * `outcomeMeta`, so it comes from config (default 0 = whole shares).
   */
  async outcome(market: string, outcome: string): Promise<ResolvedAsset> {
    const id = Number(market);
    if (!Number.isInteger(id)) throw new Error(`HIP-4 market must be a numeric outcome id, got ${market}`);
    let side: 0 | 1;
    if (outcome === "0" || outcome === "1") side = Number(outcome) as 0 | 1;
    else {
      if (!this.info.outcomeMeta) throw new Error("outcomeMeta not available to resolve side names");
      this.outcomeCache ??= this.info.outcomeMeta();
      const meta = await this.outcomeCache;
      const o = meta.outcomes.find((x) => x.outcome === id);
      if (!o) throw new Error(`unknown HIP-4 outcome ${id}`);
      const norm = (s: string) => s.replace(/^template:/, "").toLowerCase();
      const idx = o.sideSpecs.findIndex((s) => norm(s.name) === outcome.toLowerCase());
      if (idx !== 0 && idx !== 1) throw new Error(`outcome ${id} has no side "${outcome}"`);
      side = idx;
    }
    const encoding = 10 * id + side;
    return {
      asset: outcomeAssetId(id, side),
      coin: `#${encoding}`,
      dex: "",
      szDecimals: this.opts.outcomeSzDecimals ?? 0,
      tickKind: "spot",
      market: "outcome",
    };
  }

  async mid(a: ResolvedAsset): Promise<number> {
    const mids = await this.info.allMids(a.dex);
    const raw = mids[a.coin];
    const px = raw == null ? NaN : Number(raw);
    if (!(px > 0)) throw new Error(`no mid price for ${a.coin}`);
    return px;
  }
}
