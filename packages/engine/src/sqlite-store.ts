import { DatabaseSync } from "node:sqlite";
import type { DeploymentRecord, EngineEvent, Fill, Position } from "./types.ts";
import { DEFAULT_LIMITS, type DeploymentRuntime, type Store, type StoreBatch, type StoreLimits } from "./store.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS eval_state (
  deployment_id TEXT PRIMARY KEY,
  eval_state TEXT NOT NULL,
  runtime TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  position TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS positions_dep ON positions (deployment_id, opened_at);
CREATE TABLE IF NOT EXISTS fills (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  deployment_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  fill TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fills_dep ON fills (deployment_id, seq);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  deployment_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  event TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_dep ON events (deployment_id, seq);
CREATE TABLE IF NOT EXISTS intent_keys (
  deployment_id TEXT NOT NULL,
  key TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (deployment_id, key)
);
CREATE TABLE IF NOT EXISTS equity_samples (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  equity_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS equity_dep ON equity_samples (deployment_id, seq);
`;

/**
 * Durable store on Node's built-in SQLite (`node:sqlite`), one file per engine.
 * Rows hold JSON documents; every batch is one transaction.
 */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly limits: Required<StoreLimits>;

  constructor(path: string, limits: StoreLimits = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  async commit(b: StoreBatch): Promise<void> {
    const id = b.deploymentId;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (b.deployment) {
        const d = b.deployment;
        this.db
          .prepare(
            `INSERT INTO deployments (id, status, created_at, updated_at, record) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, record = excluded.record`
          )
          .run(d.id, d.status, d.createdAt, d.updatedAt, JSON.stringify(d));
      }
      if (b.runtime) {
        const { evalState, ...rest } = b.runtime;
        this.db
          .prepare(
            `INSERT INTO eval_state (deployment_id, eval_state, runtime) VALUES (?, ?, ?)
             ON CONFLICT(deployment_id) DO UPDATE SET eval_state = excluded.eval_state, runtime = excluded.runtime`
          )
          .run(id, JSON.stringify(evalState), JSON.stringify(rest));
      }
      if (b.upsertPositions?.length) {
        const st = this.db.prepare(
          `INSERT INTO positions (id, deployment_id, opened_at, position) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET position = excluded.position`
        );
        for (const p of b.upsertPositions) st.run(p.id, id, p.openedAt, JSON.stringify(p));
      }
      if (b.deletePositionIds?.length) {
        const st = this.db.prepare(`DELETE FROM positions WHERE id = ? AND deployment_id = ?`);
        for (const pid of b.deletePositionIds) st.run(pid, id);
      }
      if (b.fills?.length) {
        const st = this.db.prepare(`INSERT INTO fills (id, deployment_id, ts, fill) VALUES (?, ?, ?, ?)`);
        for (const f of b.fills) st.run(f.id, id, f.ts, JSON.stringify(f));
      }
      if (b.events?.length) {
        const st = this.db.prepare(`INSERT INTO events (id, deployment_id, ts, type, event) VALUES (?, ?, ?, ?, ?)`);
        for (const e of b.events) st.run(e.id, id, e.ts, e.type, JSON.stringify(e));
        this.db
          .prepare(
            `DELETE FROM events WHERE deployment_id = ? AND seq <= (
               SELECT seq FROM events WHERE deployment_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)`
          )
          .run(id, id, this.limits.maxEvents);
      }
      if (b.intentKeys?.length) {
        const st = this.db.prepare(`INSERT OR IGNORE INTO intent_keys (deployment_id, key, ts) VALUES (?, ?, ?)`);
        for (const k of b.intentKeys) st.run(id, k.key, k.ts);
      }
      if (b.equitySample) {
        this.db.prepare(`INSERT INTO equity_samples (deployment_id, ts, equity_usd) VALUES (?, ?, ?)`).run(id, b.equitySample[0], b.equitySample[1]);
        this.db
          .prepare(
            `DELETE FROM equity_samples WHERE deployment_id = ? AND seq <= (
               SELECT seq FROM equity_samples WHERE deployment_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)`
          )
          .run(id, id, this.limits.maxEquitySamples);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async getDeployment(id: string): Promise<DeploymentRecord | null> {
    const row = this.db.prepare(`SELECT record FROM deployments WHERE id = ?`).get(id) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as DeploymentRecord) : null;
  }

  async listDeployments(): Promise<DeploymentRecord[]> {
    const rows = this.db.prepare(`SELECT record FROM deployments ORDER BY created_at, id`).all() as { record: string }[];
    return rows.map((r) => JSON.parse(r.record) as DeploymentRecord);
  }

  async getRuntime(id: string): Promise<DeploymentRuntime | null> {
    const row = this.db.prepare(`SELECT eval_state, runtime FROM eval_state WHERE deployment_id = ?`).get(id) as
      | { eval_state: string; runtime: string }
      | undefined;
    if (!row) return null;
    return { ...(JSON.parse(row.runtime) as Omit<DeploymentRuntime, "evalState">), evalState: JSON.parse(row.eval_state) };
  }

  async listPositions(id: string): Promise<Position[]> {
    const rows = this.db.prepare(`SELECT position FROM positions WHERE deployment_id = ? ORDER BY opened_at, id`).all(id) as { position: string }[];
    return rows.map((r) => JSON.parse(r.position) as Position);
  }

  async listFills(id: string): Promise<Fill[]> {
    const rows = this.db.prepare(`SELECT fill FROM fills WHERE deployment_id = ? ORDER BY seq`).all(id) as { fill: string }[];
    return rows.map((r) => JSON.parse(r.fill) as Fill);
  }

  async listEvents(id: string, opts: { sinceTs?: number; limit?: number } = {}): Promise<EngineEvent[]> {
    const since = opts.sinceTs ?? -1;
    const limit = opts.limit ?? -1;
    const rows = this.db
      .prepare(
        `SELECT event FROM (
           SELECT seq, event FROM events WHERE deployment_id = ? AND ts > ? ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq`
      )
      .all(id, since, limit) as { event: string }[];
    return rows.map((r) => JSON.parse(r.event) as EngineEvent);
  }

  async hasIntentKey(id: string, key: string): Promise<boolean> {
    return this.db.prepare(`SELECT 1 FROM intent_keys WHERE deployment_id = ? AND key = ?`).get(id, key) != null;
  }

  async listEquity(id: string): Promise<[number, number][]> {
    const rows = this.db.prepare(`SELECT ts, equity_usd FROM equity_samples WHERE deployment_id = ? ORDER BY seq`).all(id) as {
      ts: number;
      equity_usd: number;
    }[];
    return rows.map((r) => [r.ts, r.equity_usd]);
  }

  async close(): Promise<void> {
    if (this.db.isOpen) this.db.close();
  }
}
