import { createHash } from "node:crypto";
import { PrivyClient } from "@privy-io/node";
import type { TypedDataSigner } from "@weft/execution";
import type { Hex } from "viem";
import type { Accounts } from "../lib/accounts.ts";

/**
 * Per-user Hyperliquid agent wallets, held as Privy server wallets.
 *
 * Weft never sees the agent's private key: Privy keeps it in its enclave and
 * signs on our request. Every agent wallet carries a Privy policy that only
 * allows EIP-712 signatures for Hyperliquid L1 actions (domain chainId 1337,
 * verifyingContract 0x0). Withdrawals, transfers, transactions and anything
 * else are refused by Privy itself, on top of Hyperliquid's own rule that
 * agent wallets cannot withdraw.
 */

export const AGENT_POLICY_NAME = "weft-hyperliquid-agent-v1";

export interface AgentWallet {
  walletId: string;
  address: Hex;
}

/** The slice of the Privy SDK we use (injectable for tests). */
export interface PrivyAgentApi {
  createPolicy(): Promise<string>;
  createWallet(externalId: string, policyId: string): Promise<AgentWallet>;
  signTypedData(walletId: string, typedData: { domain: Record<string, unknown>; types: Record<string, readonly { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> }): Promise<Hex>;
}

export function privyAgentApi(appId: string, appSecret: string): PrivyAgentApi {
  const privy = new PrivyClient({ appId, appSecret });
  return {
    async createPolicy() {
      const p = await privy.policies().create({
        name: AGENT_POLICY_NAME,
        version: "1.0",
        chain_type: "ethereum",
        rules: [
          {
            name: "Hyperliquid L1 actions only",
            method: "eth_signTypedData_v4",
            action: "ALLOW",
            conditions: [
              { field_source: "ethereum_typed_data_domain", field: "chainId", operator: "eq", value: "1337" },
              { field_source: "ethereum_typed_data_domain", field: "verifyingContract", operator: "eq", value: "0x0000000000000000000000000000000000000000" },
            ],
          },
        ],
      });
      return p.id;
    },
    async createWallet(externalId, policyId) {
      const w = await privy.wallets().create({ chain_type: "ethereum", policy_ids: [policyId], external_id: externalId, display_name: "Weft Hyperliquid agent" });
      return { walletId: w.id, address: w.address as Hex };
    },
    async signTypedData(walletId, td) {
      const { EIP712Domain: _drop, ...types } = td.types as Record<string, readonly { name: string; type: string }[]>;
      const r = await privy.wallets().ethereum().signTypedData(walletId, {
        params: {
          typed_data: {
            domain: td.domain as never,
            types: types as never,
            message: td.message,
            primary_type: td.primaryType,
          },
        },
      });
      return r.signature as Hex;
    },
  };
}

export class AgentWallets {
  private policyId: string | null = null;

  private readonly api: PrivyAgentApi;
  private readonly accounts: Accounts;
  constructor(api: PrivyAgentApi, accounts: Accounts) {
    this.api = api;
    this.accounts = accounts;
  }

  private async policy(): Promise<string> {
    if (this.policyId) return this.policyId;
    const stored = this.accounts.kvGet("privy_agent_policy_id");
    if (stored) return (this.policyId = stored);
    const id = await this.api.createPolicy();
    this.accounts.kvSet("privy_agent_policy_id", id);
    return (this.policyId = id);
  }

  /** The user's agent wallet, created on first use (idempotent). */
  async forUser(userId: string): Promise<AgentWallet> {
    const existing = this.accounts.agentWallet(userId);
    if (existing) return existing;
    const policyId = await this.policy();
    // external_id must be unique per app and alphanumeric-ish (DIDs contain colons): hash it.
    const externalId = `weft-agent-${createHash("sha256").update(userId).digest("hex").slice(0, 40)}`;
    const w = await this.api.createWallet(externalId, policyId);
    this.accounts.setAgentWallet(userId, w);
    return w;
  }

  existing(userId: string): AgentWallet | null {
    return this.accounts.agentWallet(userId);
  }

  /** A TypedDataSigner backed by Privy, for @weft/execution's Hyperliquid executor. */
  signer(w: AgentWallet): TypedDataSigner {
    return {
      address: w.address,
      signTypedData: (p) => this.api.signTypedData(w.walletId, p),
    };
  }
}
