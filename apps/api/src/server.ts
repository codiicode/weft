import { TradeTape } from "./lib/tape.ts";
import { Backups } from "./lib/backup.ts";
import { PrivyClient } from "@privy-io/node";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { JupiterSwapBuilder } from "@weft/execution";
import type { Fill } from "@weft/engine";
import { REWARDS, Rewards } from "./lib/rewards.ts";
import { Treasury } from "./token/treasury.ts";
import { HolderDiscount, holderConfigFromEnv } from "./live/holders.ts";
import { SolanaReconciler, connectionBalances } from "./live/solana-reconcile.ts";
import { SolanaLive, SolanaRouterExecutor, privySolanaApi, solanaConfigFromEnv } from "./live/solana.ts";
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
import { HlDeposits, depositConfigFromEnv } from "./live/deposits.ts";
import { LiveRouterExecutor, LiveService, hlBaseUrl, liveConfigFromEnv } from "./live/service.ts";
import { NativeStops } from "./live/native-stops.ts";
import { SolanaWithdrawals } from "./live/solana-withdraw.ts";
import { earnings } from "./lib/earnings.ts";
import { R2, r2ConfigFromEnv, uploadSnapshot } from "./lib/offsite.ts";
import { CompositeEngine } from "./live/composite.ts";
import { Reconciler } from "./live/reconcile.ts";
import { TelegramBot } from "./lib/telegram.ts";
import { createApp } from "./app.ts";
import { claudePostMatcher } from "./ai/post-matcher.ts";
import { HeliusWebhook } from "./live/helius-webhook.ts";
import { createTopTraders } from "./lib/traders.ts";

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.WEFT_DATA_DIR ?? fileURLToPath(new URL("../.data/", import.meta.url));
mkdirSync(DATA_DIR, { recursive: true });

const venues = createVenues({
  oiHistoryPath: join(DATA_DIR, "oi-history.json"),
  ...(process.env.JUPITER_API_KEY ? { jupiterUrl: "https://api.jup.ag", jupiterApiKey: process.env.JUPITER_API_KEY } : {}),
  // Token data reads Solana too; the public endpoint is heavily rate limited.
  ...(process.env.SOLANA_RPC_URL ? { solanaRpcUrl: process.env.SOLANA_RPC_URL } : process.env.HELIUS_API_KEY ? { solanaRpcUrl: `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` } : {}),
  // X data (social, post_match) and wallet tracking: live when their keys are set, simulated or off otherwise.
  ...(process.env.TWITTERAPI_IO_KEY ? { twitterApiKey: process.env.TWITTERAPI_IO_KEY, postMatcher: process.env.ANTHROPIC_API_KEY ? claudePostMatcher() : undefined } : {}),
  ...(process.env.HELIUS_API_KEY ? { heliusApiKey: process.env.HELIUS_API_KEY } : {}),
});
const accounts = new Accounts(join(DATA_DIR, "accounts.db"));
const paperEngine = createEngine({
  store: new SqliteStore(join(DATA_DIR, "engine.db")),
  marketData: venues.marketData,
  signalProviders: venues.signalProviders,
  tokenFacts: venues.tokenFacts,
  copy: venues.copyFeeds,
});

// Live trading: per-user Privy agent wallets → Hyperliquid. A separate engine and store, so paper
// and live money never share an executor. Off unless WEFT_LIVE_ENABLED=1; testnet by default.
const liveCfg = liveConfigFromEnv();
const agents = process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET ? new AgentWallets(privyAgentApi(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET), accounts) : null;
const live = process.env.PRIVY_APP_ID ? new LiveService(liveCfg, accounts, agents) : null;
const deposits = live ? new HlDeposits(depositConfigFromEnv(liveCfg.network)) : null;
const liveRouter = live ? new LiveRouterExecutor(live, (id) => accounts.deploymentOwner(id)) : null;
const liveEngine = live
  ? createEngine({
      // One store per network: testnet runs can never wake up on mainnet.
      store: new SqliteStore(join(DATA_DIR, `engine-live-${liveCfg.network}.db`)),
      marketData: venues.marketData,
      signalProviders: venues.signalProviders,
      tokenFacts: venues.tokenFacts,
      copy: venues.copyFeeds,
      executor: liveRouter!,
    })
  : null;
// Real stop-loss / take-profit trigger orders on Hyperliquid for every live perp position, so a
// position keeps its stop even if Weft is down.
const nativeStops =
  live && liveEngine
    ? new NativeStops({
        engine: liveEngine,
        accounts,
        executorFor: (userId) => live.executorReady(userId),
        addressOf: (userId) => {
          const a = accounts.liveAccount(userId);
          return a && a.network === liveCfg.network ? a.hlAddress : null;
        },
        baseUrl: hlBaseUrl(liveCfg.network),
        log: (m) => console.log(m),
      })
    : null;
if (liveRouter && nativeStops) liveRouter.onFilled = () => nativeStops.poke();
// Live Solana tokens: the user's own Privy wallet with Weft as a limited signer. Always mainnet, so
// these runs get their own store. Off unless WEFT_SOL_LIVE=1.
const solCfg = solanaConfigFromEnv();
const solana =
  process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET
    ? new SolanaLive(solCfg, accounts, privySolanaApi(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET, solCfg.authorizationKey))
    : null;
const solanaEngine = solana
  ? createEngine({
      store: new SqliteStore(join(DATA_DIR, "engine-live-solana.db")),
      marketData: venues.marketData,
      signalProviders: venues.signalProviders,
      tokenFacts: venues.tokenFacts,
      copy: venues.copyFeeds,
      executor: new SolanaRouterExecutor(solana, (id) => accounts.deploymentOwner(id)),
    })
  : null;
const engine = new CompositeEngine(paperEngine, liveEngine, solanaEngine);

// $WEFT holder discount on Weft's fees (inactive until WEFT_TOKEN_MINT and WEFT_HOLDER_MIN are set).
// Holdings are read on-chain from wallets Privy says belong to the user.
const holderCfg = holderConfigFromEnv();
const privyUsers = process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET ? new PrivyClient({ appId: process.env.PRIVY_APP_ID, appSecret: process.env.PRIVY_APP_SECRET }) : null;
const holders = new HolderDiscount(holderCfg, {
  conn: new Connection(solCfg.rpcUrl, "confirmed"),
  wallets: async (userId) => {
    const out = [accounts.solanaAccount(userId)?.address].filter((x): x is string => Boolean(x));
    if (privyUsers) {
      const u = (await privyUsers.users()._get(userId).catch(() => null)) as { linked_accounts?: { type?: string; chain_type?: string; address?: string }[] } | null;
      for (const a of u?.linked_accounts ?? []) if (a.type === "wallet" && a.chain_type === "solana" && a.address) out.push(a.address);
    }
    return out;
  },
});
// Hourly snapshots of every database in the data directory (24 hourly + 14 daily kept), and a copy
// of each in Cloudflare R2 when R2_* is set (latest + 30 daily), so a lost disk loses nothing.
const r2Cfg = r2ConfigFromEnv();
const r2 = r2Cfg ? new R2(r2Cfg) : null;
const backups =
  process.env.WEFT_BACKUPS === "0"
    ? null
    : new Backups({
        dataDir: DATA_DIR,
        log: (m) => console.log(`  ${m}`),
        offsite: r2 ? (folder, files, now, firstOfDay) => uploadSnapshot(r2, folder, files, now, 30, firstOfDay) : undefined,
      });
backups?.start();

// Solana positions follow the wallet: tokens moved or sold by hand are booked out (every 2 minutes).
const solanaReconciler = solanaEngine ? new SolanaReconciler(solanaEngine, accounts, connectionBalances(new Connection(solCfg.rpcUrl, "confirmed"))) : null;
nativeStops?.start();
const solanaReconcileTimer = solanaReconciler
  ? setInterval(() => void solanaReconciler.run().catch((e) => console.warn("solana reconcile failed:", (e as Error).message)), 120_000)
  : null;
solanaReconcileTimer?.unref();
if (live) live.holders = holders;
if (solana) solana.holders = holders;
const library = new StrategyLibrary(join(DATA_DIR, "library.db"));
// The provider the router actually uses for each kind (the first one registered), so a live feed
// listed ahead of a simulated fallback counts as live.
const signalModes = Object.fromEntries([...new Set(venues.signalProviders.flatMap((p) => p.kinds))].map((k) => [k, venues.signals.modeOf(k)!] as const));

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
  // Practice runs say so in every message, so pretend trades are never mistaken for real ones.
  strategyName: async (id) => {
    const d = (await engine.getSnapshot(id))?.deployment;
    return d ? `${d.mode === "paper" && !d.alertsOnly ? "Practice · " : ""}${d.strategy.name}` : id;
  },
  log: (m) => console.warn(m),
});
const auth = createAuthenticator({ appId: process.env.PRIVY_APP_ID, verificationKey: process.env.PRIVY_VERIFICATION_KEY });
// Second-level charts: record trades for the busiest Hyperliquid markets (refreshed hourly).
const tape = process.env.WEFT_TAPE === "0" ? null : new TradeTape({ log: (m) => console.log(`  ${m}`) });
async function busiestCoins(): Promise<string[]> {
  const [perps, stocks] = await Promise.all([venues.catalog.list("perps", { limit: 15 }), venues.catalog.list("stocks", { limit: 8 })]);
  const coins = await Promise.all([...perps, ...stocks].map((r) => venues.history.liveCoin(r.instrument).catch(() => null)));
  return coins.filter((c): c is string => Boolean(c));
}
if (tape) {
  tape.start([]);
  const warm = () => busiestCoins().then((c) => tape.setWarm(c)).catch((e) => console.warn("tape: couldn't list markets:", (e as Error).message));
  void warm();
  setInterval(warm, 3_600_000).unref();
}

// Weft trades with real money only on the hosted service; paper runs stay for local development.
const allowPaper = process.env.WEFT_ALLOW_PAPER === "1" || !auth.enabled;
// Practice: pretend money at real prices, on the paper engine (WEFT_PRACTICE_BUDGET per user, 0 turns it off).
const practiceBudgetUsd = Number(process.env.WEFT_PRACTICE_BUDGET ?? 10_000);

// Watched Solana wallets (wallet signals and copy leaders of running strategies) are pushed to us by
// Helius the moment they trade; each push checks the strategies that watch that wallet right away.
const publicUrl = process.env.PUBLIC_API_URL ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
const watchersOf = new Map<string, Set<string>>();
const lastPoke = new Map<string, number>();
const heliusWebhook =
  venues.ctx.helius && process.env.HELIUS_API_KEY && publicUrl
    ? new HeliusWebhook({
        apiKey: process.env.HELIUS_API_KEY,
        publicUrl,
        wallets: venues.ctx.helius,
        kvGet: (k) => accounts.kvGet(k),
        kvSet: (k, v) => accounts.kvSet(k, v),
        log: (m) => console.log(`  ${m}`),
        onActivity: (addresses) => {
          const now = Date.now();
          for (const a of addresses)
            for (const id of watchersOf.get(a) ?? []) {
              // At most one extra check every 3 s per strategy, however busy the wallet.
              if (now - (lastPoke.get(id) ?? 0) < 3_000) continue;
              lastPoke.set(id, now);
              engine.tick(id).catch((e) => console.warn(`webhook tick ${id}: ${(e as Error).message}`));
            }
        },
      })
    : null;
async function syncWatchedWallets() {
  if (!heliusWebhook) return;
  watchersOf.clear();
  for (const d of await engine.listDeployments()) {
    if (d.status !== "running") continue;
    const add = (a: string) => watchersOf.set(a, (watchersOf.get(a) ?? new Set()).add(d.id));
    for (const sig of d.strategy.signals) if (sig.kind === "wallet") add(sig.params.address);
    for (const a of d.strategy.actions) if (a.type === "copy" && a.leader.venue === "solana") add(a.leader.wallet);
  }
  await heliusWebhook.sync([...watchersOf.keys()]);
}
if (heliusWebhook) {
  setTimeout(() => syncWatchedWallets().catch((e) => console.warn(`helius webhook: ${(e as Error).message}`)), 5_000);
  setInterval(() => syncWatchedWallets().catch((e) => console.warn(`helius webhook: ${(e as Error).message}`)), 60_000).unref();
}

// $WEFT rewards. Every live fill's Weft fee goes into the ledger from now on (with the user and the
// creator of the strategy); days earn rewards from WEFT_REWARDS_START (UTC date, set at launch).
const rewards = new Rewards(join(DATA_DIR, "rewards.db"), { startDay: process.env.WEFT_REWARDS_START || null });
engine.subscribe((e) => {
  if (e.type !== "fill") return;
  const fill = e.data?.fill as Fill | undefined;
  if (!fill?.builderFeeUsd) return;
  const userId = accounts.deploymentOwner(e.deploymentId);
  if (!userId) return;
  void engine.getSnapshot(e.deploymentId).then((s) => {
    if (s?.deployment.mode !== "live") return;
    rewards.record({ id: fill.id, ts: fill.ts, userId, deploymentId: e.deploymentId, creatorId: accounts.deploymentCreator(e.deploymentId), instrumentKey: fill.instrumentKey, feeUsd: fill.builderFeeUsd! });
  });
});
// The treasury (WEFT_TREASURY_KEY, a wallet of its own) claims the fees on $WEFT trades, splits
// them 2% to the fee wallet / 0.4% to buybacks, buys and burns, and pays claims: off until the token
// exists and its key is set.
const treasury = (() => {
  if (!holderCfg.mint || !process.env.WEFT_TREASURY_KEY) return null;
  try {
    const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.WEFT_TREASURY_KEY)));
    const key = process.env.JUPITER_API_KEY;
    const revenue = process.env.WEFT_REVENUE_WALLET ? new PublicKey(process.env.WEFT_REVENUE_WALLET) : solCfg.feeWallet;
    if (!revenue) throw new Error("WEFT_REVENUE_WALLET (or WEFT_SOL_FEE_WALLET) is required");
    return new Treasury({
      conn: new Connection(solCfg.rpcUrl, "confirmed"),
      keypair,
      mint: holderCfg.mint,
      decimals: Number(process.env.WEFT_TOKEN_DECIMALS ?? 6),
      dbcPool: process.env.WEFT_DBC_POOL ? new PublicKey(process.env.WEFT_DBC_POOL) : null,
      revenueWallet: revenue,
      jupiter: new JupiterSwapBuilder(key ? { apiKey: key, baseUrl: "https://api.jup.ag/swap/v1" } : {}),
      log: (m) => console.log(`  ${m}`),
    });
  } catch (e) {
    console.log(`  treasury: FAILED to load (${(e as Error).message.slice(0, 120)})`);
    return null;
  }
})();
// About every ten minutes (8 to 12, so the timing can't be predicted): close any ended day, then
// claim, split, buy and burn. Never two runs at once.
let rewardsRunning = false;
const runRewards = async () => {
  if (rewardsRunning) return;
  rewardsRunning = true;
  try {
    // WEFT_REWARDS_HOLD=1: no day is closed or shared out; buys keep filling the pots until it's lifted.
    if (process.env.WEFT_REWARDS_HOLD !== "1")
      for (const day of rewards.pendingDays()) await rewards.closeDay(day, async (u) => REWARDS.boost[(await holders.status(u)).tier]);
    if (treasury) {
      const r = await treasury.tick(rewards);
      if (r.claimedSol || r.boughtTokens) console.log(`  treasury: claimed ${r.claimedSol.toFixed(4)} SOL (${r.protocolSol.toFixed(4)} to Weft), bought ${r.boughtTokens.toFixed(0)} WEFT for $${r.spentUsd.toFixed(2)}, burned ${r.burnedTokens.toFixed(0)}`);
    }
  } finally {
    rewardsRunning = false;
  }
};
let rewardsTimer: NodeJS.Timeout | null = null;
const scheduleRewards = (ms: number) => {
  rewardsTimer = setTimeout(() => {
    void runRewards()
      .catch((e) => console.warn("rewards failed:", (e as Error).message.slice(0, 300)))
      .finally(() => scheduleRewards(8 * 60_000 + Math.random() * 4 * 60_000));
  }, ms);
  rewardsTimer.unref();
};
scheduleRewards(30_000);
console.log(`  rewards: ${rewards.enabled ? `from ${rewards.startDay}` : "ledger only (WEFT_REWARDS_START not set)"} · treasury ${treasury ? treasury.address.toBase58().slice(0, 8) + "…" : "off"}`);

const app = createApp({
  holders,
  rewards,
  treasury: treasury ?? undefined,
  heliusWebhook: heliusWebhook ?? undefined,
  topTraders: createTopTraders(),
  allowPaper,
  practiceBudgetUsd,
  tape: tape ?? undefined,
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
  solana: solana ?? undefined,
  deposits: deposits ?? undefined,
  solanaWithdrawals: solana ? new SolanaWithdrawals(new Connection(solCfg.rpcUrl, "confirmed")) : undefined,
  isAdmin: (userId) => Boolean(solana?.isTester(userId)),
  earnings: () =>
    earnings({
      engine,
      hlBaseUrl: live ? hlBaseUrl(liveCfg.network) : null,
      builder: liveCfg.builder?.address ?? null,
      solana: solCfg.feeWallet ? { conn: new Connection(solCfg.rpcUrl, "confirmed"), feeWallet: solCfg.feeWallet } : null,
      token: holderCfg.mint
        ? { mint: holderCfg.mint, initialSupply: Number(process.env.WEFT_TOKEN_INITIAL_SUPPLY ?? 1_000_000_000), conn: new Connection(solCfg.rpcUrl, "confirmed") }
        : null,
      // Buybacks run every ten minutes or so: shown per day.
      buybackLog: () => rewards.stats().days.map((d) => ({ at: Date.parse(`${d.day}T00:00:00Z`), tx: "", spentUsd: d.spent, boughtTokens: d.bought, burnedTokens: d.burned })),
      tokenFees: holderCfg.mint ? () => rewards.stats().tokenFees : null,
      treasury: treasury?.address ?? null,
    }),
  onExitsChanged: () => nativeStops?.poke(500),
  telegram: telegram ?? undefined,
  webOrigins: process.env.WEB_ORIGINS ? process.env.WEB_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean) : undefined,
  liveMaxTotalUsd: process.env.WEFT_LIVE_MAX_TOTAL_USD ? Number(process.env.WEFT_LIVE_MAX_TOTAL_USD) : undefined,
  backtest: { history: venues.history, tokenFacts: venues.tokenFacts, calendar: calendarFields },
});
engine.start();

// Live runs: blocked and failed orders go to the server log too (run id prefix and reason only), so
// problems with real money can be diagnosed without reading anyone's private activity.
engine.subscribe((e) => {
  if (e.type !== "rejected" && e.type !== "error") return;
  void engine.getSnapshot(e.deploymentId).then((s) => {
    if (s?.deployment.mode === "live") console.warn(`[live ${e.deploymentId.slice(0, 8)}] ${e.type}: ${e.message.slice(0, 400)}`);
  });
});

// Create (or load) Weft's Solana signer and policy now, so a setup problem shows up in the logs.
if (solana && solCfg.authorizationKey) {
  void solana
    .signer()
    .then(async (ids) => {
      const fees = Object.keys(await solana.feeAccounts().catch(() => ({}))).length;
      const t = await solana.resolveTesters();
      console.log(`  solana signer: ready (${ids.signerId.slice(0, 8)}…) · fee accounts ${fees}/2 · testers ${t.resolved}${t.missing.length ? ` (not found: ${t.missing.join(", ")})` : ""}`);
    })
    .catch((e) => console.log(`  solana signer: FAILED · ${(e as Error).message.slice(0, 300)}`));
}

// Where this server's orders appear to come from (Polymarket rejects orders from blocked regions).
void fetch("https://polymarket.com/api/geoblock", { signal: AbortSignal.timeout(8_000) })
  .then((r) => r.json() as Promise<{ blocked?: boolean; country?: string; region?: string }>)
  .then((g) => console.log(`  egress: ${g.country ?? "?"}${g.region ? `/${g.region}` : ""} · Polymarket ${g.blocked ? "BLOCKED" : "allowed"}`))
  .catch(() => console.log("  egress: unknown (geoblock check failed)"));

// Without practice, simulated runs don't belong on the hosted service: stop any left over (their
// history stays readable). Alerts-only runs never trade and keep running.
if (!allowPaper && !(practiceBudgetUsd > 0)) {
  void (async () => {
    for (const d of await engine.listDeployments()) {
      if (d.mode !== "paper" || d.alertsOnly || (d.status !== "running" && d.status !== "paused")) continue;
      await engine.kill(d.id).catch(() => {});
      await engine.note?.(d.id, "notify", "Paper trading has ended. Weft now trades with real money only; start this strategy live to keep going.").catch(() => {});
    }
  })();
}

// Every minute, check live runs against what Hyperliquid actually holds.
const reconciler = liveEngine && liveCfg.enabled ? new Reconciler(liveEngine, accounts, liveCfg) : null;
const reconcileTimer = reconciler ? setInterval(() => void reconciler.run().catch((e) => console.warn("reconcile failed:", (e as Error).message)), 60_000) : null;
reconcileTimer?.unref();

// Never serve publicly without sign-in: in local mode every request acts as one shared user.
const publicBind = process.env.HOST && !/^(127\.0\.0\.1|localhost|::1)$/.test(process.env.HOST);
if (!auth.enabled && (process.env.NODE_ENV === "production" || publicBind)) {
  console.error("Refusing to start: sign-in is off (PRIVY_APP_ID missing) and this is a public server. Set PRIVY_APP_ID, or run locally.");
  process.exit(1);
}
const HOST = process.env.HOST ?? (auth.enabled ? "0.0.0.0" : "127.0.0.1");

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`weft api listening on http://localhost:${info.port}`);
  console.log(`  data: ${DATA_DIR}`);
  console.log(`  alerts: ${[telegram ? "Telegram per user" : null, ...notifier.sinks].filter(Boolean).join(", ") || "off (set TELEGRAM_BOT_TOKEN for per-user Telegram alerts)"}`);
  console.log(`  auth: ${auth.enabled ? `Privy (${auth.appId})` : "local mode (set PRIVY_APP_ID to require sign-in)"}`);
  console.log(
    `  live: ${live ? `${liveCfg.enabled ? "ON" : "off (WEFT_LIVE_ENABLED=1 to enable)"} · ${liveCfg.network} · agents ${agents ? "Privy" : "need PRIVY_APP_SECRET"} · cap ${liveCfg.maxAllocationUsd != null ? `$${liveCfg.maxAllocationUsd}` : "none"} · builder ${liveCfg.builder?.address ?? "none"}` : "unavailable (needs PRIVY_APP_ID)"}`
  );
  console.log(`  backups: ${process.env.WEFT_BACKUPS === "0" ? "off" : `hourly on the volume${r2Cfg ? ` + Cloudflare R2 (${r2Cfg.bucket})` : " (set R2_* for an off-site copy)"}`}`);
  console.log(`  deposits: ${deposits?.relayerAddress ? `gas-free via relayer ${deposits.relayerAddress}` : "user pays gas (set WEFT_RELAYER_KEY for gas-free deposits)"}`);
  if (deposits?.relayerAddress)
    void deposits.relayerEth().then((eth) => eth != null && eth < 0.0005 && console.warn(`  deposits: relayer has only ${eth.toFixed(5)} ETH on Arbitrum ${liveCfg.network === "mainnet" ? "One" : "Sepolia"}; top it up`)).catch(() => {});
  console.log(
    `  solana: ${solana ? `${solCfg.enabled ? "ON" : "off (WEFT_SOL_LIVE=1 to enable)"} · signer ${solCfg.authorizationKey ? "set" : "needs PRIVY_AUTHORIZATION_KEY"} · fee ${solCfg.feeWallet ? `${solCfg.platformFeeBps} bps` : "none (WEFT_SOL_FEE_WALLET)"} · rpc ${new URL(solCfg.rpcUrl).host} · cap ${solCfg.maxAllocationUsd != null ? `$${solCfg.maxAllocationUsd}` : "none"} · jupiter ${solCfg.jupiterApiKey ? "api key" : "free tier (JUPITER_API_KEY)"}` : "unavailable (needs Privy)"}`
  );
  console.log(`  fees: Hyperliquid ${(liveCfg.builder?.feeTenthsBps ?? 100) / 10} bps · Solana ${solCfg.platformFeeBps} bps · $WEFT tiers ${holders.enabled ? `Holder ${holderCfg.discount * 100}% off from ${holderCfg.minAmount}, Whale ${holderCfg.bigDiscount * 100}% off from ${holderCfg.bigAmount}` : "off (WEFT_TOKEN_MINT)"}`);
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
    tape?.stop();
    if (reconcileTimer) clearInterval(reconcileTimer);
    if (solanaReconcileTimer) clearInterval(solanaReconcileTimer);
    if (rewardsTimer) clearTimeout(rewardsTimer);
    nativeStops?.stop();
    backups?.stop();
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
