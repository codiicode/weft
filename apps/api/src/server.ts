import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createVenues } from "@weft/venues";
import { createEngine, SqliteStore } from "@weft/engine";
import { StrategyLibrary } from "./lib/library.ts";
import { createApp } from "./app.ts";

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.WEFT_DATA_DIR ?? fileURLToPath(new URL("../.data/", import.meta.url));
mkdirSync(DATA_DIR, { recursive: true });

const venues = createVenues();
const engine = createEngine({
  store: new SqliteStore(join(DATA_DIR, "engine.db")),
  marketData: venues.marketData,
  signalProviders: venues.signalProviders,
  tokenFacts: venues.tokenFacts,
});
const library = new StrategyLibrary(join(DATA_DIR, "library.db"));
const signalModes = Object.fromEntries(venues.signalProviders.flatMap((p) => p.kinds.map((k) => [k, p.mode] as const)));

const app = createApp({ catalog: venues.catalog, marketData: venues.marketData, engine, library, signalModes });
engine.start();

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`weft api listening on http://localhost:${info.port}`);
  console.log(`  data: ${DATA_DIR}`);
  console.log(`  AI generation: ${process.env.ANTHROPIC_API_KEY ? "Claude (claude-opus-5-5)" : "template fallback (set ANTHROPIC_API_KEY for Claude)"}`);
});

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    console.log("shutting down…");
    server.close();
    await engine.shutdown();
    library.close();
    process.exit(0);
  });
}
