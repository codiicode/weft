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

  close() {
    this.db.close();
  }
}
