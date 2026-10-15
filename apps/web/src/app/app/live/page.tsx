"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SolanaSetup } from "@/components/app/SolanaSetup";
import { useWallets } from "@privy-io/react-auth";
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

function Setup() {
  const { wallets, ready: walletsReady } = useWallets();
  const status = useApi(() => api.liveStatus(), [], { pollMs: 10_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s: LiveStatus | null = status.data;

  if (status.error && !s) {
    const notConfigured = (status.error as ApiError).status === 501;
    return <Empty title={notConfigured ? "Live trading isn't configured on this server" : "Couldn't load live status"} sub={status.error.message} />;
  }
  if (!s) return <div className="h-64 animate-pulse rounded-[12px] bg-paper-2" />;

  const net = s.config.network;
  const linked = s.account && s.account.network === net ? s.account : null;
  const signer = linked ? wallets.find((w) => w.address.toLowerCase() === linked.hlAddress.toLowerCase()) : undefined;
  const agentOk = !!s.venue?.agentApprovedOnVenue;
  const builderOk = !s.config.builder || (s.venue?.builderMaxFeeTenthsBps ?? 0) >= (s.config.builderFeeBps ?? 0) * 10;
  const funded = (s.venue?.accountValueUsd ?? 0) > 0;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await status.refresh();
    } catch (e) {
      const msg = (e as { message?: string }).message ?? String(e);
      setError(/rejected|denied|cancel/i.test(msg) ? "You cancelled the signature in your wallet." : msg);
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
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
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
            ) : wallets.length === 0 ? (
              <span className="text-[13.5px] text-muted">No Ethereum wallet on your account yet. Sign in with MetaMask or Rabby.</span>
            ) : (
              wallets.map((w) => (
                <button
                  key={w.address}
                  disabled={busy != null || linked?.hlAddress.toLowerCase() === w.address.toLowerCase()}
                  onClick={() => run("link", async () => void (await api.linkLive(w.address)))}
                  className={`rounded-full border px-3 py-1.5 font-mono text-[12px] transition-colors disabled:cursor-default ${
                    linked?.hlAddress.toLowerCase() === w.address.toLowerCase() ? "border-long bg-[var(--long-soft)] text-long" : "border-line text-ink-2 hover:border-ink hover:text-ink"
                  }`}
                >
                  {shortAddress(w.address)} · {w.walletClientType === "privy" ? "Weft wallet" : w.walletClientType}
                </button>
              ))
            )}
          </div>
        </Step>

        <Step n={2} title="Allow Weft to trade" done={agentOk && builderOk} active={!!linked}>
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            Sign once in your wallet. This gives Weft a trading-only key for your account: it can place and cancel orders, and nothing else.
            {s.config.builder ? ` A second signature allows the ${(s.config.builderFeeBps ?? 0) / 100}% trading fee.` : ""}
          </p>
          {s.agentAddress && <div className="mt-2 font-mono text-[13px] text-faint">agent {s.agentAddress}</div>}
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
            <Btn href="/app/library" variant="ghost">Browse strategies</Btn>
            <Btn href="/app/new" variant="ghost">New strategy</Btn>
          </div>
        </Step>
      </div>

      <div className="space-y-4">
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div className="text-[15px] font-semibold tracking-[-0.015em]">{net === "mainnet" ? "Hyperliquid" : "Hyperliquid testnet"}</div>
            <Pill tone={net === "mainnet" ? "short" : "trigger"}>{net === "mainnet" ? "Real money" : "Test money"}</Pill>
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
              [true, "Set leverage within your limits"],
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
            <dd className="tnum text-right">up to ${s.config.maxAllocationUsd.toLocaleString()}</dd>
            <dt className="text-muted">Leverage</dt>
            <dd className="tnum text-right">up to {s.config.maxLeverage}×</dd>
            <dt className="text-muted">Markets</dt>
            <dd className="text-right">Perps and spot</dd>
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
  const tab = useSearchParams().get("venue") === "solana" ? "solana" : "hyperliquid";
  return (
    <>
      <PageHeader title="Trading accounts" sub="Weft trades from accounts you own. It can place trades for you, but can never withdraw." />
      <div className="px-5 py-6 lg:px-10">
        {!auth.enabled ? (
          <Empty title="Trading isn’t available here" sub="This server runs without accounts." />
        ) : !auth.authenticated ? (
          <Empty title="Sign in to set up trading" sub="Hyperliquid for perps and stocks, Solana for tokens." action={<Btn onClick={auth.login}>Sign in</Btn>} />
        ) : (
          <>
            <div className="mb-6 inline-flex rounded-[10px] bg-paper-2 p-0.5" role="tablist">
              {(
                [
                  ["hyperliquid", "Hyperliquid", "Perps and stocks"],
                  ["solana", "Solana", "Tokens"],
                ] as const
              ).map(([id, label, sub]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => router.replace(`/app/live${id === "solana" ? "?venue=solana" : ""}`)}
                  className={`rounded-[8px] px-4 py-2 text-left transition-colors ${tab === id ? "bg-[var(--raised)] shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "hover:bg-paper-2"}`}
                >
                  <div className={`text-[14px] ${tab === id ? "font-medium text-ink" : "text-ink-2"}`}>{label}</div>
                  <div className="text-[12px] text-muted">{sub}</div>
                </button>
              ))}
            </div>
            {tab === "solana" ? <SolanaSetup /> : <Setup />}
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
