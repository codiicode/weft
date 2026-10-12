# Weft

Open, non-custodial AI trading agent. Write a thesis, get a strategy graph you can read, run it on paper
against live markets, go live when you approve. Perps, stocks, predictions, Solana tokens and options.

```
apps/web              Landing page + product app (/app)
apps/api              HTTP API: markets, AI drafting and edits, library, paper/alerts/live runs, SSE, Telegram
packages/strategy     Strategy graph schema, validator, evaluator, risk checks
packages/venues       Live market data + signal providers (Hyperliquid, Jupiter, Deribit, …)
packages/engine       Runtime: tick loop, paper executor, exits, persistence, replay
packages/execution    Live execution: Hyperliquid agent wallet, Jupiter swaps + tx inspection
```

```bash
npm install
npm run dev -w @weft/api     # :8787  (set ANTHROPIC_API_KEY for Claude-powered generation)
npm run dev -w @weft/web     # :3000  → open /app
npm run seed -w @weft/api    # optional demo runs
npm test && npm run typecheck
```

Requires Node 24 (the API and scripts run TypeScript directly).

Design rules for the web app (keep them when adding UI): Inter for interface text and numbers
(tabular), Newsreader only for large display headings, mono only for addresses and code. Colour means
something: blue = what a strategy watches, amber = conditions, green/red = trades and P&L. Write copy in
plain words; show strategies as sentences (`describeStrategy` in `apps/web/src/lib/strategy-view.ts`).

- [docs/STATUS.md](docs/STATUS.md): what works, what's live vs simulated, what's needed next
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pieces fit
