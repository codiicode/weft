import { createECDH, createPrivateKey, sign as nodeSign } from "node:crypto";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { FetchLike } from "../hyperliquid/info.ts";

/**
 * A Solana signer. Weft never holds a user's Solana key in production: the user's wallet lives in
 * a policy-controlled signer (Turnkey), whose policy only allows the swap programs and transfers
 * back to the user. `LocalKeypairSigner` exists for devnet and tests only.
 */
export interface Signer {
  readonly publicKey: PublicKey;
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
}

export type Cluster = "devnet" | "testnet" | "localnet" | "mainnet-beta";

/** Devnet / localnet / tests only. Refuses to exist for mainnet. */
export class LocalKeypairSigner implements Signer {
  readonly publicKey: PublicKey;
  constructor(
    private readonly keypair: Keypair,
    readonly cluster: Exclude<Cluster, "mainnet-beta">
  ) {
    if ((cluster as Cluster) === "mainnet-beta") throw new Error("LocalKeypairSigner is for devnet/tests only; use a policy signer on mainnet");
    this.publicKey = keypair.publicKey;
  }
  async signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction> {
    tx.sign([this.keypair]);
    return tx;
  }
}

/* ------------------------------------------------------------------ */
/* Turnkey                                                              */
/* ------------------------------------------------------------------ */

/** Produces the `X-Stamp` header value for a request body. */
export interface TurnkeyStamper {
  stamp(body: string): Promise<{ header: "X-Stamp"; value: string }>;
}

/**
 * API-key stamper per Turnkey's "Stamps" docs: ECDSA P-256 / SHA-256 over the exact JSON body,
 * DER-encoded and hex'd; stamp = base64url(JSON { publicKey, signature, scheme }).
 * `privateKeyHex` is the API key's raw 32-byte private scalar; `publicKeyHex` its compressed point.
 */
export class TurnkeyApiKeyStamper implements TurnkeyStamper {
  private readonly key: ReturnType<typeof createPrivateKey>;
  constructor(
    private readonly publicKeyHex: string,
    privateKeyHex: string
  ) {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(privateKeyHex, "hex"));
    const pub = ecdh.getPublicKey(); // 0x04 ‖ x ‖ y
    const b64u = (b: Buffer) => b.toString("base64url");
    this.key = createPrivateKey({
      key: { kty: "EC", crv: "P-256", d: b64u(Buffer.from(privateKeyHex, "hex")), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
      format: "jwk",
    });
    const compressed = ecdh.getPublicKey(undefined, "compressed").toString("hex");
    if (compressed !== publicKeyHex.toLowerCase()) throw new Error("Turnkey API public key does not match the private key");
  }
  async stamp(body: string) {
    const signature = nodeSign("sha256", Buffer.from(body), { key: this.key, dsaEncoding: "der" }).toString("hex");
    const stamp = { publicKey: this.publicKeyHex, signature, scheme: "SIGNATURE_SCHEME_TK_API_P256" };
    return { header: "X-Stamp" as const, value: Buffer.from(JSON.stringify(stamp)).toString("base64url") };
  }
}

export interface TurnkeySignerOptions {
  organizationId: string;
  /** Wallet account address (the user's Solana address) or private key id. */
  signWith: string;
  publicKey: PublicKey;
  stamper: TurnkeyStamper;
  baseUrl?: string;
  fetch?: FetchLike;
  now?: () => number;
}

/** Body of POST /public/v1/submit/sign_transaction (Turnkey public API swagger: SignTransactionRequest). */
export function turnkeySignTransactionBody(o: { organizationId: string; signWith: string; unsignedTransactionHex: string; timestampMs: number }) {
  return {
    type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2" as const,
    timestampMs: String(o.timestampMs),
    organizationId: o.organizationId,
    parameters: { signWith: o.signWith, unsignedTransaction: o.unsignedTransactionHex, type: "TRANSACTION_TYPE_SOLANA" as const },
  };
}

/**
 * Turnkey policy signer. Request/response shapes follow Turnkey's public OpenAPI spec
 * (`SignTransactionRequest` / `ActivityResponse.activity.result.signTransactionResult.signedTransaction`)
 * and the documented API-key stamp. UNTESTED against a live Turnkey org (none available):
 * verify with Turnkey's docs/SDK (`@turnkey/solana`) before production use. Activities that need
 * consensus (`ACTIVITY_STATUS_CONSENSUS_NEEDED`) are surfaced as errors, never retried blindly.
 */
export class TurnkeySigner implements Signer {
  readonly publicKey: PublicKey;
  constructor(private readonly o: TurnkeySignerOptions) {
    this.publicKey = o.publicKey;
  }

  async signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction> {
    const body = JSON.stringify(
      turnkeySignTransactionBody({
        organizationId: this.o.organizationId,
        signWith: this.o.signWith,
        unsignedTransactionHex: Buffer.from(tx.serialize()).toString("hex"),
        timestampMs: (this.o.now ?? Date.now)(),
      })
    );
    const { header, value } = await this.o.stamper.stamp(body);
    const fetchFn = this.o.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const res = await fetchFn(`${this.o.baseUrl ?? "https://api.turnkey.com"}/public/v1/submit/sign_transaction`, {
      method: "POST",
      headers: { "content-type": "application/json", [header]: value },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`turnkey sign_transaction HTTP ${res.status}: ${text.slice(0, 300)}`);
    const json = JSON.parse(text) as {
      activity?: { status?: string; result?: { signTransactionResult?: { signedTransaction?: string } }; failure?: unknown };
    };
    const a = json.activity;
    if (a?.status !== "ACTIVITY_STATUS_COMPLETED") throw new Error(`turnkey activity not completed: ${a?.status ?? "no activity"} ${JSON.stringify(a?.failure ?? "")}`);
    const signed = a.result?.signTransactionResult?.signedTransaction;
    if (!signed) throw new Error("turnkey response has no signedTransaction");
    const out = VersionedTransaction.deserialize(Buffer.from(signed, "hex"));
    // The signed message must be byte-identical to what we inspected.
    if (!Buffer.from(out.message.serialize()).equals(Buffer.from(tx.message.serialize()))) throw new Error("turnkey returned a different message than the one submitted");
    return out;
  }
}
