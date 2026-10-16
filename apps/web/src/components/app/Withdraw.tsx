"use client";
import { useState } from "react";
import { useSignTypedData, useWallets } from "@privy-io/react-auth";
import { useSignTransaction, useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { api, type LiveStatus, type SolanaStatus } from "@/lib/api";
import { fmtUsd } from "@/lib/use-api";
import { Btn, Card } from "./AppShell";

const field = "h-10 w-full rounded-[10px] border border-line-2 bg-card px-3 text-[14px] text-ink outline-none placeholder:text-faint focus:border-ink/40";
const errText = (e: unknown) => {
  const m = (e as { message?: string; code?: number }).message ?? String(e);
  return (e as { code?: number }).code === 4001 || /user (rejected|denied)|closed the (modal|window)/i.test(m) ? "You cancelled it in your wallet." : m;
};
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function Done({ text, href, onAgain }: { text: string; href?: string; onAgain: () => void }) {
  return (
    <div className="mt-3 rounded-[10px] bg-[var(--long-soft)] px-3.5 py-3 text-[13.5px] text-ink">
      {text}
      {href && (
        <>
          {" "}
          <a className="underline decoration-line-2 underline-offset-4" href={href} target="_blank" rel="noopener noreferrer">
            View transaction ↗
          </a>
        </>
      )}
      <button onClick={onAgain} className="ml-3 text-muted hover:text-ink">
        Another
      </button>
    </div>
  );
}

/**
 * Withdraw USDC from Hyperliquid to an address on Arbitrum. The account owner signs it: silently
 * with a Weft wallet, in MetaMask/Rabby for an own wallet. Weft's agent can never withdraw.
 */
export function HyperliquidWithdraw({ status, onDone }: { status: LiveStatus; onDone: () => Promise<unknown> | void }) {
  const { wallets } = useWallets();
  const { signTypedData } = useSignTypedData();
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const owner = status.account?.hlAddress.toLowerCase();
  const wallet = wallets.find((w) => w.address.toLowerCase() === owner);
  const free = status.venue?.withdrawableUsd ?? 0;
  const n = Number(amount);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!wallet) throw new Error("Connect the wallet that owns this Hyperliquid account first.");
      const embedded = wallet.walletClientType === "privy";
      const chain = embedded ? (status.config.network === "mainnet" ? "0xa4b1" : "0x66eee") : `0x${Number(wallet.chainId.split(":").pop()).toString(16)}`;
      const prep = await api.prepareWithdraw({ destination: to.trim(), amountUsd: n, signatureChainId: chain });
      let signature: string;
      if (embedded) signature = (await signTypedData(prep.typedData as never, { uiOptions: { showWalletUIs: false }, address: wallet.address })).signature;
      else {
        const provider = await wallet.getEthereumProvider();
        signature = (await provider.request({ method: "eth_signTypedData_v4", params: [wallet.address, JSON.stringify(prep.typedData)] })) as string;
      }
      await api.submitWithdraw(signature);
      setDone(`On its way: ${fmtUsd(prep.receiveUsd, 2)} to ${to.trim().slice(0, 6)}…${to.trim().slice(-4)} on Arbitrum. It usually arrives within a few minutes.`);
      setAmount("");
      await onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="text-[15px] font-semibold tracking-[-0.015em] text-ink">Withdraw</div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
        Send USDC from Hyperliquid to any address on Arbitrum, like your exchange or another wallet. Hyperliquid charges $1.
      </p>
      {done ? (
        <Done text={done} onAgain={() => setDone(null)} />
      ) : (
        <div className="mt-3 space-y-2.5">
          <div className="flex gap-2">
            <input className={field} inputMode="decimal" placeholder="Amount (USDC)" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
            <button type="button" onClick={() => setAmount(String(Math.floor(free * 100) / 100))} className="shrink-0 rounded-[10px] px-3 text-[13px] text-muted hover:text-ink">
              Max
            </button>
          </div>
          <input className={`${field} font-mono text-[12.5px]`} placeholder="Arbitrum address (0x…)" value={to} onChange={(e) => setTo(e.target.value)} />
          <div className="flex items-center justify-between text-[12.5px] text-muted">
            <span>Free to withdraw {fmtUsd(free, 2)}</span>
            {n > 1 && <span className="tnum">You receive {fmtUsd(n - 1, 2)}</span>}
          </div>
          {error && <p className="text-[12.5px] text-short">{error}</p>}
          <Btn onClick={() => void go()} disabled={busy || !(n > 1) || n > free + 1e-9 || !/^0x[0-9a-fA-F]{40}$/.test(to.trim())} className="w-full">
            {busy ? "Withdrawing…" : n > 1 ? `Withdraw ${fmtUsd(n, 2)}` : "Withdraw"}
          </Btn>
        </div>
      )}
    </Card>
  );
}

/**
 * Send SOL, USDC or a token from the Weft Solana wallet to any address. The user's own wallet signs
 * it (Weft's limited signer can't send funds out); Weft checks the signed transaction is the one it
 * built before sending.
 */
export function SolanaWithdraw({ status, onDone }: { status: SolanaStatus; onDone: () => Promise<unknown> | void }) {
  const { wallets } = useSolanaWallets();
  const { signTransaction } = useSignTransaction();
  const [asset, setAsset] = useState<"SOL" | "USDC" | "token">("SOL");
  const [mint, setMint] = useState("");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; sig: string } | null>(null);
  const address = status.wallet?.address;
  const wallet = wallets.find((w) => w.address === address);
  const have = asset === "SOL" ? (status.balances?.sol ?? 0) : asset === "USDC" ? (status.balances?.usdc ?? 0) : null;
  const assetId = asset === "SOL" ? "SOL" : asset === "USDC" ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" : mint.trim();

  const go = async (max: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (!wallet) throw new Error("Your Weft Solana wallet isn’t connected in this browser yet. Reload the page and try again.");
      const prep = await api.prepareSolanaWithdraw({ asset: assetId, amount: max ? "max" : Number(amount), destination: to.trim() });
      const { signedTransaction } = await signTransaction({ transaction: fromB64(prep.transaction), wallet, chain: "solana:mainnet", options: { uiOptions: { showWalletUIs: false } } });
      const r = await api.submitSolanaWithdraw(b64(signedTransaction));
      setDone({ text: `Sent ${prep.amount} ${asset === "token" ? "tokens" : asset} to ${prep.destination.slice(0, 4)}…${prep.destination.slice(-4)}.`, sig: r.signature });
      setAmount("");
      await onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const n = Number(amount);
  const validTo = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to.trim());
  return (
    <Card className="p-5">
      <div className="text-[15px] font-semibold tracking-[-0.015em] text-ink">Withdraw</div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">Send SOL, USDC or any token to another Solana address, like Phantom or an exchange.</p>
      {done ? (
        <Done text={done.text} href={`https://solscan.io/tx/${done.sig}`} onAgain={() => setDone(null)} />
      ) : (
        <div className="mt-3 space-y-2.5">
          <div className="inline-flex rounded-[10px] bg-paper-2 p-0.5">
            {(["SOL", "USDC", "token"] as const).map((a) => (
              <button key={a} onClick={() => setAsset(a)} className={`h-8 rounded-[8px] px-3 text-[13px] ${asset === a ? "bg-[var(--raised)] font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-muted hover:text-ink"}`}>
                {a === "token" ? "Other token" : a}
              </button>
            ))}
          </div>
          {asset === "token" && <input className={`${field} font-mono text-[12.5px]`} placeholder="Token address (mint)" value={mint} onChange={(e) => setMint(e.target.value)} />}
          <div className="flex gap-2">
            <input className={field} inputMode="decimal" placeholder={`Amount${asset === "token" ? "" : ` (${asset})`}`} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
            <button type="button" disabled={busy || !validTo || (asset === "token" && mint.trim().length < 32)} onClick={() => void go(true)} className="shrink-0 rounded-[10px] px-3 text-[13px] text-muted hover:text-ink disabled:opacity-40">
              Send all
            </button>
          </div>
          <input className={`${field} font-mono text-[12.5px]`} placeholder="Solana address" value={to} onChange={(e) => setTo(e.target.value)} />
          {have != null && <div className="text-[12.5px] text-muted">In your wallet: {have.toFixed(asset === "SOL" ? 4 : 2)} {asset}</div>}
          {error && <p className="text-[12.5px] text-short">{error}</p>}
          <Btn onClick={() => void go(false)} disabled={busy || !(n > 0) || !validTo || (asset === "token" && mint.trim().length < 32)} className="w-full">
            {busy ? "Sending…" : n > 0 ? `Send ${amount} ${asset === "token" ? "" : asset}`.trim() : "Send"}
          </Btn>
        </div>
      )}
    </Card>
  );
}
