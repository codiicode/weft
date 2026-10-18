/**
 * Fomo (fomo.family) traders by username, through fomoapi.io (an independent, unofficial API):
 * a handle → its Solana and EVM addresses. Fomo's perps settle on Hyperliquid from the EVM address,
 * so that's the account to copy or fade; the Solana address is the one its token trades come from.
 *
 * Each lookup costs credits, so answers are kept: a found trader for 7 days, an unknown handle for a
 * day. Off unless FOMOAPI_KEY is set.
 */
export interface FomoTrader {
  handle: string;
  displayName: string | null;
  followers: number | null;
  verified: boolean;
  solana: string | null;
  evm: string | null;
}

const API = "https://api.fomoapi.io";
const FOUND_MS = 7 * 86_400_000, MISSING_MS = 86_400_000;

export const normalizeHandle = (h: string) => h.trim().replace(/^@+/, "").toLowerCase();

export function fomoLookup(o: { key: string; kvGet: (k: string) => string | null; kvSet: (k: string, v: string) => void; fetch?: typeof fetch; now?: () => number }) {
  const f = o.fetch ?? fetch, now = o.now ?? Date.now;
  return async (raw: string): Promise<FomoTrader | null> => {
    const handle = normalizeHandle(raw);
    if (!/^[a-z0-9_.]{1,40}$/.test(handle)) return null;
    const kept = o.kvGet(`fomo:${handle}`);
    if (kept) {
      const k = JSON.parse(kept) as { at: number; t: FomoTrader | null };
      if (now() - k.at < (k.t ? FOUND_MS : MISSING_MS)) return k.t;
    }
    const r = await f(`${API}/v2/users/${encodeURIComponent(handle)}`, { headers: { authorization: `Bearer ${o.key}` }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) {
      o.kvSet(`fomo:${handle}`, JSON.stringify({ at: now(), t: null }));
      return null;
    }
    if (!r.ok) throw new Error(`Fomo lookup failed (HTTP ${r.status})`);
    const b = (await r.json()) as { handle?: string; displayName?: string; followers?: number; verified?: boolean; wallets?: { solana?: string; evm?: string } };
    const t: FomoTrader = {
      handle: normalizeHandle(b.handle ?? handle),
      displayName: b.displayName ?? null,
      followers: typeof b.followers === "number" ? b.followers : null,
      verified: Boolean(b.verified),
      solana: b.wallets?.solana && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b.wallets.solana) ? b.wallets.solana : null,
      evm: b.wallets?.evm && /^0x[0-9a-fA-F]{40}$/.test(b.wallets.evm) ? b.wallets.evm.toLowerCase() : null,
    };
    o.kvSet(`fomo:${handle}`, JSON.stringify({ at: now(), t }));
    return t;
  };
}
