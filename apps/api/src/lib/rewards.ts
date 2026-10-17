import { DatabaseSync } from "node:sqlite";

/**
 * $WEFT rewards (decided 2026-10-17). $WEFT is bought in small slices about every ten minutes, never
 * in one daily lump that could be front-run:
 *  - fees from trading $WEFT itself: each claim is split on the spot, 2.0/2.4 to Weft's revenue
 *    wallet and 0.4/2.4 buys $WEFT right away;
 *  - half of the fees Weft earns from strategies: each day's amount is bought over the next day.
 * Of every buy, 30% is burned in the same run, 50% goes to the day's traders' pot and 20% to the
 * day's creators' pot. After midnight UTC the day closes and the pots are shared out: traders by the
 * fees they paid that day × their holder boost, creators by the fees other people's runs of their
 * strategies paid. Shares follow fees, not volume, so trading for the reward alone never pays.
 */
export const REWARDS = {
  /** Of Weft's fees from strategies: what buys $WEFT. */
  buybackShare: 0.5,
  /** Of every $WEFT bought. */
  traderShare: 0.5,
  creatorShare: 0.2,
  burnShare: 0.3,
  /** Reward multiplier by holder tier (none, holder, big holder). */
  boost: [1, 1.5, 2] as const,
  /** Fees from trading $WEFT (bps of volume): Weft's part of each claim, and the buyback part. */
  tokenFee: { protocolBps: 200, buybackBps: 40 },
  /** Runs per day the strategy-fee budget is spread over (about every ten minutes). */
  slicesPerDay: 144,
} as const;

export const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const nextDay = (day: string) => dayOf(Date.parse(`${day}T00:00:00Z`) + 86_400_000);

export interface FeeEntry {
  /** The fill's id: recording the same fill twice is a no-op. */
  id: string;
  ts: number;
  userId: string;
  deploymentId: string;
  creatorId: string | null;
  instrumentKey: string;
  feeUsd: number;
}

export type RewardKind = "trade" | "create";

export interface RewardRow {
  day: string;
  kind: RewardKind;
  /** Fees this share is based on: what the user paid (trade) or what runs of their strategies paid (create). */
  basisUsd: number;
  share: number;
  tokens: number;
  claimedAt: number | null;
  claimTx: string | null;
}

export interface RewardDay {
  day: string;
  closedAt: number;
  feesUsd: number;
  traders: number;
  creators: number;
  traderTokens: number;
  creatorTokens: number;
}

export interface Buy {
  at: number;
  /** "token": from fees on $WEFT trades; "fees": from Weft's strategy fees. */
  source: "token" | "fees";
  spentUsd: number;
  boughtTokens: number;
  burnedTokens: number;
  swapTx: string | null;
  burnTx: string | null;
}

export class Rewards {
  private db: DatabaseSync;
  /** First day that earns rewards (UTC, YYYY-MM-DD); null = off, fees are still recorded. */
  readonly startDay: string | null;

  constructor(path: string, opts: { startDay?: string | null } = {}) {
    this.startDay = opts.startDay && /^\d{4}-\d{2}-\d{2}$/.test(opts.startDay) ? opts.startDay : null;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS fee_ledger (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        day TEXT NOT NULL,
        user_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        creator_id TEXT,
        instrument_key TEXT NOT NULL,
        fee_usd REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fee_ledger_day ON fee_ledger (day);
      CREATE INDEX IF NOT EXISTS fee_ledger_user ON fee_ledger (user_id, day);
      -- $WEFT bought during a day and waiting to be shared out when it closes
      CREATE TABLE IF NOT EXISTS pots (
        day TEXT PRIMARY KEY,
        trader_tokens REAL NOT NULL DEFAULT 0,
        creator_tokens REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS buys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        day TEXT NOT NULL,
        source TEXT NOT NULL,
        spent_usd REAL NOT NULL,
        bought_tokens REAL NOT NULL,
        burned_tokens REAL NOT NULL,
        swap_tx TEXT,
        burn_tx TEXT
      );
      CREATE INDEX IF NOT EXISTS buys_day ON buys (day);
      -- fees from $WEFT trades, claimed from the pool and split on the spot
      CREATE TABLE IF NOT EXISTS token_fee_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        stage TEXT NOT NULL,
        claimed_sol REAL NOT NULL,
        protocol_sol REAL NOT NULL,
        buyback_sol REAL NOT NULL,
        claim_tx TEXT,
        transfer_tx TEXT
      );
      -- half of each day's strategy fees, bought slice by slice over the following day
      CREATE TABLE IF NOT EXISTS budgets (
        day TEXT PRIMARY KEY,
        total_usd REAL NOT NULL,
        spent_usd REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS reward_days (
        day TEXT PRIMARY KEY,
        closed_at INTEGER NOT NULL,
        fees_usd REAL NOT NULL,
        traders INTEGER NOT NULL,
        creators INTEGER NOT NULL,
        trader_tokens REAL NOT NULL,
        creator_tokens REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rewards (
        day TEXT NOT NULL,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        basis_usd REAL NOT NULL,
        share REAL NOT NULL,
        tokens REAL NOT NULL,
        claimed_at INTEGER,
        claim_tx TEXT,
        PRIMARY KEY (day, user_id, kind)
      );
      CREATE INDEX IF NOT EXISTS rewards_user ON rewards (user_id, claimed_at);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  get enabled(): boolean {
    return this.startDay != null;
  }

  record(e: FeeEntry) {
    if (!(e.feeUsd > 0)) return;
    this.db
      .prepare("INSERT OR IGNORE INTO fee_ledger (id, ts, day, user_id, deployment_id, creator_id, instrument_key, fee_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(e.id, e.ts, dayOf(e.ts), e.userId, e.deploymentId, e.creatorId, e.instrumentKey, e.feeUsd);
  }

  /* ---------------- buying ---------------- */

  private addToPot(day: string, trader: number, creator: number) {
    this.db
      .prepare("INSERT INTO pots (day, trader_tokens, creator_tokens) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET trader_tokens = trader_tokens + excluded.trader_tokens, creator_tokens = creator_tokens + excluded.creator_tokens")
      .run(day, trader, creator);
  }

  /** How a buy splits: burned now, the rest into today's pots. */
  static split(bought: number) {
    return { burn: bought * REWARDS.burnShare, trader: bought * REWARDS.traderShare, creator: bought * REWARDS.creatorShare };
  }

  /** A buy went through (its burn share already burned): the rest joins the pots of the day it happened. */
  addBuy(b: Buy) {
    const day = dayOf(b.at), s = Rewards.split(b.boughtTokens);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO buys (at, day, source, spent_usd, bought_tokens, burned_tokens, swap_tx, burn_tx) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(b.at, day, b.source, b.spentUsd, b.boughtTokens, b.burnedTokens, b.swapTx, b.burnTx);
      this.addToPot(day, s.trader, s.creator);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  recordTokenFeeClaim(c: { at: number; stage: "curve" | "pool"; claimedSol: number; protocolSol: number; buybackSol: number; claimTx: string | null; transferTx: string | null }) {
    this.db
      .prepare("INSERT INTO token_fee_claims (at, stage, claimed_sol, protocol_sol, buyback_sol, claim_tx, transfer_tx) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(c.at, c.stage, c.claimedSol, c.protocolSol, c.buybackSol, c.claimTx, c.transferTx);
  }

  /** This run's slice of the strategy-fee budgets (USD): each closed day's buyback is spread over a day. */
  budgetSlice(): number {
    const rows = this.db.prepare("SELECT total_usd, spent_usd FROM budgets WHERE spent_usd < total_usd - 0.005").all() as { total_usd: number; spent_usd: number }[];
    return rows.reduce((a, r) => a + Math.min(r.total_usd - r.spent_usd, r.total_usd / REWARDS.slicesPerDay), 0);
  }

  /** Mark strategy-fee budget as spent, oldest day first. */
  spendBudget(usd: number) {
    let left = usd;
    const rows = this.db.prepare("SELECT day, total_usd, spent_usd FROM budgets WHERE spent_usd < total_usd ORDER BY day").all() as { day: string; total_usd: number; spent_usd: number }[];
    for (const r of rows) {
      if (left <= 0) break;
      const take = Math.min(left, r.total_usd - r.spent_usd);
      this.db.prepare("UPDATE budgets SET spent_usd = spent_usd + ? WHERE day = ?").run(take, r.day);
      left -= take;
    }
  }

  /** Token-fee SOL (lamports) set aside for a buy that didn't go through yet; retried next run. */
  owedTokenBuyback(): bigint {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = 'owed_token_buyback'").get() as { value: string } | undefined;
    return r ? BigInt(r.value) : 0n;
  }
  setOwedTokenBuyback(lamports: bigint) {
    this.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('owed_token_buyback', ?)").run(lamports.toString());
  }

  /* ---------------- closing days ---------------- */

  /** Days that have ended but aren't closed yet (from the start day up to yesterday). */
  pendingDays(now = Date.now()): string[] {
    if (!this.startDay) return [];
    const today = dayOf(now), out: string[] = [];
    for (let d = this.startDay; d < today; d = nextDay(d)) if (!this.day(d)) out.push(d);
    return out;
  }

  /**
   * Close a day: share its pots out. Traders by fees paid × their holder boost; creators by the fees
   * runs of their strategies paid (never their own). A pot nobody qualifies for rolls into the next
   * day's. The day's strategy-fee buyback becomes a budget bought over the next day.
   */
  async closeDay(day: string, boost: (userId: string) => Promise<number>, now = Date.now()): Promise<RewardDay> {
    const done = this.day(day);
    if (done) return done;
    const rows = this.db.prepare("SELECT user_id, creator_id, fee_usd FROM fee_ledger WHERE day = ?").all(day) as { user_id: string; creator_id: string | null; fee_usd: number }[];
    const paid = new Map<string, number>(), made = new Map<string, number>();
    let fees = 0;
    for (const r of rows) {
      fees += r.fee_usd;
      paid.set(r.user_id, (paid.get(r.user_id) ?? 0) + r.fee_usd);
      if (r.creator_id && r.creator_id !== r.user_id) made.set(r.creator_id, (made.get(r.creator_id) ?? 0) + r.fee_usd);
    }
    const weights = new Map<string, number>();
    for (const [u, f] of paid) weights.set(u, f * Math.max(1, await boost(u).catch(() => 1)));
    const wSum = [...weights.values()].reduce((a, b) => a + b, 0);
    const mSum = [...made.values()].reduce((a, b) => a + b, 0);
    const pot = (this.db.prepare("SELECT trader_tokens, creator_tokens FROM pots WHERE day = ?").get(day) as { trader_tokens: number; creator_tokens: number } | undefined) ?? { trader_tokens: 0, creator_tokens: 0 };
    const traderTokens = wSum > 0 ? pot.trader_tokens : 0, creatorTokens = mSum > 0 ? pot.creator_tokens : 0;
    const ins = this.db.prepare("INSERT OR REPLACE INTO rewards (day, user_id, kind, basis_usd, share, tokens) VALUES (?, ?, ?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const [u, w] of weights) ins.run(day, u, "trade", paid.get(u)!, w / wSum, (traderTokens * w) / wSum);
      for (const [u, f] of made) ins.run(day, u, "create", f, f / mSum, (creatorTokens * f) / mSum);
      this.addToPot(nextDay(day), pot.trader_tokens - traderTokens, pot.creator_tokens - creatorTokens);
      if (fees > 0) this.db.prepare("INSERT OR IGNORE INTO budgets (day, total_usd) VALUES (?, ?)").run(day, fees * REWARDS.buybackShare);
      this.db
        .prepare("INSERT INTO reward_days (day, closed_at, fees_usd, traders, creators, trader_tokens, creator_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(day, now, fees, weights.size, made.size, traderTokens, creatorTokens);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.day(day)!;
  }

  day(day: string): RewardDay | null {
    const r = this.db.prepare("SELECT * FROM reward_days WHERE day = ?").get(day) as Record<string, unknown> | undefined;
    return r ? toDay(r) : null;
  }

  /* ---------------- claiming ---------------- */

  claimableTokens(userId: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(tokens), 0) AS n FROM rewards WHERE user_id = ? AND claimed_at IS NULL").get(userId) as { n: number };
    return r.n;
  }

  /**
   * Claim: reserve everything claimable (so a second request can't pay it twice), pay it, then
   * record the transaction; if paying fails, release it again.
   */
  async claim(userId: string, pay: (tokens: number) => Promise<string>, now = Date.now()): Promise<{ tokens: number; tx: string } | null> {
    const tag = `pending:${now}:${Math.random().toString(36).slice(2)}`;
    this.db.prepare("UPDATE rewards SET claimed_at = ?, claim_tx = ? WHERE user_id = ? AND tokens > 0 AND claimed_at IS NULL").run(now, tag, userId);
    const { n } = this.db.prepare("SELECT COALESCE(SUM(tokens), 0) AS n FROM rewards WHERE claim_tx = ?").get(tag) as { n: number };
    if (!(n > 0)) return null;
    try {
      const tx = await pay(n);
      this.db.prepare("UPDATE rewards SET claim_tx = ? WHERE claim_tx = ?").run(tx, tag);
      return { tokens: n, tx };
    } catch (e) {
      this.db.prepare("UPDATE rewards SET claimed_at = NULL, claim_tx = NULL WHERE claim_tx = ?").run(tag);
      throw e;
    }
  }

  /* ---------------- reading ---------------- */

  /** What one user sees: today so far, what's waiting to be claimed, and the last 30 days. */
  summary(userId: string, now = Date.now()) {
    const today = dayOf(now);
    const day = this.db
      .prepare(
        "SELECT COALESCE(SUM(fee_usd), 0) AS all_fees, COALESCE(SUM(CASE WHEN user_id = ? THEN fee_usd END), 0) AS mine, COALESCE(SUM(CASE WHEN creator_id = ? AND user_id <> ? THEN fee_usd END), 0) AS made, COALESCE(SUM(CASE WHEN creator_id IS NOT NULL AND creator_id <> user_id THEN fee_usd END), 0) AS all_made FROM fee_ledger WHERE day = ?"
      )
      .get(userId, userId, userId, today) as { all_fees: number; mine: number; made: number; all_made: number };
    const pot = (this.db.prepare("SELECT trader_tokens, creator_tokens FROM pots WHERE day = ?").get(today) as { trader_tokens: number; creator_tokens: number } | undefined) ?? { trader_tokens: 0, creator_tokens: 0 };
    const rows = (this.db.prepare("SELECT * FROM rewards WHERE user_id = ? ORDER BY day DESC, kind LIMIT 60").all(userId) as Record<string, unknown>[]).map(toRow);
    return {
      today: {
        day: today,
        feesPaidUsd: day.mine,
        creatorFeesUsd: day.made,
        traderPotTokens: pot.trader_tokens,
        creatorPotTokens: pot.creator_tokens,
        // So far: the pots keep filling until midnight, and other traders' boosts aren't known yet.
        estTradeTokens: day.all_fees ? pot.trader_tokens * (day.mine / day.all_fees) : 0,
        estCreateTokens: day.all_made ? pot.creator_tokens * (day.made / day.all_made) : 0,
      },
      priceUsd: this.lastPrice(),
      claimableTokens: this.claimableTokens(userId),
      earnedTokens: rows.reduce((a, r) => a + r.tokens, 0),
      history: rows,
    };
  }

  /** USD per token at the most recent buy. */
  lastPrice(): number | null {
    const r = this.db.prepare("SELECT spent_usd, bought_tokens FROM buys WHERE bought_tokens > 0 ORDER BY at DESC LIMIT 1").get() as { spent_usd: number; bought_tokens: number } | undefined;
    return r ? r.spent_usd / r.bought_tokens : null;
  }

  /** Public totals: everything bought, burned and shared out, and the fee claims on $WEFT trades. */
  stats(now = Date.now()) {
    const b = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(spent_usd), 0) AS spent, COALESCE(SUM(bought_tokens), 0) AS bought, COALESCE(SUM(burned_tokens), 0) AS burned, MAX(at) AS last FROM buys").get() as { n: number; spent: number; bought: number; burned: number; last: number | null };
    const c = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(claimed_sol), 0) AS claimed, COALESCE(SUM(protocol_sol), 0) AS protocol, COALESCE(SUM(buyback_sol), 0) AS buyback, MAX(at) AS last FROM token_fee_claims").get() as { n: number; claimed: number; protocol: number; buyback: number; last: number | null };
    const d = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(trader_tokens + creator_tokens), 0) AS shared FROM reward_days").get() as { n: number; shared: number };
    const pot = (this.db.prepare("SELECT trader_tokens + creator_tokens AS t FROM pots WHERE day = ?").get(dayOf(now)) as { t: number } | undefined)?.t ?? 0;
    const budget = (this.db.prepare("SELECT COALESCE(SUM(total_usd - spent_usd), 0) AS left FROM budgets").get() as { left: number }).left;
    const days = (this.db.prepare("SELECT day, COUNT(*) AS buys, SUM(spent_usd) AS spent, SUM(bought_tokens) AS bought, SUM(burned_tokens) AS burned FROM buys GROUP BY day ORDER BY day DESC LIMIT 14").all() as { day: string; buys: number; spent: number; bought: number; burned: number }[]);
    return {
      buys: b.n,
      spentUsd: b.spent,
      boughtTokens: b.bought,
      burnedTokens: b.burned,
      lastBuyAt: b.last,
      sharedTokens: d.shared,
      daysClosed: d.n,
      todayPotTokens: pot,
      budgetLeftUsd: budget,
      tokenFees: { claims: c.n, claimedSol: c.claimed, protocolSol: c.protocol, buybackSol: c.buyback, lastClaimAt: c.last },
      days,
    };
  }
}

function toDay(r: Record<string, unknown>): RewardDay {
  return {
    day: r.day as string,
    closedAt: Number(r.closed_at),
    feesUsd: Number(r.fees_usd),
    traders: Number(r.traders),
    creators: Number(r.creators),
    traderTokens: Number(r.trader_tokens),
    creatorTokens: Number(r.creator_tokens),
  };
}

function toRow(r: Record<string, unknown>): RewardRow {
  return {
    day: r.day as string,
    kind: r.kind as RewardKind,
    basisUsd: Number(r.basis_usd),
    share: Number(r.share),
    tokens: Number(r.tokens),
    claimedAt: r.claimed_at == null ? null : Number(r.claimed_at),
    claimTx: (r.claim_tx as string | null) ?? null,
  };
}
