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
  deploymentsOf(userId: string): Set<string> {
    const rows = this.db.prepare("SELECT deployment_id FROM deployment_owners WHERE user_id = ?").all(userId) as { deployment_id: string }[];
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

  close() {
    this.db.close();
  }
}
