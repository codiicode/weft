"use client";
import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { PAPERTRADE_FEE, usePapertrade, type PapertradeStep } from "@/lib/papertrade";
import { useApi, fmtUsd } from "@/lib/use-api";
import { Card, Btn } from "@/components/app/AppShell";

/**
 * Papertrade (synthetic BTC and ETH perps up to 1000× on HyperEVM) from the same wallet as the
 * user's Hyperliquid account. One signature lets Weft's session key open and close positions there;
 * Papertrade never lets that key withdraw. Money goes in through the account's deposit address.
 */
export function PapertradeSetup() {
  const acct = useApi(() => api.papertradeAccount(), [], { pollMs: 15_000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const a = acct.data;
  const n = Number(amount);
  const funded = (a?.availableUsd ?? 0) > 0 || (a?.openPositions ?? 0) > 0;

  const papertrade = usePapertrade();
  const [step, setStep] = useState<PapertradeStep | null>(null);

  const move = async (dir: "in" | "out") => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      if (dir === "in") {
        // Deposit, wait for it to arrive, connect if needed: one click.
        await papertrade.ensureReady((a?.availableUsd ?? 0) + n * (1 - PAPERTRADE_FEE) - 0.01, setStep);
        setNote("Done: the money is in your Papertrade account and Weft can trade it.");
      } else {
        await api.papertradeWithdrawSubmit(await papertrade.signVrs(await api.papertradeWithdrawPrepare(n)));
        setNote("Withdrawal sent. It lands in your Hyperliquid account in a minute or two.");
      }
      setAmount("");
      await acct.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await papertrade.connect();
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
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/venues/papertrade.png" alt="" width={32} height={32} className="rounded-[8px]" />
          <div className="text-[15px] font-semibold text-ink">Papertrade</div>
        </div>
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
                    : funded
                      ? "Weft connects your account so it can open and close positions there. Papertrade never lets that key withdraw."
                      : "Add money below: Weft connects your account at the same time. Papertrade never lets that key withdraw."}
                </div>
              </div>
              {funded && (
                <Btn onClick={connect} disabled={busy} variant="ghost">
                  {busy && !step ? "Signing…" : a.registered ? "Renew" : "Connect"}
                </Btn>
              )}
            </div>
            <div className="px-5 py-4">
              <div className="flex items-baseline justify-between">
                <div className="text-[14.5px] font-medium text-ink">Balance</div>
                <div className="tnum text-[15px] font-semibold text-ink">{a.availableUsd != null ? fmtUsd(a.availableUsd, 2) : "—"}</div>
              </div>
              {a.paper != null && (
                <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3">
                  <div>
                    <div className="text-[14.5px] font-medium text-ink">PAPER</div>
                    <div className="mt-0.5 text-[12.5px] text-muted">Earned on Papertrade losses, staked included. It can’t be sold yet.</div>
                  </div>
                  <div className="tnum text-[15px] font-semibold text-ink">{a.paper.toLocaleString("en-US", { maximumFractionDigits: 0 })} PAPER</div>
                </div>
              )}
              {(
                <div className="mt-3">
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
                    <input
                      inputMode="decimal"
                      placeholder="Amount, USD"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                      className="col-span-2 h-10 w-full rounded-[10px] border border-line bg-paper px-3 text-[14px] text-ink outline-none focus:border-ink sm:w-40"
                    />
                    <Btn onClick={() => move("in")} disabled={busy || !(n >= 11)}>
                      {busy && step && step !== "done" ? { depositing: "Moving…", arriving: "Arriving…", connecting: "Connecting…" }[step] : "Add money"}
                    </Btn>
                    {funded && (
                      <Btn variant="ghost" onClick={() => move("out")} disabled={busy || !(n >= 10)}>
                        Withdraw
                      </Btn>
                    )}
                  </div>
                  <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
                    Money comes from your Hyperliquid account. Weft keeps 1% of what you move in (less if you hold $WEFT); withdrawals are free. At least $11 in, $10 out.
                    {n >= 11 && ` Depositing $${n.toFixed(2)}: about $${(n * 0.99).toFixed(2)} reaches Papertrade.`}
                  </p>
                  {note && <p className="mt-2 text-[13px] text-ink-2">{note}</p>}
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
