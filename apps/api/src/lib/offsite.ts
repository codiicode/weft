import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Off-site copies of the backups in Cloudflare R2 (S3-compatible), so the data survives losing the
 * server's disk. Every snapshot overwrites `latest/`; the day's first also goes to `daily/<date>/`,
 * and the daily copy from `keepDays` ago is deleted. Requests are signed with AWS SigV4.
 */

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function r2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null;
  return { accountId: R2_ACCOUNT_ID.trim(), accessKeyId: R2_ACCESS_KEY_ID.trim(), secretAccessKey: R2_SECRET_ACCESS_KEY.trim(), bucket: R2_BUCKET.trim() };
}

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s).digest();

export class R2 {
  private readonly c: R2Config;
  private readonly host: string;
  constructor(c: R2Config) {
    this.c = c;
    this.host = `${c.accountId}.r2.cloudflarestorage.com`;
  }

  async request(method: "PUT" | "GET" | "DELETE", key: string, body?: Buffer): Promise<Response> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const day = amzDate.slice(0, 8);
    const path = `/${this.c.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const payloadHash = sha256(body ?? "");
    const headers: Record<string, string> = { host: this.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    const signed = Object.keys(headers).sort();
    const canonical = [method, path, "", ...signed.map((h) => `${h}:${headers[h]}`), "", signed.join(";"), payloadHash].join("\n");
    const scope = `${day}/auto/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.c.secretAccessKey}`, day), "auto"), "s3"), "aws4_request");
    const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
    const { host: _host, ...rest } = headers;
    return fetch(`https://${this.host}${path}`, {
      method,
      headers: { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${this.c.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}` },
      body: body ? new Uint8Array(body) : undefined,
    });
  }

  async put(key: string, body: Buffer) {
    const r = await this.request("PUT", key, body);
    if (!r.ok) throw new Error(`R2 PUT ${key}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  async get(key: string): Promise<Buffer> {
    const r = await this.request("GET", key);
    if (!r.ok) throw new Error(`R2 GET ${key}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  async delete(key: string) {
    await this.request("DELETE", key).catch(() => {});
  }
}

/** Upload one snapshot folder (its .gz files and manifest). */
export async function uploadSnapshot(r2: R2, folder: string, files: { name: string }[], now: Date, keepDays = 30, firstOfDay = false) {
  const names = [...files.map((f) => f.name), "manifest.json"];
  for (const name of names) {
    const body = readFileSync(join(folder, name));
    await r2.put(`latest/${name}`, body);
    if (firstOfDay) await r2.put(`daily/${now.toISOString().slice(0, 10)}/${name}`, body);
  }
  if (firstOfDay) {
    const old = new Date(now.getTime() - keepDays * 86_400_000).toISOString().slice(0, 10);
    for (const name of names) await r2.delete(`daily/${old}/${name}`);
  }
}
