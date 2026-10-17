import type { ReactNode } from "react";
import Link from "next/link";
import { Logo } from "@/components/ui/Logo";
import { Footer } from "@/components/landing/Footer";

const PAGES = [
  ["/terms", "Terms"],
  ["/privacy", "Privacy"],
  ["/risk", "Risks"],
] as const;

/** Shared frame for the terms, privacy and risk pages: plain reading layout, no app chrome. */
export function LegalPage({ path, title, updated, intro, children }: { path: string; title: string; updated: string; intro: ReactNode; children: ReactNode }) {
  return (
    <>
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-6 px-5 sm:px-8">
          <Link href="/" aria-label="Weft home">
            <Logo />
          </Link>
          <nav className="ml-auto flex gap-5 text-[14px]">
            {PAGES.map(([href, label]) => (
              <Link key={href} href={href} className={href === path ? "text-ink" : "text-muted hover:text-ink"}>
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[44rem] px-5 pb-24 pt-14 sm:px-8 sm:pt-20">
        <h1 className="display text-[clamp(2.4rem,6vw,3.6rem)] leading-[1.04] text-ink">{title}</h1>
        <p className="mt-3 text-[13.5px] text-muted">Last updated {updated}</p>
        <div className="mt-8 text-[17px] leading-[1.65] text-ink-2">{intro}</div>
        <div className="legal mt-10 space-y-10">{children}</div>
      </main>
      <Footer />
    </>
  );
}

/** One numbered section of a legal page. */
export function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-[19px] font-semibold tracking-[-0.015em] text-ink">{title}</h2>
      <div className="mt-3 space-y-3 text-[15.5px] leading-[1.7] text-ink-2 [&_a]:text-ink [&_a]:underline [&_a]:decoration-line-2 [&_a]:underline-offset-4 [&_li]:pl-1 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}
