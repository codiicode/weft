"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSignTypedData, useWallets } from "@privy-io/react-auth";
import { api, type LiveStatus } from "./api";

/** Hyperliquid's approvals are signed for Arbitrum (mainnet) or Arbitrum Sepolia (testnet). */
const SIGNATURE_CHAIN = { mainnet: "0xa4b1", testnet: "0x66eee" } as const;

/** Where a Hyperliquid account stands on Weft's two approvals (trading key, builder fee). */
export function hlApprovals(s: LiveStatus | null | undefined) {
  const net = s?.config.network;
  const linked = !!s?.account && s.account.network === net;
  const funded = (s?.venue?.accountValueUsd ?? 0) > 0;
  const agentOk = !!s?.venue?.agentApprovedOnVenue;
  const builderOk = !s?.config.builder || (s.venue?.builderMaxFeeTenthsBps ?? 0) >= (s.config.builderFeeBps ?? 0) * 10;
  return { linked, funded, agentOk, builderOk, tradingOn: agentOk && builderOk, needsApproval: linked && funded && !(agentOk && builderOk) };
}

/**
 * Signs Weft's approvals with the user's Weft wallet, in the background (no wallet popups). With
 * `auto`, it runs once by itself whenever an approval is missing, e.g. right after Weft's fee is
 * switched on; `approve` is there as a button fallback. Own MetaMask/Rabby accounts can't be
 * signed silently: `silent` is false for them and they approve on the Wallets page.
 */
export function useHlApprove(status: LiveStatus | null | undefined, onDone: () => Promise<unknown> | void, auto = true) {
  const { wallets, ready } = useWallets();
  const { signTypedData } = useSignTypedData();
  const embedded = wallets.find((w) => w.walletClientType === "privy" && w.address.startsWith("0x"));
  const a = hlApprovals(status);
  const silent = !!embedded && !!status?.account && status.account.hlAddress.toLowerCase() === embedded.address.toLowerCase();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tried = useRef(false);

  const approve = useCallback(async () => {
    if (!embedded || !status) return;
    setBusy(true);
    setError(null);
    try {
      const prep = await api.prepareApprovals(SIGNATURE_CHAIN[status.config.network]);
      for (const r of prep.requests) {
        const { signature } = await signTypedData(r.typedData as never, { uiOptions: { showWalletUIs: false }, address: embedded.address });
        await api.submitApproval(r.kind, signature);
      }
      await onDone();
    } catch (e) {
      setError(((e as { message?: string }).message ?? String(e)).replace(/^Hyperliquid rejected the (\w+) approval: /, "Hyperliquid said no: "));
    } finally {
      setBusy(false);
    }
  }, [embedded, status, signTypedData, onDone]);

  useEffect(() => {
    if (!auto || !ready || !silent || !a.needsApproval || busy || tried.current) return;
    tried.current = true;
    void approve();
  }, [auto, ready, silent, a.needsApproval, busy, approve]);

  return { ...a, silent, busy, error, approve };
}
