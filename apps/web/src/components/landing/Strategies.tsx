import { Section } from "./Section";
import { buttonClass } from "../ui/Button";
import type { Instrument } from "@weft/strategy";
import { MarketSpark } from "./MarketSpark";
import { AssetIcon } from "../ui/AssetIcon";

type Card = { icon: string; market: string; instrument: Instrument; tag: string; title: string; thesis: string; prompt: string; rules: [string, string][] };

/** Examples written for this section, so the page doesn't repeat itself. Charts are the markets' real prices. */
const CARDS: Card[] = [
  {
    icon: "ETH",
    market: "ETH",
    instrument: { kind: "perp", venue: "hyperliquid", symbol: "ETH", assetClass: "crypto" },
    tag: "Sentiment",
    title: "Buy the panic",
    thesis: "When the whole market is scared, get long the majors with a small stake.",
    prompt: "If the Fear & Greed index reaches 20, open a 20x long on ETH and a 20x long on BTC with $100 on each.",
    rules: [
      ["Watch", "Crypto Fear & Greed Index"],
      ["When", "it falls to 20 or lower"],
      ["Do", "long ETH and BTC at 20×, $100 each"],
    ],
  },
  {
    icon: "BTC",
    market: "BTC",
    instrument: { kind: "perp", venue: "hyperliquid", symbol: "BTC", assetClass: "crypto" },
    tag: "Posts on X",
    title: "Saylor buys, you buy",
    thesis: "When Strategy announces another bitcoin purchase, ride the headline.",
    prompt: "If @saylor posts that Strategy bought more bitcoin and BTC funding is under 0.01% an hour, long BTC 3x with $100. Stop at -15% on the position.",
    rules: [
      ["Watch", "@saylor on X, BTC funding"],
      ["When", "a new post says Strategy bought more, funding under 0.01%"],
      ["Do", "long BTC at 3×, stop at −15% on the position"],
    ],
  },
  {
    icon: "NATGAS",
    market: "Natural gas",
    instrument: { kind: "perp", venue: "hyperliquid", dex: "xyz", symbol: "NATGAS", assetClass: "commodity" },
    tag: "Weather",
    title: "Cold snap in Chicago",
    thesis: "A colder week in the Midwest means more heating, and more demand for gas.",
    prompt: "Long natural gas 2x with $100 if Chicago is forecast to be 5°C colder next week than this week. Stop at -10% on the position.",
    rules: [
      ["Watch", "Chicago 7-day forecast"],
      ["When", "5°C colder than the past week"],
      ["Do", "long natural gas at 2×, stop at −10% on the position"],
    ],
  },
];

function StrategyCard({ c }: { c: Card }) {
  return (
    <a
      href={`/new?thesis=${encodeURIComponent(c.prompt)}`}
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
      lead="Saved strategies are public, with no names attached. Open one, read exactly what it does and change what you like. Your wallet and your amounts are never shown."
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
