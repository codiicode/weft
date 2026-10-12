# DRAFT Turnkey policy for Weft's Solana swap signer

> **DRAFT: verify against Turnkey's docs before use.** Written from Turnkey's public
> policy-language reference (`solana.tx.*` fields, `all` / `any` / `in`) and Solana policy
> examples as of 2026-10. It has not been evaluated by a live Turnkey organization. Test every
> policy with a **non-root** user (root quorum bypasses policies) against the allowed and blocked
> transactions in `test/solana.test.ts` before relying on it.

## Model

- Each user has a Turnkey sub-organization holding their Solana wallet. The user is the root;
  Weft is a **non-root API user** with delegated, policy-limited signing.
- Weft may only ask Turnkey to sign Solana transactions that:
  1. touch only the swap programs (Jupiter v6, SPL Token, Token-2022, Associated Token Account,
     Compute Budget, System);
  2. move SOL only from the user to the user (wrapping into the user's own WSOL account);
  3. move SPL tokens only to the user's own token accounts or Weft's platform-fee token accounts.
- Everything else (withdrawals, transfers to third parties, approvals, account takeovers)
  requires the user.
- `inspectSwapTransaction` runs the same checks (and more) inside Weft **before** the request is
  sent. The Turnkey policy is the control that still holds if Weft itself is compromised.

## Placeholders

| Placeholder | Meaning |
| --- | --- |
| `<WEFT_API_USER_ID>` | Weft's non-root API user in the user's sub-org |
| `<WALLET_ID>` | The user's Solana wallet id |
| `<USER_ADDRESS>` | The user's Solana address (fee payer, owner of their token accounts) |
| `<USER_WSOL_ATA>` | `ATA(<USER_ADDRESS>, So111…112)` (SPL Token program) |
| `<FEE_ACCT_SOL>`, `<FEE_ACCT_USDC>` | Weft's platform-fee token accounts (WSOL and USDC) |

Program ids:

```
JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4   Jupiter Aggregator v6
TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA   SPL Token
TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb   Token-2022
ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL  Associated Token Account
ComputeBudget111111111111111111111111111111   Compute Budget
11111111111111111111111111111111              System
```

## Policy 1: allow swap transactions (ALLOW)

```json
{
  "policyName": "Weft: allow Jupiter swaps for the user's own wallet",
  "effect": "EFFECT_ALLOW",
  "consensus": "approvers.any(user, user.id == '<WEFT_API_USER_ID>')",
  "condition": "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && wallet.id == '<WALLET_ID>' && solana.tx.program_keys.all(p, p in ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'ComputeBudget111111111111111111111111111111', '11111111111111111111111111111111']) && solana.tx.transfers.all(t, t.from == '<USER_ADDRESS>' && t.to in ['<USER_ADDRESS>', '<USER_WSOL_ATA>']) && solana.tx.spl_transfers.all(t, t.owner == '<USER_ADDRESS>' && t.to in ['<FEE_ACCT_SOL>', '<FEE_ACCT_USDC>'])"
}
```

Notes:

- `solana.tx.transfers` covers top-level System transfers; Jupiter's wrap is one transfer from
  the user to `<USER_WSOL_ATA>`.
- `solana.tx.spl_transfers` covers top-level `Transfer` / `TransferChecked` /
  `TransferCheckedWithFee`. Jupiter swaps do not normally emit top-level SPL transfers (the swap
  happens inside the Jupiter instruction via CPI), so this clause mostly blocks smuggled
  transfers. Transfers to the user's own token accounts would need those accounts listed; since
  they vary per mint, the safer default is to allow only the fee accounts and let the swap program
  route output.
- Inner (CPI) instructions are not visible to the policy. The swap output destination inside
  the Jupiter instruction is checked by Weft's inspector; to enforce it in Turnkey, upload the
  Jupiter v6 IDL (see "Smart Contract Interfaces") and add a condition on
  `parsed_instruction_data.named_accounts` for the destination/authority accounts. Verify the
  exact field shape in Turnkey's docs before writing it.

## Policy 2: deny dangerous token instructions (DENY)

SPL Token instruction tags (first data byte): `4` Approve, `6` SetAuthority, `8` Burn,
`13` ApproveChecked, `15` BurnChecked. An explicit deny wins over any allow.

```json
{
  "policyName": "Weft: deny token approvals, authority changes and burns",
  "effect": "EFFECT_DENY",
  "condition": "solana.tx.instructions.any(i, i.program_key in ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'] && (i.instruction_data_hex.startsWith('04') || i.instruction_data_hex.startsWith('06') || i.instruction_data_hex.startsWith('08') || i.instruction_data_hex.startsWith('0d') || i.instruction_data_hex.startsWith('0f')))"
}
```

> `startsWith` on strings is an assumption: confirm the string functions Turnkey supports. If it
> is unavailable, enumerate the denied tags with Turnkey's IDL support for the token programs
> instead.

## Policy 3: deny CloseAccount rent to third parties (DENY)

`CloseAccount` (tag `09`) has accounts `[account, destination, owner]`.

```json
{
  "policyName": "Weft: deny closing token accounts to anyone but the user",
  "effect": "EFFECT_DENY",
  "condition": "solana.tx.instructions.any(i, i.program_key in ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'] && i.instruction_data_hex == '09' && i.accounts[1].account_key != '<USER_ADDRESS>')"
}
```

## Policy 4: address lookup tables (DENY, optional)

Jupiter transactions use address lookup tables, which Turnkey reports as `ADDRESS_TABLE_LOOKUP`
in transfer recipients. Deny any transfer whose recipient is resolved through a lookup table, so
a lookup table cannot hide a recipient:

```json
{
  "policyName": "Weft: deny transfers to lookup-table addresses",
  "effect": "EFFECT_DENY",
  "condition": "solana.tx.transfers.any(t, t.to == 'ADDRESS_TABLE_LOOKUP') || solana.tx.spl_transfers.any(t, t.to == 'ADDRESS_TABLE_LOOKUP')"
}
```

## Before production

- [ ] Evaluate each policy with Turnkey's policy evaluation tooling against: a real Jupiter swap
      (must pass), and each blocked case in `test/solana.test.ts` (must fail).
- [ ] Confirm `in`, `all`, `any`, `startsWith` and list indexing behave as written. The engine
      does not short-circuit `&&`/`||`, so a missing field errors the whole policy.
- [ ] Decide on V0 vs V1 transactions. Jupiter returns V0 today, and V1 priority-fee fields do not
      apply to V0.
- [ ] Add a per-transaction value cap (e.g. on `transfers[*].amount` for SOL wraps) matching the
      deployment's risk caps.
