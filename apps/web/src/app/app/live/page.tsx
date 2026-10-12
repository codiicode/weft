"use client";
import { useState } from "react";
import Link from "next/link";
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
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full font-mono text-[12px] ${done ? "bg-[var(--long-soft)] text-long" : active ? "bg-ink text-paper" : "bg-paper-2 text-muted"}`}>
          {done ? <IconCheck size={14} strokeWidth={2.4} /> : n}
        </span>
        <div className="text-[16px] font-semibold tracking-[-0.02em]">{title}</div>
      </div>
      <div className="mt-3 pl-11">{children}</div>
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
  if (!s) return <div className="h-64 animate-pulse rounded-[20px] bg-paper-2" />;

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

        <Step n={1} title="Link your Hyperliquid account" done={!!linked} active>
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            Your own wallet is your Hyperliquid account. Funds stay there; Weft never holds them.
          </p>
          {linked ? (
            <div className="mt-3 flex flex-wrap items-center gap-3 font-mono text-[12.5px]">
              <span className="rounded-lg bg-paper-2 px-2.5 py-1">{shortAddress(linked.hlAddress)}</span>
              <span className="text-faint">account value</span>
              <span className={funded ? "text-ink" : "text-trigger"}>{fmtUsd(s.venue?.accountValueUsd ?? 0, 2)}</span>
              {!funded && (
                <a className="text-signal underline-offset-4 hover:underline" href={HL_APP[net]} target="_blank" rel="noopener noreferrer">
                  Deposit on Hyperliquid {net} ↗
                </a>
              )}
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {!walletsReady ? (
              <span className="font-mono text-[12px] text-faint">Loading wallets…</span>
            ) : wallets.length === 0 ? (
              <span className="text-[13px] text-ink-2">No EVM wallet on your account yet. Sign in with MetaMask/Rabby, or use your Privy wallet.</span>
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
                  {shortAddress(w.address)} · {w.walletClientType === "privy" ? "Privy wallet" : w.walletClientType}
                </button>
              ))
            )}
          </div>
        </Step>

        <Step n={2} title={s.config.builder ? "Approve the Weft agent and builder fee" : "Approve the Weft agent"} done={agentOk && builderOk} active={!!linked}>
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            One signature in your wallet authorises Weft&apos;s agent for your account. It can place and cancel orders, nothing else: Hyperliquid
            doesn&apos;t let agent wallets withdraw, and our key provider only lets it sign trades.
            {s.config.builder ? ` A second signature allows a ${s.config.builderFeeBps} bps builder fee, which funds token buybacks.` : ""}
          </p>
          {s.agentAddress && <div className="mt-2 font-mono text-[11.5px] text-faint">agent {s.agentAddress}</div>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Btn onClick={approve} disabled={!linked || busy != null || (agentOk && builderOk)} variant={agentOk && builderOk ? "ghost" : "ink"}>
              {busy === "approve" ? "Waiting for your wallet…" : agentOk && builderOk ? "Approved" : "Approve in wallet"}
            </Btn>
            {agentOk && <Pill tone="long">agent ✓</Pill>}
            {s.config.builder && builderOk && <Pill tone="long">builder fee ✓</Pill>}
          </div>
          {linked && !signer && <p className="mt-2 text-[12.5px] text-trigger">Sign in with {shortAddress(linked.hlAddress)} to sign the approval.</p>}
        </Step>

        <Step n={3} title="Go live from any strategy" done={s.ready} active={agentOk && builderOk}>
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            Open a strategy, choose <span className="font-medium text-ink">Live</span> in the run panel and confirm. Start small; you can kill it any time.
          </p>
          {s.blockers.length > 0 && (
            <ul className="mt-2 space-y-1 text-[13px] text-trigger">
              {s.blockers.map((b) => (
                <li key={b}>• {b}</li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-2">
            <Btn href="/app/library" variant="ghost">Library</Btn>
            <Btn href="/app/new" variant="ghost">New strategy</Btn>
          </div>
        </Step>
      </div>

      <div className="space-y-4">
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div className="text-[15px] font-semibold tracking-[-0.02em]">Network</div>
            <Pill tone={net === "mainnet" ? "short" : "trigger"}>{net === "mainnet" ? "Mainnet · real money" : "Testnet · play money"}</Pill>
          </div>
          {net === "testnet" && (
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              Testnet uses test USDC from Hyperliquid&apos;s{" "}
              <a className="text-signal underline-offset-4 hover:underline" href={`${HL_APP.testnet}/drip`} target="_blank" rel="noopener noreferrer">faucet</a>. Everything works like mainnet, without risk.
            </p>
          )}
        </Card>
        <Card className="p-5">
          <div className="text-[15px] font-semibold tracking-[-0.02em]">What the agent can do</div>
          <ul className="mt-3 space-y-2 text-[13.5px]">
            {[
              [true, "Place, cancel and close orders"],
              [true, "Set leverage within your caps"],
              [false, "Withdraw or transfer funds"],
              [false, "Sign anything that isn't a Hyperliquid trade"],
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
        <Card className="p-5 font-mono text-[12px]">
          <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.14em] text-muted">
            <IconShield size={12} /> Safety caps
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-y-2">
            <dt className="text-faint">Max per live run</dt>
            <dd className="text-right">${s.config.maxAllocationUsd}</dd>
            <dt className="text-faint">Max leverage</dt>
            <dd className="text-right">{s.config.maxLeverage}×</dd>
            <dt className="text-faint">Products</dt>
            <dd className="text-right">HL perps + spot</dd>
          </dl>
        </Card>
        <Card className="p-5 text-[13px] leading-relaxed text-ink-2">
          <div className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.02em] text-ink">
            <IconKey size={14} /> Revoke any time
          </div>
          <p className="mt-2">
            On Hyperliquid, open <span className="font-mono">More → API</span> and remove the &quot;weft&quot; agent. Weft then can&apos;t trade for you at all.
          </p>
        </Card>
      </div>
    </div>
  );
}

export default function LivePage() {
  const auth = useAuth();
  return (
    <>
      <PageHeader eyebrow="Live trading" title={<>Real trades, <span className="serif-em">your</span> keys.</>} sub="Connect your Hyperliquid account once. Strategies you approve then trade through an agent that can't withdraw." />
      <div className="px-5 py-6 lg:px-10">
        {!auth.enabled ? (
          <Empty title="Live trading needs sign-in" sub="Set NEXT_PUBLIC_PRIVY_APP_ID to enable accounts." />
        ) : !auth.authenticated ? (
          <Empty title="Sign in to set up live trading" action={<Btn onClick={auth.login}>Sign in</Btn>} />
        ) : (
          <Setup />
        )}
        <p className="mt-6 font-mono text-[11px] text-faint">
          Not financial advice. Leverage can lose more than you expect. <Link href="/app/runs" className="hover:text-ink">Your runs →</Link>
        </p>
      </div>
    </>
  );
}
