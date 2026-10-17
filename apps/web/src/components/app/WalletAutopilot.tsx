"use client";
import { useEffect, useRef } from "react";
import { useCreateWallet, useSignTypedData, useSigners, useWallets } from "@privy-io/react-auth";
import { useCreateWallet as useCreateSolanaWallet } from "@privy-io/react-auth/solana";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/use-api";

const SIGNATURE_CHAIN = { mainnet: "0xa4b1", testnet: "0x66eee" } as const;
const SILENT = { uiOptions: { showWalletUIs: false } };

/**
 * Signing in is the consent: once someone has a Weft account, their Weft wallets are made ready to
 * trade by themselves, on whatever page they're on. Nothing to click and no Wallets page to visit:
 *  - Hyperliquid: create the wallet, link it, move USDC that arrives on Arbitrum onto Hyperliquid
 *    (a free permit, Weft pays the gas), then sign Weft's trading key and fee approvals;
 *  - Solana: create the wallet and add Weft's limited signer (it can only sign Jupiter swaps).
 * All signatures are silent (the user's own embedded wallets). Accounts a user linked from their own
 * MetaMask or Rabby are never touched: those approvals stay on the Wallets page. Each step runs at
 * most once per value per session; the Wallets page keeps buttons for anything that failed.
 */
export function WalletAutopilot() {
  const auth = useAuth();
  const on = auth.enabled && auth.authenticated;
  const { wallets, ready } = useWallets();
  const { createWallet } = useCreateWallet();
  const { createWallet: createSolanaWallet } = useCreateSolanaWallet();
  const { signTypedData } = useSignTypedData();
  const { addSigners } = useSigners();
  const live = useApi(on ? () => api.liveStatus() : null, [on], { pollMs: 20_000 });
  const sol = useApi(on ? () => api.solanaStatus() : null, [on], { pollMs: 30_000 });
  const evm = wallets.find((w) => w.walletClientType === "privy" && w.address.startsWith("0x"));
  const s = live.data;
  const net = s?.config.network;
  const linkedOwn = !!s?.account && (!evm || s.account.hlAddress.toLowerCase() !== evm.address.toLowerCase());
  const linked = !!s?.account && !!evm && s.account.network === net && s.account.hlAddress.toLowerCase() === evm.address.toLowerCase();
  const dep = useApi(on && linked ? () => api.depositStatus() : null, [on, linked], { pollMs: 10_000 });
  const done = useRef(new Set<string>());
  const busy = useRef(false);

  const step = (key: string, fn: () => Promise<unknown>, refresh: () => Promise<unknown>) => {
    if (busy.current || done.current.has(key)) return;
    done.current.add(key);
    busy.current = true;
    void fn()
      .then(refresh)
      .catch((e) => console.warn(`[wallets] ${key.split(":")[0]} didn't finish:`, (e as Error).message))
      .finally(() => {
        busy.current = false;
      });
  };

  // Hyperliquid
  useEffect(() => {
    if (!on || !ready || !s || !net) return;
    const refresh = () => Promise.all([live.refresh(), dep.refresh()]);
    if (!evm) return step("create-evm", () => createWallet(), refresh);
    if (linkedOwn) return; // their own MetaMask/Rabby account: they approve it on the Wallets page
    if (!linked) return step(`link:${evm.address}`, () => api.linkLive(evm.address), refresh);
    const d = dep.data;
    if (d && d.walletUsdc >= d.minUsdc && !d.inFlight && d.relayer.ready)
      return step(`deposit:${d.walletUsdc}`, async () => {
        const prep = await api.prepareDeposit();
        const { signature } = await signTypedData(prep.typedData as never, { ...SILENT, address: evm.address });
        await api.submitDeposit(signature);
      }, refresh);
    const funded = (s.venue?.accountValueUsd ?? 0) > 0;
    const agentOk = !!s.venue?.agentApprovedOnVenue;
    const builderOk = !s.config.builder || (s.venue?.builderMaxFeeTenthsBps ?? 0) >= (s.config.builderFeeBps ?? 0) * 10;
    if (funded && !(agentOk && builderOk))
      return step(`approve:${s.config.builderFeeBps ?? 0}`, async () => {
        const prep = await api.prepareApprovals(SIGNATURE_CHAIN[net]);
        for (const r of prep.requests) {
          const { signature } = await signTypedData(r.typedData as never, { ...SILENT, address: evm.address });
          await api.submitApproval(r.kind, signature);
        }
      }, refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, ready, s, evm?.address, linked, linkedOwn, dep.data]);

  // Solana
  const solEmbedded = auth.wallets.find((w) => w.chain === "solana" && w.embedded);
  const t = sol.data;
  useEffect(() => {
    if (!on || !ready || !t) return;
    const address = t.wallet?.address ?? solEmbedded?.address ?? null;
    if (!address) return step("create-solana", () => createSolanaWallet(), sol.refresh);
    if (t.wallet?.delegated || !t.signerId || !t.policyId) return;
    step(`signer:${address}`, async () => {
      await addSigners({ address, signers: [{ signerId: t.signerId!, policyIds: [t.policyId!] }] });
      await api.linkSolana(address);
    }, sol.refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, ready, t, solEmbedded?.address]);

  return null;
}
