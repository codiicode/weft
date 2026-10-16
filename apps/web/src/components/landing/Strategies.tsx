import { Section } from "./Section";
import { buttonClass } from "../ui/Button";
import type { Instrument } from "@weft/strategy";
import { MarketSpark } from "./MarketSpark";
import { AssetIcon } from "../ui/AssetIcon";

type Card = { icon: string; market: string; instrument: Instrument; tag: string; title: string; thesis: string; rules: [string, string][] };

/** Examples written for this section, so the page doesn't repeat itself. Charts are the markets' real prices. */
const CARDS: Card[] = [
  {
    icon: "GOLD",
    market: "Gold",
    instrument: { kind: "perp", venue: "hyperliquid", dex: "xyz", symbol: "GOLD", assetClass: "commodity" },
    tag: "Commodities",
    title: "Gold on falling real yields",
    thesis: "When real yields roll over, gold catches a bid. Get long and let it run.",
    rules: [
      ["Watch", "10-year real yield, gold"],
      ["When", "real yield down 15 bp in 5 days"],
      ["Do", "long gold at 2×, trailing stop 3%"],
    ],
  },
  {
    icon: "SOL",
    market: "SOL",
    instrument: { kind: "perp", venue: "hyperliquid", symbol: "SOL", assetClass: "crypto" },
    tag: "Funding",
    title: "Fade the crowded SOL long",
    thesis: "When everyone pays to be long SOL, the squeeze usually goes the other way.",
    rules: [
      ["Watch", "SOL funding, open interest"],
      ["When", "funding above 0.1% for 8 hours"],
      ["Do", "short SOL at 2×, stop at +4%"],
    ],
  },
  {
    icon: "ETH",
    market: "ETH",
    instrument: { kind: "perp", venue: "hyperliquid", symbol: "ETH", assetClass: "crypto" },
    tag: "Mean reversion",
    title: "Buy the ETH flush",
    thesis: "When ETH drops hard in a day and shorts start paying, the panic is usually overdone.",
    rules: [
      ["Watch", "ETH price, funding"],
      ["When", "down 8% in 24 hours and funding below 0"],
      ["Do", "long ETH at 2×, stop 4%, take profit 8%"],
    ],
  },
];

function StrategyCard({ c }: { c: Card }) {
  return (
    <a
      href={`/new?thesis=${encodeURIComponent(c.thesis)}`}
      className="group flex flex-col rounded-[14px] border border-line bg-card p-6 transition-[border-color,transform] duration-300 hover:-translate-y-0.5 hover:border-line-2"
    >
      <div className="text-[13px] text-muted">{c.tag}</div>
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
      <MarketSpark instrument={c.instrument} label={c.market} />
      <div className="mt-auto flex items-center justify-between pt-5 text-[13px]">
        <span className="text-muted">Example strategy</span>
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
        <a href="/strategies" className={buttonClass("secondary", "md")}>
          Browse all strategies
        </a>
        <span className="text-[13px] text-muted">Examples to start from, not advice. Charts show each market’s real price.</span>
      </div>
    </Section>
  );
}
