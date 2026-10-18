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
import { DEFAULT_X_PREFS, XBot, type XPrefs } from "./social/xbot.ts";
import { fomoLookup } from "./lib/fomo.ts";
import { claudeTradeIntent } from "./ai/trade-intent.ts";
import { setTraderLookup } from "./ai/generate.ts";
import { FastExits } from "./live/fast-exits.ts";
import { RiftFunding } from "./live/rift.ts";
import { PapertradeAccounts } from "./live/papertrade.ts";
import { PapertradeExecutor, type Executor } from "@weft/execution";
import { generateStrategy } from "./ai/generate.ts";
import { randomBytes } from "node:crypto";
import { claudePostMatcher } from "./ai/post-matcher.ts";
import { HeliusWebhook } from "./live/helius-webhook.ts";
import { createTopTraders } from "./lib/traders.ts";

/** Weft's dev buy at launch, burned in full in the creating transaction (on-chain, 2026-10-17). */
const WEFT_LAUNCH_BURN = {
  mint: "HqmFi85adLD8BQA7en1HfajdAfzVFps5REgQaYuw6Ax8",
  at: Date.parse("2026-10-17T17:58:17Z"),
  tx: "3LyNget6sM9cCDnLq7HZ5oLaDYFcjz9jS3kHskJkSEaVfMYUDppZ65zJmZRtMQ3GuP4VZDP1zo18VfC6xVbYTAmK",
  tokens: 35_308_838.390007,
};

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
// Papertrade (synthetic BTC/ETH perps on HyperEVM) runs in the Hyperliquid live engine: same wallet.
// Accounts (session keys, registration, deposit address) exist whenever Privy is configured; orders
// only go out with WEFT_PAPERTRADE_LIVE=1.
const papertrade =
  process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET
    ? new PapertradeAccounts({
        appId: process.env.PRIVY_APP_ID,
        appSecret: process.env.PRIVY_APP_SECRET,
        accounts,
        // Weft's 1% deposit fee lands on Weft's own Hyperliquid address (the builder's, unless set).
        feeAddress: process.env.WEFT_PAPERTRADE_FEE_ADDRESS ?? liveCfg.builder?.address ?? null,
        // $WEFT holders pay less, as on every other Weft fee (called later: holders is set up below).
        feeMultiplier: async (userId) => (await holders.status(userId).catch(() => null))?.feeMultiplier ?? 1,
      })
    : null;
const papertradeLive = Boolean(papertrade) && process.env.WEFT_PAPERTRADE_LIVE === "1";
const papertradeExec = papertrade
  ? new PapertradeExecutor({
      account: async (deploymentId) => {
        const owner = accounts.deploymentOwner(deploymentId);
        return owner ? papertrade.account(owner) : null;
      },
      sentStore: { get: (k) => accounts.kvGet(`pt_sent:${k}`) || null, set: (k, v) => accounts.kvSet(`pt_sent:${k}`, v) },
      log: (m) => console.log(`  ${m}`),
    })
  : null;
const liveExecutor: Executor | null = liveRouter
  ? {
      mode: "live",
      execute: (req, now) =>
        req.instrument.kind !== "synth"
          ? liveRouter.execute(req, now)
          : papertradeLive && papertradeExec
            ? papertradeExec.execute(req)
            : Promise.resolve({ status: "rejected", reason: "Papertrade live trading is switched off" }),
    }
  : null;
const liveEngine = live
  ? createEngine({
      // One store per network: testnet runs can never wake up on mainnet.
      store: new SqliteStore(join(DATA_DIR, `engine-live-${liveCfg.network}.db`)),
      marketData: venues.marketData,
      signalProviders: venues.signalProviders,
      tokenFacts: venues.tokenFacts,
      copy: venues.copyFeeds,
      executor: liveExecutor!,
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
// Stops and targets on Papertrade (and practice perps) react to Hyperliquid's streamed prices at
// once, not only at the next tick. Off with WEFT_FAST_EXITS=0.
if (process.env.WEFT_FAST_EXITS !== "0") {
  const fast = new FastExits({
    engine,
    listRuns: async () => (await engine.listDeployments()).filter((d) => d.status === "running" || d.status === "paused").map((d) => ({ id: d.id, mode: d.mode, status: d.status })),
    log: (m) => console.warn(m),
  });
  fast.start();
  console.log("  fast exits: watching Hyperliquid best bid/offer");
}
// Live liquidity (WEFT_SOL_LP=1): make sure Weft's Solana signer may sign Meteora DLMM transactions.
if (solana && solCfg.lpEnabled)
  void solana
    .ensureLpPolicy()
    .then((m) => console.log(`  liquidity: ${m}`))
    .catch((e) => console.warn(`  liquidity: couldn't update the signing policy: ${(e as Error).message.slice(0, 200)}`));

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

// Fomo traders by username (fomoapi.io): the AI can copy or fade "frank on Fomo". Off without FOMOAPI_KEY.
if (process.env.FOMOAPI_KEY) {
  const lookup = fomoLookup({ key: process.env.FOMOAPI_KEY, kvGet: (k) => accounts.kvGet(k), kvSet: (k, v) => accounts.kvSet(k, v) });
  setTraderLookup(async (handle) => {
    const t = await lookup(handle);
    if (!t) return null;
    // What they hold on Hyperliquid now, so the plan (and the person reading it) can see it's them.
    const st = t.evm
      ? ((await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "clearinghouseState", user: t.evm }), signal: AbortSignal.timeout(10_000) })
          .then((r) => r.json())
          .catch(() => null)) as { assetPositions?: { position: { coin: string; szi: string; leverage?: { value?: number } } }[] } | null)
      : null;
    return {
      handle: t.handle, displayName: t.displayName, followers: t.followers, verified: t.verified, hyperliquid: t.evm, solana: t.solana,
      hyperliquidPositions: (st?.assetPositions ?? []).map((p) => ({ coin: p.position.coin, side: Number(p.position.szi) >= 0 ? ("long" as const) : ("short" as const), leverage: p.position.leverage?.value ?? 1 })),
    };
  });
  console.log("  fomo: trader lookup on");
}

// In-process requests as a user (the X bot starting a run through the same route as the Start button).
const INTERNAL_KEY = randomBytes(32).toString("hex");

// The X reply bot (@weftfinance): off unless WEFT_XBOT is "dry" (logs replies) or "live" (posts them).
const xbotMode = process.env.WEFT_XBOT === "live" || process.env.WEFT_XBOT === "dry" ? process.env.WEFT_XBOT : null;
if (xbotMode && process.env.TWITTERAPI_IO_KEY) {
  const xKeys = process.env.X_API_KEY && process.env.X_API_SECRET && process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_SECRET
    ? { apiKey: process.env.X_API_KEY, apiSecret: process.env.X_API_SECRET, accessToken: process.env.X_ACCESS_TOKEN, accessSecret: process.env.X_ACCESS_SECRET }
    : undefined;
  const mode = xbotMode === "live" && xKeys ? "live" : "dry";
  const bot = new XBot({
    mode,
    handle: process.env.WEFT_X_HANDLE ?? "weftfinance",
    twitterApiKey: process.env.TWITTERAPI_IO_KEY,
    site: (process.env.WEFT_SITE_URL ?? "https://weft.fi").replace(/\/$/, ""),
    x: xKeys,
    maxPerDay: Number(process.env.WEFT_XBOT_MAX_PER_DAY ?? 15),
    perAuthorPerDay: Number(process.env.WEFT_XBOT_PER_AUTHOR ?? 2),
    perLinkedPerDay: Number(process.env.WEFT_XBOT_PER_LINKED ?? 10),
    minFollowers: Number(process.env.WEFT_XBOT_MIN_FOLLOWERS ?? 10),
    // Only real AI drafts get posted: the template fallback isn't good enough to answer someone with.
    draft: async (thesis) => {
      const r = await generateStrategy(thesis, { catalog: venues.catalog });
      return r.source === "template" ? null : { strategy: r.strategy, rationale: r.rationale };
    },
    saveDraft: (d) => {
      const id = randomBytes(8).toString("hex").slice(0, 12);
      accounts.kvSet(`draft:${id}`, JSON.stringify({ id, ...d }));
      return id;
    },
    // Tweet a trade: someone who connected X in Settings gets what they chose there.
    linked: (xId) => {
      const userId = accounts.kvGet(`x:link:${xId}`);
      if (!userId) return null;
      const raw = accounts.kvGet(`x:prefs:${userId}`);
      return { userId, prefs: raw ? { ...DEFAULT_X_PREFS, ...(JSON.parse(raw) as Partial<XPrefs>) } : DEFAULT_X_PREFS };
    },
    start: async (userId, strategy, mode, allocationUsd) => {
      const r = await app.request("/deployments", {
        method: "POST",
        headers: { "content-type": "application/json", "x-weft-internal": INTERNAL_KEY, "x-weft-as": userId },
        body: JSON.stringify({ strategy, mode, allocationUsd, ...(mode === "live" ? { confirm: "GO LIVE" } : {}) }),
      });
      const body = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!r.ok || !body.id) throw new Error(body.error ?? `HTTP ${r.status}`);
      return { id: body.id };
    },
    tell: async (userId, text) => {
      await telegram?.sendToUser(userId, text);
    },
    isTradeIdea: claudeTradeIntent(),
    kvGet: (k) => accounts.kvGet(k),
    kvSet: (k, v) => accounts.kvSet(k, v),
    log: (m) => console.log(`  ${m}`),
  });
  // Every 10 seconds: a tweet gets its answer in well under a minute (most of that is the AI drafting).
  setInterval(() => void bot.run().catch((e) => console.warn(`xbot: ${(e as Error).message.slice(0, 200)}`)), Number(process.env.WEFT_XBOT_POLL_SEC ?? 10) * 1000).unref();
  console.log(`  x bot: ${mode}${xbotMode === "live" && !xKeys ? " (X_API_* keys missing, so nothing is posted)" : ""}`);
}

// Papertrade busts happen on chain: book any live Papertrade position that has settled there
// (closing it through the executor finds the settlement and sends nothing).
if (liveEngine && papertradeLive)
  setInterval(async () => {
    try {
      for (const d of await liveEngine.listDeployments()) {
        if (d.status !== "running" && d.status !== "paused") continue;
        const snap = await liveEngine.getSnapshot(d.id);
        const synth = (snap?.positions ?? []).filter((p) => p.instrument.kind === "synth" && p.venueId);
        if (!synth.length || !papertradeExec) continue;
        // Only positions Papertrade has already settled: closing those books the settlement and sends nothing.
        const settled = await papertradeExec.settledIds(d.id);
        for (const p of synth) if (settled.has(p.venueId!)) await liveEngine.closePosition?.(d.id, p.id, 1).catch(() => false);
      }
    } catch (e) {
      console.warn(`papertrade reconcile: ${(e as Error).message.slice(0, 160)}`);
    }
  }, 5 * 60_000).unref();

const app = createApp({
  holders,
  rewards,
  treasury: treasury ?? undefined,
  heliusWebhook: heliusWebhook ?? undefined,
  topTraders: createTopTraders(),
  papertrade: papertrade ?? undefined,
  papertradeLive,
  rift: new RiftFunding({ accounts, apiKey: process.env.RIFT_API_KEY ?? null }),
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
      // Every buyback with its swap and burn (the page groups them by day).
      buybackLog: () => rewards.buyList().map((x) => ({ at: x.at, source: x.source, tx: x.swapTx ?? "", spentUsd: x.spentUsd, boughtTokens: x.boughtTokens, burnTx: x.burnTx, burnedTokens: x.burnedTokens })),
      tokenFees: holderCfg.mint ? () => rewards.stats().tokenFees : null,
      treasury: treasury?.address ?? null,
      owedBuybackSol: () => Number(rewards.owedTokenBuyback()) / 1e9,
      launchBurn: holderCfg.mint?.toBase58() === WEFT_LAUNCH_BURN.mint ? WEFT_LAUNCH_BURN : null,
    }),
  onExitsChanged: () => nativeStops?.poke(500),
  telegram: telegram ?? undefined,
  webOrigins: process.env.WEB_ORIGINS ? process.env.WEB_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean) : undefined,
  liveMaxTotalUsd: process.env.WEFT_LIVE_MAX_TOTAL_USD ? Number(process.env.WEFT_LIVE_MAX_TOTAL_USD) : undefined,
  internalKey: INTERNAL_KEY,
  // The X account the user linked with Privy (Settings → Tweet a trade), read from Privy, not the browser.
  xAccountOf: privyUsers && xbotMode && process.env.TWITTERAPI_IO_KEY
    ? async (userId) => {
        const u = (await privyUsers.users()._get(userId)) as { linked_accounts?: { type?: string; subject?: string; username?: string | null }[] };
        const x = u.linked_accounts?.find((a) => a.type === "twitter_oauth" && a.subject);
        return x ? { id: String(x.subject), username: String(x.username ?? "") } : null;
      }
    : undefined,
  backtest: { history: venues.history, tokenFacts: venues.tokenFacts, calendar: calendarFields },
});
engine.start();

// Usage at a glance, in the log (counts only, nobody's name or money): at boot and hourly.
async function logUsage() {
  const runs = await engine.listDeployments();
  const day = Date.now() - 86_400_000, week = Date.now() - 7 * 86_400_000;
  const kind = (d: (typeof runs)[number]) => (d.mode === "live" ? "live" : d.alertsOnly ? "alerts" : "practice");
  const venue = (d: (typeof runs)[number]) => {
    const o = d.strategy.actions.find((a) => a.type === "open" || a.type === "liquidity") as { type: string; instrument?: { kind: string } } | undefined;
    return o?.type === "liquidity" ? "lp" : o?.instrument?.kind === "synth" ? "papertrade" : o?.instrument?.kind === "token" ? "solana" : o?.instrument ? "hyperliquid" : "none";
  };
  const tally = (list: typeof runs, f: (d: (typeof runs)[number]) => string) => Object.entries(list.reduce<Record<string, number>>((m, d) => ((m[f(d)] = (m[f(d)] ?? 0) + 1), m), {})).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  const active = runs.filter((d) => d.status === "running" || d.status === "paused");
  const owners = new Set(runs.map((d) => accounts.deploymentOwner(d.id)).filter(Boolean));
  const liveOwners = new Set(active.filter((d) => d.mode === "live").map((d) => accounts.deploymentOwner(d.id)).filter(Boolean));
  let fills = 0, liveFills = 0;
  for (const d of runs) {
    const n = (await engine.getFills(d.id).catch(() => [])).length;
    fills += n;
    if (d.mode === "live") liveFills += n;
  }
  console.log(
    `usage: ${runs.length} runs by ${owners.size} people (${tally(runs, kind)}); active now ${active.length} (${tally(active, kind)}; venues ${tally(active, venue)}), live by ${liveOwners.size} people, $${Math.round(active.filter((d) => d.mode === "live").reduce((n, d) => n + d.allocationUsd, 0))} live; ` +
      `started last 24h ${runs.filter((d) => d.createdAt > day).length}, last 7d ${runs.filter((d) => d.createdAt > week).length}; fills ${fills} (live ${liveFills})`,
  );
}
// Where people stop on the way to trading live: counts only. Balances are read from the chains.
async function logFunnel() {
  const f = accounts.funnel();
  const runs = await engine.listDeployments();
  const who = (pred: (d: (typeof runs)[number]) => boolean) => new Set(runs.filter(pred).map((d) => accounts.deploymentOwner(d.id)).filter(Boolean)).size;
  const hlFunded = (
    await Promise.all(
      f.hlAddresses.map(async (a) => {
        const post = async (body: unknown) => (await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })).json();
        const [perp, spot] = await Promise.all([post({ type: "clearinghouseState", user: a }).catch(() => null), post({ type: "spotClearinghouseState", user: a }).catch(() => null)]);
        const usdc = Number((spot as { balances?: { coin: string; total: string }[] } | null)?.balances?.find((b) => b.coin === "USDC")?.total ?? 0);
        return Number((perp as { marginSummary?: { accountValue?: string } } | null)?.marginSummary?.accountValue ?? 0) + usdc >= 1;
      }),
    )
  ).filter(Boolean).length;
  const conn = new Connection(solCfg.rpcUrl, "confirmed");
  const solFunded = (await Promise.all(f.solAddresses.map(async (a) => (await conn.getBalance(new PublicKey(a)).catch(() => 0)) >= 0.01e9))).filter(Boolean).length;
  console.log(
    `funnel: ${f.visitorsDrafted} visitors drafted without an account · ${f.users} signed up (${f.seen7d} seen in 7d) → ${f.drafted} drafted with AI → ${who(() => true)} started a run (${who((d) => d.mode === "paper" && !d.alertsOnly)} practice) → ` +
      `Hyperliquid linked ${f.hlLinked}, approved ${f.hlApproved}, funded ${hlFunded} · Solana wallet ${f.solWallets}, funded ${solFunded} → ${who((d) => d.mode === "live")} ever live, ${who((d) => d.mode === "live" && (d.status === "running" || d.status === "paused"))} live now`,
  );
}
setTimeout(() => void logUsage().catch((e) => console.warn(`usage: ${(e as Error).message}`)), 20_000).unref();
setTimeout(() => void logFunnel().catch((e) => console.warn(`funnel: ${(e as Error).message}`)), 25_000).unref();
setInterval(() => void logFunnel().catch(() => {}), 3_600_000).unref();
setInterval(() => void logUsage().catch(() => {}), 3_600_000).unref();

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
