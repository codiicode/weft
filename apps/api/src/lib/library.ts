import { DatabaseSync } from "node:sqlite";
import { validateStrategy, type Strategy } from "@weft/strategy";
import { examples } from "@weft/strategy/examples";

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
    if (count === 0) {
      const authors = ["@monsoon_maria", "@pump_hunter", "@basis_point_bea", "@contrarian_kai", "@iv_crush_ivy", "@tape_reader"];
      examples.forEach((s, i) => this.save(s, { author: authors[i % authors.length]! }));
    } else {
      // Keep seeded examples' wording in step with the code (instruments may have been resolved since).
      const upd = this.db.prepare("UPDATE strategies SET doc = ?, updated_at = ? WHERE id = ? AND forked_from IS NULL");
      for (const ex of examples) {
        const cur = this.get(ex.id);
        if (cur && (cur.strategy.thesis !== ex.thesis || cur.strategy.name !== ex.name))
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
