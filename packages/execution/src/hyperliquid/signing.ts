import { encode as msgpackEncode } from "@msgpack/msgpack";
import { keccak256, parseSignature, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Hyperliquid signing, ported 1:1 from the official Python SDK
 * (hyperliquid-python-sdk `hyperliquid/utils/signing.py`). Proven against the SDK's own
 * test vectors in `test/hyperliquid-signing.test.ts`.
 *
 * Two signature schemes exist:
 *  - **L1 actions** (orders, cancels, leverage…): msgpack(action) is hashed with the nonce,
 *    vault and expiry into a `connectionId`, wrapped in a "phantom agent" and signed with
 *    EIP-712 domain `Exchange` / chainId 1337. These can be signed by an approved
 *    agent (API) wallet: that is how Weft trades without ever holding the user's key.
 *  - **User-signed actions** (approveAgent, approveBuilderFee, transfers…): plain EIP-712
 *    over the action fields with domain `HyperliquidSignTransaction`. These must be signed
 *    by the user's main wallet; Weft only *builds* them (see `approvals.ts`).
 */

export interface Signature {
  r: Hex;
  s: Hex;
  v: number;
}

/** Anything that can sign EIP-712 typed data: a viem LocalAccount, or a remote/KMS signer. */
export interface TypedDataSigner {
  readonly address: Hex;
  signTypedData(params: {
    domain: Record<string, unknown>;
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
}

export function signerFromPrivateKey(privateKey: Hex): TypedDataSigner {
  const acct = privateKeyToAccount(privateKey);
  return {
    address: acct.address,
    // viem's generic typing is stricter than our structural one; the runtime contract is identical.
    signTypedData: (p) => acct.signTypedData(p as Parameters<typeof acct.signTypedData>[0]),
  };
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/* ------------------------------------------------------------------ */
/* Number formatting                                                    */
/* ------------------------------------------------------------------ */

/**
 * Python: `float_to_wire`. Format with 8 decimals, refuse if that rounds, then strip
 * trailing zeros (Decimal.normalize + "f" formatting).
 */
export function floatToWire(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`floatToWire: not a finite number: ${x}`);
  const rounded = x.toFixed(8);
  if (Math.abs(Number(rounded) - x) >= 1e-12) throw new Error(`floatToWire causes rounding: ${x}`);
  let s = rounded.includes(".") ? rounded.replace(/0+$/, "").replace(/\.$/, "") : rounded;
  if (s === "-0") s = "0";
  return s;
}

/** Python: `float_to_int(x, power)`. */
export function floatToInt(x: number, power: number): number {
  const withDecimals = x * 10 ** power;
  if (Math.abs(Math.round(withDecimals) - withDecimals) >= 1e-3) throw new Error(`floatToInt causes rounding: ${x}`);
  return Math.round(withDecimals);
}

export const floatToIntForHashing = (x: number) => floatToInt(x, 8);
export const floatToUsdInt = (x: number) => floatToInt(x, 6);

/* ------------------------------------------------------------------ */
/* L1 actions                                                           */
/* ------------------------------------------------------------------ */

/**
 * msgpack-encode exactly like Python's `msgpack.packb(action)`: dict insertion order,
 * smallest int encodings, str8 strings, float64 for non-integers. Keys whose value is
 * `undefined` are dropped (Python dicts would simply not contain them).
 */
export function packAction(action: unknown): Uint8Array {
  return msgpackEncode(action, { ignoreUndefined: true });
}

function u64be(n: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

function addressBytes(address: string): Uint8Array {
  const hex = address.startsWith("0x") ? address.slice(2) : address;
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) throw new Error(`invalid address ${address}`);
  return Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
}

/**
 * Python: `action_hash`. keccak(msgpack(action) ‖ nonce u64be ‖ vault flag[+addr] ‖ [0x00 ‖ expiresAfter u64be]).
 */
export function actionHash(
  action: unknown,
  vaultAddress: string | null | undefined,
  nonce: number,
  expiresAfter?: number | null
): Hex {
  const parts: Uint8Array[] = [packAction(action), u64be(nonce)];
  if (vaultAddress == null) parts.push(Uint8Array.of(0));
  else parts.push(Uint8Array.of(1), addressBytes(vaultAddress));
  if (expiresAfter != null) parts.push(Uint8Array.of(0), u64be(expiresAfter));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const data = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    data.set(p, o);
    o += p.length;
  }
  return keccak256(data);
}

export function constructPhantomAgent(hash: Hex, isMainnet: boolean): { source: "a" | "b"; connectionId: Hex } {
  return { source: isMainnet ? "a" : "b", connectionId: hash };
}

/** EIP-712 payload for an L1 action (Python: `l1_payload`). */
export function l1TypedData(phantomAgent: { source: string; connectionId: Hex }) {
  return {
    domain: { chainId: 1337, name: "Exchange", verifyingContract: ZERO_ADDRESS, version: "1" },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent" as const,
    message: phantomAgent,
  };
}

export function splitSignature(sig: Hex): Signature {
  const p = parseSignature(sig);
  const v = p.v != null ? Number(p.v) : 27 + (p.yParity ?? 0);
  return { r: p.r, s: p.s, v };
}

/** Python: `sign_l1_action`. */
export async function signL1Action(
  signer: TypedDataSigner,
  action: unknown,
  vaultAddress: string | null | undefined,
  nonce: number,
  expiresAfter: number | null | undefined,
  isMainnet: boolean
): Promise<Signature> {
  const hash = actionHash(action, vaultAddress, nonce, expiresAfter);
  const data = l1TypedData(constructPhantomAgent(hash, isMainnet));
  return splitSignature(await signer.signTypedData(data));
}

/** Python: `recover_agent_or_user_from_l1_action`. Used by tests and as a pre-send self-check. */
export async function recoverL1Signer(
  action: unknown,
  signature: Signature,
  vaultAddress: string | null | undefined,
  nonce: number,
  expiresAfter: number | null | undefined,
  isMainnet: boolean
): Promise<Hex> {
  const hash = actionHash(action, vaultAddress, nonce, expiresAfter);
  const data = l1TypedData(constructPhantomAgent(hash, isMainnet));
  return recoverTypedDataAddress({ ...data, signature: joinSignature(signature) });
}

export function joinSignature(sig: Signature): Hex {
  const pad = (h: Hex) => h.slice(2).padStart(64, "0");
  return `0x${pad(sig.r)}${pad(sig.s)}${sig.v.toString(16).padStart(2, "0")}` as Hex;
}

/* ------------------------------------------------------------------ */
/* User-signed actions                                                  */
/* ------------------------------------------------------------------ */

export type Eip712Field = { name: string; type: string };

/** Hyperliquid's default signature chain (Arbitrum Sepolia id); any chain id is accepted by the venue. */
export const DEFAULT_SIGNATURE_CHAIN_ID = "0x66eee";

export const APPROVE_AGENT_TYPES: Eip712Field[] = [
  { name: "hyperliquidChain", type: "string" },
  { name: "agentAddress", type: "address" },
  { name: "agentName", type: "string" },
  { name: "nonce", type: "uint64" },
];

export const APPROVE_BUILDER_FEE_TYPES: Eip712Field[] = [
  { name: "hyperliquidChain", type: "string" },
  { name: "maxFeeRate", type: "string" },
  { name: "builder", type: "address" },
  { name: "nonce", type: "uint64" },
];

export const USD_SEND_TYPES: Eip712Field[] = [
  { name: "hyperliquidChain", type: "string" },
  { name: "destination", type: "string" },
  { name: "amount", type: "string" },
  { name: "time", type: "uint64" },
];

export const WITHDRAW_TYPES = USD_SEND_TYPES;

/**
 * Python: `user_signed_payload`. The message contains only the typed fields (eth_account
 * ignores the extra `type` / `signatureChainId` keys; we drop them explicitly).
 */
export function userSignedTypedData(
  primaryType: string,
  payloadTypes: Eip712Field[],
  action: Record<string, unknown> & { signatureChainId: string }
) {
  const message: Record<string, unknown> = {};
  for (const f of payloadTypes) {
    const v = action[f.name];
    if (v === undefined) throw new Error(`user-signed action missing field ${f.name}`);
    message[f.name] = v;
  }
  return {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: parseInt(action.signatureChainId, 16),
      verifyingContract: ZERO_ADDRESS,
    },
    types: { [primaryType]: payloadTypes },
    primaryType,
    message,
  };
}

/**
 * Python: `sign_user_signed_action`. Mutates nothing: returns the completed action
 * (with signatureChainId + hyperliquidChain) and its signature.
 *
 * Weft never calls this with a user's main key in production: the user signs in their own
 * wallet. It exists so the typed-data construction is proven against SDK vectors, and for
 * testnet tooling with throwaway keys.
 */
export async function signUserSignedAction<A extends Record<string, unknown>>(
  signer: TypedDataSigner,
  action: A,
  payloadTypes: Eip712Field[],
  primaryType: string,
  isMainnet: boolean,
  signatureChainId: string = DEFAULT_SIGNATURE_CHAIN_ID
): Promise<{ action: A & { signatureChainId: string; hyperliquidChain: string }; signature: Signature }> {
  const full = { ...action, signatureChainId, hyperliquidChain: isMainnet ? "Mainnet" : "Testnet" };
  const data = userSignedTypedData(primaryType, payloadTypes, full);
  return { action: full, signature: splitSignature(await signer.signTypedData(data)) };
}

export async function recoverUserSigner(
  action: Record<string, unknown> & { signatureChainId: string },
  signature: Signature,
  payloadTypes: Eip712Field[],
  primaryType: string
): Promise<Hex> {
  const data = userSignedTypedData(primaryType, payloadTypes, action);
  return recoverTypedDataAddress({ ...data, signature: joinSignature(signature) } as unknown as Parameters<typeof recoverTypedDataAddress>[0]);
}
