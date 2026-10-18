import { DatabaseSync } from "node:sqlite";

/**
 * Users, ownership of deployments, and per-user AI usage (cost control).
 * Users are keyed by their Privy DID ("local" in local mode).
 */

export interface Account {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  wallets: string[];
  displayName: string | null;
}

export interface LiveAccount {
  userId: string;
  network: "testnet" | "mainnet";
  /** The user's Hyperliquid master account (their own wallet address). */
  hlAddress: `0x${string}`;
  agentApprovedAt: number | null;
  builderApprovedAt: number | null;
}

export class Accounts {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        wallets TEXT NOT NULL DEFAULT '[]',
        display_name TEXT
      );
      CREATE TABLE IF NOT EXISTS deployment_owners (
        deployment_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS deployment_owners_user ON deployment_owners (user_id);
      CREATE TABLE IF NOT EXISTS deployment_creators (
        deployment_id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS solana_accounts (
        user_id TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        wallet_id TEXT NOT NULL,
        linked_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shared_runs (
        deployment_id TEXT PRIMARY KEY,
        shared_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS strategy_owners (
        strategy_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_wallets (
        user_id TEXT PRIMARY KEY,
        wallet_id TEXT NOT NULL,
        address TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS live_accounts (
        user_id TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        hl_address TEXT NOT NULL,
        agent_approved_at INTEGER,
        builder_approved_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_usage (
        user_id TEXT NOT NULL,
        day TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (user_id, day)
      );
      CREATE TABLE IF NOT EXISTS telegram_links (
        user_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        username TEXT,
        linked_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS telegram_codes (
        code TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  touch(id: string, info: { wallets?: string[]; displayName?: string | null } = {}): Account {
    const now = Date.now();
    const existing = this.get(id);
    if (!existing) {
      this.db
        .prepare("INSERT INTO users (id, created_at, last_seen_at, wallets, display_name) VALUES (?, ?, ?, ?, ?)")
        .run(id, now, now, JSON.stringify(info.wallets ?? []), info.displayName ?? null);
    } else {
      const wallets = info.wallets?.length ? [...new Set([...existing.wallets, ...info.wallets])] : existing.wallets;
      this.db
        .prepare("UPDATE users SET last_seen_at = ?, wallets = ?, display_name = COALESCE(?, display_name) WHERE id = ?")
        .run(now, JSON.stringify(wallets), info.displayName ?? null, id);
    }
    return this.get(id)!;
  }

  get(id: string): Account | null {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      createdAt: r.created_at as number,
      lastSeenAt: r.last_seen_at as number,
      wallets: JSON.parse(r.wallets as string) as string[],
      displayName: (r.display_name as string | null) ?? null,
    };
  }

  /* ---------------- ownership ---------------- */

  setDeploymentOwner(deploymentId: string, userId: string) {
    this.db.prepare("INSERT OR REPLACE INTO deployment_owners (deployment_id, user_id) VALUES (?, ?)").run(deploymentId, userId);
  }
  deploymentOwner(deploymentId: string): string | null {
    const r = this.db.prepare("SELECT user_id FROM deployment_owners WHERE deployment_id = ?").get(deploymentId) as { user_id: string } | undefined;
    return r?.user_id ?? null;
  }
  /** Whose published strategy a run is (for creator rewards); never the run's own owner. */
  setDeploymentCreator(deploymentId: string, creatorId: string) {
    this.db.prepare("INSERT OR REPLACE INTO deployment_creators (deployment_id, creator_id) VALUES (?, ?)").run(deploymentId, creatorId);
  }
  deploymentCreator(deploymentId: string): string | null {
    const r = this.db.prepare("SELECT creator_id FROM deployment_creators WHERE deployment_id = ?").get(deploymentId) as { creator_id: string } | undefined;
    return r?.creator_id ?? null;
  }
  deploymentsOf(userId: string): Set<string> {
    const rows = this.db.prepare("SELECT deployment_id FROM deployment_owners WHERE user_id = ?").all(userId) as { deployment_id: string }[];
    return new Set(rows.map((r) => r.deployment_id));
  }

  /** The user's own Privy Solana wallet that Weft may trade from (they added Weft as a signer). */
  setSolanaAccount(userId: string, address: string, walletId: string) {
    this.db.prepare("INSERT OR REPLACE INTO solana_accounts (user_id, address, wallet_id, linked_at) VALUES (?, ?, ?, ?)").run(userId, address, walletId, Date.now());
  }
  solanaAccount(userId: string): { address: string; walletId: string; linkedAt: number } | null {
    const r = this.db.prepare("SELECT * FROM solana_accounts WHERE user_id = ?").get(userId) as Record<string, unknown> | undefined;
    return r ? { address: r.address as string, walletId: r.wallet_id as string, linkedAt: r.linked_at as number } : null;
  }

  /** Live runs whose owner chose to show their return (percent only) on the leaderboard. */
  setShared(deploymentId: string, shared: boolean) {
    if (shared) this.db.prepare("INSERT OR REPLACE INTO shared_runs (deployment_id, shared_at) VALUES (?, ?)").run(deploymentId, Date.now());
    else this.db.prepare("DELETE FROM shared_runs WHERE deployment_id = ?").run(deploymentId);
  }
  isShared(deploymentId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM shared_runs WHERE deployment_id = ?").get(deploymentId));
  }
  sharedRuns(): Set<string> {
    const rows = this.db.prepare("SELECT deployment_id FROM shared_runs").all() as { deployment_id: string }[];
    return new Set(rows.map((r) => r.deployment_id));
  }

  setStrategyOwner(strategyId: string, userId: string) {
    this.db.prepare("INSERT OR REPLACE INTO strategy_owners (strategy_id, user_id) VALUES (?, ?)").run(strategyId, userId);
  }
  strategyOwner(strategyId: string): string | null {
    const r = this.db.prepare("SELECT user_id FROM strategy_owners WHERE strategy_id = ?").get(strategyId) as { user_id: string } | undefined;
    return r?.user_id ?? null;
  }

  /* ---------------- AI usage ---------------- */

  aiUsedToday(userId: string, now = Date.now()): number {
    const day = new Date(now).toISOString().slice(0, 10);
    const r = this.db.prepare("SELECT count FROM ai_usage WHERE user_id = ? AND day = ?").get(userId, day) as { count: number } | undefined;
    return r?.count ?? 0;
  }
  recordAiUse(userId: string, now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    this.db
      .prepare("INSERT INTO ai_usage (user_id, day, count) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1")
      .run(userId, day);
  }

  /* ---------------- key/value ---------------- */

  kvGet(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }
  kvSet(key: string, value: string) {
    this.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, value);
  }

  /* ---------------- telegram alerts ---------------- */

  telegramLink(userId: string): { chatId: string; username: string | null; linkedAt: number } | null {
    const r = this.db.prepare("SELECT chat_id, username, linked_at FROM telegram_links WHERE user_id = ?").get(userId) as
      | { chat_id: string; username: string | null; linked_at: number }
      | undefined;
    return r ? { chatId: r.chat_id, username: r.username, linkedAt: r.linked_at } : null;
  }
  setTelegramLink(userId: string, chatId: string, username: string | null) {
    this.db.prepare("DELETE FROM telegram_links WHERE chat_id = ? AND user_id != ?").run(chatId, userId);
    this.db.prepare("INSERT OR REPLACE INTO telegram_links (user_id, chat_id, username, linked_at) VALUES (?, ?, ?, ?)").run(userId, chatId, username, Date.now());
  }
  removeTelegramLink(userId: string) {
    this.db.prepare("DELETE FROM telegram_links WHERE user_id = ?").run(userId);
  }
  removeTelegramChat(chatId: string) {
    this.db.prepare("DELETE FROM telegram_links WHERE chat_id = ?").run(chatId);
  }
  createTelegramCode(userId: string, code: string, ttlMs: number) {
    this.db.prepare("DELETE FROM telegram_codes WHERE expires_at < ?").run(Date.now());
    this.db.prepare("INSERT OR REPLACE INTO telegram_codes (code, user_id, expires_at) VALUES (?, ?, ?)").run(code, userId, Date.now() + ttlMs);
  }
  /** Single use: returns the user id and deletes the code. */
  consumeTelegramCode(code: string): string | null {
    const r = this.db.prepare("SELECT user_id, expires_at FROM telegram_codes WHERE code = ?").get(code) as { user_id: string; expires_at: number } | undefined;
    this.db.prepare("DELETE FROM telegram_codes WHERE code = ?").run(code);
    return r && r.expires_at >= Date.now() ? r.user_id : null;
  }

  /* ---------------- live trading ---------------- */

  agentWallet(userId: string): { walletId: string; address: `0x${string}` } | null {
    const r = this.db.prepare("SELECT wallet_id, address FROM agent_wallets WHERE user_id = ?").get(userId) as { wallet_id: string; address: string } | undefined;
    return r ? { walletId: r.wallet_id, address: r.address as `0x${string}` } : null;
  }
  setAgentWallet(userId: string, w: { walletId: string; address: string }) {
    this.db.prepare("INSERT OR REPLACE INTO agent_wallets (user_id, wallet_id, address, created_at) VALUES (?, ?, ?, ?)").run(userId, w.walletId, w.address, Date.now());
  }

  liveAccount(userId: string): LiveAccount | null {
    const r = this.db.prepare("SELECT * FROM live_accounts WHERE user_id = ?").get(userId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      userId,
      network: r.network as "testnet" | "mainnet",
      hlAddress: r.hl_address as `0x${string}`,
      agentApprovedAt: (r.agent_approved_at as number | null) ?? null,
      builderApprovedAt: (r.builder_approved_at as number | null) ?? null,
    };
  }
  /** Linking a (new) Hyperliquid account resets approvals: they are per account and network. */
  setLiveAccount(userId: string, network: "testnet" | "mainnet", hlAddress: string) {
    const cur = this.liveAccount(userId);
    if (cur && cur.network === network && cur.hlAddress.toLowerCase() === hlAddress.toLowerCase()) return;
    this.db
      .prepare("INSERT OR REPLACE INTO live_accounts (user_id, network, hl_address, agent_approved_at, builder_approved_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)")
      .run(userId, network, hlAddress, Date.now());
  }
  markApproved(userId: string, kind: "agent" | "builder", at = Date.now()) {
    const col = kind === "agent" ? "agent_approved_at" : "builder_approved_at";
    this.db.prepare(`UPDATE live_accounts SET ${col} = ?, updated_at = ? WHERE user_id = ?`).run(at, at, userId);
  }

  /** Counts for the sign-up → live funnel (no names), plus the addresses to check balances on. */
  funnel(now = Date.now()) {
    const n = (sql: string, ...args: (string | number)[]) => (this.db.prepare(sql).get(...args) as { n: number }).n;
    return {
      users: n("SELECT COUNT(*) AS n FROM users"),
      seen7d: n("SELECT COUNT(*) AS n FROM users WHERE last_seen_at > ?", now - 7 * 86_400_000),
      // ai_usage also counts visitors (hashed); only signed-up people here
      drafted: n("SELECT COUNT(DISTINCT a.user_id) AS n FROM ai_usage a JOIN users u ON u.id = a.user_id"),
      visitorsDrafted: n("SELECT COUNT(DISTINCT a.user_id) AS n FROM ai_usage a LEFT JOIN users u ON u.id = a.user_id WHERE u.id IS NULL"),
      hlLinked: n("SELECT COUNT(*) AS n FROM live_accounts WHERE network = 'mainnet'"),
      hlApproved: n("SELECT COUNT(*) AS n FROM live_accounts WHERE network = 'mainnet' AND agent_approved_at IS NOT NULL"),
      solWallets: n("SELECT COUNT(*) AS n FROM solana_accounts"),
      hlAddresses: (this.db.prepare("SELECT hl_address AS a FROM live_accounts WHERE network = 'mainnet'").all() as { a: string }[]).map((r) => r.a),
      solAddresses: (this.db.prepare("SELECT address AS a FROM solana_accounts").all() as { a: string }[]).map((r) => r.a),
    };
  }

  close() {
    this.db.close();
  }
}
