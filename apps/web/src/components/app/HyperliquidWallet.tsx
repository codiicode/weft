"use client";
import { useEffect, useRef, useState } from "react";
import { useCreateWallet, useExportWallet, useSignTypedData, useWallets } from "@privy-io/react-auth";
import { api, type DepositStatus, type LiveStatus } from "@/lib/api";
import { shortAddress } from "@/lib/auth";
import { hlFreeUsd } from "@/lib/trading";
import { useApi, fmtUsd } from "@/lib/use-api";
import { Card, Btn, Pill } from "./AppShell";
import { CopyAddress, Step } from "./SolanaSetup";
import { HyperliquidWithdraw } from "./Withdraw";
import { IconCheck, IconKey, IconLock } from "@/components/graph/icons";

/** Hyperliquid's approvals are signed for Arbitrum (mainnet) or Arbitrum Sepolia (testnet). */
const SIGNATURE_CHAIN = { mainnet: "0xa4b1", testnet: "0x66eee" } as const;
const TX_URL = { mainnet: "https://arbiscan.io/tx/", testnet: "https://sepolia.arbiscan.io/tx/" } as const;
const SILENT = { uiOptions: { showWalletUIs: false } };

const errText = (e: unknown) => (e as { message?: string }).message ?? String(e);

/**
 * Hyperliquid with a wallet Weft makes for the user (theirs, exportable). No browser extension:
 * the user sends USDC on Arbitrum to their address, Weft moves it onto Hyperliquid (the user signs a
 * free permit in the background, Weft pays the gas), then switches on trading by signing the agent
 * and fee approvals in the background too.
 */
export function HyperliquidWallet({ status, onChange, autoLink }: { status: LiveStatus; onChange: () => Promise<unknown>; autoLink: boolean }) {
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();
  const { exportWallet } = useExportWallet();
  const { signTypedData } = useSignTypedData();
  const embedded = wallets.find((w) => w.walletClientType === "privy" && w.address.startsWith("0x"));
  const net = status.config.network;
  const linked = status.account && status.account.network === net && embedded && status.account.hlAddress.toLowerCase() === embedded.address.toLowerCase();

  const dep = useApi<DepositStatus>(linked ? () => api.depositStatus() : null, [linked], { pollMs: 8_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tried = useRef<Set<string>>(new Set());

  const funded = (status.venue?.accountValueUsd ?? 0) > 0;
  const agentOk = !!status.venue?.agentApprovedOnVenue;
  const builderOk = !status.config.builder || (status.venue?.builderMaxFeeTenthsBps ?? 0) >= (status.config.builderApproveBps ?? status.config.builderFeeBps ?? 0) * 10;
  const tradingOn = agentOk && builderOk;
  const d = dep.data;
  const waiting = d && d.walletUsdc >= d.minUsdc && !d.inFlight;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await Promise.all([onChange(), dep.refresh()]);
    } catch (e) {
      setError(errText(e).replace(/^Hyperliquid rejected the (\w+) approval: /, "Hyperliquid said no: "));
    } finally {
      setBusy(null);
    }
  };

  const create = () => run("create", async () => void (await createWallet()));
  const link = () => run("link", async () => void (embedded && (await api.linkLive(embedded.address))));
  const deposit = () =>
    run("deposit", async () => {
      if (!embedded) return;
      const prep = await api.prepareDeposit();
      const { signature } = await signTypedData(prep.typedData as never, { ...SILENT, address: embedded.address });
      await api.submitDeposit(signature);
    });
  const turnOn = () =>
    run("approve", async () => {
      if (!embedded) return;
      const prep = await api.prepareApprovals(SIGNATURE_CHAIN[net]);
      for (const r of prep.requests) {
        const { signature } = await signTypedData(r.typedData as never, { ...SILENT, address: embedded.address });
        await api.submitApproval(r.kind, signature);
      }
    });

  // Creating, depositing and approving run by themselves on every page (WalletAutopilot); the
  // buttons below are there if one fails. Here only: switching to the Weft wallet when the user
  // picked it over an account they had linked themselves.
  const once = (key: string, fn: () => void) => {
    if (busy || tried.current.has(key)) return;
    tried.current.add(key);
    fn();
  };
  useEffect(() => {
    if (walletsReady && embedded && !linked && autoLink && status.account) once(`link:${embedded.address}`, link);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletsReady, embedded?.address, linked, autoLink, busy]);

  const address = embedded?.address ?? null;
  const testnet = net === "testnet";

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        {error && <Card className="p-4 text-[13.5px] text-short">{error}</Card>}

        <Step n={1} title="Your Hyperliquid wallet" done={!!linked} active>
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            Made for you by Weft, and yours: its key is secured by Privy, not held by Weft. No extension or Hyperliquid account needed.
          </p>
          {address ? (
            <div className="mt-3 max-w-[30rem]">
              <CopyAddress address={address} />
              <button onClick={() => void exportWallet({ address }).catch(() => {})} className="mt-2 text-[13px] font-medium text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">
                Export key to Phantom, Rabby or MetaMask
              </button>
            </div>
          ) : (
            <Btn className="mt-3" onClick={create} disabled={busy != null || !walletsReady}>
              {busy === "create" || !walletsReady ? "Creating your wallet…" : "Create my wallet"}
            </Btn>
          )}
          {address && !linked && (
            <Btn className="mt-3" onClick={link} disabled={busy != null}>
              {busy === "link" ? "Setting up…" : "Use this wallet"}
            </Btn>
          )}
        </Step>

        <Step n={2} title="Add USDC" done={funded} active={!!linked}>
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            Send USDC on <span className="font-medium text-ink">{testnet ? "Arbitrum Sepolia (test USDC)" : "Arbitrum"}</span> to the address above, at least {d?.minUsdc ?? 5} USDC.
            Weft moves it to Hyperliquid for you and pays the network fee.
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">Already on Hyperliquid? Send USDC from there to the same address instead. It arrives straight away.</p>

          {linked && (
            <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 text-[13.5px]">
              <div>
                <dt className="text-muted">On Hyperliquid</dt>
                <dd className={`tnum mt-0.5 font-medium ${funded ? "text-ink" : "text-muted"}`}>{fmtUsd(status.venue?.accountValueUsd ?? 0, 2)}</dd>
              </div>
              {funded && (
                <>
                  <div>
                    <dt className="text-muted">Free to trade</dt>
                    <dd className="tnum mt-0.5 font-medium text-ink">{fmtUsd(hlFreeUsd(status.venue) ?? 0, 2)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">In positions</dt>
                    <dd className="tnum mt-0.5 font-medium text-ink">{fmtUsd(status.venue?.positionsWorthUsd ?? 0, 2)}</dd>
                  </div>
                </>
              )}
              <div>
                <dt className="text-muted">Arriving on Arbitrum</dt>
                <dd className="tnum mt-0.5 font-medium text-ink">{d ? `${d.walletUsdc.toFixed(2)} USDC` : "…"}</dd>
              </div>
            </dl>
          )}

          {d?.inFlight && (
            <p className="mt-3 rounded-[10px] bg-paper-2 px-3.5 py-2.5 text-[13px] text-ink-2">
              Moving {d.inFlight.usdc.toFixed(2)} USDC to Hyperliquid. This usually takes about a minute.
              {d.inFlight.tx && (
                <>
                  {" "}
                  <a className="text-ink underline decoration-line-2 underline-offset-4" href={`${TX_URL[net]}${d.inFlight.tx}`} target="_blank" rel="noopener noreferrer">
                    View transaction ↗
                  </a>
                </>
              )}
            </p>
          )}
          {d && d.walletUsdc > 0 && d.walletUsdc < d.minUsdc && !d.inFlight && (
            <p className="mt-3 text-[13px] text-trigger">Hyperliquid needs at least {d.minUsdc} USDC per deposit. Send a little more and it moves automatically.</p>
          )}
          {waiting && (
            <Btn className="mt-3" onClick={deposit} disabled={busy != null || !d.relayer.ready}>
              {busy === "deposit" ? "Moving to Hyperliquid…" : `Move ${d.walletUsdc.toFixed(2)} USDC to Hyperliquid`}
            </Btn>
          )}
          {d && !d.relayer.ready && <p className="mt-2 text-[12.5px] text-faint">Gas-free deposits aren’t switched on yet on this server.</p>}
        </Step>

        <Step n={3} title="Weft can trade" done={tradingOn} active={funded}>
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            Weft turns this on by itself once your money has arrived: a trading-only key for your account that can place and cancel orders, and nothing else.
            {status.config.builder ? ` Weft’s fee is ${(status.config.builderFeeBps ?? 0) / 100}% on perps${status.config.builderSpotFeeBps ? ` and ${status.config.builderSpotFeeBps / 100}% on spot sales` : ""}.` : ""}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {tradingOn ? (
              <Pill tone="long">Trading is on</Pill>
            ) : (
              <Btn onClick={turnOn} disabled={!funded || busy != null}>
                {busy === "approve" ? "Turning on…" : "Turn on trading"}
              </Btn>
            )}
          </div>
        </Step>

        <Step n={4} title="Start a strategy" done={status.ready} active={tradingOn}>
          <p className="text-[13.5px] leading-relaxed text-ink-2">Write what you want to trade, or open a strategy, and press start. Start small. You can stop at any time.</p>
          {tradingOn && status.blockers.length > 0 && (
            <ul className="mt-2 space-y-1 text-[13px] text-trigger">
              {status.blockers.map((b) => (
                <li key={b}>• {b}</li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-2">
            <Btn href="/new" variant="ghost">New strategy</Btn>
            <Btn href="/markets" variant="ghost">Browse markets</Btn>
          </div>
        </Step>
      </div>

      <div className="space-y-4">
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div className="text-[15px] font-semibold tracking-[-0.015em]">{testnet ? "Hyperliquid testnet" : "Hyperliquid"}</div>
            {testnet && <Pill tone="trigger">Test money</Pill>}
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
            Perps and stocks, up to each market’s own max leverage.{status.config.maxAllocationUsd != null ? ` Up to $${status.config.maxAllocationUsd.toLocaleString()} per strategy.` : ""}
          </p>
        </Card>
        {linked && funded && <HyperliquidWithdraw status={status} onDone={onChange} />}
        <Card className="p-5">
          <div className="text-[15px] font-semibold tracking-[-0.015em]">What Weft can do</div>
          <ul className="mt-3 space-y-2 text-[13.5px]">
            {[
              [true, "Place, cancel and close orders"],
              [true, "Move USDC you send into Hyperliquid"],
              [false, "Withdraw or send your money anywhere"],
              [false, "Sign anything that isn’t a trade"],
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
          <p className="mt-2">Export the key to Rabby or MetaMask to use the same account on Hyperliquid directly.</p>
          {address && (
            <>
              <button onClick={() => void exportWallet({ address }).catch(() => {})} className="mt-3 text-[13.5px] font-medium text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">
                Export wallet key
              </button>
              <div className="mt-2 font-mono text-[12px] text-faint">{shortAddress(address)}</div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
