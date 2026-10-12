import { brand } from "@/config/brand";

/** The mark: a single weft thread woven across a dark square. */
export function LogoMark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden fill="none">
      <rect width="24" height="24" rx="6" style={{ fill: "var(--logo-ink)" }} />
      <path d="M4.5 9.2c2 0 2.2 5.6 4.1 5.6s2-4.4 3.4-4.4 1.5 4.4 3.4 4.4 2.1-5.6 4.1-5.6" style={{ stroke: "var(--paper)" }} strokeWidth="2" strokeLinecap="round" />
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
