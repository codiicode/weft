import { randomBytes, timingSafeEqual } from "node:crypto";
import type { HeliusTx, HeliusWallets } from "@weft/venues";

/**
 * Helius pushes a transaction the moment a watched Solana wallet makes one, so wallet signals and
 * copy trading react in seconds instead of on the next check. One webhook holds every address that
 * a running strategy watches; it is created on first use and kept in step as strategies start and
 * stop. The parsed transactions go straight into the shared wallet cache, and the strategies that
 * watch that wallet get checked right away.
 */
const API = "https://api-mainnet.helius-rpc.com/v0/webhooks";
const KV = "helius-webhook";

interface Saved {
  id: string | null;
  secret: string;
  addresses: string[];
}

export interface HeliusWebhookDeps {
  apiKey: string;
  /** Public base URL of this API, e.g. https://weft-api-production.up.railway.app */
  publicUrl: string;
  wallets: HeliusWallets;
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
  /** Called with the watched addresses that just traded. */
  onActivity(addresses: string[]): void;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

export class HeliusWebhook {
  private saved: Saved;
  private readonly f: typeof fetch;
  private readonly d: HeliusWebhookDeps;

  constructor(d: HeliusWebhookDeps) {
    this.d = d;
    this.f = d.fetch ?? fetch;
    const raw = d.kvGet(KV);
    this.saved = raw ? (JSON.parse(raw) as Saved) : { id: null, secret: randomBytes(24).toString("hex"), addresses: [] };
    if (!raw) this.persist();
  }

  private persist() {
    this.d.kvSet(KV, JSON.stringify(this.saved));
  }

  get url() {
    return `${this.d.publicUrl.replace(/\/$/, "")}/webhooks/helius`;
  }

  /** Make the webhook watch exactly these addresses (no call when nothing changed). */
  async sync(addresses: string[]): Promise<void> {
    const want = [...new Set(addresses)].sort();
    if (want.join() === [...this.saved.addresses].sort().join() && (this.saved.id || !want.length)) return;
    const q = `?api-key=${this.d.apiKey}`;
    if (!want.length) {
      if (this.saved.id) await this.f(`${API}/${this.saved.id}${q}`, { method: "DELETE" }).catch(() => null);
      this.saved = { ...this.saved, id: null, addresses: [] };
      this.persist();
      this.d.log?.("helius webhook: removed (no wallets watched)");
      return;
    }
    const body = JSON.stringify({ webhookURL: this.url, transactionTypes: ["ANY"], accountAddresses: want, webhookType: "enhanced", authHeader: this.saved.secret });
    let res = this.saved.id ? await this.f(`${API}/${this.saved.id}${q}`, { method: "PUT", headers: { "content-type": "application/json" }, body }) : null;
    // No webhook yet, or it was deleted on Helius' side: create one.
    if (!res || res.status === 404) res = await this.f(`${API}${q}`, { method: "POST", headers: { "content-type": "application/json" }, body });
    if (!res.ok) throw new Error(`helius webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { webhookID?: string };
    this.saved = { ...this.saved, id: json.webhookID ?? this.saved.id, addresses: want };
    this.persist();
    this.d.log?.(`helius webhook: watching ${want.length} wallet${want.length === 1 ? "" : "s"}`);
  }

  /** Checks the shared secret Helius sends back in the Authorization header. */
  authorized(header: string | undefined): boolean {
    if (!header) return false;
    const a = Buffer.from(header);
    const b = Buffer.from(this.saved.secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** A delivery from Helius: cache the transactions per watched wallet and report who traded. */
  handle(txs: HeliusTx[]): string[] {
    const watched = new Set(this.saved.addresses);
    const byAddress = new Map<string, HeliusTx[]>();
    for (const tx of Array.isArray(txs) ? txs : []) {
      const involved = new Set<string>();
      const t = tx as HeliusTx & { feePayer?: string; nativeTransfers?: { fromUserAccount?: string; toUserAccount?: string }[] };
      if (t.feePayer) involved.add(t.feePayer);
      for (const x of t.tokenTransfers ?? []) [x.fromUserAccount, x.toUserAccount].forEach((a) => a && involved.add(a));
      for (const x of t.nativeTransfers ?? []) [x.fromUserAccount, x.toUserAccount].forEach((a) => a && involved.add(a));
      for (const x of t.accountData ?? []) involved.add(x.account);
      for (const a of involved) if (watched.has(a)) byAddress.set(a, [...(byAddress.get(a) ?? []), tx]);
    }
    for (const [a, list] of byAddress) this.d.wallets.ingest(a, list);
    const who = [...byAddress.keys()];
    if (who.length) this.d.onActivity(who);
    return who;
  }
}
