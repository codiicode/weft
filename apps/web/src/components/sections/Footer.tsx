import { brand } from "@/config/brand";
import { Logo } from "../ui/Logo";

const cols = [
  ["Product", [["What you can trade", "#products"], ["How it works", "#how"], ["Strategies", "#gallery"], ["Signals", "#signals"], ["Leaderboard", "#leaderboard"]]],
  ["Trust", [["Safety", "#safety"], ["Open vs. closed", "#compare"], ["FAQ", "#faq"]]],
  ["Token", [[`$${brand.ticker}`, "#token"], ["Buybacks", "#token"]]],
  ["Social", [["X / Twitter", brand.socials.x], ["Telegram", brand.socials.telegram], ["GitHub", brand.socials.github]]],
] as const;

export function Footer() {
  return (
    <footer className="relative overflow-hidden pt-10">
      <div className="mx-auto max-w-[1240px] px-5">
        <div className="grid gap-12 border-t border-line pt-14 md:grid-cols-[minmax(0,1.3fr)_repeat(4,minmax(0,1fr))]">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-[14px] leading-relaxed text-ink-2">{brand.tagline} An open, non-custodial AI trading agent for perps, stocks, predictions and Solana tokens.</p>
          </div>
          {cols.map(([title, links]) => (
            <div key={title}>
              <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint">{title}</div>
              <ul className="mt-4 space-y-2.5">
                {links.map(([l, h]) => (
                  <li key={l}>
                    <a href={h} className="text-[14px] text-ink-2 transition-colors hover:text-ink" {...(h.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                      {l}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 grid gap-4 rounded-2xl border border-line bg-card/50 p-5 text-[12.5px] leading-relaxed text-muted md:grid-cols-2">
          <p>
            <span className="font-medium text-ink">Not financial advice.</span> {brand.name} executes strategies you approve. Trading perpetual futures, leveraged products, tokenized stocks, prediction markets and memecoins carries a high risk of loss, including losses beyond your initial margin. Past performance, paper or live, does not predict future results.
          </p>
          <p>
            <span className="font-medium text-ink">All figures on this page are demo data</span>: prices, odds, returns, leaderboards, buyback totals and handles are illustrative. Venue names are used descriptively; {brand.name} is not affiliated with Hyperliquid, Jupiter, Meteora, pump.fun, Raydium, Polymarket, xStocks or any company mentioned. Options are not yet available. Waitlist form is a frontend demo.
          </p>
        </div>

        <div className="flex flex-col justify-between gap-2 py-8 font-mono text-[11px] text-faint sm:flex-row">
          <span>© {new Date().getFullYear()} {brand.name}. All rights reserved.</span>
          <span>Made with conviction, not custody.</span>
        </div>
      </div>
      <div aria-hidden className="pointer-events-none select-none overflow-hidden">
        <div
          className="mx-auto -mb-[0.22em] max-w-[1400px] text-center text-[clamp(8rem,31vw,28rem)] font-semibold leading-[0.8] tracking-[-0.07em]"
          style={{ backgroundImage: "linear-gradient(to bottom, var(--line-2), transparent 80%)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}
        >
          {brand.name.toLowerCase()}
        </div>
      </div>
    </footer>
  );
}
