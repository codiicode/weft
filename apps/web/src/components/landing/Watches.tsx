import { Section } from "./Section";
import { Reveal } from "../ui/Reveal";

/**
 * Everything a rule can listen to, in one place: each tile names a source and gives one condition
 * built on it. Tiles open the builder with a ready-made sentence; wallet and trader tiles need an
 * address of your own, so they open it empty.
 */
const SOURCES: { name: string; example: string; thesis?: string; href?: string; cta?: string; tone: string }[] = [
  { name: "Prices", example: "ETH breaks $2,600", thesis: "Long ETH 5x with $50 if ETH breaks $2,600. 20% stop.", tone: "var(--signal)" },
  { name: "Funding", example: "Longs pay over 0.02% an hour", thesis: "Short SOL 5x with $50 when funding stays above 0.02% an hour. 15% stop.", tone: "var(--signal)" },
  { name: "Posts on X", example: "@saylor posts that Strategy bought more bitcoin", thesis: "If @saylor posts that Strategy bought more bitcoin, long BTC 3x with $100. Stop at -15% on the position.", tone: "var(--trigger)" },
  { name: "Buzz on X", example: "$SOL mentions double in an hour", thesis: "Long SOL 3x with $50 if mentions of $SOL on X double in an hour and the mood is bullish.", tone: "var(--trigger)" },
  { name: "Wallets", example: "A wallet you follow buys a token, and you buy too", tone: "var(--long)" },
  { name: "Hyperliquid traders", example: "A trader you copy opens a BTC long, and so do you", href: "/traders", cta: "Pick a trader →", tone: "var(--long)" },
  { name: "Prediction odds", example: "Polymarket’s Fed cut odds pass 60%", thesis: "Long BTC 2x with $100 if Polymarket’s odds of a Fed cut pass 60%.", tone: "var(--signal)" },
  { name: "News", example: "Three negative Solana headlines in an hour", thesis: "Short SOL 3x with $50 if there are 3 or more negative news headlines about Solana in an hour.", tone: "var(--trigger)" },
  { name: "Fear & Greed", example: "The index falls to 20", thesis: "If the Fear & Greed index reaches 20, open a 20x long on ETH and a 20x long on BTC with $100 on each.", tone: "var(--short)" },
  { name: "Rates and the economy", example: "The 2-year yield drops 10 bp in 5 days", thesis: "Long BTC 2x with $100 if the US 2-year yield falls 10 bp in 5 days.", tone: "var(--signal)" },
  { name: "Weather", example: "Chicago gets 5°C colder next week", thesis: "Long natural gas 2x with $100 if Chicago is forecast to be 5°C colder next week than this week.", tone: "var(--signal)" },
  { name: "Protocol fees", example: "Hyperliquid’s daily fees pass $5M", thesis: "Long HYPE 3x with $100 if Hyperliquid’s daily fees pass $5 million.", tone: "var(--signal)" },
];

export function Watches() {
  return (
    <Section
      id="watches"
      layout="stack"
      title="What it watches"
      lead="Any of these can be a condition, and one sentence can mix as many as you like. Pick one to try it."
    >
      <ul className="grid gap-px overflow-hidden rounded-[14px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        {SOURCES.map((s, i) => {
          const body = (
            <>
              <span className="flex items-center gap-2 text-[13px] text-muted">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.tone }} />
                {s.name}
              </span>
              <span className="mt-3 block text-[16px] leading-snug text-ink">“{s.example}”</span>
              <span className="mt-auto block pt-4 text-[13px] text-ink-2 transition-transform duration-300 group-hover:translate-x-0.5">
                {s.cta ?? (s.thesis ? "Try it →" : "Paste an address →")}
              </span>
            </>
          );
          return (
            <li key={s.name} className="bg-paper">
              <Reveal delay={(i % 4) * 70} className="h-full">
                <a href={s.href ?? (s.thesis ? `/new?thesis=${encodeURIComponent(s.thesis)}` : "/new")} className="group flex h-full flex-col p-5 transition-colors hover:bg-paper-2/60 sm:p-6">
                  {body}
                </a>
              </Reveal>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
