import { HL_MAINNET_URL, HL_TESTNET_URL, postJson, type FetchLike } from "./info.ts";
import { recoverL1Signer, signL1Action, type Signature, type TypedDataSigner } from "./signing.ts";

/** Body of POST /exchange. */
export interface ExchangeRequest {
  action: unknown;
  nonce: number;
  signature: Signature;
  vaultAddress: string | null;
  expiresAfter?: number;
}

export type OrderStatus =
  | { filled: { totalSz: string; avgPx: string; oid: number; cloid?: string } }
  | { resting: { oid: number; cloid?: string } }
  | { error: string }
  | "waitingForFill"
  | "waitingForTrigger"
  | "success";

export type ExchangeResponse =
  | { status: "ok"; response: { type: "order"; data: { statuses: OrderStatus[] } } }
  | { status: "ok"; response: { type: "cancel" | "cancelByCloid"; data: { statuses: ({ error: string } | "success")[] } } }
  | { status: "ok"; response: { type: string; data?: unknown } }
  | { status: "err"; response: string };

export interface ExchangeClientOptions {
  /** The agent (API) wallet. Never the user's main key. */
  signer: TypedDataSigner;
  isMainnet: boolean;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Subaccount / vault to trade for (the agent must be approved by its master). */
  vaultAddress?: string | null;
  /** If set, actions expire this many ms after signing (`expiresAfter`). */
  expiresAfterMs?: number;
  /**
   * Hard guard: POSTing to mainnet requires this to be true. Signing (dry runs) is always allowed.
   */
  allowMainnetSend?: boolean;
  /** Clock, for tests. */
  now?: () => number;
}

/**
 * Low-level signed /exchange client: nonce management, L1 signing, posting.
 * Nonces are millisecond timestamps, strictly increasing per client (Hyperliquid keeps the
 * 100 highest nonces per signer and rejects reuse).
 */
export class HlExchangeClient {
  readonly isMainnet: boolean;
  readonly baseUrl: string;
  private lastNonce = 0;

  private readonly opts: ExchangeClientOptions;
  constructor(opts: ExchangeClientOptions) {
    this.opts = opts;
    this.isMainnet = opts.isMainnet;
    this.baseUrl = opts.baseUrl ?? (opts.isMainnet ? HL_MAINNET_URL : HL_TESTNET_URL);
    if (!opts.isMainnet && this.baseUrl === HL_MAINNET_URL) throw new Error("testnet client pointed at the mainnet URL");
    if (opts.isMainnet && this.baseUrl === HL_TESTNET_URL) throw new Error("mainnet client pointed at the testnet URL");
  }

  get agentAddress() {
    return this.opts.signer.address;
  }

  nextNonce(): number {
    const now = (this.opts.now ?? Date.now)();
    this.lastNonce = Math.max(now, this.lastNonce + 1);
    return this.lastNonce;
  }

  /** Sign an L1 action into a ready-to-post body (nothing is sent). */
  async sign(action: unknown, nonce = this.nextNonce()): Promise<ExchangeRequest> {
    const vault = this.opts.vaultAddress ?? null;
    const expiresAfter = this.opts.expiresAfterMs != null ? nonce + this.opts.expiresAfterMs : undefined;
    const signature = await signL1Action(this.opts.signer, action, vault, nonce, expiresAfter, this.isMainnet);
    // Self-check: the signature must recover to our agent, or the venue would attribute it elsewhere.
    const who = await recoverL1Signer(action, signature, vault, nonce, expiresAfter, this.isMainnet);
    if (who.toLowerCase() !== this.opts.signer.address.toLowerCase()) throw new Error(`signature self-check failed: recovered ${who}`);
    const req: ExchangeRequest = { action, nonce, signature, vaultAddress: vault };
    if (expiresAfter != null) req.expiresAfter = expiresAfter;
    return req;
  }

  async post(req: ExchangeRequest): Promise<ExchangeResponse> {
    if (this.isMainnet && !this.opts.allowMainnetSend) throw new Error("refusing to POST to Hyperliquid mainnet: allowMainnetSend is not set");
    const fetchFn = this.opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    return postJson<ExchangeResponse>(fetchFn, `${this.baseUrl}/exchange`, req);
  }
}

/** Extract per-order statuses or throw on a top-level error. */
export function orderStatuses(res: ExchangeResponse): OrderStatus[] {
  if (res.status === "err") throw new Error(`hyperliquid: ${res.response}`);
  const data = (res.response as { data?: { statuses?: OrderStatus[] } }).data;
  return data?.statuses ?? [];
}
