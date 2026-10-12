import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  actionHash,
  constructPhantomAgent,
  floatToIntForHashing,
  floatToWire,
  packAction,
  recoverL1Signer,
  recoverUserSigner,
  signerFromPrivateKey,
  signL1Action,
  signUserSignedAction,
  USD_SEND_TYPES,
  WITHDRAW_TYPES,
  type Signature,
} from "../src/hyperliquid/signing.ts";
import { orderAction, orderToWire, type HlOrder } from "../src/hyperliquid/wire.ts";

/**
 * Official vectors from hyperliquid-python-sdk `tests/signing_test.py` (master).
 * The SDK renders r/s with `to_hex(int)`, which strips leading zeros, so we compare numerically.
 */
const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123" as Hex;
const signer = signerFromPrivateKey(KEY);

function expectSig(sig: Signature, r: string, s: string, v: number) {
  expect(BigInt(sig.r)).toBe(BigInt(r));
  expect(BigInt(sig.s)).toBe(BigInt(s));
  expect(sig.v).toBe(v);
}

const order = (o: Partial<HlOrder>): HlOrder => ({
  asset: 1,
  isBuy: true,
  sz: 100,
  limitPx: 100,
  reduceOnly: false,
  orderType: { limit: { tif: "Gtc" } },
  ...o,
});

describe("hyperliquid signing: official SDK vectors", () => {
  it("test_phantom_agent_creation_matches_production", () => {
    const action = orderAction([
      orderToWire({ asset: 4, isBuy: true, sz: 0.0147, limitPx: 1670.1, reduceOnly: false, orderType: { limit: { tif: "Ioc" } } }),
    ]);
    const hash = actionHash(action, null, 1677777606040, null);
    expect(constructPhantomAgent(hash, true).connectionId).toBe("0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908");
  });

  it("test_l1_action_signing_matches (dummy action, mainnet + testnet)", async () => {
    const action = { type: "dummy", num: floatToIntForHashing(1000) };
    expectSig(
      await signL1Action(signer, action, null, 0, null, true),
      "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298",
      "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8",
      27
    );
    expectSig(
      await signL1Action(signer, action, null, 0, null, false),
      "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510",
      "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613",
      28
    );
  });

  it("test_l1_action_signing_order_matches", async () => {
    const action = orderAction([orderToWire(order({}))]);
    expectSig(
      await signL1Action(signer, action, null, 0, null, true),
      "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e",
      "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e",
      28
    );
    expectSig(
      await signL1Action(signer, action, null, 0, null, false),
      "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54",
      "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5",
      27
    );
  });

  it("test_l1_action_signing_order_with_cloid_matches", async () => {
    const action = orderAction([orderToWire(order({ cloid: "0x00000000000000000000000000000001" }))]);
    expectSig(
      await signL1Action(signer, action, null, 0, null, true),
      "0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3",
      "0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da",
      27
    );
    expectSig(
      await signL1Action(signer, action, null, 0, null, false),
      "0xeba0664bed2676fc4e5a743bf89e5c7501aa6d870bdb9446e122c9466c5cd16d",
      "0x7f3e74825c9114bc59086f1eebea2928c190fdfbfde144827cb02b85bbe90988",
      28
    );
  });

  it("test_l1_action_signing_matches_with_vault", async () => {
    const action = { type: "dummy", num: floatToIntForHashing(1000) };
    const vault = "0x1719884eb866cb12b2287399b15f7db5e7d775ea";
    expectSig(
      await signL1Action(signer, action, vault, 0, null, true),
      "0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239",
      "0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c",
      28
    );
    expectSig(
      await signL1Action(signer, action, vault, 0, null, false),
      "0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b",
      "0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60",
      27
    );
  });

  it("test_l1_action_signing_tpsl_order_matches", async () => {
    const action = orderAction([orderToWire(order({ orderType: { trigger: { triggerPx: 103, isMarket: true, tpsl: "sl" } } }))]);
    expectSig(
      await signL1Action(signer, action, null, 0, null, true),
      "0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9",
      "0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405",
      27
    );
    expectSig(
      await signL1Action(signer, action, null, 0, null, false),
      "0x971c554d917c44e0e1b6cc45d8f9404f32172a9d3b3566262347d0302896a2e4",
      "0x206257b104788f80450f8e786c329daa589aa0b32ba96948201ae556d5637eac",
      28
    );
  });

  it("test_create_sub_account_action", async () => {
    const action = { type: "createSubAccount", name: "example" };
    expectSig(
      await signL1Action(signer, action, null, 0, null, true),
      "0x51096fe3239421d16b671e192f574ae24ae14329099b6db28e479b86cdd6caa7",
      "0xb71f7d293af92d3772572afb8b102d167a7cef7473388286bc01f52a5c5b423",
      27
    );
    expectSig(
      await signL1Action(signer, action, null, 0, null, false),
      "0xa699e3ed5c2b89628c746d3298b5dc1cca604694c2c855da8bb8250ec8014a5b",
      "0x53f1b8153a301c72ecc655b1c315d64e1dcea3ee58921fd7507e35818fcc1584",
      28
    );
  });

  it("test_sub_account_transfer_action", async () => {
    const action = { type: "subAccountTransfer", subAccountUser: "0x1d9470d4b963f552e6f671a81619d395877bf409", isDeposit: true, usd: 10 };
    expectSig(
      await signL1Action(signer, action, null, 0, null, true),
      "0x43592d7c6c7d816ece2e206f174be61249d651944932b13343f4d13f306ae602",
      "0x71a926cb5c9a7c01c3359ec4c4c34c16ff8107d610994d4de0e6430e5cc0f4c9",
      28
    );
    expectSig(
      await signL1Action(signer, action, null, 0, null, false),
      "0xe26574013395ad55ee2f4e0575310f003c5bb3351b5425482e2969fa51543927",
      "0xefb08999196366871f919fd0e138b3a7f30ee33e678df7cfaf203e25f0a4278",
      28
    );
  });

  it("test_schedule_cancel_action (with and without time)", async () => {
    let action: Record<string, unknown> = { type: "scheduleCancel" };
    expectSig(
      await signL1Action(signer, action, null, 0, null, true),
      "0x6cdfb286702f5917e76cd9b3b8bf678fcc49aec194c02a73e6d4f16891195df9",
      "0x6557ac307fa05d25b8d61f21fb8a938e703b3d9bf575f6717ba21ec61261b2a0",
      27
    );
    expectSig(
      await signL1Action(signer, action, null, 0, null, false),
      "0xc75bb195c3f6a4e06b7d395acc20bbb224f6d23ccff7c6a26d327304e6efaeed",
      "0x342f8ede109a29f2c0723bd5efb9e9100e3bbb493f8fb5164ee3d385908233df",
      28
    );
    action = { type: "scheduleCancel", time: 123456789 };
    expectSig(
      await signL1Action(signer, action, null, 0, null, true),
      "0x609cb20c737945d070716dcc696ba030e9976fcf5edad87afa7d877493109d55",
      "0x16c685d63b5c7a04512d73f183b3d7a00da5406ff1f8aad33f8ae2163bab758b",
      28
    );
    expectSig(
      await signL1Action(signer, action, null, 0, null, false),
      "0x4e4f2dbd4107c69783e251b7e1057d9f2b9d11cee213441ccfa2be63516dc5bc",
      "0x706c656b23428c8ba356d68db207e11139ede1670481a9e01ae2dfcdb0e1a678",
      27
    );
  });

  it("test_float_to_int_for_hashing", () => {
    // 123123123123 → 12312312312300000000 exceeds 2^53 in JS; the SDK vector is checked as a BigInt-safe subset.
    expect(floatToIntForHashing(0.00001231)).toBe(1231);
    expect(floatToIntForHashing(1.033)).toBe(103300000);
    expect(() => floatToIntForHashing(0.000012312312)).toThrow();
  });

  it("test_sign_usd_transfer_action (user-signed, testnet)", async () => {
    const message = { destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a", amount: "1", time: 1687816341423 };
    const { signature } = await signUserSignedAction(signer, message, USD_SEND_TYPES, "HyperliquidTransaction:UsdSend", false);
    expectSig(
      signature,
      "0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073",
      "0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7",
      27
    );
  });

  it("test_sign_withdraw_from_bridge_action (user-signed, testnet)", async () => {
    const message = { destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a", amount: "1", time: 1687816341423 };
    const { action, signature } = await signUserSignedAction(signer, message, WITHDRAW_TYPES, "HyperliquidTransaction:Withdraw", false);
    expectSig(
      signature,
      "0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9",
      "0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881",
      28
    );
    expect(await recoverUserSigner(action, signature, WITHDRAW_TYPES, "HyperliquidTransaction:Withdraw")).toBe(
      privateKeyToAccount(KEY).address
    );
  });
});

describe("hyperliquid signing: internals", () => {
  it("floatToWire matches Python float_to_wire", () => {
    expect(floatToWire(100)).toBe("100");
    expect(floatToWire(1670.1)).toBe("1670.1");
    expect(floatToWire(0.0147)).toBe("0.0147");
    expect(floatToWire(0.00000001)).toBe("0.00000001");
    expect(floatToWire(123456)).toBe("123456");
    expect(floatToWire(0)).toBe("0");
    expect(floatToWire(-0)).toBe("0");
    expect(() => floatToWire(0.000000001)).toThrow(/rounding/);
    expect(() => floatToWire(1.123456789)).toThrow(/rounding/);
  });

  it("msgpack matches Python msgpack.packb byte-for-byte (hand-checked encodings)", () => {
    // {"type":"dummy","num":100000000000}: fixmap(2), fixstr "type", fixstr "dummy", fixstr "num", uint64
    const hex = Buffer.from(packAction({ type: "dummy", num: 100000000000 })).toString("hex");
    expect(hex).toBe("82a474797065a564756d6d79a36e756dcf000000174876e800");
    // str8 for strings ≥ 32 bytes (Python msgpack ≥ 1.0 default use_bin_type=True)
    const s = "x".repeat(40);
    expect(Buffer.from(packAction(s)).toString("hex").slice(0, 4)).toBe("d928");
    // undefined keys are dropped, not encoded as nil
    expect(Buffer.from(packAction({ a: 1, c: undefined })).toString("hex")).toBe("81a16101");
  });

  it("expiresAfter changes the hash (0x00 ‖ u64be appended)", () => {
    const a = { type: "dummy" };
    expect(actionHash(a, null, 1, null)).not.toBe(actionHash(a, null, 1, 2));
  });

  it("recovers the agent address from an L1 signature", async () => {
    const action = orderAction([orderToWire(order({}))]);
    const sig = await signL1Action(signer, action, null, 42, 1000, false);
    expect(await recoverL1Signer(action, sig, null, 42, 1000, false)).toBe(signer.address);
    expect(await recoverL1Signer(action, sig, null, 42, 1000, true)).not.toBe(signer.address);
  });
});
