import { createHash, createPublicKey, generateKeyPairSync, verify as nodeVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
} from "@solana/web3.js";
import { inspectSwapTransaction } from "../src/solana/inspect.ts";
import { associatedTokenAddress, JUPITER_IX, PROGRAMS, USDC_MINT, WSOL_MINT } from "../src/solana/programs.ts";
import { LocalKeypairSigner, TurnkeyApiKeyStamper, TurnkeySigner } from "../src/solana/signer.ts";
import { JupiterSwapBuilder, type QuoteResponse } from "../src/solana/jupiter.ts";
import { JupiterExecutor } from "../src/solana/executor.ts";

/* ------------------------------------------------------------------ */
/* Transaction construction helpers (offline)                           */
/* ------------------------------------------------------------------ */

const user = Keypair.generate();
const U = user.publicKey;
const attacker = Keypair.generate().publicKey;
const OUT_MINT = new PublicKey("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN");
const feeOwner = Keypair.generate().publicKey;
const FEE_ACCT = associatedTokenAddress(feeOwner, OUT_MINT);
const wsolAta = associatedTokenAddress(U, WSOL_MINT);
const outAta = associatedTokenAddress(U, OUT_MINT);
const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
const disc = (name: string) => Buffer.from(JUPITER_IX.find((l) => l.name === name)!.discriminator, "hex");

const ataCreateIdempotent = (owner: PublicKey, mint: PublicKey, funder = U) =>
  new TransactionInstruction({
    programId: PROGRAMS.associatedToken,
    keys: [
      { pubkey: funder, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: PROGRAMS.token, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });

const tokenIx = (data: number[], keys: PublicKey[], programId: PublicKey = PROGRAMS.token) =>
  new TransactionInstruction({ programId, keys: keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })), data: Buffer.from(data) });

const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return [...b];
};

const programAuthority = Keypair.generate().publicKey;
const progSrc = Keypair.generate().publicKey;
const progDst = Keypair.generate().publicKey;
const eventAuthority = Keypair.generate().publicKey;
const poolAccounts = Array.from({ length: 6 }, () => Keypair.generate().publicKey);

/** Jupiter shared_accounts_route with the IDL account layout (+ remaining pool accounts). */
const sharedRoute = (o: { authority?: PublicKey; dest?: PublicKey; fee?: PublicKey } = {}) =>
  new TransactionInstruction({
    programId: PROGRAMS.jupiterV6,
    keys: [
      PROGRAMS.token,
      programAuthority,
      o.authority ?? U,
      wsolAta,
      progSrc,
      progDst,
      o.dest ?? outAta,
      WSOL_MINT,
      OUT_MINT,
      o.fee ?? FEE_ACCT,
      PROGRAMS.jupiterV6, // token_2022_program = None
      eventAuthority,
      PROGRAMS.jupiterV6,
      ...poolAccounts,
    ].map((pubkey, i) => ({ pubkey, isSigner: i === 2, isWritable: i !== 0 })),
    data: Buffer.concat([disc("shared_accounts_route"), Buffer.from([1, 2, 3, 4])]),
  });

function goodInstructions(): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    ataCreateIdempotent(U, WSOL_MINT),
    SystemProgram.transfer({ fromPubkey: U, toPubkey: wsolAta, lamports: 10_000_000 }),
    tokenIx([17], [wsolAta]), // SyncNative
    ataCreateIdempotent(U, OUT_MINT),
    sharedRoute(),
    tokenIx([9], [wsolAta, U, U]), // CloseAccount → rent to user
  ];
}

const ALT_KEY = Keypair.generate().publicKey;
const alt = new AddressLookupTableAccount({
  key: ALT_KEY,
  state: {
    deactivationSlot: BigInt("18446744073709551615"),
    lastExtendedSlot: 0,
    lastExtendedSlotStartIndex: 0,
    authority: undefined,
    addresses: [programAuthority, progSrc, progDst, eventAuthority, ...poolAccounts],
  },
});

function v0(ixs: TransactionInstruction[], payer = U, useAlt = true) {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message(useAlt ? [alt] : []);
  return new VersionedTransaction(msg);
}

const rpc = (accounts: Record<string, AccountInfo<Buffer>> = {}) => ({
  getAddressLookupTable: async (k: PublicKey) => ({ value: k.equals(ALT_KEY) ? alt : null }),
  getAccountInfo: async (k: PublicKey) => accounts[k.toBase58()] ?? null,
});

const tokenAccountInfo = (owner: PublicKey, mint: PublicKey): AccountInfo<Buffer> => {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  return { data, owner: PROGRAMS.token, lamports: 2039280, executable: false, rentEpoch: 0 };
};

const inspect = (tx: VersionedTransaction, extra: Partial<Parameters<typeof inspectSwapTransaction>[1]> = {}) =>
  inspectSwapTransaction(tx, { user: U, rpc: rpc(), platformFeeAccount: FEE_ACCT, ...extra });

/* ------------------------------------------------------------------ */
/* Inspection                                                           */
/* ------------------------------------------------------------------ */

describe("inspectSwapTransaction", () => {
  it("Jupiter discriminators are sha256('global:<name>')[0..8] (values copied from the on-chain IDL)", () => {
    // One IDL entry's discriminator is not derived from its IDL name (the on-chain IDL value is authoritative).
    const notDerived = new Set(["create_idempotent_associated_token_account"]);
    for (const l of JUPITER_IX) {
      const derived = createHash("sha256").update(`global:${l.name}`).digest().subarray(0, 8).toString("hex");
      if (notDerived.has(l.name)) expect(derived).not.toBe(l.discriminator);
      else expect(derived).toBe(l.discriminator);
    }
  });

  it("accepts a well-formed Jupiter swap (ALT resolved via rpc)", async () => {
    const tx = v0(goodInstructions());
    expect(tx.message.addressTableLookups.length).toBe(1);
    const r = await inspect(tx, { maxPriorityFeeLamports: 1_000, maxWrapLamports: 10_000_000n });
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.priorityFeeLamports).toBe(300);
    expect(r.instructions.map((i) => i.name)).toEqual([
      "setComputeUnitLimit",
      "setComputeUnitPrice",
      "ata.createIdempotent",
      "system.transfer",
      "token.syncNative",
      "ata.createIdempotent",
      "jupiter.shared_accounts_route",
      "token.closeAccount",
    ]);
  });

  it("accepts serialized bytes too", async () => {
    expect((await inspect(v0(goodInstructions()).serialize() as unknown as VersionedTransaction)).ok).toBe(true);
  });

  it("fails closed when lookup tables cannot be resolved", async () => {
    const r = await inspectSwapTransaction(v0(goodInstructions()), { user: U });
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toMatch(/lookup tables/);
  });

  const cases: [string, () => TransactionInstruction[], RegExp][] = [
    ["SOL transfer to a stranger", () => [...goodInstructions(), SystemProgram.transfer({ fromPubkey: U, toPubkey: attacker, lamports: 1 })], /does not own/],
    ["SPL transfer to a stranger", () => [...goodInstructions(), tokenIx([3, ...u64(5n)], [outAta, associatedTokenAddress(attacker, OUT_MINT), U])], /neither the user's/],
    ["token approve (delegate drain)", () => [...goodInstructions(), tokenIx([4, ...u64(5n)], [outAta, attacker, U])], /not allowed/],
    ["set authority", () => [...goodInstructions(), tokenIx([6, 2, 1, ...attacker.toBuffer()], [outAta, U])], /not allowed/],
    ["close account rent to a stranger", () => [...goodInstructions(), tokenIx([9], [outAta, attacker, U])], /rent goes to/],
    ["unknown program", () => [...goodInstructions(), new TransactionInstruction({ programId: attacker, keys: [], data: Buffer.alloc(0) })], /not allow-listed/],
    ["system createAccount", () => [...goodInstructions(), SystemProgram.createAccount({ fromPubkey: U, newAccountPubkey: U, lamports: 1, space: 0, programId: attacker })], /only System transfers/],
    ["swap output to a stranger", () => goodInstructions().map((ix) => (ix.programId.equals(PROGRAMS.jupiterV6) ? sharedRoute({ dest: associatedTokenAddress(attacker, OUT_MINT) }) : ix)), /does not own/],
    ["swap spending someone else's tokens", () => goodInstructions().map((ix) => (ix.programId.equals(PROGRAMS.jupiterV6) ? sharedRoute({ authority: attacker }) : ix)), /spending authority/],
    ["platform fee to an unexpected account", () => goodInstructions().map((ix) => (ix.programId.equals(PROGRAMS.jupiterV6) ? sharedRoute({ fee: associatedTokenAddress(attacker, OUT_MINT) }) : ix)), /platform fee goes to/],
    ["ATA created for someone else", () => [...goodInstructions(), ataCreateIdempotent(attacker, OUT_MINT)], /not the user/],
    ["Jupiter admin instruction", () => [...goodInstructions(), new TransactionInstruction({ programId: PROGRAMS.jupiterV6, keys: [], data: disc("claim") })], /admin/],
    ["unknown Jupiter instruction", () => [...goodInstructions(), new TransactionInstruction({ programId: PROGRAMS.jupiterV6, keys: [], data: Buffer.alloc(8, 7) })], /unknown Jupiter/],
  ];
  for (const [label, ixs, re] of cases) {
    it(`blocks: ${label}`, async () => {
      const r = await inspect(v0(ixs()));
      expect(r.ok).toBe(false);
      expect(r.violations.join("\n")).toMatch(re);
    });
  }

  it("allows a token transfer to the configured platform fee account", async () => {
    const r = await inspect(v0([...goodInstructions(), tokenIx([3, ...u64(5n)], [outAta, FEE_ACCT, U])]));
    expect(r.violations).toEqual([]);
  });

  it("proves ownership of non-ATA destinations through the token account's owner field", async () => {
    const custom = Keypair.generate().publicKey;
    const ixs = goodInstructions().map((ix) => (ix.programId.equals(PROGRAMS.jupiterV6) ? sharedRoute({ dest: custom }) : ix));
    expect((await inspect(v0(ixs))).ok).toBe(false);
    const ok = await inspect(v0(ixs), { rpc: rpc({ [custom.toBase58()]: tokenAccountInfo(U, OUT_MINT) }) });
    expect(ok.violations).toEqual([]);
    const notOk = await inspect(v0(ixs), { rpc: rpc({ [custom.toBase58()]: tokenAccountInfo(attacker, OUT_MINT) }) });
    expect(notOk.ok).toBe(false);
  });

  it("blocks foreign fee payers, extra signers, excessive priority fees and oversized wraps", async () => {
    const other = Keypair.generate().publicKey;
    expect((await inspect(v0(goodInstructions(), other))).violations.join()).toMatch(/fee payer/);
    const extraSigner = [...goodInstructions(), SystemProgram.transfer({ fromPubkey: other, toPubkey: U, lamports: 1 })];
    expect((await inspect(v0(extraSigner))).violations.join()).toMatch(/requires 2 signatures/);
    expect((await inspect(v0(goodInstructions()), { maxPriorityFeeLamports: 100 })).violations.join()).toMatch(/priority fee 300/);
    expect((await inspect(v0(goodInstructions()), { maxWrapLamports: 1_000n })).violations.join()).toMatch(/exceeds/);
  });

  it("respects a custom allow-list", async () => {
    const r = await inspect(v0(goodInstructions()), { allowedPrograms: [PROGRAMS.jupiterV6, PROGRAMS.token, PROGRAMS.associatedToken, PROGRAMS.system] });
    expect(r.violations.join()).toMatch(/ComputeBudget.* is not allow-listed/);
  });
});

/* ------------------------------------------------------------------ */
/* Jupiter builder                                                      */
/* ------------------------------------------------------------------ */

function jupFetch(handlers: { quote?: unknown; swap?: unknown }) {
  const calls: { url: string; method: string; body?: unknown; headers: Record<string, string> }[] = [];
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const payload = url.includes("/quote") ? handlers.quote : handlers.swap;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return { fetch, calls };
}

const quoteFixture = (o: Partial<QuoteResponse> = {}): QuoteResponse => ({
  inputMint: WSOL_MINT.toBase58(),
  outputMint: OUT_MINT.toBase58(),
  inAmount: "10000000",
  outAmount: "2500000",
  otherAmountThreshold: "2487500",
  swapMode: "ExactIn",
  slippageBps: 50,
  platformFee: { amount: "12500", feeBps: 50 },
  priceImpactPct: "0.001",
  routePlan: [],
  ...o,
});

describe("JupiterSwapBuilder", () => {
  const builder = (fetch?: ReturnType<typeof jupFetch>["fetch"]) =>
    new JupiterSwapBuilder({ fetch, platformFeeBps: 50, feeAccounts: { [OUT_MINT.toBase58()]: FEE_ACCT, [USDC_MINT.toBase58()]: Keypair.generate().publicKey } });

  it("quote URL carries platformFeeBps only when a fee account exists for the pair", () => {
    const b = builder();
    const withFee = new URL(b.quoteUrl({ inputMint: WSOL_MINT, outputMint: OUT_MINT, amount: 10_000_000n, slippageBps: 50 }));
    expect(withFee.origin + withFee.pathname).toBe("https://lite-api.jup.ag/swap/v1/quote");
    expect(Object.fromEntries(withFee.searchParams)).toEqual({
      inputMint: WSOL_MINT.toBase58(),
      outputMint: OUT_MINT.toBase58(),
      amount: "10000000",
      slippageBps: "50",
      swapMode: "ExactIn",
      platformFeeBps: "50",
      restrictIntermediateTokens: "true",
    });
    const other = Keypair.generate().publicKey;
    expect(() => b.quoteUrl({ inputMint: WSOL_MINT, outputMint: other, amount: 1, slippageBps: 50 })).toThrow(/no fee account/);
    expect(b.feeAccountFor(OUT_MINT, USDC_MINT, "ExactOut")?.equals(FEE_ACCT)).toBe(true);
  });

  it("quote() drops the fee when the pair has no fee account; buildSwap posts the documented body", async () => {
    const tx = v0(goodInstructions());
    const { fetch, calls } = jupFetch({
      quote: quoteFixture(),
      swap: { swapTransaction: Buffer.from(tx.serialize()).toString("base64"), lastValidBlockHeight: 123, prioritizationFeeLamports: 300, computeUnitLimit: 300000, simulationError: null },
    });
    const b = builder(fetch);
    await b.quote({ inputMint: WSOL_MINT, outputMint: Keypair.generate().publicKey, amount: 1, slippageBps: 50 });
    expect(calls[0]!.url).not.toContain("platformFeeBps");
    const q = await b.quote({ inputMint: WSOL_MINT, outputMint: OUT_MINT, amount: 10_000_000n, slippageBps: 50 });
    const built = await b.buildSwap({ quote: q, userPublicKey: U });
    expect(calls[2]).toMatchObject({
      method: "POST",
      url: "https://lite-api.jup.ag/swap/v1/swap",
      body: {
        quoteResponse: q,
        userPublicKey: U.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: "high" } },
        feeAccount: FEE_ACCT.toBase58(),
      },
    });
    expect(built.transaction.signatures[0]!.every((b) => b === 0)).toBe(true); // unsigned
    expect(built.feeAccount?.equals(FEE_ACCT)).toBe(true);
    expect(built.lastValidBlockHeight).toBe(123);
  });

  it("surfaces Jupiter errors", async () => {
    const { fetch } = jupFetch({ quote: { error: "feeAccount is required for swap with platformFee", errorCode: "NOT_SUPPORTED" } });
    await expect(builder(fetch).quote({ inputMint: WSOL_MINT, outputMint: OUT_MINT, amount: 1, slippageBps: 50 })).rejects.toThrow(/feeAccount is required/);
  });
});

/* ------------------------------------------------------------------ */
/* Signers                                                              */
/* ------------------------------------------------------------------ */

function verifyEd25519(pub: PublicKey, msg: Uint8Array, sig: Uint8Array) {
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pub.toBytes()).toString("base64url") }, format: "jwk" });
  return nodeVerify(null, Buffer.from(msg), key, Buffer.from(sig));
}

describe("signers", () => {
  it("LocalKeypairSigner signs for devnet and refuses mainnet", async () => {
    expect(() => new LocalKeypairSigner(user, "mainnet-beta" as "devnet")).toThrow(/devnet/);
    const s = new LocalKeypairSigner(user, "devnet");
    const tx = await s.signTransaction(v0(goodInstructions()));
    expect(verifyEd25519(U, tx.message.serialize(), tx.signatures[0]!)).toBe(true);
  });

  it("TurnkeyApiKeyStamper produces a verifiable P-256 X-Stamp", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = privateKey.export({ format: "jwk" });
    const d = Buffer.from(jwk.d!, "base64url").toString("hex");
    const compressed = (() => {
      const x = Buffer.from(jwk.x!, "base64url");
      const y = Buffer.from(jwk.y!, "base64url");
      return Buffer.concat([Buffer.from([y[31]! & 1 ? 3 : 2]), x]).toString("hex");
    })();
    const stamper = new TurnkeyApiKeyStamper(compressed, d);
    const body = JSON.stringify({ hello: "world" });
    const { header, value } = await stamper.stamp(body);
    expect(header).toBe("X-Stamp");
    const stamp = JSON.parse(Buffer.from(value, "base64url").toString());
    expect(stamp).toMatchObject({ publicKey: compressed, scheme: "SIGNATURE_SCHEME_TK_API_P256" });
    expect(nodeVerify("sha256", Buffer.from(body), { key: publicKey, dsaEncoding: "der" }, Buffer.from(stamp.signature, "hex"))).toBe(true);
    expect(() => new TurnkeyApiKeyStamper("02" + "00".repeat(32), d)).toThrow(/does not match/);
  });

  it("TurnkeySigner sends the documented sign_transaction request and checks the returned message", async () => {
    const tx = v0(goodInstructions());
    const signedLocally = await new LocalKeypairSigner(user, "devnet").signTransaction(v0(goodInstructions()));
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const respond = (activity: unknown) => async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ activity }) };
    };
    const stamper = { stamp: async () => ({ header: "X-Stamp" as const, value: "stamp" }) };
    const signer = new TurnkeySigner({
      organizationId: "org-1",
      signWith: U.toBase58(),
      publicKey: U,
      stamper,
      now: () => 1700000000000,
      fetch: respond({ status: "ACTIVITY_STATUS_COMPLETED", result: { signTransactionResult: { signedTransaction: Buffer.from(signedLocally.serialize()).toString("hex") } } }),
    });
    const out = await signer.signTransaction(tx);
    expect(verifyEd25519(U, out.message.serialize(), out.signatures[0]!)).toBe(true);
    expect(seen[0]!.url).toBe("https://api.turnkey.com/public/v1/submit/sign_transaction");
    expect(seen[0]!.headers["X-Stamp"]).toBe("stamp");
    expect(seen[0]!.body).toEqual({
      type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
      timestampMs: "1700000000000",
      organizationId: "org-1",
      parameters: { signWith: U.toBase58(), unsignedTransaction: Buffer.from(tx.serialize()).toString("hex"), type: "TRANSACTION_TYPE_SOLANA" },
    });

    const tampered = await new LocalKeypairSigner(user, "devnet").signTransaction(v0([...goodInstructions(), SystemProgram.transfer({ fromPubkey: U, toPubkey: attacker, lamports: 1 })]));
    const evil = new TurnkeySigner({
      organizationId: "org-1",
      signWith: U.toBase58(),
      publicKey: U,
      stamper,
      fetch: respond({ status: "ACTIVITY_STATUS_COMPLETED", result: { signTransactionResult: { signedTransaction: Buffer.from(tampered.serialize()).toString("hex") } } }),
    });
    await expect(evil.signTransaction(v0(goodInstructions()))).rejects.toThrow(/different message/);
    const pending = new TurnkeySigner({ organizationId: "o", signWith: "w", publicKey: U, stamper, fetch: respond({ status: "ACTIVITY_STATUS_CONSENSUS_NEEDED" }) });
    await expect(pending.signTransaction(tx)).rejects.toThrow(/CONSENSUS_NEEDED/);
  });
});

/* ------------------------------------------------------------------ */
/* JupiterExecutor (engine Executor)                                    */
/* ------------------------------------------------------------------ */

describe("JupiterExecutor", () => {
  const TOKEN = { kind: "token" as const, chain: "solana" as const, mint: OUT_MINT.toBase58(), quote: "SOL" as const, route: "auto" as const, assetClass: "crypto" as const };
  const mintInfo = (decimals: number): AccountInfo<Buffer> => {
    const data = Buffer.alloc(82);
    data[44] = decimals;
    return { data, owner: PROGRAMS.token, lamports: 1, executable: false, rentEpoch: 0 };
  };

  function setup(swapTx: VersionedTransaction, extra: Partial<ConstructorParameters<typeof JupiterExecutor>[0]> = {}) {
    const fetch = async (url: string) => {
      const u = new URL(url);
      let payload: unknown;
      if (u.pathname.endsWith("/quote")) {
        payload =
          u.searchParams.get("outputMint") === USDC_MINT.toBase58()
            ? quoteFixture({ inputMint: WSOL_MINT.toBase58(), outputMint: USDC_MINT.toBase58(), inAmount: "1000000000", outAmount: "150000000", platformFee: null })
            : quoteFixture({ inAmount: u.searchParams.get("amount")! });
      } else payload = { swapTransaction: Buffer.from(swapTx.serialize()).toString("base64"), lastValidBlockHeight: 1, prioritizationFeeLamports: 300 };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };
    const sent: Uint8Array[] = [];
    const ex = new JupiterExecutor({
      builder: new JupiterSwapBuilder({ fetch, platformFeeBps: 50, feeAccounts: { [OUT_MINT.toBase58()]: FEE_ACCT } }),
      signer: new LocalKeypairSigner(user, "devnet"),
      rpc: {
        ...rpc({ [OUT_MINT.toBase58()]: mintInfo(6) }),
        sendRawTransaction: async (raw) => {
          sent.push(raw);
          return "sig1";
        },
        confirmTransaction: async () => ({ value: { err: null } }),
      },
      ...extra,
    });
    return { ex, sent };
  }

  it("dry run: quotes in SOL from a USD notional, builds, inspects, never signs", async () => {
    const reports: unknown[] = [];
    const { ex, sent } = setup(v0(goodInstructions()), { dryRun: true, onBuilt: (b) => reports.push(b) });
    const res = await ex.execute({ clientId: "c1", instrument: TOKEN, instrumentKey: "k", side: "buy", phase: "open", notionalUsd: 1.5 }, 0);
    expect(res).toEqual({ status: "pending", reason: "dry run: swap built and inspected, not signed" });
    expect(sent).toHaveLength(0);
    expect((reports[0] as { quote: QuoteResponse }).quote.inAmount).toBe("10000000"); // $1.5 / $150 per SOL = 0.01 SOL
  });

  it("rejects a swap that fails inspection", async () => {
    const bad = v0([...goodInstructions(), SystemProgram.transfer({ fromPubkey: U, toPubkey: attacker, lamports: 1 })]);
    const { ex, sent } = setup(bad);
    const res = await ex.execute({ clientId: "c2", instrument: TOKEN, instrumentKey: "k", side: "buy", phase: "open", notionalUsd: 1.5 }, 0);
    expect(res).toMatchObject({ status: "rejected", reason: expect.stringMatching(/failed inspection/) });
    expect(sent).toHaveLength(0);
  });

  it("sells never exceed what the wallet holds, and a close sells everything left", async () => {
    const seen: string[] = [];
    const balance = (held: bigint) => ({
      dryRun: true,
      onBuilt: (b: { quote: QuoteResponse }) => seen.push(b.quote.inAmount),
      rpc: { ...rpc({ [OUT_MINT.toBase58()]: mintInfo(6) }), tokenBalance: async () => held },
    });
    // Asked to sell 5 tokens (5_000_000 atomic) but only 3.2 landed: sell 3.2.
    await setup(v0(goodInstructions()), balance(3_200_000n)).ex.execute({ clientId: "s1", instrument: TOKEN, instrumentKey: "k", side: "sell", phase: "close", qty: 5 }, 0);
    // A full close takes the dust too.
    await setup(v0(goodInstructions()), balance(5_000_123n)).ex.execute({ clientId: "s2", instrument: TOKEN, instrumentKey: "k", side: "sell", phase: "close", qty: 5 }, 0);
    // A partial close (half) sells exactly half.
    await setup(v0(goodInstructions()), balance(5_000_000n)).ex.execute({ clientId: "s4", instrument: TOKEN, instrumentKey: "k", side: "sell", phase: "close", qty: 2.5 }, 0);
    expect(seen).toEqual(["3200000", "5000123", "2500000"]);
    const empty = await setup(v0(goodInstructions()), balance(0n)).ex.execute({ clientId: "s3", instrument: TOKEN, instrumentKey: "k", side: "sell", phase: "close", qty: 5 }, 0);
    expect(empty).toMatchObject({ status: "rejected", reason: expect.stringMatching(/nothing left/) });
  });

  it("closes the user's empty token accounts with rent back to the user, after a sell that empties the wallet", async () => {
    const empty = Keypair.generate().publicKey;
    const closed: unknown[] = [];
    const sellRpc = (held: bigint) => ({
      rpc: {
        ...rpc({ [OUT_MINT.toBase58()]: mintInfo(6) }),
        sendRawTransaction: async (raw: Uint8Array) => {
          sent.push(raw);
          return `sig${sent.length}`;
        },
        confirmTransaction: async () => ({ value: { err: null } }),
        tokenBalance: async () => held,
        emptyTokenAccounts: async () => [{ address: empty, programId: PROGRAMS.token }],
        getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 9 }),
      },
      onAccountsClosed: (r: unknown) => closed.push(r),
    });
    const sent: Uint8Array[] = [];

    // Direct: one CloseAccount, rent to the user, signed by the user only.
    const { ex } = setup(v0(goodInstructions()), sellRpc(0n));
    const sig = await ex.closeEmptyAccounts(OUT_MINT);
    expect(sig).toBe("sig1");
    const tx = VersionedTransaction.deserialize(sent[0]!);
    const keys = tx.message.staticAccountKeys;
    expect(tx.message.compiledInstructions).toHaveLength(1);
    const ix = tx.message.compiledInstructions[0]!;
    expect(keys[ix.programIdIndex]!.equals(PROGRAMS.token)).toBe(true);
    expect(Array.from(ix.data)).toEqual([9]);
    expect(keys[ix.accountKeyIndexes[0]!]!.equals(empty)).toBe(true);
    expect(keys[ix.accountKeyIndexes[1]!]!.equals(U)).toBe(true);
    expect(closed).toEqual([{ mint: OUT_MINT.toBase58(), accounts: 1, signature: "sig1" }]);

    // A partial sell leaves the account alone.
    sent.length = 0;
    const partial = setup(v0(goodInstructions()), sellRpc(5_000_000n)).ex;
    await partial.execute({ clientId: "p1", instrument: TOKEN, instrumentKey: "k", side: "sell", phase: "close", qty: 2.5 }, 0);
    // Selling everything closes it.
    const sellIxs = goodInstructions().filter((_, i) => i !== 3 && i !== 4); // a sale: no SOL wrap
    const full = setup(v0(sellIxs), sellRpc(5_000_000n)).ex;
    const res = await full.execute({ clientId: "f1", instrument: TOKEN, instrumentKey: "k", side: "sell", phase: "close", qty: 5 }, 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(res.status, JSON.stringify(res)).toBe("filled");
    expect(closed).toHaveLength(2);
  });

  it("signs + sends a clean swap and reports the quoted fill; duplicate clientIds are refused", async () => {
    const { ex, sent } = setup(v0(goodInstructions()));
    const res = await ex.execute({ clientId: "c3", instrument: TOKEN, instrumentKey: "k", side: "buy", phase: "open", notionalUsd: 1.5 }, 0);
    expect(sent).toHaveLength(1);
    expect(res).toMatchObject({ status: "filled", qty: 2.5, price: expect.closeTo(0.6, 9), builderFeeUsd: expect.closeTo(0.0075, 9) });
    expect(await ex.execute({ clientId: "c3", instrument: TOKEN, instrumentKey: "k", side: "buy", phase: "open", notionalUsd: 1.5 }, 0)).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/duplicate/),
    });
  });
});
