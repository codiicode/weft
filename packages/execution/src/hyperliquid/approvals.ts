import type { Hex } from "viem";
import {
  APPROVE_AGENT_TYPES,
  APPROVE_BUILDER_FEE_TYPES,
  WITHDRAW_TYPES,
  SPOT_SEND_TYPES,
  USD_CLASS_TRANSFER_TYPES,
  DEFAULT_SIGNATURE_CHAIN_ID,
  floatToWire,
  recoverUserSigner,
  splitSignature,
  userSignedTypedData,
  type Eip712Field,
  type Signature,
} from "./signing.ts";
import type { ExchangeRequest } from "./exchange.ts";

/**
 * Payloads the USER signs in their own wallet. Weft never sees the user's main key:
 * it builds the EIP-712 typed data, the user's wallet signs it (eth_signTypedData_v4 /
 * viem `walletClient.signTypedData`), and `toRequest(signature)` assembles the /exchange body.
 *
 *  - approveAgent: authorises Weft's per-user agent (API) wallet to TRADE. Agent wallets
 *    cannot withdraw or transfer funds.
 *  - approveBuilderFee: lets orders carry Weft's builder code up to `maxFeeRate`.
 */
export interface UserSignRequest<A extends Record<string, unknown>> {
  /** The action exactly as it will be posted. */
  action: A;
  nonce: number;
  /** Hand to the wallet: `walletClient.signTypedData(typedData)`. JSON-serialisable. */
  typedData: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Hex };
    types: Record<string, Eip712Field[]>;
    primaryType: string;
    message: Record<string, unknown>;
  };
  /** Assemble the /exchange body from the wallet's signature; optionally checks the signer. */
  toRequest(signature: Hex | Signature, expectedSigner?: Hex): Promise<ExchangeRequest>;
}

interface CommonOpts {
  isMainnet: boolean;
  /** Defaults to Date.now(). Must be the same in the action and the request body. */
  nonce?: number;
  /**
   * Chain id the wallet signs with (hex). The SDK uses 0x66eee; browser wallets may refuse
   * to sign typed data for a chain other than the connected one, so pass the wallet's chain.
   */
  signatureChainId?: string;
}

function build<A extends Record<string, unknown> & { signatureChainId: string }>(
  primaryType: string,
  types: Eip712Field[],
  signedAction: A,
  postedAction: Record<string, unknown>,
  nonce: number
): UserSignRequest<A> {
  const td = userSignedTypedData(primaryType, types, signedAction);
  return {
    action: postedAction as A,
    nonce,
    typedData: td as UserSignRequest<A>["typedData"],
    async toRequest(signature, expectedSigner) {
      const sig = typeof signature === "string" ? splitSignature(signature) : signature;
      if (expectedSigner) {
        const who = await recoverUserSigner(signedAction, sig, types, primaryType);
        if (who.toLowerCase() !== expectedSigner.toLowerCase())
          throw new Error(`signature was made by ${who}, expected ${expectedSigner}`);
      }
      return { action: postedAction, nonce, signature: sig, vaultAddress: null };
    },
  };
}

/** Python: `Exchange.approve_agent` (minus key generation: the agent key lives in Weft's signer). */
export function buildApproveAgent(
  opts: CommonOpts & { agentAddress: Hex; agentName?: string; validUntil?: number }
): UserSignRequest<Record<string, unknown> & { signatureChainId: string }> {
  const nonce = opts.nonce ?? Date.now();
  let name = opts.agentName;
  if (opts.validUntil != null) name = `${name ?? ""} valid_until ${opts.validUntil}`.trim();
  const signed = {
    type: "approveAgent",
    agentAddress: opts.agentAddress,
    agentName: name ?? "",
    nonce,
    signatureChainId: opts.signatureChainId ?? DEFAULT_SIGNATURE_CHAIN_ID,
    hyperliquidChain: opts.isMainnet ? "Mainnet" : "Testnet",
  };
  // Like the SDK: an unnamed agent is signed with agentName "" and posted without the key.
  const posted: Record<string, unknown> = { ...signed };
  if (name == null) delete posted.agentName;
  return build("HyperliquidTransaction:ApproveAgent", APPROVE_AGENT_TYPES, signed, posted, nonce);
}

/** Builder fee in tenths of a basis point → the percent string the venue expects (50 → "0.05%"). */
export function feeTenthsBpsToPercent(f: number): string {
  if (!Number.isInteger(f) || f < 0) throw new Error(`builder fee must be a non-negative integer (tenths of bps), got ${f}`);
  return `${floatToWire(f / 1000)}%`;
}

/** Python: `Exchange.approve_builder_fee`. */
export function buildApproveBuilderFee(
  opts: CommonOpts & { builder: Hex; maxFeeTenthsBps?: number; maxFeeRate?: string }
): UserSignRequest<Record<string, unknown> & { signatureChainId: string }> {
  const nonce = opts.nonce ?? Date.now();
  const maxFeeRate = opts.maxFeeRate ?? feeTenthsBpsToPercent(opts.maxFeeTenthsBps ?? 50);
  if (!/^\d+(\.\d+)?%$/.test(maxFeeRate)) throw new Error(`maxFeeRate must look like "0.05%", got ${maxFeeRate}`);
  // Same key order as the SDK, then the fields sign_user_signed_action appends.
  const signed = {
    maxFeeRate,
    builder: opts.builder,
    nonce,
    type: "approveBuilderFee",
    signatureChainId: opts.signatureChainId ?? DEFAULT_SIGNATURE_CHAIN_ID,
    hyperliquidChain: opts.isMainnet ? "Mainnet" : "Testnet",
  };
  return build("HyperliquidTransaction:ApproveBuilderFee", APPROVE_BUILDER_FEE_TYPES, signed, { ...signed }, nonce);
}

/**
 * Python: `Exchange.withdraw_from_bridge`. Sends USDC from the user's Hyperliquid account to
 * `destination` on Arbitrum (Hyperliquid charges a $1 fee). Only the account owner can sign
 * this: agent wallets cannot withdraw.
 */
export function buildWithdraw(
  opts: CommonOpts & { destination: Hex; amountUsd: number }
): UserSignRequest<Record<string, unknown> & { signatureChainId: string }> {
  const nonce = opts.nonce ?? Date.now();
  if (!(opts.amountUsd > 0)) throw new Error("withdraw amount must be positive");
  const signed = {
    destination: opts.destination,
    amount: floatToWire(opts.amountUsd),
    time: nonce,
    type: "withdraw3",
    signatureChainId: opts.signatureChainId ?? DEFAULT_SIGNATURE_CHAIN_ID,
    hyperliquidChain: opts.isMainnet ? "Mainnet" : "Testnet",
  };
  return build("HyperliquidTransaction:Withdraw", WITHDRAW_TYPES, signed, { ...signed }, nonce);
}

/** Python: `Exchange.spot_transfer`. Sends a spot token (e.g. "USDC:0x6d1e…") to another HyperCore address. */
export function buildSpotSend(
  opts: CommonOpts & { destination: Hex; token: string; amount: string }
): UserSignRequest<Record<string, unknown> & { signatureChainId: string }> {
  const nonce = opts.nonce ?? Date.now();
  const signed = {
    destination: opts.destination.toLowerCase(),
    token: opts.token,
    amount: opts.amount,
    time: nonce,
    type: "spotSend",
    signatureChainId: opts.signatureChainId ?? DEFAULT_SIGNATURE_CHAIN_ID,
    hyperliquidChain: opts.isMainnet ? "Mainnet" : "Testnet",
  };
  return build("HyperliquidTransaction:SpotSend", SPOT_SEND_TYPES, signed, { ...signed }, nonce);
}

/** Python: `Exchange.usd_class_transfer`. Moves USDC between the perp and spot balances. */
export function buildUsdClassTransfer(
  opts: CommonOpts & { amount: string; toPerp: boolean }
): UserSignRequest<Record<string, unknown> & { signatureChainId: string }> {
  const nonce = opts.nonce ?? Date.now();
  const signed = {
    amount: opts.amount,
    toPerp: opts.toPerp,
    nonce,
    type: "usdClassTransfer",
    signatureChainId: opts.signatureChainId ?? DEFAULT_SIGNATURE_CHAIN_ID,
    hyperliquidChain: opts.isMainnet ? "Mainnet" : "Testnet",
  };
  return build("HyperliquidTransaction:UsdClassTransfer", USD_CLASS_TRANSFER_TYPES, signed, { ...signed }, nonce);
}
