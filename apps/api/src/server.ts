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
import { AgentWallets, privyAgentApi } from "./live/agents.ts";
import { LiveRouterExecutor, LiveService, liveConfigFromEnv } from "./live/service.ts";
import { CompositeEngine } from "./live/composite.ts";
import { Reconciler } from "./live/reconcile.ts";
import { TelegramBot } from "./lib/telegram.ts";
import { createApp } from "./app.ts";

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.WEFT_DATA_DIR ?? fileURLToPath(new URL("../.data/", import.meta.url));
mkdirSync(DATA_DIR, { recursive: true });

const venues = createVenues({ oiHistoryPath: join(DATA_DIR, "oi-history.json") });
const accounts = new Accounts(join(DATA_DIR, "accounts.db"));
const paperEngine = createEngine({
  store: new SqliteStore(join(DATA_DIR, "engine.db")),
  marketData: venues.marketData,
  signalProviders: venues.signalProviders,
  tokenFacts: venues.tokenFacts,
});

// Live trading: per-user Privy agent wallets → Hyperliquid. A separate engine and store, so paper
// and live money never share an executor. Off unless WEFT_LIVE_ENABLED=1; testnet by default.
const liveCfg = liveConfigFromEnv();
const agents = process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET ? new AgentWallets(privyAgentApi(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET), accounts) : null;
const live = process.env.PRIVY_APP_ID ? new LiveService(liveCfg, accounts, agents) : null;
const liveEngine = live
  ? createEngine({
      // One store per network: testnet runs can never wake up on mainnet.
      store: new SqliteStore(join(DATA_DIR, `engine-live-${liveCfg.network}.db`)),
      marketData: venues.marketData,
      signalProviders: venues.signalProviders,
      tokenFacts: venues.tokenFacts,
      executor: new LiveRouterExecutor(live, (id) => accounts.deploymentOwner(id)),
    })
  : null;
const engine = new CompositeEngine(paperEngine, liveEngine);
const library = new StrategyLibrary(join(DATA_DIR, "library.db"));
const signalModes = Object.fromEntries(venues.signalProviders.flatMap((p) => p.kinds.map((k) => [k, p.mode] as const)));

// One bot for everyone: users link their own chat from Settings. TELEGRAM_CHAT_ID (optional) still gets everything.
const telegram = process.env.TELEGRAM_BOT_TOKEN
  ? new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, accounts, { username: process.env.TELEGRAM_BOT_USERNAME, log: (m) => console.warn(m) })
  : null;
telegram?.start();
const notifier = createNotifier(engine, sinksFromEnv(), {
  perUser: telegram
    ? { ownerOf: (id) => accounts.deploymentOwner(id), send: (userId, a) => telegram.sendToUser(userId, `◆ ${a.strategyName}\n${a.text}`) }
    : undefined,
  includeFills: process.env.WEFT_ALERT_FILLS === "1",
  strategyName: async (id) => (await engine.getSnapshot(id))?.deployment.strategy.name ?? id,
  log: (m) => console.warn(m),
});
const auth = createAuthenticator({ appId: process.env.PRIVY_APP_ID, verificationKey: process.env.PRIVY_VERIFICATION_KEY });
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
  live: live ?? undefined,
  telegram: telegram ?? undefined,
  backtest: { history: venues.history, tokenFacts: venues.tokenFacts, calendar: calendarFields },
});
engine.start();

// Every minute, check live runs against what Hyperliquid actually holds.
const reconciler = liveEngine && liveCfg.enabled ? new Reconciler(liveEngine, accounts, liveCfg) : null;
const reconcileTimer = reconciler ? setInterval(() => void reconciler.run().catch((e) => console.warn("reconcile failed:", (e as Error).message)), 60_000) : null;
reconcileTimer?.unref();

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`weft api listening on http://localhost:${info.port}`);
  console.log(`  data: ${DATA_DIR}`);
  console.log(`  alerts: ${[telegram ? "Telegram per user" : null, ...notifier.sinks].filter(Boolean).join(", ") || "off (set TELEGRAM_BOT_TOKEN for per-user Telegram alerts)"}`);
  console.log(`  auth: ${auth.enabled ? `Privy (${auth.appId})` : "local mode (set PRIVY_APP_ID to require sign-in)"}`);
  console.log(
    `  live: ${live ? `${liveCfg.enabled ? "ON" : "off (WEFT_LIVE_ENABLED=1 to enable)"} · ${liveCfg.network} · agents ${agents ? "Privy" : "need PRIVY_APP_SECRET"} · cap $${liveCfg.maxAllocationUsd} · builder ${liveCfg.builder?.address ?? "none"}` : "unavailable (needs PRIVY_APP_ID)"}`
  );
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
    // Never let a slow venue call or long poll keep the old process (and its database locks) alive.
    setTimeout(() => process.exit(0), 3_000).unref();
    telegram?.stop();
    if (reconcileTimer) clearInterval(reconcileTimer);
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
