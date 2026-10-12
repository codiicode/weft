import Link from "next/link";
import { Logo } from "@/components/ui/Logo";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[1200px] flex-col px-5 py-8 sm:px-8">
      <Link href="/" aria-label="Weft home">
        <Logo />
      </Link>
      <div className="my-auto max-w-[32rem] py-24">
        <h1 className="display text-[clamp(2.6rem,6vw,4.4rem)] leading-[1] text-ink">This page doesn’t exist.</h1>
        <p className="mt-5 text-[17px] leading-[1.6] text-ink-2">The link may be old, or the strategy was removed.</p>
        <div className="mt-8 flex flex-wrap gap-2">
          <Link href="/app" className="inline-flex h-11 items-center rounded-[10px] bg-ink px-5 text-[15px] font-medium text-paper hover:bg-ink/85">
            Open the app
          </Link>
          <Link href="/" className="inline-flex h-11 items-center rounded-[10px] px-5 text-[15px] font-medium text-ink-2 hover:bg-paper-2 hover:text-ink">
            Home
          </Link>
        </div>
      </div>
    </main>
  );
}
