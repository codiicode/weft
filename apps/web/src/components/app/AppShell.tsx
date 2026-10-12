"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { motion } from "motion/react";
import { Logo, LogoMark } from "../ui/Logo";
import { ThemeToggle } from "../ui/ThemeToggle";
import { api, API_URL } from "@/lib/api";
import { useApi } from "@/lib/use-api";

const NAV = [
  { href: "/app", label: "Overview", icon: "M3 9.5 10 4l7 5.5V16a1 1 0 0 1-1 1h-4v-5H8v5H4a1 1 0 0 1-1-1z" },
  { href: "/app/new", label: "New strategy", icon: "M10 4v12M4 10h12" },
  { href: "/app/markets", label: "Markets", icon: "M4 15l4-5 3 3 5-7" },
  { href: "/app/runs", label: "Runs", icon: "M5 4.5v11l10-5.5z" },
  { href: "/app/library", label: "Library", icon: "M4 4h4v12H4zM10 4h6v5h-6zM10 11h6v5h-6z" },
  { href: "/app/leaderboard", label: "Leaderboard", icon: "M4 16V9M10 16V4M16 16v-5" },
];

function NavIcon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function ApiStatus() {
  const { data, error } = useApi(() => api.health(), [], { pollMs: 15_000 });
  const ok = !!data && !error;
  const simulated = data ? Object.entries(data.signals).filter(([, m]) => m === "simulated").map(([k]) => k) : [];
  return (
    <div className="rounded-2xl border border-line bg-card/60 p-3 text-[11.5px]" title={ok ? `API ${API_URL}` : `Cannot reach ${API_URL}`}>
      <div className="flex items-center gap-2 font-mono uppercase tracking-[0.12em] text-muted">
        <span className="relative flex h-2 w-2">
          {ok && <span className="pulse-ring absolute inset-0 rounded-full bg-long" />}
          <span className={`relative h-2 w-2 rounded-full ${ok ? "bg-long" : "bg-short"}`} />
        </span>
        {ok ? "Engine online" : "API offline"}
      </div>
      <div className="mt-1.5 leading-relaxed text-faint">
        {ok ? (
          <>
            Paper trading · live market data{simulated.length ? <>; simulated: {simulated.join(", ")}</> : null}
          </>
        ) : (
          <>Start it with <span className="font-mono text-ink-2">npm run dev -w @weft/api</span></>
        )}
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const active = (href: string) => (href === "/app" ? path === "/app" || path === "/app/" : path.startsWith(href));
  return (
    <div className="min-h-screen bg-paper lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      {/* Sidebar */}
      <aside className="sticky top-0 hidden h-screen flex-col gap-6 border-r border-line bg-paper-2/40 p-4 lg:flex">
        <Link href="/" className="px-2 pt-1" aria-label="Weft home">
          <Logo />
        </Link>
        <nav className="flex flex-col gap-0.5">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`relative flex items-center gap-3 rounded-xl px-3 py-2 text-[14px] transition-colors ${active(n.href) ? "text-ink" : "text-ink-2 hover:bg-card/70 hover:text-ink"}`}
            >
              {active(n.href) && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-xl border border-line bg-card shadow-card" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
              <span className="relative"><NavIcon d={n.icon} /></span>
              <span className="relative">{n.label}</span>
            </Link>
          ))}
        </nav>
        <div className="mt-auto space-y-3">
          <ApiStatus />
          <div className="flex items-center justify-between px-1">
            <span className="font-mono text-[10.5px] text-faint">Paper mode · demo</span>
            <ThemeToggle />
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-line bg-paper/85 px-4 py-3 backdrop-blur-xl lg:hidden">
        <Link href="/app" aria-label="Weft app"><LogoMark size={26} /></Link>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">Paper mode</span>
        <ThemeToggle />
      </header>

      <main className="min-w-0 pb-24 lg:pb-0">{children}</main>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-6 border-t border-line bg-paper/90 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={`flex flex-col items-center gap-1 py-2.5 text-[10px] ${active(n.href) ? "text-ink" : "text-muted"}`}>
            <NavIcon d={n.icon} />
            <span className="truncate">{n.label.split(" ")[0]}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function PageHeader({ eyebrow, title, sub, actions }: { eyebrow?: string; title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 border-b border-line px-5 pb-6 pt-7 sm:flex-row sm:items-end sm:justify-between lg:px-10 lg:pt-10">
      <div className="min-w-0">
        {eyebrow && <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">{eyebrow}</div>}
        <h1 className="mt-2 text-[clamp(1.7rem,3vw,2.4rem)] font-semibold leading-[1.05] tracking-[-0.04em]">{title}</h1>
        {sub && <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-2">{sub}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-[20px] border border-line bg-card shadow-card ${className}`}>{children}</div>;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "long" | "short" }) {
  return (
    <Card className="p-4">
      <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className={`tnum mt-2 font-mono text-[22px] tracking-[-0.02em] ${tone === "long" ? "text-long" : tone === "short" ? "text-short" : "text-ink"}`}>{value}</div>
      {sub && <div className="mt-1 text-[12px] text-faint">{sub}</div>}
    </Card>
  );
}

export function Empty({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="dot-grid flex flex-col items-center justify-center rounded-[20px] border border-dashed border-line-2 px-6 py-14 text-center">
      <div className="text-[17px] font-semibold tracking-[-0.02em]">{title}</div>
      {sub && <p className="mt-1.5 max-w-sm text-[14px] text-ink-2">{sub}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "long" | "short" | "trigger" | "signal" }) {
  const cls = {
    neutral: "bg-paper-2 text-ink-2",
    long: "bg-[var(--long-soft)] text-long",
    short: "bg-[var(--short-soft)] text-short",
    trigger: "bg-[var(--trigger-soft)] text-trigger",
    signal: "bg-[var(--signal-soft)] text-signal",
  }[tone];
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.08em] ${cls}`}>{children}</span>;
}

export function Btn({
  children,
  onClick,
  href,
  variant = "ink",
  disabled,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  variant?: "ink" | "ghost" | "volt" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  const cls = `inline-flex h-10 items-center justify-center gap-2 rounded-full px-4 text-[14px] font-medium transition-[background-color,opacity,box-shadow] disabled:cursor-not-allowed disabled:opacity-40 ${
    {
      ink: "bg-ink text-paper hover:shadow-[0_8px_24px_-10px_rgba(0,0,0,.5)]",
      ghost: "border border-line-2 bg-card/60 text-ink hover:bg-card",
      volt: "bg-volt text-[#0b0c0f] hover:shadow-[0_10px_30px_-10px_rgba(205,255,63,.7)]",
      danger: "bg-short text-white",
    }[variant]
  } ${className}`;
  if (href) return <Link href={href} className={cls}>{children}</Link>;
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cls}>
      {children}
    </button>
  );
}
