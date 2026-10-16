import { brand } from "@/config/brand";

/**
 * The mark: three threads (the signals) meet in a knot (the rule) and leave as one (the trade).
 * Under 20px it drops the middle thread and thickens the rest so it stays crisp in a browser tab.
 * Keep in step with public/icon.svg and scripts/brand-assets.mjs.
 */
export function LogoMark({ size = 22, className = "" }: { size?: number; className?: string }) {
  const tiny = size < 20;
  const w = tiny ? 6 : size < 40 ? 4.4 : 3.6;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className={className} aria-hidden fill="none">
      <rect width="48" height="48" rx="12" style={{ fill: "var(--logo-ink)" }} />
      <g style={{ stroke: "var(--paper)" }} strokeWidth={w} strokeLinecap="round">
        <path d="M8 13C20 13 21 24 30 24" />
        {!tiny && <path d="M8 24H30" />}
        <path d="M8 35C20 35 21 24 30 24" />
        <path d="M30 24H40" />
      </g>
      <circle cx="30" cy="24" r={tiny ? 6 : size < 40 ? 5.6 : 5.2} style={{ fill: "var(--paper)" }} />
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 text-ink ${className}`}>
      <LogoMark />
      <span className="text-[18px] font-semibold tracking-[-0.035em]">{brand.name.toLowerCase()}</span>
    </span>
  );
}
