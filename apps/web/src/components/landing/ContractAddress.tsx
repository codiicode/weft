"use client";
import { useState } from "react";
import { brand, $T } from "@/config/brand";

/** The one official $WEFT address, with copy and the places people check it. Hidden until it's set. */
export function ContractAddress() {
  const ca = brand.contractAddress;
  const [copied, setCopied] = useState(false);
  if (!ca || ca.startsWith("PLACEHOLDER")) return null;
  const links: [string, string][] = [
    ["Solscan", `https://solscan.io/token/${ca}`],
    ["DexScreener", `https://dexscreener.com/solana/${ca}`],
    ["Jupiter", `https://jup.ag/tokens/${ca}`],
  ];
  return (
    <div className="mt-10 rounded-[14px] border border-line bg-card p-5">
      <div className="text-[13px] text-muted">{$T} contract address · the only official one</div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <code className="break-all font-mono text-[15px] text-ink">{ca}</code>
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(ca).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
          className="rounded-[8px] border border-line-2 px-3 py-1.5 text-[13px] text-ink hover:border-ink/30"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-[13.5px]">
        {links.map(([label, href]) => (
          <a key={label} href={href} target="_blank" rel="noopener noreferrer" className="text-ink-2 underline decoration-line-2 underline-offset-4 hover:text-ink">
            {label} ↗
          </a>
        ))}
      </div>
    </div>
  );
}
