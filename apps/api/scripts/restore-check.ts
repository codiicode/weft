// Proves the off-site backup can be restored: downloads latest/ from Cloudflare R2, unzips each
// database into a temp folder and runs SQLite's integrity check on it. Changes nothing anywhere.
// Usage: node --env-file=.env scripts/restore-check.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { R2, r2ConfigFromEnv } from "../src/lib/offsite.ts";

const cfg = r2ConfigFromEnv();
if (!cfg) throw new Error("set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET");
const r2 = new R2(cfg);
const manifest = JSON.parse((await r2.get("latest/manifest.json")).toString()) as { at: string; files: { name: string }[] };
console.log(`latest backup: ${manifest.at} (${manifest.files.length} files)`);
const dir = mkdtempSync(join(tmpdir(), "weft-restore-"));
for (const f of manifest.files) {
  const raw = gunzipSync(await r2.get(`latest/${f.name}`));
  const path = join(dir, f.name.replace(/\.gz$/, ""));
  writeFileSync(path, raw);
  if (!path.endsWith(".db")) {
    console.log(`  ${f.name}: ${raw.length} bytes`);
    continue;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  const ok = (db.prepare("PRAGMA integrity_check").get() as Record<string, string>).integrity_check;
  const tables = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number }).n;
  db.close();
  console.log(`  ${f.name}: ${raw.length} bytes, ${tables} tables, integrity ${ok}`);
}
console.log(`restored into ${dir}`);
