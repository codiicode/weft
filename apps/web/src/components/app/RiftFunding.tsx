"use client";
import { useEffect, useRef, useState } from "react";
import { useSignTypedData, useWallets } from "@privy-io/react-auth";
import { api, type LiveStatus, type RiftOrder, type RiftQuote } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { Btn, Card } from "./AppShell";

const field = "h-10 w-full rounded-[10px] border border-line-2 bg-card px-3 text-[14px] text-ink outline-none placeholder:text-faint focus:border-ink/40";
const STATUS: Record<string, string> = {
  awaiting_deposit: "Waiting for your deposit",
  funded: "Received, on its way",
  executing: "On its way",
  underfunded: "Less arrived than quoted: Rift refunds it",
  delivered: "Arrived",
  refunded: "Refunded",
  expired: "Expired (nothing was sent)",
  frozen: "Held by Rift: contact support",
};
const num = (s: string, d = 6) => Number(s).toLocaleString("en-US", { maximumFractionDigits: d });

/**
 * Add money to (or take it out of) the Hyperliquid account from any chain: BTC, ETH or USDC on
 * Bitcoin, Ethereum, Base or Arbitrum, through Rift. Money in lands as USDC in the user's own
 * account (Weft sets that address); on a default account Weft then moves it to the trading balance
 * with one background signature. Money out is signed by the account's wallet.
 */
/** `compact`: a narrow column (the start panel): adding money only, fields stacked. */
export function RiftFunding({ status, embedded = false, compact = false }: { status: LiveStatus; embedded?: boolean; compact?: boolean }) {
  const assets = useApi(() => api.riftAssets(), []);
  const orders = useApi(() => api.riftOrders(), [], { pollMs: 10_000 });
  const { wallets } = useWallets();
  const { signTypedData } = useSignTypedData();
  const [tab, setTab] = useState<"in" | "out">("in");
  const [asset, setAsset] = useState("bitcoin.btc");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [quote, setQuote] = useState<RiftQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<RiftOrder | null>(null);
  const [copied, setCopied] = useState(false);
  const moved = useRef<Set<string>>(new Set());
  const owner = status.account?.hlAddress.toLowerCase();
  const wallet = wallets.find((w) => w.address.toLowerCase() === owner);
  const a = assets.data?.assets.find((x) => x.id === asset);
  const n = Number(amount);

  const sign = async (tds: Record<string, unknown>[]) => {
    if (!wallet) throw new Error("Connect the wallet that owns this Hyperliquid account first.");
    const out: string[] = [];
    for (const td of tds) {
      if (wallet.walletClientType === "privy") out.push((await signTypedData(td as never, { uiOptions: { showWalletUIs: false }, address: wallet.address })).signature);
      else {
        const provider = await wallet.getEthereumProvider();
        out.push((await provider.request({ method: "eth_signTypedData_v4", params: [wallet.address, JSON.stringify(td)] })) as string);
      }
    }
    return out;
  };
  const chainId = () => (wallet && wallet.walletClientType !== "privy" ? `0x${Number(wallet.chainId.split(":").pop()).toString(16)}` : "0xa4b1");

  // A fresh quote whenever the asset or amount settles.
  useEffect(() => {
    setQuote(null);
    setError(null);
    if (!(n > 0)) return;
    const t = setTimeout(async () => {
      setQuoting(true);
      try {
        setQuote(await api.riftQuote(tab, asset, n));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setQuoting(false);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [tab, asset, n]);

  // Money that arrived in spot on a default account goes to the trading balance, once per order.
  useEffect(() => {
    const arrived = (orders.data?.orders ?? []).filter((o) => o.kind === "in" && o.status === "delivered" && !o.movedToPerps && !moved.current.has(o.id));
    if (!arrived.length || !wallet) return;
    arrived.forEach((o) => moved.current.add(o.id));
    void (async () => {
      for (const o of arrived) {
        try {
          const p = await api.riftToPerps(o.id, chainId());
          if (p.typedData.length) await api.riftToPerpsSubmit(await sign(p.typedData));
        } catch {
          /* it stays in spot; it's tried again on the next visit */
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders.data, wallet]);

  const start = async () => {
    if (!quote) return;
    setBusy(true);
    setError(null);
    try {
      if (tab === "in") setOpen(await api.riftDeposit(quote.id));
      else {
        const w = await api.riftWithdraw(quote.id, to.trim(), chainId());
        await api.riftWithdrawSubmit(await sign(w.typedData));
        setOpen(w.order);
      }
      setAmount("");
      setQuote(null);
      await orders.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const recent = (orders.data?.orders ?? []).slice(0, 5);
  const live = open ? (orders.data?.orders.find((o) => o.id === open.id) ?? open) : null;

  return (
    <Wrap embedded={embedded}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className={embedded ? "text-[14px] font-medium text-ink" : "text-[15px] font-semibold tracking-[-0.015em]"}>{embedded ? "Or from any chain: BTC, ETH or USDC" : "From any chain"}</div>
        <div className={`${compact ? "hidden" : "inline-flex"} rounded-[9px] bg-paper-2 p-0.5 text-[13px]`}>
          {(["in", "out"] as const).map((k) => (
            <button key={k} onClick={() => (setTab(k), setOpen(null))} className={`rounded-[7px] px-3 py-1 ${tab === k ? "bg-[var(--raised)] text-ink" : "text-muted hover:text-ink"}`}>
              {k === "in" ? "Add money" : "Withdraw"}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">
        {tab === "in"
          ? "Send BTC, ETH or USDC from Bitcoin, Ethereum, Base or Arbitrum. It arrives as USDC in your Hyperliquid account, ready to trade."
          : "Take USDC out of your Hyperliquid account as BTC, ETH or USDC on another chain."}{" "}
        Through Rift, which holds it for the few minutes it takes. Each transfer costs about $2 plus a little on the swap, so small amounts cost relatively more.
      </p>

      {live ? (
        <div className="mt-4 rounded-[10px] bg-paper-2 p-4">
          {live.kind === "in" && live.status === "awaiting_deposit" ? (
            <>
              <div className="text-[13.5px] text-ink">
                Send exactly <span className="tnum font-semibold">{num(live.fromAmount, 8)} {live.from.split(".")[1]!.toUpperCase()}</span> on {assets.data?.assets.find((x) => x.id === live.from)?.chain ?? live.from.split(".")[0]} to:
              </div>
              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(live.depositAddress);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="mt-2 w-full truncate rounded-[10px] border border-line bg-card px-3.5 py-2.5 text-left font-mono text-[12.5px] text-ink-2 hover:text-ink"
              >
                {copied ? "Copied" : live.depositAddress}
              </button>
              <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
                About {num(live.estimatedOut, 2)} USDC arrives in your Hyperliquid account a few minutes after it lands. This address is for this one deposit; it stays open for 7 days.
              </p>
            </>
          ) : (
            <div className="text-[13.5px] text-ink">
              {STATUS[live.status] ?? live.status}
              {live.status === "delivered" && live.kind === "in" ? `: about ${num(live.estimatedOut, 2)} USDC is in your account.` : ""}
              {live.status === "delivered" && live.kind === "out" ? ` at ${live.toAddress.slice(0, 6)}…${live.toAddress.slice(-4)}.` : ""}
            </div>
          )}
          <button onClick={() => setOpen(null)} className="mt-2 text-[12.5px] text-muted hover:text-ink">
            {live.status === "awaiting_deposit" ? "Done, I sent it" : "Another"}
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className={`grid gap-3 ${compact ? "" : "sm:grid-cols-2"}`}>
            <div className="relative">
              <select value={asset} onChange={(e) => setAsset(e.target.value)} className={`${field} cursor-pointer appearance-none pr-10`}>
                {(assets.data?.assets ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
              <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-muted">
                <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <input inputMode="decimal" placeholder={tab === "in" ? `Amount, ${a?.symbol ?? ""}` : "Amount, USDC"} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} className={field} />
          </div>
          {tab === "out" && <input placeholder={`Your ${a?.symbol ?? ""} address on ${a?.chain ?? ""}`} value={to} onChange={(e) => setTo(e.target.value)} className={`${field} font-mono text-[13px]`} />}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="tnum text-[13.5px] text-muted">
              {quoting ? "Getting a price…" : quote ? (tab === "in" ? `≈ ${num(quote.estimatedOut, 2)} USDC arrives` : `≈ ${num(quote.estimatedOut, 8)} ${a?.symbol ?? ""} arrives`) : n > 0 ? "" : " "}
            </span>
            <Btn onClick={start} disabled={busy || !quote || (tab === "out" && to.trim().length < 20)}>
              {busy ? "Working…" : tab === "in" ? "Get a deposit address" : "Withdraw"}
            </Btn>
          </div>
        </div>
      )}
      {error && <p className="mt-3 text-[13px] text-short">{error}</p>}

      {!!recent.length && (
        <ul className="mt-4 divide-y divide-line border-t border-line text-[13px]">
          {recent.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3 py-2">
              <span className="text-ink-2">
                {o.kind === "in" ? `${num(o.fromAmount, 8)} ${o.from.split(".")[1]!.toUpperCase()} in` : `${num(o.fromAmount, 2)} USDC out to ${o.to.split(".")[1]!.toUpperCase()}`}
              </span>
              <button onClick={() => setOpen(o)} className="text-muted hover:text-ink">
                {STATUS[o.status] ?? o.status}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Wrap>
  );
}

function Wrap({ embedded, children }: { embedded: boolean; children: React.ReactNode }) {
  return embedded ? <div className="mt-4 rounded-[12px] border border-line p-4">{children}</div> : <Card className="p-5">{children}</Card>;
}

