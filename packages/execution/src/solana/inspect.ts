import {
  PublicKey,
  VersionedTransaction,
  type AccountInfo,
  type AddressLookupTableAccount,
  type MessageAccountKeys,
} from "@solana/web3.js";
import { associatedTokenAddress, DEFAULT_ALLOWED_PROGRAMS, JUPITER_IX, PROGRAMS, WSOL_MINT } from "./programs.ts";

/**
 * Defense-in-depth inspection of an (unsigned) swap transaction before it is handed to a signer.
 * The wallet policy (Turnkey) is the primary control; this catches a malicious or buggy route
 * builder before a signature is even requested.
 *
 * Rules:
 *  - fee payer is the user, and the user is the only required signer;
 *  - every top-level instruction targets an allow-listed program (lookup tables resolved via RPC);
 *  - System: only `Transfer` from the user to an account the user owns (e.g. wrapping SOL into
 *    the user's WSOL ATA);
 *  - SPL Token / Token-2022: only SyncNative, CloseAccount (rent back to the user),
 *    InitializeAccount* (owner = user) and Transfer/TransferChecked to user-owned accounts or the
 *    configured platform fee account. Approve / SetAuthority / Burn / Mint / anything else is blocked;
 *  - Associated Token Account: Create / CreateIdempotent funded by and owned by the user;
 *  - Compute Budget: allowed, with an optional priority-fee cap;
 *  - Jupiter v6: known swap instructions only; the spending authority is the user, every output
 *    destination is user-owned, the platform-fee account is the configured one. Admin
 *    instructions and unknown discriminators are blocked.
 *
 * Inner (CPI) instructions are not visible statically and are the venue program's responsibility;
 * the slippage bound in the signed route instruction caps what the user can lose to routing.
 */

export interface InspectRpc {
  getAddressLookupTable(key: PublicKey): Promise<{ value: AddressLookupTableAccount | null }>;
  /** Used to prove ownership of destination token accounts that are not derivable ATAs. */
  getAccountInfo?(key: PublicKey): Promise<AccountInfo<Buffer> | null>;
}

export interface InspectOptions {
  user: PublicKey;
  allowedPrograms?: readonly PublicKey[];
  /** Pre-resolved lookup tables (skips RPC). */
  lookupTables?: AddressLookupTableAccount[];
  rpc?: InspectRpc;
  /** The integrator (Weft) fee token account: the only non-user account allowed to receive tokens. */
  platformFeeAccount?: PublicKey | null;
  /** Max priority fee (lamports) = CU price (µlamports) × CU limit / 1e6. */
  maxPriorityFeeLamports?: number;
  /** Max lamports the user may move from their wallet into their own WSOL account. */
  maxWrapLamports?: bigint | number;
}

export interface InspectedInstruction {
  index: number;
  programId: string;
  name: string;
  accounts: string[];
}

export interface InspectReport {
  ok: boolean;
  violations: string[];
  /** Non-blocking notes (e.g. checks that could not be performed statically). */
  warnings: string[];
  instructions: InspectedInstruction[];
  feePayer: string;
  priorityFeeLamports: number | null;
}

const SYSTEM_TRANSFER = 2;
const TOKEN = {
  InitializeAccount: 1,
  Transfer: 3,
  Approve: 4,
  SetAuthority: 6,
  CloseAccount: 9,
  TransferChecked: 12,
  InitializeAccount2: 16,
  SyncNative: 17,
  InitializeAccount3: 18,
} as const;

function u32le(d: Uint8Array, o = 0) {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);
}
function u64le(d: Uint8Array, o: number) {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
}

export async function inspectSwapTransaction(tx: VersionedTransaction | Uint8Array, opts: InspectOptions): Promise<InspectReport> {
  const vtx = tx instanceof VersionedTransaction ? tx : VersionedTransaction.deserialize(tx);
  const msg = vtx.message;
  const user = opts.user;
  const userB58 = user.toBase58();
  const allowed = new Set((opts.allowedPrograms ?? DEFAULT_ALLOWED_PROGRAMS).map((p) => p.toBase58()));
  const feeAcct = opts.platformFeeAccount?.toBase58() ?? null;
  const violations: string[] = [];
  const warnings: string[] = [];

  /* ---- resolve account keys (incl. address lookup tables) ---- */
  let keys: MessageAccountKeys;
  try {
    let tables = opts.lookupTables ?? [];
    if (msg.addressTableLookups.length && !opts.lookupTables) {
      if (!opts.rpc) throw new Error("transaction uses address lookup tables but no rpc / lookupTables were provided");
      tables = [];
      for (const l of msg.addressTableLookups) {
        const r = await opts.rpc.getAddressLookupTable(l.accountKey);
        if (!r.value) throw new Error(`lookup table ${l.accountKey.toBase58()} not found`);
        tables.push(r.value);
      }
    }
    keys = msg.getAccountKeys({ addressLookupTableAccounts: tables });
  } catch (e) {
    return {
      ok: false,
      violations: [`cannot resolve account keys: ${e instanceof Error ? e.message : String(e)}`],
      warnings,
      instructions: [],
      feePayer: msg.staticAccountKeys[0]?.toBase58() ?? "",
      priorityFeeLamports: null,
    };
  }
  const key = (i: number): PublicKey => {
    const k = keys.get(i);
    if (!k) throw new Error(`account index ${i} out of range`);
    return k;
  };

  /* ---- signers ---- */
  const feePayer = msg.staticAccountKeys[0]!.toBase58();
  if (feePayer !== userB58) violations.push(`fee payer ${feePayer} is not the user ${userB58}`);
  if (msg.header.numRequiredSignatures !== 1) violations.push(`transaction requires ${msg.header.numRequiredSignatures} signatures; only the user may sign`);

  /* ---- what the user owns ---- */
  const ownedTokenAccounts = new Set<string>();
  const addAtasFor = (mint: PublicKey) => {
    ownedTokenAccounts.add(associatedTokenAddress(user, mint, PROGRAMS.token).toBase58());
    ownedTokenAccounts.add(associatedTokenAddress(user, mint, PROGRAMS.token2022).toBase58());
  };
  addAtasFor(WSOL_MINT);
  const ixs = msg.compiledInstructions.map((ix, index) => ({
    index,
    programId: key(ix.programIdIndex),
    accounts: ix.accountKeyIndexes.map(key),
    data: ix.data,
  }));
  // Mints referenced by ATA creations and Jupiter swaps → the user's ATAs for them.
  for (const ix of ixs) {
    if (ix.programId.equals(PROGRAMS.associatedToken) && ix.accounts[2]?.equals(user) && ix.accounts[3]) addAtasFor(ix.accounts[3]);
    if (ix.programId.equals(PROGRAMS.token) || ix.programId.equals(PROGRAMS.token2022)) {
      const t = ix.data[0];
      if (t === TOKEN.InitializeAccount3 || t === TOKEN.InitializeAccount2) {
        if (ix.data.length >= 33 && new PublicKey(ix.data.subarray(1, 33)).equals(user) && ix.accounts[0]) ownedTokenAccounts.add(ix.accounts[0].toBase58());
      } else if (t === TOKEN.InitializeAccount && ix.accounts[2]?.equals(user) && ix.accounts[0]) ownedTokenAccounts.add(ix.accounts[0].toBase58());
    }
  }
  const proven = new Map<string, boolean>();
  const isUserOwned = async (acct: PublicKey): Promise<boolean> => {
    const b58 = acct.toBase58();
    if (b58 === userB58 || ownedTokenAccounts.has(b58)) return true;
    if (proven.has(b58)) return proven.get(b58)!;
    let owned = false;
    if (opts.rpc?.getAccountInfo) {
      const info = await opts.rpc.getAccountInfo(acct);
      const isTokenAcct = info && (info.owner.equals(PROGRAMS.token) || info.owner.equals(PROGRAMS.token2022)) && info.data.length >= 64;
      owned = !!isTokenAcct && new PublicKey(info!.data.subarray(32, 64)).equals(user);
    }
    proven.set(b58, owned);
    return owned;
  };

  /* ---- per-instruction rules ---- */
  const report: InspectedInstruction[] = [];
  let cuLimit: number | null = null;
  let cuPriceMicro: bigint | null = null;

  for (const ix of ixs) {
    const pid = ix.programId.toBase58();
    let name = "unknown";
    const v = (m: string) => violations.push(`#${ix.index} ${name}: ${m}`);
    const acc = (i: number) => ix.accounts[i];

    if (!allowed.has(pid)) {
      name = "disallowed-program";
      v(`program ${pid} is not allow-listed`);
    } else if (ix.programId.equals(PROGRAMS.computeBudget)) {
      const t = ix.data[0];
      name = ["requestUnits", "requestHeapFrame", "setComputeUnitLimit", "setComputeUnitPrice", "setLoadedAccountsDataSizeLimit"][t ?? 99] ?? "unknown";
      if (t === 2) cuLimit = u32le(ix.data, 1);
      else if (t === 3) cuPriceMicro = u64le(ix.data, 1);
      else if (name === "unknown") v("unknown compute budget instruction");
    } else if (ix.programId.equals(PROGRAMS.system)) {
      const t = ix.data.length >= 4 ? u32le(ix.data) : -1;
      if (t === SYSTEM_TRANSFER) {
        name = "system.transfer";
        const [from, to] = [acc(0), acc(1)];
        const lamports = u64le(ix.data, 4);
        if (!from?.equals(user)) v(`transfer source ${from?.toBase58()} is not the user`);
        if (!to || !(await isUserOwned(to))) v(`SOL transfer of ${lamports} lamports to ${to?.toBase58()}, which the user does not own`);
        if (opts.maxWrapLamports != null && lamports > BigInt(opts.maxWrapLamports)) v(`SOL transfer of ${lamports} lamports exceeds the ${opts.maxWrapLamports} allowed`);
      } else {
        name = `system.${t}`;
        v("only System transfers to the user's own accounts are allowed");
      }
    } else if (ix.programId.equals(PROGRAMS.token) || ix.programId.equals(PROGRAMS.token2022)) {
      const t = ix.data[0];
      switch (t) {
        case TOKEN.SyncNative:
          name = "token.syncNative";
          if (!acc(0) || !(await isUserOwned(acc(0)!))) v("syncNative on an account the user does not own");
          break;
        case TOKEN.CloseAccount:
          name = "token.closeAccount";
          if (!acc(1)?.equals(user)) v(`rent goes to ${acc(1)?.toBase58()}, not the user`);
          if (!acc(2)?.equals(user)) v("account owner is not the user");
          break;
        case TOKEN.Transfer:
        case TOKEN.TransferChecked: {
          name = t === TOKEN.Transfer ? "token.transfer" : "token.transferChecked";
          const dest = t === TOKEN.Transfer ? acc(1) : acc(2);
          const owner = t === TOKEN.Transfer ? acc(2) : acc(3);
          if (!owner?.equals(user)) v("transfer authority is not the user");
          const toFee = feeAcct != null && dest?.toBase58() === feeAcct;
          if (!dest || (!toFee && !(await isUserOwned(dest)))) v(`token transfer to ${dest?.toBase58()}, which is neither the user's nor the platform fee account`);
          break;
        }
        case TOKEN.InitializeAccount:
        case TOKEN.InitializeAccount2:
        case TOKEN.InitializeAccount3: {
          name = "token.initializeAccount";
          const owner = t === TOKEN.InitializeAccount ? acc(2) : ix.data.length >= 33 ? new PublicKey(ix.data.subarray(1, 33)) : undefined;
          if (!owner?.equals(user)) v(`new token account owned by ${owner?.toBase58()}, not the user`);
          break;
        }
        default:
          name = `token.${t === TOKEN.Approve ? "approve" : t === TOKEN.SetAuthority ? "setAuthority" : t}`;
          v("token instruction not allowed (only syncNative / closeAccount / initializeAccount / transfers to the user)");
      }
    } else if (ix.programId.equals(PROGRAMS.associatedToken)) {
      const t = ix.data.length === 0 ? 0 : ix.data[0];
      name = t === 0 ? "ata.create" : t === 1 ? "ata.createIdempotent" : `ata.${t}`;
      if (t !== 0 && t !== 1) v("only ATA create / createIdempotent are allowed");
      else {
        if (!acc(0)?.equals(user)) v("ATA funder is not the user");
        if (!acc(2)?.equals(user)) v(`ATA wallet ${acc(2)?.toBase58()} is not the user`);
        if (acc(1) && acc(2) && acc(3) && acc(5) && !associatedTokenAddress(acc(2)!, acc(3)!, acc(5)!).equals(acc(1)!))
          v("ATA address does not match its derivation");
      }
    } else if (ix.programId.equals(PROGRAMS.jupiterV6)) {
      const disc = Buffer.from(ix.data.subarray(0, 8)).toString("hex");
      const layout = JUPITER_IX.find((l) => l.discriminator === disc);
      name = layout ? `jupiter.${layout.name}` : `jupiter.unknown(${disc})`;
      if (!layout) v("unknown Jupiter instruction");
      else if (layout.kind === "admin") v("Jupiter admin instruction is not allowed");
      else if (layout.kind === "setup") {
        if (layout.user != null && !acc(layout.user)?.equals(user)) v("setup instruction is not for the user");
        if (layout.name === "create_idempotent_associated_token_account" && !acc(2)?.equals(user)) v("creates a token account for someone else");
      } else {
        if (!acc(layout.authority!)?.equals(user)) v(`spending authority ${acc(layout.authority!)?.toBase58()} is not the user`);
        for (const d of layout.destinations ?? []) {
          const a = acc(d);
          if (!a || a.equals(PROGRAMS.jupiterV6)) continue; // optional account = None
          if (!(await isUserOwned(a))) v(`swap output goes to ${a.toBase58()}, which the user does not own`);
        }
        if (layout.platformFee != null) {
          const f = acc(layout.platformFee);
          if (f && !f.equals(PROGRAMS.jupiterV6) && f.toBase58() !== feeAcct) v(`platform fee goes to ${f.toBase58()}, not the configured fee account`);
        } else if (feeAcct) warnings.push(`#${ix.index} ${name}: v2 route; platform fee account is not checked statically`);
      }
    }
    report.push({ index: ix.index, programId: pid, name, accounts: ix.accounts.map((a) => a.toBase58()) });
  }

  let priorityFeeLamports: number | null = null;
  if (cuPriceMicro != null) {
    priorityFeeLamports = Number((cuPriceMicro * BigInt(cuLimit ?? 200_000)) / 1_000_000n);
    if (opts.maxPriorityFeeLamports != null && priorityFeeLamports > opts.maxPriorityFeeLamports)
      violations.push(`priority fee ${priorityFeeLamports} lamports exceeds the ${opts.maxPriorityFeeLamports} cap`);
  }

  return { ok: violations.length === 0, violations, warnings, instructions: report, feePayer, priorityFeeLamports };
}
