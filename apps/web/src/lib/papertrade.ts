"use client";
import { useCallback } from "react";
import { useSignTypedData, useWallets } from "@privy-io/react-auth";
import { api } from "@/lib/api";

const SILENT = { uiOptions: { showWalletUIs: false } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Weft keeps this share of what's moved in (the server applies the holder discount). */
export const PAPERTRADE_FEE = 0.01;
/** Papertrade needs this much to arrive on a deposit. */
export const PAPERTRADE_MIN_DEPOSIT = 11;

export type PapertradeStep = "depositing" | "arriving" | "connecting" | "done";

/**
 * Papertrade in one go: move money in from the Hyperliquid account (if needed), wait until it has
 * arrived, and connect (register Weft's key) if it isn't yet. Every signature is the user's own
 * wallet, signed in the background: no prompts, no second click.
 */
export function usePapertrade() {
  const { wallets } = useWallets();
  const { signTypedData } = useSignTypedData();

  const walletFor = useCallback(
    (address: string | null | undefined) => {
      const w = wallets.find((x) => x.address.toLowerCase() === String(address ?? "").toLowerCase());
      if (!w) throw new Error("Your Hyperliquid wallet isn’t connected in this browser.");
      return w;
    },
    [wallets]
  );

  /** Sign typed data and return the message with v/r/s, as Papertrade reads it. */
  const signVrs = useCallback(
    async (td: { message: Record<string, string> } & Record<string, unknown>) => {
      const w = walletFor(td.message.user);
      const { signature } = await signTypedData(td as never, { ...SILENT, address: w.address });
      const hex = signature.slice(2);
      const v = parseInt(hex.slice(128, 130), 16);
      return { ...td.message, v: String(v < 27 ? v + 27 : v), r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}` };
    },
    [signTypedData, walletFor]
  );

  const deposit = useCallback(
    async (amountUsd: number, wallet: string) => {
      const w = walletFor(wallet);
      const prep = await api.papertradeDepositPrepare(amountUsd, "0xa4b1");
      const sigs: string[] = [];
      for (const td of prep.typedData) sigs.push((await signTypedData(td as never, { ...SILENT, address: w.address })).signature);
      await api.papertradeDepositSubmit(sigs);
      return prep;
    },
    [signTypedData, walletFor]
  );

  const connect = useCallback(async () => {
    await api.papertradeRegister(await signVrs(await api.papertradeRegistration()));
  }, [signVrs]);

  /**
   * Make the Papertrade account ready to trade `needUsd`: top it up from Hyperliquid if it holds
   * less (adding Weft's fee so `needUsd` arrives), wait for the money, connect if needed.
   */
  const ensureReady = useCallback(
    async (needUsd: number, onStep?: (s: PapertradeStep) => void) => {
      let a = await api.papertradeAccount();
      if (!a.enabled || !a.wallet) throw new Error("Set up your Hyperliquid wallet in Weft first: Papertrade uses the same wallet.");
      const have = a.availableUsd ?? 0;
      if (have < needUsd) {
        onStep?.("depositing");
        const amount = Math.max(PAPERTRADE_MIN_DEPOSIT, Math.ceil(((needUsd - have) / (1 - PAPERTRADE_FEE)) * 100) / 100);
        await deposit(amount, a.wallet);
        onStep?.("arriving");
        const until = Date.now() + 4 * 60_000;
        for (;;) {
          await sleep(4_000);
          a = await api.papertradeAccount();
          if ((a.availableUsd ?? 0) >= Math.min(needUsd, have + amount * (1 - PAPERTRADE_FEE) - 1.01)) break;
          if (Date.now() > until) throw new Error("The money is on its way to Papertrade but hasn’t arrived yet. Try again in a minute.");
        }
      }
      // A key that's missing, or runs out within three days, gets (re)registered.
      if (!a.registered || (a.sessionExpiresAt ?? 0) - Date.now() < 3 * 86_400_000) {
        onStep?.("connecting");
        await connect();
      }
      onStep?.("done");
    },
    [connect, deposit]
  );

  return { ensureReady, deposit, connect, signVrs };
}
