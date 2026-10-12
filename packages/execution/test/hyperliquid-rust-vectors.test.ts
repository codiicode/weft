import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  APPROVE_BUILDER_FEE_TYPES,
  constructPhantomAgent,
  l1TypedData,
  signerFromPrivateKey,
  signL1Action,
  signUserSignedAction,
  splitSignature,
} from "../src/hyperliquid/signing.ts";
import { buildApproveBuilderFee } from "../src/hyperliquid/approvals.ts";
import type { OrderWire } from "../src/hyperliquid/wire.ts";

/**
 * Official vectors from hyperliquid-rust-sdk (`src/signature/create_signature.rs`,
 * `src/exchange/exchange_client.rs` tests). These use pre-formatted price strings ("2000.0"),
 * so the wires are built directly to test hashing + signing, and include the user-signed
 * ApproveBuilderFee vectors that the Python SDK lacks.
 */
const KEY = "0xe908f86dbb4d55ac876378565aafeabc187f6690f046459397b17d9b9a19688e" as Hex;
const signer = signerFromPrivateKey(KEY);
const NONCE = 1583838;

function expectRsv(sig: { r: Hex; s: Hex; v: number }, expected: string) {
  const e = splitSignature(expected as Hex);
  expect(BigInt(sig.r)).toBe(BigInt(e.r));
  expect(BigInt(sig.s)).toBe(BigInt(e.s));
  expect(sig.v).toBe(e.v);
}

const wire = (o: Partial<OrderWire> = {}): OrderWire => ({
  a: 1,
  b: true,
  p: "2000.0",
  s: "3.5",
  r: false,
  t: { limit: { tif: "Ioc" } },
  ...o,
});

describe("hyperliquid signing: official Rust SDK vectors", () => {
  it("test_sign_l1_action (phantom agent from a fixed connection id)", async () => {
    const cid = "0xde6c4037798a4434ca03cd05f00e3b803126221375cd1e7eaaaf041768be06eb" as Hex;
    expectRsv(
      splitSignature(await signer.signTypedData(l1TypedData(constructPhantomAgent(cid, true)))),
      "0xfa8a41f6a3fa728206df80801a83bcbfbab08649cd34d9c0bfba7c7b2f99340f53a00226604567b98a1492803190d65a201d6805e5831b7044f17fd530aec7841c"
    );
    expectRsv(
      splitSignature(await signer.signTypedData(l1TypedData(constructPhantomAgent(cid, false)))),
      "0x1713c0fc661b792a50e8ffdd59b637b1ed172d9a3aa4d801d9d88646710fb74b33959f4d075a7ccbec9f2374a6da21ffa4448d58d0413a0d335775f680a881431c"
    );
  });

  it("test_limit_order_action_hashing", async () => {
    const action = { type: "order", orders: [wire()], grouping: "na" };
    expectRsv(
      await signL1Action(signer, action, null, NONCE, null, true),
      "0x77957e58e70f43b6b68581f2dc42011fc384538a2e5b7bf42d5b936f19fbb67360721a8598727230f67080efee48c812a6a4442013fd3b0eed509171bef9f23f1c"
    );
    expectRsv(
      await signL1Action(signer, action, null, NONCE, null, false),
      "0xcd0925372ff1ed499e54883e9a6205ecfadec748f80ec463fe2f84f1209648776377961965cb7b12414186b1ea291e95fd512722427efcbcfb3b0b2bcd4d79d01c"
    );
  });

  it("test_limit_order_action_hashing_with_cloid", async () => {
    const action = { type: "order", orders: [wire({ c: "0x1e60610f0b3d420597c88c1fed2ad5ee" })], grouping: "na" };
    expectRsv(
      await signL1Action(signer, action, null, NONCE, null, true),
      "0xd3e894092eb27098077145714630a77bbe3836120ee29df7d935d8510b03a08f456de5ec1be82aa65fc6ecda9ef928b0445e212517a98858cfaa251c4cd7552b1c"
    );
    expectRsv(
      await signL1Action(signer, action, null, NONCE, null, false),
      "0x3768349dbb22a7fd770fc9fc50c7b5124a7da342ea579b309f58002ceae49b4357badc7909770919c45d850aabb08474ff2b7b3204ae5b66d9f7375582981f111c"
    );
  });

  it("test_tpsl_order_action_hashing (tp and sl)", async () => {
    const cases: [ "tp" | "sl", string, string][] = [
      [
        "tp",
        "0xb91e5011dff15e4b4a40753730bda44972132e7b75641f3cac58b66159534a170d422ee1ac3c7a7a2e11e298108a2d6b8da8612caceaeeb3e571de3b2dfda9e41b",
        "0x6df38b609904d0d4439884756b8f366f22b3a081801dbdd23f279094a2299fac6424cb0cdc48c3706aeaa368f81959e91059205403d3afd23a55983f710aee871b",
      ],
      [
        "sl",
        "0x8456d2ace666fce1bee1084b00e9620fb20e810368841e9d4dd80eb29014611a0843416e51b1529c22dd2fc28f7ff8f6443875635c72011f60b62cbb8ce90e2d1c",
        "0xeb5bdb52297c1d19da45458758bd569dcb24c07e5c7bd52cf76600fd92fdd8213e661e21899c985421ec018a9ee7f3790e7b7d723a9932b7b5adcd7def5354601c",
      ],
    ];
    for (const [tpsl, main, test] of cases) {
      const action = { type: "order", orders: [wire({ t: { trigger: { isMarket: true, triggerPx: "2000.0", tpsl } } })], grouping: "na" };
      expectRsv(await signL1Action(signer, action, null, NONCE, null, true), main);
      expectRsv(await signL1Action(signer, action, null, NONCE, null, false), test);
    }
  });

  it("test_cancel_action_hashing", async () => {
    const action = { type: "cancel", cancels: [{ a: 1, o: 82382 }] };
    expectRsv(
      await signL1Action(signer, action, null, NONCE, null, true),
      "0x02f76cc5b16e0810152fa0e14e7b219f49c361e3325f771544c6f54e157bf9fa17ed0afc11a98596be85d5cd9f86600aad515337318f7ab346e5ccc1b03425d51b"
    );
    expectRsv(
      await signL1Action(signer, action, null, NONCE, null, false),
      "0x6ffebadfd48067663390962539fbde76cfa36f53be65abe2ab72c9db6d0db44457720db9d7c4860f142a484f070c84eb4b9694c3a617c83f0d698a27e55fd5e01c"
    );
  });

  const BUILDER_MAIN =
    "0x343c9078af7c3d6683abefd0ca3b2960de5b669b716863e6dc49090853a4a3cd6c016301239461091a8ca3ea5ac783362526c4d9e9e624ffc563aea93d6ac2391b";
  const BUILDER_TEST =
    "0x2ada43eeebeba9cfe13faf95aa84e5b8c4885c3a07cbf4536f2df5edd340d4eb1ed0e24f60a80d199a842258d5fa737a18d486f7d4e656268b434d226f2811d71c";
  const builder = "0x1234567890123456789012345678901234567890" as Hex;

  it("test_approve_builder_fee_signing (sign_user_signed_action path)", async () => {
    const action = { maxFeeRate: "0.001%", builder, nonce: NONCE, type: "approveBuilderFee" };
    const main = await signUserSignedAction(signer, action, APPROVE_BUILDER_FEE_TYPES, "HyperliquidTransaction:ApproveBuilderFee", true);
    expectRsv(main.signature, BUILDER_MAIN);
    const test = await signUserSignedAction(signer, action, APPROVE_BUILDER_FEE_TYPES, "HyperliquidTransaction:ApproveBuilderFee", false);
    expectRsv(test.signature, BUILDER_TEST);
  });

  it("buildApproveBuilderFee typed data, signed by a 'wallet', reproduces the vector and assembles the body", async () => {
    // Simulates the user's wallet: Weft only hands over typed data and receives a signature.
    const wallet = privateKeyToAccount(KEY);
    for (const [isMainnet, expected] of [
      [true, BUILDER_MAIN],
      [false, BUILDER_TEST],
    ] as const) {
      const req = buildApproveBuilderFee({ isMainnet, builder, maxFeeTenthsBps: 1, nonce: NONCE });
      expect(req.action.maxFeeRate).toBe("0.001%");
      const sig = await wallet.signTypedData(req.typedData as Parameters<typeof wallet.signTypedData>[0]);
      expectRsv(splitSignature(sig), expected);
      const body = await req.toRequest(sig, wallet.address);
      expect(body).toMatchObject({
        action: {
          type: "approveBuilderFee",
          maxFeeRate: "0.001%",
          builder,
          nonce: NONCE,
          signatureChainId: "0x66eee",
          hyperliquidChain: isMainnet ? "Mainnet" : "Testnet",
        },
        nonce: NONCE,
        vaultAddress: null,
      });
      await expect(req.toRequest(sig, "0x0000000000000000000000000000000000000001")).rejects.toThrow(/expected/);
    }
  });
});
