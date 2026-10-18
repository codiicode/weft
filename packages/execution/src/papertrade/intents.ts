import { concat, hashTypedData, keccak256, recoverAddress, toBytes, type Hex } from "viem";

/**
 * Papertrade's signed intents (EIP-712). Every write to Papertrade is a typed-data message signed
 * off chain and posted to its relayer, which batches them on HyperEVM.
 *
 * The exchange domain's name is the literal string "String": a real mainnet Close only recovers to
 * the trader's registered session key under that name (checked in our tests against Papertrade's
 * own record of the wallet's session keys).
 */

export const PT_CHAIN_ID = 999;
export const PT_EXCHANGE = "0x6cd5661646289fb6e65ea5c032310fded797d0a2" as const;

export const PT_TYPES = {
  RegisterSessionKey: [
    { name: "user", type: "address" },
    { name: "key", type: "address" },
    { name: "expiry", type: "uint64" },
    { name: "feeAddress", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  OpenPosition: [
    { name: "user", type: "address" },
    { name: "instrumentId", type: "uint32" },
    { name: "isLong", type: "bool" },
    { name: "size", type: "uint128" },
    { name: "leverage", type: "uint32" },
    { name: "useDebt", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  Close: [
    { name: "user", type: "address" },
    { name: "positionIds", type: "uint256[]" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export type PtType = keyof typeof PT_TYPES;
export type PtDomain = { name: string; version: string; chainId: number; verifyingContract: Hex };

export const exchangeDomain = (): PtDomain => ({ name: "String", version: "1", chainId: PT_CHAIN_ID, verifyingContract: PT_EXCHANGE });

/** What the relayer reads: uints as decimal strings, addresses lowercase, bools as is, plus v/r/s. */
export type WireIntent = Record<string, string | boolean | string[]> & { v: string; r: Hex; s: Hex };

function typed(type: PtType, message: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const f of PT_TYPES[type]) {
    const v = message[f.name];
    if (v === undefined) throw new Error(`${type}.${f.name} is required`);
    out[f.name] = f.type === "uint256[]" ? (v as (string | number | bigint)[]).map((x) => BigInt(x)) : f.type.startsWith("uint") ? BigInt(v as string | number | bigint) : f.type === "address" ? (String(v).toLowerCase() as Hex) : v;
  }
  return out;
}

function wire(type: PtType, message: Record<string, unknown>): Record<string, string | boolean | string[]> {
  const t = typed(type, message);
  const out: Record<string, string | boolean | string[]> = {};
  for (const f of PT_TYPES[type]) {
    const v = t[f.name];
    out[f.name] = Array.isArray(v) ? v.map((x) => (x as bigint).toString()) : typeof v === "bigint" ? v.toString() : (v as string | boolean);
  }
  return out;
}

export function digestOf(type: PtType, message: Record<string, unknown>, domain = exchangeDomain()): Hex {
  return hashTypedData({ domain, types: { [type]: PT_TYPES[type] }, primaryType: type, message: typed(type, message) } as unknown as Parameters<typeof hashTypedData>[0]);
}

const PREFIX = keccak256(toBytes("papertrade:intent-id:v2"));
/** The id Papertrade records for an intent: keccak256(keccak256(prefix) ++ digest ++ signer). */
export const intentIdOf = (digest: Hex, signer: Hex): Hex => keccak256(concat([PREFIX, digest, signer.toLowerCase() as Hex]));

/** Signs EIP-712 typed data (a viem account, or a Privy server wallet behind an adapter). */
export interface PtSigner {
  address: Hex;
  signTypedData(td: { domain: PtDomain; types: Record<string, readonly { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> }): Promise<Hex>;
}

/** Sign an intent and return it in the relayer's wire form, with its intent id. */
export async function signIntent(signer: PtSigner, type: PtType, message: Record<string, unknown>, domain = exchangeDomain()): Promise<{ signed: WireIntent; intentId: Hex }> {
  const sig = await signer.signTypedData({ domain, types: { [type]: PT_TYPES[type] }, primaryType: type, message: typed(type, message) });
  const hex = sig.slice(2);
  if (hex.length !== 130) throw new Error("the signer returned a malformed signature");
  const v = parseInt(hex.slice(128, 130), 16);
  const signed: WireIntent = { ...wire(type, message), v: String(v < 27 ? v + 27 : v), r: `0x${hex.slice(0, 64)}` as Hex, s: `0x${hex.slice(64, 128)}` as Hex };
  return { signed, intentId: intentIdOf(digestOf(type, message, domain), signer.address) };
}

/** Who signed a wire intent, and its id (what the relayer recomputes). */
export async function inspectIntent(type: PtType, signed: WireIntent, domain = exchangeDomain()): Promise<{ signer: Hex; intentId: Hex }> {
  const digest = digestOf(type, signed, domain);
  const signer = (await recoverAddress({ hash: digest, signature: { r: signed.r, s: signed.s, v: BigInt(signed.v) } })).toLowerCase() as Hex;
  return { signer, intentId: intentIdOf(digest, signer) };
}
