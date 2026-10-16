// Claims Weft's accrued Hyperliquid builder fees into the builder wallet's Hyperliquid account.
// Signed locally with the builder key (it never goes to the server).
// Usage: node scripts/claim-builder-fees.ts            (shows what's claimable)
//        node scripts/claim-builder-fees.ts --send     (claims it)
import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { HlExchangeClient, signerFromPrivateKey } from "@weft/execution";

const key = JSON.parse(readFileSync(new URL("../../../secrets/weft-builder.json", import.meta.url), "utf8")).privateKey as Hex;
const signer = signerFromPrivateKey(key);
const info = (body: unknown) =>
  fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const ref = (await info({ type: "referral", user: signer.address })) as { builderRewards?: string; unclaimedRewards?: string; claimedRewards?: string };
console.log(`builder ${signer.address}: earned $${ref.builderRewards ?? 0}, claimable $${ref.unclaimedRewards ?? 0}, claimed so far $${ref.claimedRewards ?? 0}`);
if (!process.argv.includes("--send")) process.exit(0);
if (!(Number(ref.unclaimedRewards ?? 0) > 0)) {
  console.log("nothing to claim");
  process.exit(0);
}
const client = new HlExchangeClient({ signer, isMainnet: true, allowMainnetSend: true });
const res = await client.post(await client.sign({ type: "claimRewards" }));
console.log("claim:", JSON.stringify(res));
