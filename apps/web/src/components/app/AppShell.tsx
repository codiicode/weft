"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { brand } from "@/config/brand";
import { Logo } from "../ui/Logo";
import { ThemeToggle } from "../ui/ThemeToggle";
import { api, API_URL } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth";
import { CommandPalette } from "./CommandPalette";
import { Toasts } from "./Toasts";

const NAV = [
  { href: "/app", label: "Home", icon: "M3.5 9 10 4l6.5 5v7a.5.5 0 0 1-.5.5h-3.5V12h-5v4.5H4a.5.5 0 0 1-.5-.5z" },
  { href: "/app/runs", label: "Runs", icon: "M6 4.5v11l9-5.5z" },
  { href: "/app/library", label: "Strategies", icon: "M4 4.5h12M4 10h12M4 15.5h7" },
  { href: "/app/markets", label: "Markets", icon: "M3.5 14.5 8 9.5l3 3 5.5-6.5" },
  { href: "/app/leaderboard", label: "Leaderboard", icon: "M5 16V10M10 16V4.5M15 16v-4" },
];
const ACCOUNT_NAV = [
  { href: "/app/live", label: "Live trading", icon: "M10.5 3 5 11h4.5l-1 6 5.5-8H9.5z" },
  { href: "/app/settings", label: "Settings", icon: "M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM16 10l1.5-1-1.5-2.6-1.7.4a6 6 0 0 0-1.3-.8L12.5 4h-3l-.5 2a6 6 0 0 0-1.3.8L6 6.4 4.5 9 6 10l-1.5 1L6 13.6l1.7-.4c.4.3.8.6 1.3.8l.5 2h3l.5-2c.5-.2.9-.5 1.3-.8l1.7.4L17.5 11z" },
];
const MOBILE_NAV = [NAV[0]!, NAV[1]!, { href: "/app/new", label: "New", icon: "M10 4.5v11M4.5 10h11" }, NAV[2]!];
const MORE_NAV = [NAV[3]!, NAV[4]!, ...ACCOUNT_NAV];

function NavIcon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function ApiStatus() {
  const { data, error } = useApi(() => api.health(), [], { pollMs: 15_000 });
  const ok = !!data && !error;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[12.5px] text-muted"
      title={ok ? "Connected to live market data" : `Can't reach the Weft server at ${API_URL}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-long" : "bg-short"}`} />
      {ok ? "Prices connected" : "Offline"}
    </span>
  );
}

function AccountButton({ compact = false }: { compact?: boolean }) {
  const auth = useAuth();
  if (!auth.enabled) return null;
  if (!auth.ready) return <div className={compact ? "h-8 w-16 animate-pulse rounded-[8px] bg-paper-2" : "h-10 animate-pulse rounded-[10px] bg-paper-2"} />;
  if (!auth.authenticated) {
    return (
      <button
        onClick={auth.login}
        className={compact ? "h-8 rounded-[8px] px-3 text-[13px] font-medium text-ink hover:bg-paper-2" : "h-10 w-full rounded-[10px] border border-line-2 text-[14px] font-medium text-ink transition-colors hover:border-ink/30"}
      >
        Sign in
      </button>
    );
  }
  return (
    <div className="group flex items-center gap-2.5">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-paper-2 text-[11px] font-medium uppercase text-ink-2">
        {(auth.label ?? "?").replace(/^0x/, "").slice(0, 2)}
      </span>
      {!compact && <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{auth.label}</span>}
      <button onClick={() => auth.logout()} className="rounded-[6px] px-1.5 py-1 text-[12.5px] text-muted hover:text-ink">
        Sign out
      </button>
    </div>
  );
}

function NavLink({ n, active }: { n: { href: string; label: string; icon: string }; active: boolean }) {
  return (
    <Link
      href={n.href}
      aria-current={active ? "page" : undefined}
      className={`flex h-9 items-center gap-3 rounded-[8px] px-2.5 text-[14px] transition-colors ${active ? "bg-paper-2 font-medium text-ink" : "text-ink-2 hover:bg-paper-2/60 hover:text-ink"}`}
    >
      <span className={active ? "text-ink" : "text-muted"}>
        <NavIcon d={n.icon} />
      </span>
      {n.label}
    </Link>
  );
}

/** Builds for a public host without an API set NEXT_PUBLIC_APP_CLOSED (scripts/deploy-web.sh). */
const APP_OPEN = !process.env.NEXT_PUBLIC_APP_CLOSED;

function OpeningSoon() {
  return (
    <div className="flex min-h-[80vh] items-center px-5 lg:px-10">
      <div className="max-w-[34rem]">
        <p className="text-[13px] text-muted">Private beta</p>
        <h1 className="display mt-3 text-[clamp(2.4rem,5vw,4rem)] leading-[1.02] text-ink">The app opens in a few days.</h1>
        <p className="mt-5 text-[17px] leading-[1.6] text-ink-2">
          Paper trading opens first, then live trading on Hyperliquid. Follow along and you’ll hear the moment it’s ready.
        </p>
        <div className="mt-8 flex flex-wrap gap-2">
          <Btn href={brand.socials.x}>Follow on X</Btn>
          <Btn href={brand.socials.telegram} variant="ghost">
            Join the Telegram
          </Btn>
          <Btn href="/#work" variant="quiet">
            See how it works
          </Btn>
        </div>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [more, setMore] = useState(false);
  const appOpen = APP_OPEN;
  const active = (href: string) => (href === "/app" ? path === "/app" || path === "/app/" : path.startsWith(href));
  return (
    <div className="min-h-screen bg-paper lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
      {/* Sidebar */}
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-line px-3 pb-4 pt-5 lg:flex">
        <Link href="/" className="px-2.5" aria-label="Weft home">
          <Logo />
        </Link>
        <Link href="/app/new" className="mx-0.5 mt-6 flex h-9 items-center justify-center gap-2 rounded-[10px] bg-ink text-[14px] font-medium text-paper transition-opacity hover:opacity-85">
          <NavIcon d="M10 4.5v11M4.5 10h11" /> New strategy
        </Link>
        <button
          onClick={() => window.dispatchEvent(new Event("weft:palette"))}
          className="mx-0.5 mt-2 flex h-9 items-center gap-2.5 rounded-[10px] px-2.5 text-[14px] text-muted transition-colors hover:bg-paper-2/60 hover:text-ink"
        >
          <NavIcon d="M8.5 14a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM16.5 16.5l-4-4" />
          Search
          <kbd className="ml-auto font-sans text-[12px] text-faint">⌘K</kbd>
        </button>
        <nav className="mt-4 flex flex-col gap-0.5">
          {NAV.map((n) => (
            <NavLink key={n.href} n={n} active={active(n.href)} />
          ))}
        </nav>
        <p className="mt-6 px-2.5 text-[12px] text-faint">Account</p>
        <nav className="mt-1.5 flex flex-col gap-0.5">
          {ACCOUNT_NAV.map((n) => (
            <NavLink key={n.href} n={n} active={active(n.href)} />
          ))}
        </nav>
        <div className="mt-auto space-y-4 px-1">
          {appOpen !== false && <AccountButton />}
          <div className="flex items-center justify-between pl-1.5">
            {appOpen === false ? <span className="text-[12.5px] text-muted">Private beta</span> : <ApiStatus />}
            <ThemeToggle />
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-line bg-paper/90 px-4 backdrop-blur-md lg:hidden">
        <Link href="/app" aria-label="Weft app">
          <Logo />
        </Link>
        <div className="flex items-center gap-1">
          {appOpen !== false && <AccountButton compact />}
          <ThemeToggle />
        </div>
      </header>

      <main className="min-w-0 pb-24 lg:pb-0">{appOpen === false ? <OpeningSoon /> : children}</main>
      <CommandPalette />
      <Toasts />

      {/* Mobile bottom nav */}
      {more && (
        <div className="fixed inset-0 z-40 bg-black/30 dark:bg-black/60 lg:hidden" onClick={() => setMore(false)}>
          <nav
            className="absolute inset-x-0 bottom-0 rounded-t-[16px] border-t border-line bg-card px-3 pb-[calc(76px+env(safe-area-inset-bottom))] pt-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-line-2" aria-hidden />
            {MORE_NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => setMore(false)}
                aria-current={active(n.href) ? "page" : undefined}
                className={`flex h-12 items-center gap-3 rounded-[10px] px-3 text-[15px] text-ink hover:bg-paper-2 ${active(n.href) ? "bg-paper-2 font-medium" : ""}`}
              >
                <span className="text-muted">
                  <NavIcon d={n.icon} />
                </span>
                {n.label}
              </Link>
            ))}
            <button
              onClick={() => {
                setMore(false);
                window.dispatchEvent(new Event("weft:palette"));
              }}
              className="flex h-12 w-full items-center gap-3 rounded-[10px] px-3 text-[15px] text-ink hover:bg-paper-2"
            >
              <span className="text-muted">
                <NavIcon d="M8.5 14a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM16.5 16.5l-4-4" />
              </span>
              Search
            </button>
          </nav>
        </div>
      )}
      <nav className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-5 border-t border-line bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden">
        {MOBILE_NAV.map((n) => (
          <Link key={n.href} href={n.href} onClick={() => setMore(false)} className={`flex flex-col items-center gap-1 py-2.5 text-[11px] ${active(n.href) && !more ? "text-ink" : "text-muted"}`}>
            <NavIcon d={n.icon} />
            <span className="truncate">{n.label.split(" ")[0]}</span>
          </Link>
        ))}
        <button
          onClick={() => setMore((m) => !m)}
          aria-expanded={more}
          className={`flex flex-col items-center gap-1 py-2.5 text-[11px] ${more || MORE_NAV.some((n) => active(n.href)) ? "text-ink" : "text-muted"}`}
        >
          <NavIcon d="M5 10h.01M10 10h.01M15 10h.01" />
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}

export function PageHeader({ title, sub, actions, back }: { eyebrow?: string; title: ReactNode; sub?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="flex flex-col gap-4 px-5 pb-2 pt-8 sm:flex-row sm:items-end sm:justify-between lg:px-10 lg:pt-12">
      <div className="min-w-0">
        {back && (
          <Link href={back.href} className="mb-3 inline-block text-[13.5px] text-muted hover:text-ink">
            ← {back.label}
          </Link>
        )}
        <h1 className="text-[26px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink sm:text-[28px]">{title}</h1>
        {sub && <p className="mt-1.5 max-w-2xl text-[15px] leading-relaxed text-muted">{sub}</p>}
      </div>
      {actions && <div className="-ml-3 flex shrink-0 flex-wrap items-center gap-1.5 sm:ml-0 sm:gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-[12px] border border-line bg-card ${className}`}>{children}</div>;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "long" | "short" }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] text-muted">{label}</div>
      <div className={`tnum mt-1 text-[22px] font-medium tracking-[-0.02em] ${tone === "long" ? "text-long" : tone === "short" ? "text-short" : "text-ink"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[12.5px] text-faint">{sub}</div>}
    </div>
  );
}

export function Empty({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[12px] border border-line px-6 py-14 text-center">
      <div className="text-[16px] font-semibold tracking-[-0.015em] text-ink">{title}</div>
      {sub && <p className="mt-1.5 max-w-sm text-[14px] leading-relaxed text-muted">{sub}</p>}
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
  return <span className={`inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-[6px] px-2 text-[12px] font-medium ${cls}`}>{children}</span>;
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
  variant?: "ink" | "ghost" | "volt" | "danger" | "quiet";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  const cls = `inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] px-3.5 text-[14px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
    {
      ink: "bg-ink text-paper hover:bg-ink/85",
      volt: "bg-ink text-paper hover:bg-ink/85",
      ghost: "border border-line-2 bg-card text-ink hover:border-ink/30",
      quiet: "text-ink-2 hover:bg-paper-2 hover:text-ink",
      danger: "bg-short text-white hover:bg-short/90",
    }[variant]
  } ${className}`;
  if (href) return <Link href={href} className={cls}>{children}</Link>;
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cls}>
      {children}
    </button>
  );
}
