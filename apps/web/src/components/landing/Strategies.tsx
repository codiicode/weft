import { Section } from "./Section";
import { Sparkline } from "../ui/Sparkline";
import { buttonClass } from "../ui/Button";
import { walk } from "@/lib/rng";
import { AssetIcon } from "../ui/AssetIcon";

type Card = { icon: string; tag: string; title: string; thesis: string; rules: [string, string][]; ret: number; seed: number };

/** Examples written for this section, so the page doesn't repeat itself. Returns are paper and illustrative. */
const CARDS: Card[] = [
  {
    icon: "GOLD",
    tag: "Commodities",
    title: "Gold on falling real yields",
    thesis: "When real yields roll over, gold catches a bid. Get long and let it run.",
    rules: [
      ["Watch", "10-year real yield, gold"],
      ["When", "real yield down 15 bp in 5 days"],
      ["Do", "long gold at 2×, trailing stop 3%"],
    ],
    ret: 7.4,
    seed: 61,
  },
  {
    icon: "SOL",
    tag: "Funding",
    title: "Fade the crowded SOL long",
    thesis: "When everyone pays to be long SOL, the squeeze usually goes the other way.",
    rules: [
      ["Watch", "SOL funding, open interest"],
      ["When", "funding above 0.1% for 8 hours"],
      ["Do", "short SOL at 2×, stop at +4%"],
    ],
    ret: 11.2,
    seed: 72,
  },
  {
    icon: "OUTCOME",
    tag: "Politics",
    title: "Polls ahead of the odds",
    thesis: "Prediction markets lag the polls by a day. Buy the side the polls already favour.",
    rules: [
      ["Watch", "polling average, market odds"],
      ["When", "polls 6+ points ahead of the odds"],
      ["Do", "buy YES up to 62¢, out at 85¢"],
    ],
    ret: 5.1,
    seed: 83,
  },
];

function StrategyCard({ c }: { c: Card }) {
  return (
    <a
      href={`/app/new?thesis=${encodeURIComponent(c.thesis)}`}
      className="group flex flex-col rounded-[14px] border border-line bg-card p-6 transition-[border-color,transform] duration-300 hover:-translate-y-0.5 hover:border-line-2"
    >
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="text-muted">{c.tag}</span>
        <span className="tnum font-medium text-long">+{c.ret}%</span>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <AssetIcon symbol={c.icon} size={30} />
        <h3 className="text-[19px] font-semibold leading-tight tracking-[-0.02em] text-ink">{c.title}</h3>
      </div>
      <p className="mt-2 text-[14.5px] leading-[1.55] text-ink-2">{c.thesis}</p>
      <dl className="mt-5 space-y-1.5 border-t border-line pt-4 text-[13.5px]">
        {c.rules.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[52px_1fr] gap-2">
            <dt className="text-muted">{k}</dt>
            <dd className="text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <Sparkline data={walk(c.seed, 36, 0.4, 0.55)} width={300} height={44} color="var(--long)" strokeWidth={1.5} className="mt-5 w-full" />
      <div className="mt-auto flex items-center justify-between pt-5 text-[13px]">
        <span className="text-muted">Example, on paper</span>
        <span className="font-medium text-ink transition-transform duration-300 group-hover:translate-x-0.5">Use this →</span>
      </div>
    </a>
  );
}

export function Strategies() {
  return (
    <Section
      id="strategies"
      layout="stack"
      title="Start from someone else’s strategy"
      lead="Every strategy is public. Read exactly what it does, copy it, and make it yours. Your wallet and amounts stay private."
    >
      <div className="grid gap-4 md:grid-cols-3">
        {CARDS.map((c) => (
          <StrategyCard key={c.title} c={c} />
        ))}
      </div>
      <div className="mt-8 flex flex-wrap items-center gap-4">
        <a href="/app/library" className={buttonClass("secondary", "md")}>
          Browse all strategies
        </a>
        <span className="text-[13px] text-muted">Returns shown are from paper runs and are illustrative.</span>
      </div>
    </Section>
  );
}
