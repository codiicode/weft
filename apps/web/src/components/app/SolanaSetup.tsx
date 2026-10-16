"use client";
import { useState } from "react";
import { useSigners } from "@privy-io/react-auth";
import { useCreateWallet, useExportWallet } from "@privy-io/react-auth/solana";
import { api, ApiError, type SolanaStatus } from "@/lib/api";
import { useAuth, shortAddress } from "@/lib/auth";
import { useApi } from "@/lib/use-api";
import { Card, Btn, Pill, Empty } from "./AppShell";
import { IconCheck, IconKey, IconLock } from "@/components/graph/icons";
import { SolanaWithdraw } from "./Withdraw";

export function Step({ n, title, done, active, children }: { n: number; title: string; done: boolean; active: boolean; children: React.ReactNode }) {
  return (
    <Card className={`p-5 transition-opacity ${active || done ? "" : "opacity-50"}`}>
      <div className="flex items-center gap-3">
        <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[13px] font-medium ${done ? "bg-[var(--long-soft)] text-long" : active ? "bg-ink text-paper" : "bg-paper-2 text-muted"}`}>
          {done ? <IconCheck size={14} strokeWidth={2.4} /> : n}
        </span>
        <div className="text-[16px] font-semibold tracking-[-0.015em] text-ink">{title}</div>
      </div>
      <div className="mt-3 pl-10">{children}</div>
    </Card>
  );
}

export function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(address).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="group flex w-full items-center justify-between gap-3 rounded-[10px] border border-line-2 bg-card px-3 py-2.5 text-left hover:border-ink/30"
    >
      <span className="break-all font-mono text-[12.5px] text-ink">{address}</span>
      <span className="shrink-0 text-[12.5px] text-muted group-hover:text-ink">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

/**
 * Solana trading: the user's own Weft wallet (a Privy embedded wallet they can export at any time),
 * with Weft added as a limited signer that can only sign swaps.
 */
export function SolanaSetup() {
  const auth = useAuth();
  const status = useApi(() => api.solanaStatus(), [], { pollMs: 15_000 });
  const { createWallet } = useCreateWallet();
  const { exportWallet } = useExportWallet();
  const { addSigners } = useSigners();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s: SolanaStatus | null = status.data;

  if (status.error && !s) {
    const notConfigured = (status.error as ApiError).status === 501;
    return <Empty title={notConfigured ? "Solana trading isn’t configured on this server" : "Couldn’t load Solana status"} sub={status.error.message} />;
  }
  if (!s) return <div className="h-64 animate-pulse rounded-[12px] bg-paper-2" />;

  const embedded = auth.wallets.find((w) => w.chain === "solana" && w.embedded);
  const address = s.wallet?.address ?? embedded?.address ?? null;
  const delegated = Boolean(s.wallet?.delegated);
  const funded = (s.balances?.sol ?? 0) >= 0.01;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await status.refresh();
    } catch (e) {
      const msg = (e as { message?: string }).message ?? String(e);
      setError(/rejected|denied|cancel|closed/i.test(msg) ? "You closed the window before it finished." : msg);
    } finally {
      setBusy(null);
    }
  };

  const allow = () =>
    run("allow", async () => {
      if (!address) throw new Error("Create your trading wallet first.");
      if (!s.signerId || !s.policyId) throw new Error("Solana trading isn’t ready on the server yet.");
      await addSigners({ address, signers: [{ signerId: s.signerId, policyIds: [s.policyId] }] });
      await api.linkSolana(address);
    });

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        {error && <Card className="p-4 text-[13.5px] text-short">{error}</Card>}

        <Step n={1} title="Your Solana trading wallet" done={!!address} active>
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            A wallet that belongs to you, inside Weft. You can export its key to Phantom or any wallet at any time.
          </p>
          {address ? (
            <div className="mt-3 max-w-[30rem]">
              <CopyAddress address={address} />
            </div>
          ) : (
            <Btn className="mt-3" onClick={() => run("create", async () => void (await createWallet()))} disabled={busy != null}>
              {busy === "create" ? "Creating…" : "Create my trading wallet"}
            </Btn>
          )}
        </Step>

        <Step n={2} title="Let Weft trade from it" done={delegated} active={!!address}>
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            Weft gets a limited key that can only sign swaps through Jupiter. It can’t send your coins anywhere else, and every trade is checked before it’s signed.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Btn onClick={allow} disabled={!address || busy != null || delegated} variant={delegated ? "ghost" : "ink"}>
              {busy === "allow" ? "Confirm in the window…" : delegated ? "Allowed" : "Allow trading"}
            </Btn>
            {delegated && <Pill tone="long">Weft can trade</Pill>}
          </div>
        </Step>

        <Step n={3} title="Add funds" done={funded} active={delegated}>
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            Send SOL (and USDC if you like) to your trading wallet from Phantom or an exchange. Keep a little SOL for network fees, around 0.02.
          </p>
          {s.balances && (
            <dl className="mt-3 flex gap-8 text-[13.5px]">
              <div>
                <dt className="text-muted">SOL</dt>
                <dd className={`tnum mt-0.5 font-medium ${funded ? "text-ink" : "text-trigger"}`}>{(s.balances.sol ?? 0).toFixed(4)}</dd>
              </div>
              <div>
                <dt className="text-muted">USDC</dt>
                <dd className="tnum mt-0.5 font-medium text-ink">{(s.balances.usdc ?? 0).toFixed(2)}</dd>
              </div>
            </dl>
          )}
        </Step>

        <Step n={4} title="Start a strategy" done={s.ready} active={delegated && funded}>
          <p className="text-[13.5px] leading-relaxed text-ink-2">Open any Solana token strategy and choose Trade. Start small. You can stop it at any time.</p>
          {s.blockers.length > 0 && (
            <ul className="mt-2 space-y-1 text-[13px] text-trigger">
              {s.blockers.map((b) => (
                <li key={b}>• {b}</li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-2">
            <Btn href="/app/markets?p=tokens" variant="ghost">Browse tokens</Btn>
            <Btn href="/app/new" variant="ghost">New strategy</Btn>
          </div>
        </Step>
      </div>

      <div className="space-y-4">
        {delegated && (s.balances?.sol ?? 0) > 0 && <SolanaWithdraw status={s} onDone={status.refresh} />}
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div className="text-[15px] font-semibold tracking-[-0.015em]">Solana</div>
            <Pill tone="short">Real money</Pill>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
            Swaps go through Jupiter at the best route.{s.feeBps ? ` Weft’s fee is ${(s.feeBps / 100).toFixed(1)}% per swap${s.holder?.active ? ", halved because you hold $WEFT" : ""}.` : ""}{s.maxAllocationUsd != null ? ` Up to $${s.maxAllocationUsd.toLocaleString()} per strategy.` : ""}
          </p>
        </Card>
        <Card className="p-5">
          <div className="text-[15px] font-semibold tracking-[-0.015em]">What Weft can do</div>
          <ul className="mt-3 space-y-2 text-[13.5px]">
            {[
              [true, "Buy and sell tokens through Jupiter"],
              [true, "Run the safety checks on every token"],
              [false, "Send your coins to anyone"],
              [false, "Sign anything that isn’t a swap"],
            ].map(([ok, t]) => (
              <li key={t as string} className="flex items-center gap-2.5">
                <span className={`grid h-5 w-5 place-items-center rounded-full ${ok ? "bg-[var(--long-soft)] text-long" : "bg-[var(--short-soft)] text-short"}`}>
                  {ok ? <IconCheck size={10} strokeWidth={2.4} /> : <IconLock size={10} />}
                </span>
                <span className={ok ? "text-ink" : "text-ink-2"}>{t as string}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-5 text-[13px] leading-relaxed text-ink-2">
          <div className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.02em] text-ink">
            <IconKey size={14} /> It’s your wallet
          </div>
          <p className="mt-2">Export the key to Phantom or Backpack and you hold the coins outside Weft too. Stopping a strategy sells its tokens first.</p>
          {address && (
            <button onClick={() => void exportWallet({ address }).catch(() => {})} className="mt-3 text-[13.5px] font-medium text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">
              Export wallet key
            </button>
          )}
          {address && <div className="mt-2 font-mono text-[12px] text-faint">{shortAddress(address)}</div>}
        </Card>
      </div>
    </div>
  );
}
