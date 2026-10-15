import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { Backups } from "../src/lib/backup.ts";

describe("backups", () => {
  it("snapshots every database (while it's open) and JSON file, keeps a daily, prunes old hours", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weft-bk-"));
    const db = new DatabaseSync(join(dir, "accounts.db"));
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('kept')");
    writeFileSync(join(dir, "oi-history.json"), JSON.stringify({ a: 1 }));
    let t = new Date("2026-10-15T10:00:00Z");
    const b = new Backups({ dataDir: dir, hourly: 2, daily: 3, now: () => t });
    for (let h = 0; h < 4; h++) {
      await b.run();
      t = new Date(t.getTime() + 3_600_000);
    }
    const hourly = readdirSync(join(dir, "backups", "hourly"));
    expect(hourly).toEqual(["2026-10-15T12", "2026-10-15T13"]);
    expect(readdirSync(join(dir, "backups", "daily"))).toEqual(["2026-10-15"]);
    const snap = join(dir, "backups", "hourly", "2026-10-15T13");
    expect(readdirSync(snap).sort()).toEqual(["accounts.db.gz", "manifest.json", "oi-history.json.gz"]);
    // The copy is a working database with the data, taken while the original was open in WAL mode.
    const restored = join(dir, "restored.db");
    writeFileSync(restored, gunzipSync(readFileSync(join(snap, "accounts.db.gz"))));
    const r = new DatabaseSync(restored);
    expect(r.prepare("SELECT x FROM t").get()).toEqual({ x: "kept" });
    r.close();
    db.close();
  });
});
