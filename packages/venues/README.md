# @weft/venues

Real market data from public APIs for all five Weft products, plus signal providers and Solana token safety facts. It is **read-only**: nothing here signs a transaction, uses a key, creates an account or sends an order.

```ts
import { createVenues } from "@weft/venues";

const v = createVenues();                                   // options: fetch, timeouts, URLs, jupiterApiKey, solanaRpcUrl…
await v.catalog.list("stocks", { search: "nvidia" });       // MarketListing[] sorted by 24h volume
await v.marketData.getQuote(instrument, { side: "buy", sizeUsd: 5_000 }); // fillPrice + priceImpactBps
await v.signals.fetch(signal, Date.now());                   // SignalSnapshot | null (never throws)
await v.tokenFacts.getTokenFacts(mint, { sizeUsd: 1_000 });  // TokenFacts (+ `unknown` list)
```

`createVenues` returns `{ marketData, catalog, signalProviders, signals, tokenFacts, ctx }`. `signals` is a router over `signalProviders`, keyed by kind. The package runs under plain Node 24 with type stripping (`erasableSyntaxOnly`).

## What is live and what is simulated

| Product / signal | Mode | Source |
| --- | --- | --- |
| **perps** catalog + quotes | live | Hyperliquid `metaAndAssetCtxs`, `allMids`, `l2Book` (book walk for size) |
| **stocks** catalog + quotes | live | HIP-3 builder dexes (`perpDexs` → `metaAndAssetCtxs{dex}`), classified equity/index/commodity/fx/other; plus verified **xStocks** on Solana (Jupiter, tag `xstocks`) |
| **predictions** catalog + quotes | live | HIP-4 `outcomeMeta` + `allMids` + `spotMetaAndAssetCtxs` (outcome ctxs `#<10·id+side>`) + `l2Book`; **Jupiter Prediction** `/prediction/v1/events`, `/markets/{id}`, `/orderbook/{id}` (Polymarket/Kalshi-backed, readable without a key on lite-api) |
| **tokens** catalog + quotes | live | Jupiter Tokens v2 (`toptrending/1h`, `search`), Price v3, Swap v1 `quote` (size-aware impact) |
| **options** catalog + quotes | live | Deribit public (`get_book_summary_by_currency`, `get_instruments`, `ticker`, `get_order_book`): BTC/ETH inverse (premium × index → USD), SOL USDC-linear. Derive (`api.lyra.finance/public/get_ticker`) quotes for `venue: "derive"` |
| `price` | live | HL mids + 1m candles (5m/1h change); Jupiter token stats; option/Jupiter outcome: price only |
| `funding` | live | HL funding (hourly) → 1h/8h/APR; OI × mark. `oi_zscore_30d` = null (no public OI history) |
| `liquidity` | live | Book: depth ±2%, spread, $1k walk. Tokens: Jupiter quotes ($1k/$25k buy, $1k sell); depth ±2% is an **estimate** (impact ≈ a + b·size, capped at pool liquidity) |
| `odds` | live | HIP-4 mid, 24h Δpp, volume; Jupiter mid (24h Δ null; volume only for single-market events) |
| `token_onchain` | live | Jupiter Tokens v2 → DexScreener fallback → Solana RPC `getAccountInfo` for authorities. `lp_locked`, `dev_sold_pct`, `smart_wallet_buys_1h` = null |
| `forecast` | live | NOAA CPC weekly OISST (`wksst9120.for`): `noaa_cpc` series `nino34_anomaly`, `nino34_sst`, `nino3_*`, `nino4_*`, `nino12_*`. Other sources → null |
| `macro` | live | FX pairs (`USDBRL`, `EURUSD`…) via Frankfurter (ECB); `US2Y`, `US10Y`, `US3M`, `FEDFUNDS`, `VIX`, `WTI`, `BRENT`, `DXY` (FRED broad dollar index), or `FRED:<ID>` via FRED's keyless `fredgraph.csv` |
| `calendar` | live / **static** | `custom` is exact. `fomc` / `cpi` / `earnings` come from a static table in `src/signals/calendar.ts`. The FOMC 2026 dates are the Fed's published schedule; the 2027 FOMC dates, CPI release dates and earnings dates are estimates and must be refreshed |
| `social`, `news`, `post_match`, `model` | **simulated** | Deterministic smooth noise seeded by params and time (same inputs give the same output and values drift slowly). `model` is anchored to the live market price when an instrument is given |
| `position` | n/a | The engine produces this signal; this package does not |

### Instrument conventions
- HIP-4 outcome: `{ venue: "hyperliquid", market: "<outcome id>", outcome: "YES" | "NO" | <side name> }`. `market` may also be `#<encoding>`. Slugs such as `fomc-dec-2026-cut` do not resolve, so they return null or throw.
- Jupiter outcome: `{ venue: "jupiter", market: "<marketId e.g. POLY-2589812>", outcome: "YES" | "NO" }`.
- Spot: `"HYPE/USDC"`, `"HYPE"` or the HL coin `"@107"`.
- Token prices are in USD (quoted against USDC), even when `quote: "SOL"`.
- Quotes may include `depthExhausted: true` (`VenueQuote extends Quote`) when the visible book can't absorb the size.

## HTTP, caching and rate limits
`src/http.ts` is shared by every client. It provides a timeout (10s default), retries on network errors, 429 and 5xx (exponential backoff with jitter, honouring `Retry-After`), a TTL cache, coalescing of identical in-flight requests, and a cap of 6 concurrent requests per host. TTLs are 1s for books, 2s for mids, 5s for meta and quotes, 15–30s for catalogs and token info, 1h for macro, 6h for NOAA and 10m for instrument lists. A full catalog sweep of all five products takes about 60 requests.

- **Hyperliquid info**: weight-based limit of about 1200 weight/min per IP. `l2Book`/`allMids` are cheap and `metaAndAssetCtxs` is heavier. Prefer `getQuotes` (one `allMids` per dex).
- **Jupiter lite-api**: free tier with a low rate limit. Pass `jupiterUrl: "https://api.jup.ag"` and `jupiterApiKey` for production limits. Prediction is beta and may start requiring the key.
- **DexScreener**: about 300 req/min.
- **Solana public RPC**: aggressively rate limited (429s are common). Set `solanaRpcUrl` to Helius, Triton or similar.
- **Deribit / Derive public**: generous, but don't poll per tick: quotes are cached 2–3s.
- **NOAA / FRED / Frankfurter**: daily or weekly data, cached for hours.

## Needs paid keys or feeds later
- **X API** (Pro/Enterprise) for `social` and `post_match`, plus an embedding model for claim matching.
- **News API** (NewsAPI / Benzinga / Tiingo…) for `news`.
- **Weft model** for `model`.
- **Solana indexer** (Helius / Birdeye / GMGN / RugCheck) for `dev_sold_pct`, `lp_locked`, `smart_wallet_buys_1h`, holder history, and a private RPC.
- **Earnings / economic calendar feed** to replace the static tables.
- **OI history** (own recorder or a data vendor) for `oi_zscore_30d`.
- **Turnkey** (or similar) wallets for execution. That is out of scope here: this package never signs.

## Token facts caveats
- `getTokenFacts` fails closed on unknowns: liquidity 0, top-10 100%, authorities not revoked, age 0. The returned `unknown` array lists which fields were filled this way.
- `dev_sold_pct` has no free source. It is filled with `devSoldPctWhenUnknown`, which defaults to 0 (permissive); set it to 100 to fail closed.
- xStocks keep issuer mint/freeze authorities and have concentrated holders, so the default token gates block them. The risk policy needs an exemption for verified `assetClass: "equity"` tokens.

## Development
```bash
npm test -w @weft/venues          # offline: fetch is injected, fixtures in test/fixtures (trimmed real responses)
npx tsc --noEmit -p packages/venues
npm run smoke -w @weft/venues     # LIVE: hits every API, prints a summary, exits 1 on failure
```
