import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { calendarFields, createVenues } from "@weft/venues";
import { createEngine, SqliteStore } from "@weft/engine";
import { StrategyLibrary } from "./lib/library.ts";
import { resolvePlaceholders } from "./lib/resolve.ts";
import { createNotifier, sinksFromEnv } from "./lib/alerts.ts";
import { createAuthenticator } from "./lib/auth.ts";
import { Accounts } from "./lib/accounts.ts";
import { createApp } from "./app.ts";

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.WEFT_DATA_DIR ?? fileURLToPath(new URL("../.data/", import.meta.url));
mkdirSync(DATA_DIR, { recursive: true });

const venues = createVenues({ oiHistoryPath: join(DATA_DIR, "oi-history.json") });
const engine = createEngine({
  store: new SqliteStore(join(DATA_DIR, "engine.db")),
  marketData: venues.marketData,
  signalProviders: venues.signalProviders,
  tokenFacts: venues.tokenFacts,
});
const library = new StrategyLibrary(join(DATA_DIR, "library.db"));
const signalModes = Object.fromEntries(venues.signalProviders.flatMap((p) => p.kinds.map((k) => [k, p.mode] as const)));

const notifier = createNotifier(engine, sinksFromEnv(), {
  includeFills: process.env.WEFT_ALERT_FILLS === "1",
  strategyName: async (id) => (await engine.getSnapshot(id))?.deployment.strategy.name ?? id,
  log: (m) => console.warn(m),
});
const auth = createAuthenticator({ appId: process.env.PRIVY_APP_ID, verificationKey: process.env.PRIVY_VERIFICATION_KEY });
const accounts = new Accounts(join(DATA_DIR, "accounts.db"));
const app = createApp({
  catalog: venues.catalog,
  marketData: venues.marketData,
  engine,
  library,
  signalModes,
  notifier,
  auth,
  accounts,
  aiDailyLimit: Number(process.env.WEFT_AI_DAILY_LIMIT ?? 30),
  backtest: { history: venues.history, tokenFacts: venues.tokenFacts, calendar: calendarFields },
});
engine.start();

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`weft api listening on http://localhost:${info.port}`);
  console.log(`  data: ${DATA_DIR}`);
  console.log(`  alerts: ${notifier.sinks.length ? notifier.sinks.join(", ") : "off (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID or WEFT_ALERT_WEBHOOK_URL)"}`);
  console.log(`  auth: ${auth.enabled ? `Privy (${auth.appId})` : "local mode (set PRIVY_APP_ID to require sign-in)"}`);
  console.log(`  AI generation: ${process.env.ANTHROPIC_API_KEY ? "Claude (claude-opus-5-5)" : "template fallback (set ANTHROPIC_API_KEY for Claude)"}`);
});

// Swap placeholder instruments in seeded examples for real ones (best effort, in the background).
(async () => {
  for (const e of library.placeholderEntries()) {
    try {
      const { strategy, replaced } = await resolvePlaceholders(e.strategy, venues.catalog);
      if (replaced.length) {
        library.save(strategy, { author: e.author, replaceId: e.id });
        console.log(`  resolved ${e.id}: ${replaced.join(", ")}`);
      }
    } catch (err) {
      console.warn(`  could not resolve ${e.id}: ${(err as Error).message}`);
    }
  }
})();

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    console.log("shutting down…");
    server.close();
    await engine.shutdown();
    try {
      await venues.ctx.oi.flush();
    } catch {}
    library.close();
    accounts.close();
    process.exit(0);
  });
}
