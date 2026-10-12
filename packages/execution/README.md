# @weft/execution

Live, non-custodial execution for Weft. It turns approved order intents into correctly signed
venue requests, so a deployment can switch from the paper engine to live trading.

## Custody model

**Weft never holds a key that can withdraw user funds.**

### Hyperliquid: agent (API) wallets

1. Weft generates a per-user **agent wallet** key. It can place and cancel orders, but it
   **cannot withdraw or transfer**.
2. The user signs `approveAgent` in their **own** wallet. Weft builds the EIP-712 payload
   (`buildApproveAgent`); the wallet signs it; `toRequest(signature)` assembles the `/exchange`
   body. The user's main key never touches Weft.
3. The user signs `approveBuilderFee` the same way (`buildApproveBuilderFee`, default 5 bps =
   `f: 50`, percent string `"0.05%"`).
4. `HyperliquidExecutor` signs L1 actions (orders, cancels, leverage) with the agent key. It
   refuses to start if the agent key equals the user's address, and refuses to POST to mainnet
   unless `allowMainnetSend: true`.

### Solana: policy wallet

1. The user's Solana wallet lives in a policy-controlled signer (Turnkey sub-org). Weft is a
   non-root user that can only get transactions signed if they pass the policy
   (`docs/turnkey-policy.md`, **DRAFT**).
2. `JupiterSwapBuilder` builds an **unsigned** swap for the user's public key.
   `inspectSwapTransaction` checks it (programs, transfers, destinations, fee account, signers,
   priority fee) and fails closed **before** any signature is requested.
3. `LocalKeypairSigner` is for devnet and tests only (it refuses `mainnet-beta`). `TurnkeySigner`
   implements Turnkey's `sign_transaction` request and API-key stamp from their public OpenAPI
   spec and docs. It has not been run against a live Turnkey org.

## What's here

| Module | |
| --- | --- |
| `hyperliquid/signing.ts` | 1:1 port of the SDK's `signing.py`: msgpack action hash, phantom agent, L1 + user-signed EIP-712, `float_to_wire` |
| `hyperliquid/wire.ts` | Order/cancel/leverage wires (key order is part of the signature), deterministic cloids |
| `hyperliquid/ticks.ts` | Tick/lot rules (≤5 sig figs, ≤6/8 − szDecimals decimals, integers always valid), SDK slippage price |
| `hyperliquid/info.ts` | Read-only `/info` client; asset ids: core perps, spot `10000+i`, HIP-3 `100000 + dex×10000 + i`, HIP-4 `100000000 + 10×outcome + side` |
| `hyperliquid/approvals.ts` | `approveAgent` / `approveBuilderFee` typed data for the user's wallet |
| `hyperliquid/executor.ts` | `HyperliquidExecutor`: `placeOrder` (market = aggressive IOC, limit), TP/SL (`normalTpsl` with the entry, `positionTpsl` on a position), `closePosition`, `cancel`, `setLeverage`, `executeOpenIntent` / `executeCloseIntent`, engine `execute()`, `dryRun` |
| `solana/jupiter.ts` | `JupiterSwapBuilder`: quote (`platformFeeBps`) → unsigned `VersionedTransaction` (`/swap`, dynamic CU, capped priority fee, `feeAccount`) |
| `solana/inspect.ts` | `inspectSwapTransaction`: resolves lookup tables and enforces the allow-list and transfer rules |
| `solana/signer.ts` | `Signer`, `LocalKeypairSigner`, `TurnkeySigner`, `TurnkeyApiKeyStamper` |
| `solana/executor.ts` | `JupiterExecutor`: engine `Executor` for Solana tokens (quote → build → inspect → sign → send) |
| `router.ts` | `RoutingExecutor`: one engine `Executor` that dispatches by instrument kind |

## How the engine routes live intents

The engine (`@weft/engine`) owns intent evaluation, risk, positions and exit monitoring. It calls
a single `Executor.execute(OrderRequest)`. For live mode:

```ts
import { createEngine } from "@weft/engine";
import { HyperliquidExecutor, JupiterExecutor, JupiterSwapBuilder, RoutingExecutor, TurnkeySigner } from "@weft/execution";

const executor = new RoutingExecutor({
  hyperliquid: new HyperliquidExecutor({ agentPrivateKey, userAddress, isMainnet: true, allowMainnetSend: true, builder: { address: WEFT_BUILDER } }),
  solana: new JupiterExecutor({ builder: new JupiterSwapBuilder({ platformFeeBps: 50, feeAccounts }), signer: turnkeySigner, rpc: connection }),
});
createEngine({ executor /* , … */ });
```

- perp / spot / HIP-3 perps (+ HIP-4 outcomes when `outcomes.enabled`) go to Hyperliquid. Tokens
  go to Jupiter. Options and Jupiter prediction outcomes are rejected (no live route yet).
- `clientId` becomes the Hyperliquid `cloid` (`keccak256(clientId)[0..16]`). Before sending,
  the executor checks `orderStatus(cloid)` and refuses to resend an order the venue already knows.
- The engine's `OrderRequest` has no leverage or exits. For venue-side leverage and TP/SL, call
  `HyperliquidExecutor.executeOpenIntent(intent)` directly: it sends `updateLeverage`, then the
  entry with `normalTpsl` children. Trailing stops and time exits are not venue-native, so they
  come back in `engineManagedExits` for the engine's monitor.
- Every executor is structurally the engine's `Executor`. `test/engine-conformance.test.ts`
  checks this against `packages/engine/src/executor.ts`. This package does not depend on
  `@weft/engine`, so there is no package cycle.

## What's tested

`npm test -w @weft/execution`:

- **Official Python SDK vectors** (`tests/signing_test.py`): phantom agent connectionId;
  `test_l1_action_signing_matches` (mainnet + testnet); order signing without and with cloid;
  vault; TP/SL trigger order; createSubAccount; subAccountTransfer; scheduleCancel (with and
  without time); usdSend and withdraw (user-signed); `float_to_int_for_hashing` (JS-safe subset).
- **Official Rust SDK vectors** (`hyperliquid-rust-sdk`): `sign_l1_action` from a fixed
  connection id; limit order; limit order with cloid; TP and SL triggers; cancel;
  **ApproveBuilderFee** user-signed (mainnet + testnet), both through `signUserSignedAction` and
  through the `buildApproveBuilderFee` wallet path.
- ApproveAgent: struct hash equals the Rust SDK's hand-written ABI encoding. The wallet signature
  equals the SDK's `sign_agent` path. Neither SDK publishes an ApproveAgent vector.
- Tick/lot rules (every docs example), the SDK slippage price, asset ids (core, spot, HIP-3,
  HIP-4), exact dry-run bodies, TP/SL grouping, idempotency, mainnet guard, builder-fee approval
  check, intent mapping, closes.
- Solana: Jupiter discriminators re-derived and matched to the on-chain IDL. A clean
  Jupiter-shaped v0 transaction with a lookup table passes. 13 attack shapes are blocked. Covered
  too: the Turnkey request shape and the P-256 stamp verification, devnet signer, the
  JupiterExecutor dry run, rejection and send.
- Opt-in live checks:
  - `HL_TESTNET_PROBE=1`: one order to Hyperliquid **testnet**, signed by a throwaway
    unregistered agent. It expects "User or API Wallet <our address> does not exist".
  - `JUP_LIVE=1`: a real Jupiter quote and swap for a throwaway public key, inspected with
    mainnet RPC reads. Never signed or sent.

## TODO

- **HIP-4 outcome orders**: asset ids follow the docs (`100000000 + 10×outcome + side`) and use
  the standard `order` action, but `outcomeMeta` publishes no lot size. `szDecimals` comes from
  config, and the path is off unless `outcomes.enabled`.
- **Jupiter prediction orders**: not implemented (`RoutingExecutor` rejects `jupiter` outcomes).
- **Options venues** (Hyperliquid options, Derive, Deribit): not implemented.
- Solana token **limit orders** (Jupiter Trigger API). Jupiter fills are reported from the quote;
  they still need reconciling from the confirmed transaction's balance changes.
- Persist sent Solana signatures by `clientId`. In-process dedupe and blockhash expiry are the
  only guard today.
- Jupiter `*_v2` route instructions: destinations and authority are checked. The platform-fee
  account is not statically identifiable, so the inspector emits a warning. Quotes default to v1.
- Turnkey: live verification of `TurnkeySigner` and the draft policy.
- Fee reporting on Hyperliquid fills is an estimate (taker bps + builder fee). Reconcile from
  `userFills`.
