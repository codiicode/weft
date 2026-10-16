import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

/**
 * Hourly snapshots of everything in the data directory: each SQLite database is copied with
 * `VACUUM INTO` (a consistent copy even while the server writes), then gzipped; JSON files are
 * gzipped as they are. Kept: the last `hourly` hours and the last `daily` days.
 *
 * Restore: stop the service, gunzip the files from one snapshot folder into the data directory
 * (replacing the .db files, deleting their -wal/-shm), start it again.
 */

export interface BackupOptions {
  dataDir: string;
  /** Default: <dataDir>/backups */
  dir?: string;
  hourly?: number;
  daily?: number;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Copy each snapshot off the server too (e.g. Cloudflare R2). `firstOfDay` marks the daily one. */
  offsite?: (folder: string, files: { name: string; bytes: number }[], now: Date, firstOfDay: boolean) => Promise<void>;
}

export interface BackupResult {
  folder: string;
  files: { name: string; bytes: number }[];
  ms: number;
}

const stamp = (d: Date, hours: boolean) => d.toISOString().slice(0, hours ? 13 : 10).replace(":", "");

export class Backups {
  private readonly o: Required<Omit<BackupOptions, "log" | "offsite">> & Pick<BackupOptions, "log" | "offsite">;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<BackupResult> | null = null;
  last: BackupResult | null = null;

  constructor(o: BackupOptions) {
    this.o = { dir: join(o.dataDir, "backups"), hourly: 24, daily: 14, now: () => new Date(), ...o };
  }

  /** Back up now (and once an hour from here). */
  start(firstDelayMs = 5 * 60_000) {
    const tick = () => void this.run().catch((e) => this.o.log?.(`backup failed: ${(e as Error).message}`));
    setTimeout(tick, firstDelayMs).unref();
    this.timer = setInterval(tick, 3_600_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  run(): Promise<BackupResult> {
    this.running ??= this.snapshot().finally(() => (this.running = null));
    return this.running;
  }

  private async snapshot(): Promise<BackupResult> {
    const started = Date.now();
    const now = this.o.now();
    const hourlyDir = join(this.o.dir, "hourly");
    const dailyDir = join(this.o.dir, "daily");
    const folder = join(hourlyDir, stamp(now, true));
    mkdirSync(folder, { recursive: true });
    const files: BackupResult["files"] = [];

    for (const name of readdirSync(this.o.dataDir)) {
      const src = join(this.o.dataDir, name);
      if (!statSync(src).isFile()) continue;
      if (name.endsWith(".db")) {
        const tmp = join(folder, `${name}.tmp`);
        rmSync(tmp, { force: true });
        const db = new DatabaseSync(src, { readOnly: true });
        try {
          db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
        } finally {
          db.close();
        }
        files.push({ name: `${name}.gz`, bytes: await gzip(tmp, join(folder, `${name}.gz`)) });
        rmSync(tmp, { force: true });
      } else if (name.endsWith(".json")) {
        files.push({ name: `${name}.gz`, bytes: await gzip(src, join(folder, `${name}.gz`)) });
      }
    }
    writeFileSync(join(folder, "manifest.json"), JSON.stringify({ at: now.toISOString(), files }, null, 2));

    // The first snapshot of each day is also kept as that day's daily.
    const day = join(dailyDir, stamp(now, false));
    const firstOfDay = !existsSync(day);
    if (firstOfDay) {
      mkdirSync(dailyDir, { recursive: true });
      cpSync(folder, day, { recursive: true });
    }
    if (this.o.offsite) {
      try {
        await this.o.offsite(folder, files, now, firstOfDay);
      } catch (e) {
        this.o.log?.(`backup: off-site copy failed: ${(e as Error).message}`);
      }
    }
    prune(hourlyDir, this.o.hourly);
    prune(dailyDir, this.o.daily);

    const result = { folder, files, ms: Date.now() - started };
    this.last = result;
    const total = files.reduce((n, f) => n + f.bytes, 0);
    this.o.log?.(`backup: ${files.length} files, ${(total / 1e6).toFixed(1)} MB in ${result.ms} ms`);
    return result;
  }
}

async function gzip(src: string, dest: string): Promise<number> {
  await pipeline(createReadStream(src), createGzip({ level: 6 }), createWriteStream(dest));
  return statSync(dest).size;
}

/** Keep the newest `keep` folders (names sort by time). */
function prune(dir: string, keep: number) {
  if (!existsSync(dir)) return;
  const all = readdirSync(dir).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(dir, old), { recursive: true, force: true });
}
