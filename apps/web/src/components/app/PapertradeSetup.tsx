"use client";
import { useState } from "react";
import Link from "next/link";
import { useSignTypedData, useWallets } from "@privy-io/react-auth";
import { api } from "@/lib/api";
import { useApi, fmtUsd } from "@/lib/use-api";
import { Card, Btn } from "@/components/app/AppShell";

const SILENT = { uiOptions: { showWalletUIs: false } };

/**
 * Papertrade (synthetic BTC and ETH perps up to 1000× on HyperEVM) from the same wallet as the
 * user's Hyperliquid account. One signature lets Weft's session key open and close positions there;
 * Papertrade never lets that key withdraw. Money goes in through the account's deposit address.
 */
export function PapertradeSetup() {
  const acct = useApi(() => api.papertradeAccount(), [], { pollMs: 15_000 });
  const { wallets } = useWallets();
  const { signTypedData } = useSignTypedData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const a = acct.data;

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const td = await api.papertradeRegistration();
      const wallet = wallets.find((w) => w.address.toLowerCase() === String(td.message.user).toLowerCase());
      if (!wallet) throw new Error("Your Hyperliquid wallet isn’t connected in this browser.");
      const { signature } = await signTypedData(td as never, { ...SILENT, address: wallet.address });
      const hex = signature.slice(2);
      const v = parseInt(hex.slice(128, 130), 16);
      await api.papertradeRegister({ ...td.message, v: String(v < 27 ? v + 27 : v), r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}` });
      await acct.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!a) return <Card className="p-5 text-[14px] text-muted">{acct.error ? "Couldn’t load your Papertrade account." : "Loading…"}</Card>;
  if (!a.enabled) return <Card className="p-5 text-[14px] text-muted">Papertrade isn’t set up on this server yet.</Card>;

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="text-[15px] font-semibold text-ink">Papertrade</div>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">
          BTC and ETH up to 1000×, priced at Hyperliquid’s mid, with no fee on the position. A winning close keeps part of the gain (Papertrade’s haircut and a 2% fee), and a bust loses the whole margin: at 1000× that’s a move of about 0.05%.
          {!a.live && " Live trading through Weft opens soon. Practice works today."}
        </p>
      </Card>

      {!a.wallet ? (
        <Card className="p-5 text-[14px] text-ink-2">
          Papertrade uses the same wallet as your Hyperliquid account.{" "}
          <Link href="/wallets" className="text-ink underline decoration-line-2 underline-offset-4">
            Set up Hyperliquid first
          </Link>
          .
        </Card>
      ) : (
        <>
          <Card className="divide-y divide-line">
            <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-[14.5px] font-medium text-ink">{a.registered ? "Connected" : "Connect Papertrade"}</div>
                <div className="mt-0.5 text-[13.5px] leading-relaxed text-muted">
                  {a.registered
                    ? `Weft can open and close positions in your Papertrade account until ${new Date(a.sessionExpiresAt!).toLocaleDateString()}. It can’t withdraw.`
                    : "One signature lets Weft open and close positions in your Papertrade account for 30 days. Papertrade never lets that key withdraw."}
                </div>
              </div>
              <Btn onClick={connect} disabled={busy} variant={a.registered ? "ghost" : "ink"}>
                {busy ? "Signing…" : a.registered ? "Renew" : "Connect"}
              </Btn>
            </div>
            <div className="px-5 py-4">
              <div className="flex items-baseline justify-between">
                <div className="text-[14.5px] font-medium text-ink">Balance</div>
                <div className="tnum text-[15px] font-semibold text-ink">{a.availableUsd != null ? fmtUsd(a.availableUsd, 2) : "—"}</div>
              </div>
              {a.depositAddress && (
                <div className="mt-3">
                  <div className="text-[13.5px] leading-relaxed text-muted">
                    To add money, send USDC on Hyperliquid (spot) to your Papertrade deposit address. At least 10 USDC; the first deposit pays 1 USDC to open the account.
                  </div>
                  <button
                    onClick={async () => {
                      await navigator.clipboard.writeText(a.depositAddress!);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                    className="mt-2 w-full truncate rounded-[10px] border border-line bg-paper-2 px-3.5 py-2.5 text-left font-mono text-[12.5px] text-ink-2 hover:text-ink"
                  >
                    {copied ? "Copied" : a.depositAddress}
                  </button>
                </div>
              )}
            </div>
          </Card>
          {error && <p className="text-[13.5px] text-short">{error}</p>}
        </>
      )}
    </div>
  );
}
