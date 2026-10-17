import { DatabaseSync } from "node:sqlite";

/**
 * $WEFT rewards (decided 2026-10-17). Half of every fee Weft earns buys $WEFT on the market; of what
 * it buys, half goes back to the people who traded that day, a fifth to the creators of the
 * strategies they ran, and the rest is burned. Shares are by fees paid, never by volume, so trading
 * for the reward alone always costs more than it pays. Holders of $WEFT get a bigger share.
 *
 * Every live fill's Weft fee lands in a ledger (per user, per run, with the strategy's creator).
 * Each UTC day is closed after midnight: the day's pools are split into shares. A day is funded when
 * the treasury has bought its $WEFT; from then on its shares are tokens anyone can claim.
 */
export const REWARDS = {
  /** Of Weft's fees: what buys $WEFT. */
  buybackShare: 0.5,
  /** Of the $WEFT bought each day. */
  traderShare: 0.5,
  creatorShare: 0.2,
  burnShare: 0.3,
  /** Reward multiplier by holder tier (none, holder, big holder). */
  boost: [1, 1.5, 2] as const,
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
  /** Value at the day's pool, before the tokens are bought. */
  usd: number;
  /** Set once the day is funded. */
  tokens: number | null;
  claimedAt: number | null;
  claimTx: string | null;
}

export interface RewardDay {
  day: string;
  closedAt: number;
  feesUsd: number;
  buybackUsd: number;
  traderPoolUsd: number;
  creatorPoolUsd: number;
  burnUsd: number;
  traders: number;
  creators: number;
  fundedAt: number | null;
  spentUsd: number | null;
  priceUsd: number | null;
  traderTokens: number | null;
  creatorTokens: number | null;
  burnedTokens: number | null;
  buyTx: string | null;
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
      CREATE TABLE IF NOT EXISTS reward_days (
        day TEXT PRIMARY KEY,
        closed_at INTEGER NOT NULL,
        fees_usd REAL NOT NULL,
        buyback_usd REAL NOT NULL,
        trader_pool_usd REAL NOT NULL,
        creator_pool_usd REAL NOT NULL,
        burn_usd REAL NOT NULL,
        traders INTEGER NOT NULL,
        creators INTEGER NOT NULL,
        funded_at INTEGER,
        spent_usd REAL,
        price_usd REAL,
        trader_tokens REAL,
        creator_tokens REAL,
        burned_tokens REAL,
        buy_tx TEXT,
        burn_tx TEXT
      );
      CREATE TABLE IF NOT EXISTS rewards (
        day TEXT NOT NULL,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        basis_usd REAL NOT NULL,
        share REAL NOT NULL,
        usd REAL NOT NULL,
        tokens REAL,
        claimed_at INTEGER,
        claim_tx TEXT,
        PRIMARY KEY (day, user_id, kind)
      );
      CREATE INDEX IF NOT EXISTS rewards_user ON rewards (user_id, claimed_at);
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

  /** Days that have ended but aren't closed yet (from the start day up to yesterday). */
  pendingDays(now = Date.now()): string[] {
    if (!this.startDay) return [];
    const today = dayOf(now), out: string[] = [];
    for (let d = this.startDay; d < today; d = nextDay(d)) if (!this.day(d)) out.push(d);
    return out;
  }

  /**
   * Close a day: split its pools into shares. Traders by fees paid × their holder boost; creators by
   * fees the runs of their strategies paid. A pool nobody qualifies for goes to the burn.
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
    const buyback = fees * REWARDS.buybackShare;
    let traderPool = paid.size ? buyback * REWARDS.traderShare : 0;
    const creatorPool = made.size ? buyback * REWARDS.creatorShare : 0;
    const burn = buyback - traderPool - creatorPool;
    const weights = new Map<string, number>();
    for (const [u, f] of paid) weights.set(u, f * Math.max(1, await boost(u).catch(() => 1)));
    const wSum = [...weights.values()].reduce((a, b) => a + b, 0);
    const mSum = [...made.values()].reduce((a, b) => a + b, 0);
    if (!wSum) traderPool = 0;
    const ins = this.db.prepare("INSERT OR REPLACE INTO rewards (day, user_id, kind, basis_usd, share, usd) VALUES (?, ?, ?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const [u, w] of weights) ins.run(day, u, "trade", paid.get(u)!, w / wSum, (traderPool * w) / wSum);
      for (const [u, f] of made) ins.run(day, u, "create", f, f / mSum, (creatorPool * f) / mSum);
      this.db
        .prepare("INSERT INTO reward_days (day, closed_at, fees_usd, buyback_usd, trader_pool_usd, creator_pool_usd, burn_usd, traders, creators) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(day, now, fees, buyback, traderPool, creatorPool, burn, weights.size, made.size);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.day(day)!;
  }

  /** Closed days the treasury hasn't bought for yet, oldest first. */
  unfundedDays(): RewardDay[] {
    return (this.db.prepare("SELECT * FROM reward_days WHERE funded_at IS NULL ORDER BY day").all() as Record<string, unknown>[]).map(toDay);
  }

  /** The treasury bought the day's $WEFT: turn shares into tokens. */
  fundDay(day: string, f: { spentUsd: number; priceUsd: number | null; traderTokens: number; creatorTokens: number; burnedTokens: number; buyTx: string | null; burnTx: string | null }, now = Date.now()) {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE reward_days SET funded_at = ?, spent_usd = ?, price_usd = ?, trader_tokens = ?, creator_tokens = ?, burned_tokens = ?, buy_tx = ?, burn_tx = ? WHERE day = ?")
        .run(now, f.spentUsd, f.priceUsd, f.traderTokens, f.creatorTokens, f.burnedTokens, f.buyTx, f.burnTx, day);
      this.db.prepare("UPDATE rewards SET tokens = share * ? WHERE day = ? AND kind = 'trade'").run(f.traderTokens, day);
      this.db.prepare("UPDATE rewards SET tokens = share * ? WHERE day = ? AND kind = 'create'").run(f.creatorTokens, day);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  day(day: string): RewardDay | null {
    const r = this.db.prepare("SELECT * FROM reward_days WHERE day = ?").get(day) as Record<string, unknown> | undefined;
    return r ? toDay(r) : null;
  }

  claimableTokens(userId: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(tokens), 0) AS n FROM rewards WHERE user_id = ? AND tokens IS NOT NULL AND claimed_at IS NULL").get(userId) as { n: number };
    return r.n;
  }

  /**
   * Claim: reserve everything claimable (so a second request can't pay it twice), pay it, then
   * record the transaction; if paying fails, release it again.
   */
  async claim(userId: string, pay: (tokens: number) => Promise<string>, now = Date.now()): Promise<{ tokens: number; tx: string } | null> {
    const tag = `pending:${now}:${Math.random().toString(36).slice(2)}`;
    this.db.prepare("UPDATE rewards SET claimed_at = ?, claim_tx = ? WHERE user_id = ? AND tokens IS NOT NULL AND tokens > 0 AND claimed_at IS NULL").run(now, tag, userId);
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

  /** What one user sees: today so far, what's waiting to be claimed, and the last 30 days. */
  summary(userId: string, now = Date.now()) {
    const today = dayOf(now);
    const day = this.db.prepare("SELECT COALESCE(SUM(fee_usd), 0) AS all_fees, COALESCE(SUM(CASE WHEN user_id = ? THEN fee_usd END), 0) AS mine, COALESCE(SUM(CASE WHEN creator_id = ? AND user_id <> ? THEN fee_usd END), 0) AS made, COALESCE(SUM(CASE WHEN creator_id IS NOT NULL AND creator_id <> user_id THEN fee_usd END), 0) AS all_made FROM fee_ledger WHERE day = ?").get(userId, userId, userId, today) as { all_fees: number; mine: number; made: number; all_made: number };
    const buyback = day.all_fees * REWARDS.buybackShare;
    const rows = (this.db.prepare("SELECT * FROM rewards WHERE user_id = ? ORDER BY day DESC, kind LIMIT 60").all(userId) as Record<string, unknown>[]).map(toRow);
    const sum = (k: RewardKind, f: (r: RewardRow) => number) => rows.filter((r) => r.kind === k).reduce((a, r) => a + f(r), 0);
    return {
      today: {
        day: today,
        feesPaidUsd: day.mine,
        creatorFeesUsd: day.made,
        // An estimate: other traders' boosts aren't known until the day closes.
        estTradeUsd: day.all_fees ? buyback * REWARDS.traderShare * (day.mine / day.all_fees) : 0,
        estCreateUsd: day.all_made ? buyback * REWARDS.creatorShare * (day.made / day.all_made) : 0,
      },
      claimableTokens: this.claimableTokens(userId),
      earnedTokens: sum("trade", (r) => r.tokens ?? 0) + sum("create", (r) => r.tokens ?? 0),
      earnedUsd: sum("trade", (r) => r.usd) + sum("create", (r) => r.usd),
      history: rows,
    };
  }

  /** Public totals for the rewards page. */
  stats() {
    const t = this.db.prepare("SELECT COUNT(*) AS days, COALESCE(SUM(fees_usd), 0) AS fees, COALESCE(SUM(trader_pool_usd + creator_pool_usd), 0) AS paid_usd, COALESCE(SUM(trader_tokens), 0) + COALESCE(SUM(creator_tokens), 0) AS tokens, COALESCE(SUM(burned_tokens), 0) AS burned FROM reward_days").get() as { days: number; fees: number; paid_usd: number; tokens: number; burned: number };
    const days = (this.db.prepare("SELECT * FROM reward_days ORDER BY day DESC LIMIT 14").all() as Record<string, unknown>[]).map(toDay);
    return { daysClosed: t.days, feesUsd: t.fees, rewardsUsd: t.paid_usd, rewardTokens: t.tokens, burnedTokens: t.burned, days };
  }
}

function toDay(r: Record<string, unknown>): RewardDay {
  const n = (k: string) => (r[k] == null ? null : Number(r[k]));
  return {
    day: r.day as string,
    closedAt: Number(r.closed_at),
    feesUsd: Number(r.fees_usd),
    buybackUsd: Number(r.buyback_usd),
    traderPoolUsd: Number(r.trader_pool_usd),
    creatorPoolUsd: Number(r.creator_pool_usd),
    burnUsd: Number(r.burn_usd),
    traders: Number(r.traders),
    creators: Number(r.creators),
    fundedAt: n("funded_at"),
    spentUsd: n("spent_usd"),
    priceUsd: n("price_usd"),
    traderTokens: n("trader_tokens"),
    creatorTokens: n("creator_tokens"),
    burnedTokens: n("burned_tokens"),
    buyTx: (r.buy_tx as string | null) ?? null,
    burnTx: (r.burn_tx as string | null) ?? null,
  };
}

function toRow(r: Record<string, unknown>): RewardRow {
  return {
    day: r.day as string,
    kind: r.kind as RewardKind,
    basisUsd: Number(r.basis_usd),
    share: Number(r.share),
    usd: Number(r.usd),
    tokens: r.tokens == null ? null : Number(r.tokens),
    claimedAt: r.claimed_at == null ? null : Number(r.claimed_at),
    claimTx: (r.claim_tx as string | null) ?? null,
  };
}
