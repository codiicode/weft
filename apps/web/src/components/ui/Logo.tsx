import { brand } from "@/config/brand";

/** The mark: a single weft thread woven through five nodes, forming a W. */
export function LogoMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="9" style={{ fill: "var(--logo-bg, #0b0c0f)" }} />
      <path
        d="M6.5 10.5 C 8.5 10.5, 9 22, 11.25 22 C 13.5 22, 13.6 13.5, 16 13.5 C 18.4 13.5, 18.5 22, 20.75 22 C 23 22, 23.5 10.5, 25.5 10.5"
        fill="none"
        stroke="#CDFF3F"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <circle cx="6.5" cy="10.5" r="2.1" fill="#f4f2ec" />
      <circle cx="16" cy="13.5" r="2.1" fill="#f4f2ec" />
      <circle cx="25.5" cy="10.5" r="2.1" fill="#f4f2ec" />
      <circle cx="11.25" cy="22" r="1.5" fill="#CDFF3F" />
      <circle cx="20.75" cy="22" r="1.5" fill="#CDFF3F" />
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LogoMark />
      <span className="text-[19px] font-semibold tracking-[-0.04em]">{brand.name.toLowerCase()}</span>
    </span>
  );
}
