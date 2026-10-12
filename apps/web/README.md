# Weft: landing page

Open, non-custodial AI trading agent with a token: a frontend-only marketing site.
Next.js 16 (App Router, static export) · TypeScript · Tailwind v4 · Motion · Lenis.

## Run

```bash
npm install
npm run dev        # http://localhost:3000  (add --webpack if Turbopack's PostCSS worker can't find `node`)
npm run build      # static site in ./out
npx serve out      # preview the production build
```

Deploy: `npx vercel` from this folder (static export, no server needed).

## Swap things

| What | Where |
| --- | --- |
| Name, ticker, tagline, contract address, fee bps, socials, competitor line | `src/config/brand.ts` |
| **All** mock data: strategies/graphs, tickers, widgets, leaderboard, token stats, comparison, FAQ | `src/data/mock.ts` (a few widget-local constants sit at the top of `src/components/widgets/*`) |
| Colours, type, motion tokens | `src/app/globals.css` · `DESIGN.md` |

## The graph engine (`src/components/graph`)

- `types.ts`: Signal / Trigger / Action / Exit nodes, edges, runtime state (`visible`, `met`, `active`).
- `layout.ts`: deterministic layouts: `full` / `medium` (horizontal), `compact` (thumbnails), `stack` (mobile vertical); bezier edges.
- `StrategyGraph.tsx`: renders any `GraphSpec`; animated edge drawing, gradient "hot" edges with flowing particles (SMIL, paused offscreen), hover-to-trace, blueprint ghost slots, auto mobile layout via container queries (no CLS).
- `sequence.ts`: `useGraphSequence(spec, playing)` builds tier-by-tier, then flips triggers to Met and lights actions.

Everything respects `prefers-reduced-motion` (final states, no loops).
