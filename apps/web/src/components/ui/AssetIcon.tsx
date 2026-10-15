"use client";
import { useState } from "react";

/**
 * A round logo for a coin, token, stock or market. Tries each source in
 * order (the market's own image, a local copy, Hyperliquid's icon set) and
 * falls back to a quiet monogram, so a missing logo never leaves a hole.
 */

const HL = "https://app.hyperliquid.xyz/coins";
/** Logos we ship with the site (public/coins), keyed by symbol. */
const LOCAL = new Set([
  "BTC", "ETH", "SOL", "HYPE", "WIF", "BONK", "PUMP", "JUP", "USDC", "FARTCOIN",
  "NVDA", "TSLA", "GOLD", "AAPL", "COIN", "SILVER", "MSFT", "GOOGL", "AMZN", "META", "SP500", "XYZ100",
  "WHEAT", "NATGAS", "COPPER", "OUTCOME",
]);
/** Common aliases: perp names and tokenized stocks map to the same logo. */
const ALIAS: Record<string, string> = { KBONK: "BONK", XBT: "BTC", WETH: "ETH", WSOL: "SOL", NVDAX: "NVDA", TSLAX: "TSLA", AAPLX: "AAPL", COINX: "COIN", CRCLX: "CRCL", SPX: "SP500" };

function clean(symbol: string) {
  const s = symbol.replace(/^\$/, "").replace(/-PERP$/i, "").split(/[/:\s·]/).filter(Boolean);
  const last = (s.length > 1 && /^[a-z]+$/.test(s[0]!) ? s[1] : s[0]) ?? symbol;
  const up = last.toUpperCase();
  return ALIAS[up] ?? up;
}

export function iconSources(opts: { symbol: string; src?: string | null; dex?: string | null; alt?: string[] }): string[] {
  const sym = clean(opts.symbol);
  const out: string[] = [];
  if (opts.src) out.push(opts.src);
  for (const a of opts.alt ?? []) out.push(a);
  if (LOCAL.has(sym)) out.push(`/coins/${sym}.svg`);
  out.push(opts.dex ? `${HL}/${opts.dex}:${sym}.svg` : `${HL}/${sym}.svg`);
  if (!opts.dex) out.push(`${HL}/xyz:${sym}.svg`);
  return [...new Set(out)];
}

function hue(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function AssetIcon({
  symbol,
  src,
  dex,
  alt,
  size = 20,
  className = "",
}: {
  symbol: string;
  src?: string | null;
  dex?: string | null;
  alt?: string[];
  size?: number;
  className?: string;
}) {
  const sources = iconSources({ symbol, src, dex, alt });
  const key = sources.join("|");
  const [failed, setFailed] = useState<{ key: string; i: number }>({ key, i: 0 });
  const i = failed.key === key ? failed.i : 0;
  const setI = (n: number) => setFailed({ key, i: n });
  const label = clean(symbol);
  if (i >= sources.length) {
    const h = hue(label);
    return (
      <span
        aria-hidden
        className={`inline-grid shrink-0 place-items-center rounded-full font-semibold ${className}`}
        style={{
          width: size,
          height: size,
          fontSize: Math.max(8, size * 0.38),
          background: `oklch(0.93 0.03 ${h})`,
          color: `oklch(0.42 0.06 ${h})`,
        }}
      >
        {label.slice(0, label.length > 3 ? 2 : 3).slice(0, 2)}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={sources[i]}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setI(i + 1)}
      className={`inline-block shrink-0 rounded-full bg-paper-2 object-cover ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/** A small overlapping row of logos (a strategy's markets). */
export function AssetStack({ items, size = 20, max = 3 }: { items: { symbol: string; src?: string | null; dex?: string | null; alt?: string[] }[]; size?: number; max?: number }) {
  const shown = items.slice(0, max);
  return (
    <span className="inline-flex shrink-0 items-center">
      {shown.map((x, k) => (
        <span key={`${x.symbol}-${k}`} className="rounded-full ring-2 ring-card" style={{ marginLeft: k ? -size * 0.3 : 0, zIndex: shown.length - k }}>
          <AssetIcon {...x} size={size} />
        </span>
      ))}
      {items.length > max && <span className="ml-1 text-[11px] text-muted">+{items.length - max}</span>}
    </span>
  );
}
