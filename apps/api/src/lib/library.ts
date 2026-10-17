import { DatabaseSync } from "node:sqlite";
import { validateStrategy, type Strategy } from "@weft/strategy";
import { examples } from "@weft/strategy/examples";

/** Seeded examples that were removed from the code. */
const RETIRED_EXAMPLES = ["el-nino-harvest"];

/** Entries removed at their owner's request: [id, created before]. The date keeps a later strategy that happens to get the same id. */
const REMOVED_ENTRIES: [string, number][] = [["ray-buy-now", Date.UTC(2026, 9, 17)], ["saylor-buys", Date.UTC(2026, 9, 18)]];

/** A strategy's rules without its instruments (which get resolved from placeholders to real ones). */
const rulesOf = (s: Strategy) =>
  JSON.stringify({
    signals: s.signals.map((x) => [x.id, x.kind, x.label ?? null]),
    triggers: s.triggers,
    actions: s.actions.map((a) => ({ ...a, instrument: undefined, target: undefined, legs: undefined })),
  });

/** Public strategy library: saved, shareable, forkable strategy documents. */

export interface LibraryEntry {
  id: string;
  strategy: Strategy;
  author: string;
  forkedFrom: string | null;
  forks: number;
  createdAt: number;
  updatedAt: number;
}

export class StrategyLibrary {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY,
        doc TEXT NOT NULL,
        author TEXT NOT NULL,
        forked_from TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM strategies").get() as { n: number }).n;
    // Strategies are anonymous: clear any names, emails or wallets stored before that rule.
    this.db.exec("UPDATE strategies SET author = '' WHERE author <> ''");
    if (count === 0) {
      examples.forEach((s) => this.save(s, { author: "" }));
    } else {
      // Examples taken out of the code leave the library too (only the seeded originals, never copies).
      for (const id of RETIRED_EXAMPLES) this.db.prepare("DELETE FROM strategies WHERE id = ? AND forked_from IS NULL").run(id);
      for (const [id, before] of REMOVED_ENTRIES) this.db.prepare("DELETE FROM strategies WHERE id = ? AND created_at < ?").run(id, before);
      // New examples join an existing library.
      for (const ex of examples) if (!this.get(ex.id)) this.save(ex, { author: "" });
      // Keep seeded examples in step with the code. Instruments may have been resolved since (real
      // mints and market ids), so only wording changes keep them; a change to the rules replaces the
      // whole document and the placeholders get resolved again on startup.
      const upd = this.db.prepare("UPDATE strategies SET doc = ?, updated_at = ? WHERE id = ? AND forked_from IS NULL");
      for (const ex of examples) {
        const cur = this.get(ex.id);
        if (!cur || cur.forkedFrom) continue;
        if (rulesOf(cur.strategy) !== rulesOf(ex)) upd.run(JSON.stringify(ex), Date.now(), ex.id);
        else if (cur.strategy.thesis !== ex.thesis || cur.strategy.name !== ex.name)
          upd.run(JSON.stringify({ ...cur.strategy, thesis: ex.thesis, name: ex.name }), Date.now(), ex.id);
      }
    }
  }

  private row(r: Record<string, unknown>): LibraryEntry {
    const forks = (this.db.prepare("SELECT COUNT(*) AS n FROM strategies WHERE forked_from = ?").get(r.id as string) as { n: number }).n;
    return {
      id: r.id as string,
      strategy: JSON.parse(r.doc as string) as Strategy,
      author: r.author as string,
      forkedFrom: (r.forked_from as string | null) ?? null,
      forks,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    };
  }

  private freeId(base: string): string {
    const exists = this.db.prepare("SELECT 1 FROM strategies WHERE id = ?");
    if (!exists.get(base)) return base;
    for (let i = 2; ; i++) {
      const id = `${base.slice(0, 58)}-${i}`;
      if (!exists.get(id)) return id;
    }
  }

  /** Validates, assigns a unique id, stores. */
  save(input: unknown, opts: { author: string; forkedFrom?: string | null; replaceId?: string }): LibraryEntry {
    const v = validateStrategy(input);
    if (!v.ok) throw Object.assign(new Error("invalid strategy"), { issues: v.errors });
    const now = Date.now();
    if (opts.replaceId) {
      const strategy = { ...v.strategy, id: opts.replaceId };
      this.db.prepare("UPDATE strategies SET doc = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(strategy), now, opts.replaceId);
      return this.get(opts.replaceId)!;
    }
    const id = this.freeId(v.strategy.id);
    const strategy = { ...v.strategy, id, ...(opts.forkedFrom ? { forkedFrom: opts.forkedFrom } : {}) };
    this.db
      .prepare("INSERT INTO strategies (id, doc, author, forked_from, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, JSON.stringify(strategy), opts.author, opts.forkedFrom ?? null, now, now);
    return this.get(id)!;
  }

  get(id: string): LibraryEntry | null {
    const r = this.db.prepare("SELECT * FROM strategies WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.row(r) : null;
  }

  list(): LibraryEntry[] {
    return (this.db.prepare("SELECT * FROM strategies ORDER BY updated_at DESC").all() as Record<string, unknown>[]).map((r) => this.row(r));
  }

  fork(id: string, author: string): LibraryEntry | null {
    const src = this.get(id);
    if (!src) return null;
    return this.save(
      { ...src.strategy, id: `${src.strategy.id.slice(0, 50)}-fork`, name: `${src.strategy.name.slice(0, 72)} (fork)` },
      { author, forkedFrom: id }
    );
  }

  /** Seeded examples still pointing at placeholder instruments. */
  placeholderEntries(): LibraryEntry[] {
    return this.list().filter((e) => JSON.stringify(e.strategy).includes("ExampLeMint") || /"market":"[a-z0-9-]+-20\d\d[a-z0-9-]*"/.test(JSON.stringify(e.strategy)));
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM strategies WHERE id = ?").run(id).changes) > 0;
  }

  close() {
    this.db.close();
  }
}
