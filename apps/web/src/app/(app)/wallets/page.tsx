"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SolanaSetup } from "@/components/app/SolanaSetup";
import { HyperliquidWallet } from "@/components/app/HyperliquidWallet";
import { HyperliquidWithdraw } from "@/components/app/Withdraw";
import { PapertradeSetup } from "@/components/app/PapertradeSetup";
import { RiftFunding } from "@/components/app/RiftFunding";
import { useTradingVenues } from "@/lib/trading";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { api, ApiError, type LiveStatus } from "@/lib/api";
import { useAuth, shortAddress } from "@/lib/auth";
import { useApi, fmtUsd } from "@/lib/use-api";
import { PageHeader, Card, Btn, Pill, Empty } from "@/components/app/AppShell";
import { IconCheck, IconKey, IconLock, IconShield } from "@/components/graph/icons";

const HL_APP = { testnet: "https://app.hyperliquid-testnet.xyz", mainnet: "https://app.hyperliquid.xyz" } as const;

/** "eip155:42161" → "0xa4b1" */
const chainHex = (caip: string) => `0x${Number(caip.split(":").pop()).toString(16)}`;

function Step({ n, title, done, active, children }: { n: number; title: string; done: boolean; active: boolean; children: React.ReactNode }) {
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

/**
 * Hyperliquid: a Weft wallet by default (no extension, gas-free deposits), or the user's own
 * MetaMask/Rabby account for people who already trade on Hyperliquid.
 */
function Hyperliquid() {
  const auth = useAuth();
  const status = useApi(() => api.liveStatus(), [], { pollMs: 10_000 });
  const [choice, setChoice] = useState<"weft" | "own" | null>(null);
  const s: LiveStatus | null = status.data;

  if (status.error && !s) {
    const notConfigured = (status.error as ApiError).status === 501;
    return <Empty title={notConfigured ? "Live trading isn't configured on this server" : "Couldn't load live status"} sub={status.error.message} />;
  }
  if (!s) return <div className="h-64 animate-pulse rounded-[12px] bg-paper-2" />;

  // Someone who already linked their own wallet keeps it; everyone else starts with a Weft wallet.
  // (From the account's linked wallets, not just the ones connected in this browser.)
  const weftWallet = auth.wallets.find((w) => w.chain === "ethereum" && w.embedded)?.address.toLowerCase();
  const linkedOwn = !!s.account && s.account.network === s.config.network && s.account.hlAddress.toLowerCase() !== weftWallet;
  const mode = choice ?? (linkedOwn ? "own" : "weft");
  const switcher = (
    <p className="mt-6 text-[13px] text-muted">
      {mode === "weft" ? "Already trade on Hyperliquid? " : "New to Hyperliquid? "}
      <button onClick={() => setChoice(mode === "weft" ? "own" : "weft")} className="font-medium text-ink underline decoration-line-2 underline-offset-4 hover:decoration-ink">
        {mode === "weft" ? "Use your own wallet instead" : "Use a Weft wallet instead"}
      </button>
    </p>
  );
  return (
    <>
      {mode === "weft" ? <HyperliquidWallet status={s} onChange={status.refresh} autoLink={choice === "weft" || !linkedOwn} /> : <OwnWallet s={s} refresh={status.refresh} />}
      {mode !== "weft" && s.account && s.account.network === "mainnet" && s.config.network === "mainnet" && (
        <div className="mt-4">
          <RiftFunding status={s} />
        </div>
      )}
      {switcher}
    </>
  );
}

/** The user's own Hyperliquid account in MetaMask or Rabby: they sign the approvals in their wallet. */
function OwnWallet({ s, refresh }: { s: LiveStatus; refresh: () => Promise<unknown> }) {
  const { wallets, ready: walletsReady } = useWallets();
  const { linkWallet } = usePrivy();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = { refresh };

  const net = s.config.network;
  const linked = s.account && s.account.network === net ? s.account : null;
  const signer = linked ? wallets.find((w) => w.address.toLowerCase() === linked.hlAddress.toLowerCase()) : undefined;
  const agentOk = !!s.venue?.agentApprovedOnVenue;
  const builderOk = !s.config.builder || (s.venue?.builderMaxFeeTenthsBps ?? 0) >= (s.config.builderApproveBps ?? s.config.builderFeeBps ?? 0) * 10;
  const funded = (s.venue?.accountValueUsd ?? 0) > 0;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await status.refresh();
    } catch (e) {
      const err = e as { message?: string; code?: number };
      const msg = err.message ?? String(e);
      // Only a refusal in the wallet counts as cancelling; Hyperliquid's own answers are shown as they are.
      const cancelled = err.code === 4001 || /user (rejected|denied|cancel)|closed the (modal|window)|request rejected by user/i.test(msg);
      setError(
        cancelled
          ? "You cancelled the signature in your wallet."
          : /must deposit|does not exist|no deposit/i.test(msg)
            ? `Hyperliquid only allows this after the address has made a deposit. Deposit USDC on Hyperliquid${s?.config.network === "testnet" ? " testnet" : ""} first, then approve again.`
            : msg.replace(/^Hyperliquid rejected the (\w+) approval: /, "Hyperliquid said no: ")
      );
    } finally {
      setBusy(null);
    }
  };

  const approve = () =>
    run("approve", async () => {
      if (!signer) throw new Error("Connect the linked wallet first (sign in with it).");
      const provider = await signer.getEthereumProvider();
      const prep = await api.prepareApprovals(chainHex(signer.chainId));
      for (const r of prep.requests) {
        const signature = (await provider.request({ method: "eth_signTypedData_v4", params: [signer.address, JSON.stringify(r.typedData)] })) as string;
        await api.submitApproval(r.kind, signature);
      }
    });

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        {error && <Card className="p-4 text-[13.5px] text-short">{error}</Card>}

        <Step n={1} title="Connect your Hyperliquid account" done={!!linked} active>
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            Pick the wallet you use on Hyperliquid. Your money stays there.
          </p>
          {linked ? (
            <div className="mt-3 flex flex-wrap items-center gap-3 text-[12.5px]">
              <span className="rounded-[8px] bg-paper-2 px-2.5 py-1">{shortAddress(linked.hlAddress)}</span>
              <span className="font-sans text-muted">Balance</span>
              <span className={funded ? "text-ink" : "text-trigger"}>{fmtUsd(s.venue?.accountValueUsd ?? 0, 2)}</span>
              {!funded && (
                <a className="text-signal underline-offset-4 hover:underline" href={HL_APP[net]} target="_blank" rel="noopener noreferrer">
                  Deposit on Hyperliquid ↗
                </a>
              )}
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {!walletsReady ? (
              <span className="text-[12px] text-faint">Loading wallets…</span>
            ) : !wallets.some((w) => w.walletClientType !== "privy" && w.address.startsWith("0x")) ? (
              <span className="text-[13.5px] text-muted">No MetaMask or Rabby wallet on your account yet.</span>
            ) : (
              wallets.filter((w) => w.walletClientType !== "privy" && w.address.startsWith("0x")).map((w) => (
                <button
                  key={w.address}
                  disabled={busy != null || linked?.hlAddress.toLowerCase() === w.address.toLowerCase()}
                  onClick={() => run("link", async () => void (await api.linkLive(w.address)))}
                  className={`rounded-full border px-3 py-1.5 font-mono text-[12px] transition-colors disabled:cursor-default ${
                    linked?.hlAddress.toLowerCase() === w.address.toLowerCase() ? "border-long bg-[var(--long-soft)] text-long" : "border-line text-ink-2 hover:border-ink hover:text-ink"
                  }`}
                >
                  {shortAddress(w.address)} · {w.walletClientType}
                </button>
              ))
            )}
            <button
              onClick={() => linkWallet()}
              className="rounded-full border border-dashed border-line-2 px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-ink hover:text-ink"
            >
              + Use MetaMask or Rabby
            </button>
          </div>
        </Step>

        <Step n={2} title="Allow Weft to trade" done={agentOk && builderOk} active={!!linked}>
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            Sign once in your wallet. This gives Weft a trading-only key for your account: it can place and cancel orders, and nothing else.
            {s.config.builder ? ` A second signature allows Weft’s fee: ${(s.config.builderFeeBps ?? 0) / 100}% on perps${s.config.builderSpotFeeBps ? `, ${s.config.builderSpotFeeBps / 100}% on spot sales` : ""}.` : ""}
          </p>
          {linked && !funded && (
            <p className="mt-2 text-[12.5px] leading-relaxed text-trigger">
              Hyperliquid only accepts this after the address has made its first deposit. Deposit USDC first, then approve.
            </p>
          )}
          {s.agentAddress && <div className="mt-2 break-all font-mono text-[13px] text-faint">agent {s.agentAddress}</div>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Btn onClick={approve} disabled={!linked || busy != null || (agentOk && builderOk)} variant={agentOk && builderOk ? "ghost" : "ink"}>
              {busy === "approve" ? "Check your wallet…" : agentOk && builderOk ? "Approved" : "Approve in wallet"}
            </Btn>
            {agentOk && <Pill tone="long">Trading key approved</Pill>}
            {s.config.builder && builderOk && <Pill tone="long">Fee approved</Pill>}
          </div>
          {linked && !signer && <p className="mt-2 text-[12.5px] text-trigger">Sign in with {shortAddress(linked.hlAddress)} to sign the approval.</p>}
        </Step>

        <Step n={3} title="Start a strategy live" done={s.ready} active={agentOk && builderOk}>
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            Open any strategy, choose <span className="font-medium text-ink">Trade</span> and confirm. Start small. You can stop it at any time.
          </p>
          {s.blockers.length > 0 && (
            <ul className="mt-2 space-y-1 text-[13px] text-trigger">
              {s.blockers.map((b) => (
                <li key={b}>• {b}</li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-2">
            <Btn href="/strategies" variant="ghost">Browse strategies</Btn>
            <Btn href="/new" variant="ghost">New strategy</Btn>
          </div>
        </Step>
      </div>

      <div className="space-y-4">
        {linked && funded && <HyperliquidWithdraw status={s} onDone={refresh} />}
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div className="text-[15px] font-semibold tracking-[-0.015em]">{net === "mainnet" ? "Hyperliquid" : "Hyperliquid testnet"}</div>
            {net !== "mainnet" && <Pill tone="trigger">Test money</Pill>}
          </div>
          {net === "testnet" && (
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              Testnet uses test USDC from Hyperliquid&apos;s{" "}
              <a className="text-signal underline-offset-4 hover:underline" href={`${HL_APP.testnet}/drip`} target="_blank" rel="noopener noreferrer">faucet</a>. It works exactly like the real thing, without the risk.
            </p>
          )}
        </Card>
        <Card className="p-5">
          <div className="text-[15px] font-semibold tracking-[-0.015em]">What Weft can do</div>
          <ul className="mt-3 space-y-2 text-[13.5px]">
            {[
              [true, "Place, cancel and close orders"],
              [true, "Set leverage"],
              [false, "Withdraw or transfer funds"],
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
        <Card className="p-5 text-[13.5px]">
          <div className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.015em] text-ink">
            <IconShield size={14} /> Limits
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-y-2">
            <dt className="text-muted">Per live run</dt>
            <dd className="tnum text-right">{s.config.maxAllocationUsd != null ? `up to $${s.config.maxAllocationUsd.toLocaleString()}` : "any amount"}</dd>
            <dt className="text-muted">Leverage</dt>
            <dd className="text-right">each market’s max</dd>
            <dt className="text-muted">Markets</dt>
            <dd className="text-right">Perps, stocks, spot and predictions</dd>
          </dl>
        </Card>
        <Card className="p-5 text-[13px] leading-relaxed text-ink-2">
          <div className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.02em] text-ink">
            <IconKey size={14} /> Turn it off any time
          </div>
          <p className="mt-2">
            On Hyperliquid, go to More → API and remove “weft”. Weft can’t trade for you after that.
          </p>
        </Card>
      </div>
    </div>
  );
}

function Live() {
  const auth = useAuth();
  const router = useRouter();
  const venue = useSearchParams().get("venue");
  // Papertrade shows once live trading there is on (practice needs no wallet).
  const ptOn = Boolean(useTradingVenues()?.papertrade);
  const tab = venue === "solana" ? "solana" : venue === "papertrade" && ptOn ? "papertrade" : "hyperliquid";
  return (
    <>
      <PageHeader title="Wallets" sub="Weft trades from wallets you own. It can place trades for you, but it can never withdraw." />
      <div className="px-5 py-6 lg:px-10">
        {!auth.enabled ? (
          <Empty title="Trading isn’t available here" sub="This server runs without accounts." />
        ) : !auth.authenticated ? (
          <Empty title="Sign in to set up trading" sub="Hyperliquid for perps, stocks and prediction markets. Solana for tokens." action={<Btn onClick={auth.login}>Sign in</Btn>} />
        ) : (
          <>
            <div className="mb-6 inline-flex rounded-[10px] bg-paper-2 p-0.5" role="tablist">
              {(
                [
                  ["hyperliquid", "Hyperliquid", "Perps and stocks"],
                  ["solana", "Solana", "Tokens"],
                  ["papertrade", "Papertrade", "BTC and ETH to 1000×"],
                ] as const
              ).filter(([id]) => id !== "papertrade" || ptOn).map(([id, label, sub]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => router.replace(`/wallets${id === "hyperliquid" ? "" : `?venue=${id}`}`)}
                  className={`rounded-[8px] px-4 py-2 text-left transition-colors ${tab === id ? "bg-[var(--raised)] shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "hover:bg-paper-2"}`}
                >
                  <div className={`text-[14px] ${tab === id ? "font-medium text-ink" : "text-ink-2"}`}>{label}</div>
                  <div className="text-[12px] text-muted">{sub}</div>
                </button>
              ))}
            </div>
            {tab === "solana" ? <SolanaSetup /> : tab === "papertrade" ? <PapertradeSetup /> : <Hyperliquid />}
          </>
        )}
        <p className="mt-6 text-[12.5px] text-faint">Not financial advice. Leverage can lose more than you expect, and tokens can go to zero.</p>
      </div>
    </>
  );
}

export default function LivePage() {
  return (
    <Suspense>
      <Live />
    </Suspense>
  );
}
