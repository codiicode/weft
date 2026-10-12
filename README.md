# Weft

Open, non-custodial AI trading agent. Write a thesis, get a strategy graph, let it run.

```
apps/web            Landing page (Next.js static site)
packages/strategy   Strategy graph schema, validator, evaluator, risk checks
```

```bash
npm install
npm run dev          # landing page on http://localhost:3000
npm test             # all package tests
npm run typecheck
```

Requires Node 20+ (scripts in `packages/strategy/scripts` use Node's built-in TypeScript support, Node 23.6+).
